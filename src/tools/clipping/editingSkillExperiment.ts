import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { editingSkillPrompt, EDITING_SKILL_SOURCES, EDITING_SKILL_VERSION,
    EditingSample, EditingReference, validateEditingSamples, measureEditingTimeline } from '../../workflows/clipping/editingSkillExperiment';
import { StageConfig, Generation, validateStageRequest } from '../../workflows/clipping/stage';
import { parseModelJson } from '../../workflows/text/json';
import { buildEditingBoundaryReview } from '../../workflows/clipping/editingBoundaryReview';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const write = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
interface SampleFile {
    id: string; roomId: string; sessionId: string; split: 'screening' | 'holdout';
    promptPath: string; promptSha256: string; evidencePath: string; evidenceSha256: string; reference: EditingReference;
}
interface FrozenSample extends EditingSample { roomId: string; prompt: string; evidence: any }
export interface EditingExperimentManifest { version: 1; repetitions: number; stage: StageConfig; samples: SampleFile[] }

/** Validate every input before the first external request. Labels are never sent to generation. */
export function loadEditingExperiment(file: string): { manifest: EditingExperimentManifest; samples: FrozenSample[] } {
    const manifest = read(file) as EditingExperimentManifest;
    if (manifest.version !== 1 || !Number.isInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 3
        || !Array.isArray(manifest.samples)) throw new Error('Invalid editing experiment manifest');
    const frozen = (relative: string, digest: string) => {
        if (typeof relative !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing frozen input digest');
        const buffer = fs.readFileSync(path.resolve(path.dirname(file), relative));
        if (sha(buffer) !== digest) throw new Error('Frozen experiment input changed: ' + relative);
        return buffer.toString('utf8').replace(/^\uFEFF/, '');
    };
    const samples = manifest.samples.map(s => {
        if (!/^[a-z0-9_-]+$/.test(s.id) || !s.roomId) throw new Error('Invalid sample ID/room');
        const evidence = JSON.parse(frozen(s.evidencePath, s.evidenceSha256));
        const prompt = frozen(s.promptPath, s.promptSha256);
        if (!Array.isArray(evidence.protectedSpans) || !Array.isArray(evidence.protectedCues)) throw new Error('Missing source protection');
        for (const variant of ['baseline', 'story_beats'] as const) validateStageRequest(manifest.stage, editingSkillPrompt(prompt, variant));
        return { ...s, prompt, evidence, duration: evidence.sourceDuration, cues: evidence.sourceCues };
    });
    validateEditingSamples(samples);
    return { manifest, samples };
}

export async function runEditingPairs(manifest: EditingExperimentManifest, samples: FrozenSample[], io: {
    generate(prompt: string, sample: FrozenSample, key: string): Promise<Generation>;
    save(key: string, value: unknown): void;
    validate(draft: any, evidence: any): { profile: unknown; timeline: { keep: Array<{ start: number; end: number }> } };
}) {
    const rows: Array<Record<string, any>> = [];
    for (let repeat = 0; repeat < manifest.repetitions; repeat++) {
        for (const [index, sample] of samples.entries()) {
            const variants = (repeat + index) % 2 ? ['story_beats', 'baseline'] as const : ['baseline', 'story_beats'] as const;
            for (const variant of variants) {
                const key = `${sample.id}-r${repeat + 1}-${variant}`, prompt = editingSkillPrompt(sample.prompt, variant);
                const row: Record<string, any> = { key, sampleId: sample.id, sessionId: sample.sessionId, split: sample.split,
                    repeat: repeat + 1, variant, promptSha256: sha(prompt), status: 'pending' };
                io.save(`${key}.request`, { prompt, promptSha256: row.promptSha256, stage: manifest.stage });
                // Provider failures stop the run; invalid editorial plans remain measured failures.
                let result: Generation;
                try { result = await io.generate(prompt, sample, key); }
                catch (error) {
                    rows.push({ ...row, status: 'request_failed', error: (error as Error).message });
                    io.save('results', rows); throw error;
                }
                io.save(`${key}.response`, result);
                row.usage = result.meta?.usage ?? null; row.elapsedMs = result.meta?.elapsedMs ?? null;
                row.costCny = result.meta?.costCny ?? null;
                try {
                    const draft = parseModelJson(result.text), validated = io.validate(draft, sample.evidence);
                    const metrics = measureEditingTimeline(sample, validated.timeline.keep);
                    const boundaryReview = buildEditingBoundaryReview(validated.timeline.keep, sample.cues, sample.duration);
                    Object.assign(row, { status: 'valid', ...validated, metrics, boundaryReview });
                } catch (error) { Object.assign(row, { status: 'invalid_plan', error: (error as Error).message }); }
                rows.push(row); io.save('results', rows);
            }
        }
    }
    return rows;
}

export async function main(args = process.argv.slice(2)) {
    if (args.includes('--help')) {
        console.log('node -r ts-node/register src/tools/clipping/editingSkillExperiment.ts --manifest <frozen.json> --output <new-directory> [--execute]'); return;
    }
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (!args.includes('--manifest') || !args.includes('--output')) throw new Error('Explicit --manifest and new --output required');
    const file = path.resolve(value('--manifest')), output = path.resolve(value('--output'));
    const { manifest, samples } = loadEditingExperiment(file);
    const root = path.resolve(__dirname, '../../..');
    fs.mkdirSync(output, { recursive: false }); // Never overwrite a previous experiment.
    const save = (key: string, data: unknown) => write(path.join(output, key + '.json'), data);
    const sourceFiles = [...EDITING_SKILL_SOURCES.map(s => s.split('#')[0]),
        'src/scripts/clipping/creative_runner.js', 'src/scripts/clipping/creative_timeline.js',
        'src/workflows/clipping/editingSkillExperiment.ts', 'src/workflows/clipping/editingBoundaryReview.ts',
        'src/tools/clipping/editingSkillExperiment.ts'];
    save('provenance', { version: 1, createdAt: new Date().toISOString(), skillVersion: EDITING_SKILL_VERSION,
        sources: EDITING_SKILL_SOURCES, manifestSha256: sha(fs.readFileSync(file)),
        sourceSha256: Object.fromEntries(sourceFiles.map(p => [p, sha(fs.readFileSync(path.join(root, p)))])),
        gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
        plannedRequests: samples.length * 2 * manifest.repetitions, execution: args.includes('--execute'),
        scope: 'story planning only; no rendering, review approval, registry or queue mutations' });
    if (!args.includes('--execute')) {
        console.log(JSON.stringify({ output, samples: samples.length, networkRequests: 0, status: 'inputs_validated' })); return;
    }
    process.env.DANMAKU_WORKFLOW_RELEASE ||= read(path.join(root, 'build/workflow-candidate.json')).releaseDir;
    const { requestStage } = require('../../scripts/clipping/enhancement_runner');
    const { validateStoryPlan } = require('../../scripts/clipping/creative_timeline');
    const { editorialProfile } = require('../../scripts/clipping/creative_profile');
    const rows = await runEditingPairs(manifest, samples, {
        save,
        generate: (prompt, sample, key) => requestStage(manifest.stage,
            { mode: 'log_only', ledgerPath: path.join(output, 'usage-ledger.json') },
            { roomId: sample.roomId, sessionId: sample.sessionId, evaluationSplit: sample.split,
                outputContract: { key: 'keep', type: 'records' } }, key, prompt),
        validate: (draft, evidence) => {
            const profile = editorialProfile(draft.profile);
            const timeline = validateStoryPlan(draft, evidence.sourceCues, evidence.sourceDuration, evidence.protectedSpans, profile, 3);
            return { profile, timeline };
        }
    });
    console.log(JSON.stringify({ output, completedRequests: rows.length, valid: rows.filter(r => r.status === 'valid').length,
        qualityWinner: null, mediaReviewed: false }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
