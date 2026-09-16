import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { calculateCost, StageConfig, validateStage } from '../../workflows/clipping/stage';

const root = path.resolve(__dirname, '../../..');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');

export function validateSampleSplits(samples: Array<{ id: string; sessionId: string; split: string }>) {
    const sessions = new Map<string, string>();
    const ids = new Set<string>();
    for (const item of samples) {
        if (!item.id || ids.has(item.id) || !item.sessionId || !['screening', 'holdout'].includes(item.split)) throw new Error('Invalid evaluation sample');
        if (sessions.has(item.sessionId) && sessions.get(item.sessionId) !== item.split) throw new Error('Session leakage between screening and holdout');
        sessions.set(item.sessionId, item.split); ids.add(item.id);
    }
}

export async function main(args = process.argv.slice(2)) {
    const argument = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
    if (argument('--environment')) {
        if (!['production', 'development', 'automation'].includes(argument('--environment')!)) throw new Error('Unsupported configuration environment');
        Object.assign(process.env, { NODE_ENV: argument('--environment') });
    }
    const output = path.resolve(argument('--output') || path.join(root, 'tmp', `clip-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    fs.mkdirSync(output, { recursive: true });
    process.env.DANMAKU_WORKFLOW_RELEASE ||= read(path.join(root, 'build/workflow-candidate.json')).releaseDir;
    const own = require('../../scripts/own_stream_clipper');
    const rootConfig = require('../../scripts/config-loader').getConfig();
    const provider = rootConfig.ai?.text?.provider;
    const route = rootConfig.ai?.text?.[provider] || {};
    const baseline = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
        diffSha256: sha(execFileSync('git', ['diff', '--', 'src'], { cwd: root, windowsHide: true })),
        provider, model: rootConfig.ownStreamClips?.ai?.model || route.model,
        reasoningEffort: route.thinking?.reasoningEffort || route.thinking?.effort || null,
        apiMode: route.apiMode, maxTokens: route.maxTokens,
        hostname: os.hostname(), platform: os.platform(), cpu: os.cpus()[0]?.model,
        configEnvironment: process.env.NODE_ENV || 'development',
        workflowManifestSha256: sha(fs.readFileSync(path.join(process.env.DANMAKU_WORKFLOW_RELEASE!, 'manifest.json'))),
        sourceSha256: Object.fromEntries(['src/scripts/own_stream_clipper.js', 'src/scripts/clipping/own_selection.js',
            'src/scripts/clipping/rerank_evidence.js', 'src/scripts/clipping/enhancement_runner.js', 'src/tools/clipping/evaluate.ts']
            .map(file => [file, sha(fs.readFileSync(path.join(root, file)))])),
        workflowRelease: process.env.DANMAKU_WORKFLOW_RELEASE };
    if (argument('--srt')) {
        const source = path.resolve(argument('--srt')!);
        const parsed = require('../../scripts/asr/asr_backends').parseSrt(source);
        const config = own.getOwnStreamClipsConfig(rootConfig);
        const duration = parsed.segments.at(-1)?.end || 0;
        const comments = argument('--xml') ? await own.parseDanmakuXml(path.resolve(argument('--xml')!)) : [];
        const chunks = own.buildChunkSources(parsed, comments, duration, config);
        const seen = new Set<number>(chunks.flatMap((chunk: any) => chunk.subtitleCues.flatMap((cue: any) => cue.items.map((row: any) => row.index))));
        const report = { mode: 'offline-corpus-audit', baseline, source, sourceSha256: sha(fs.readFileSync(source)),
            duration, subtitleRows: parsed.segments.length, comments: comments.length, coveredSubtitleRows: seen.size,
            missedRows: parsed.segments.map((_: any, i: number) => i).filter((i: number) => !seen.has(i)),
            chunks: chunks.map((chunk: any) => ({ index: chunk.index, start: chunk.start, end: chunk.end,
                subtitleChars: chunk.subtitleChars, partialCues: chunk.subtitleCues.filter((cue: any) => cue.partial).length })),
            localCandidates: own.buildCandidateWindows(parsed, comments, config, duration), networkRequests: 0, paidCny: 0 };
        write(path.join(output, 'report.json'), report);
        if (report.missedRows.length || chunks.some((chunk: any) => chunk.subtitleChars > config.maxSubtitleCharsPerChunk)) throw new Error('Corpus coverage failed');
        console.log(JSON.stringify({ output, subtitleRows: report.subtitleRows, covered: seen.size, chunks: chunks.length, networkRequests: 0 }));
        return;
    }
    const manifestPath = path.resolve(argument('--manifest') || path.join(root, 'tests/fixtures/clip-evaluation.json'));
    const manifest = read(manifestPath);
    if (manifest.version !== 1) throw new Error('Unsupported evaluation manifest');
    validateSampleSplits(manifest.samples);
    const paid = args.includes('--execute-paid');
    const budget = { ledgerPath: path.join(root, 'data/runtime/clip-evaluation-ledger.json'), globalCny: 100,
        roomCny: 100, sessionCny: 100, holdoutReserveCny: 40 };
    const rows: Array<Record<string, any>> = [];
    let sent = 0;
    for (const variant of manifest.matrix) {
        for (const effort of variant.efforts) {
            const config: StageConfig = { ...manifest.stage, model: variant.model, reasoningEffort: effort,
                capabilities: { ...manifest.stage.capabilities, reasoningEfforts: variant.verifiedEfforts || [] },
                price: variant.price || manifest.stage.price };
            for (const sample of manifest.samples) {
                const prompt = sample.promptPath ? fs.readFileSync(path.resolve(path.dirname(manifestPath), sample.promptPath), 'utf8') : sample.prompt;
                if (typeof prompt !== 'string') throw new Error('Missing frozen sample prompt');
                const images = (sample.images || []).map((file: string) => {
                    const resolved = path.resolve(path.dirname(manifestPath), file);
                    return `data:image/${path.extname(resolved).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${fs.readFileSync(resolved).toString('base64')}`;
                });
                const entry: Record<string, any> = { sampleId: sample.id, sessionId: sample.sessionId, split: sample.split, stage: sample.stage,
                    model: config.model, effort, promptSha256: sha(prompt), priceVersion: config.price?.version,
                    priceConfirmed: config.price?.confirmed === true, humanReference: sample.reference || null,
                    qualityScore: null, recall: null, duplicateRate: null, falseAcceptance: null, actualCny: null };
                try {
                    entry.reservedEstimateCny = validateStage(config, prompt, images, paid);
                    entry.status = paid ? 'pending' : 'offline_only';
                    if (paid) {
                        const id = String(rows.length + 1).padStart(4, '0');
                        write(path.join(output, `${id}.request.json`), { sample, config, prompt, imageSha256: images.map((image: string) => sha(image)) });
                        const result = await require('../../scripts/clipping/enhancement_runner').requestStage(config, budget,
                            { roomId: sample.roomId, sessionId: sample.sessionId, evaluationSplit: sample.split }, `${sample.stage}:${sample.id}`, prompt, images);
                        sent++;
                        write(path.join(output, `${id}.response.json`), result);
                        entry.actualCny = calculateCost(result.meta?.usage, config.price);
                        entry.ledgerId = result.meta?.ledgerId; entry.status = 'completed';
                        if (sample.stage === 'qa' && sample.reference?.knownBad === true) {
                            try { entry.falseAcceptance = JSON.parse(result.text).approved === true; } catch { entry.falseAcceptance = false; }
                        }
                    }
                } catch (error: any) {
                    entry.status = 'blocked_or_failed'; entry.error = error.message;
                    rows.push(entry);
                    if (paid) { write(path.join(output, 'report.json'), { mode: 'paid', baseline, rows, completedRequests: sent, stopped: true }); throw error; }
                    continue;
                }
                rows.push(entry);
            }
        }
    }
    write(path.join(output, 'report.json'), { version: 1, mode: paid ? 'paid' : 'offline', baseline, manifestSha256: sha(fs.readFileSync(manifestPath)),
        rows, completedRequests: sent, modelWinner: null, note: 'No quality winner without sufficient human-reviewed holdout samples. Unuploaded is not a negative label.' });
    console.log(JSON.stringify({ output, rows: rows.length, completedRequests: sent, mode: paid ? 'paid' : 'offline' }));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
