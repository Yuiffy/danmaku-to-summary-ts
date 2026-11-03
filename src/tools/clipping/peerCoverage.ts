import * as fs from 'fs/promises';
import * as path from 'path';
import type { CoverageCandidate } from '../../workflows/clipping/peerCoverage';

/** Bounded platform probe / offline-plan check. No queue writes or publication approval. */
export async function main(args = process.argv.slice(2)): Promise<void> {
    const value = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    if (args.includes('--help')) {
        console.log('clips:peers --probe "主播 具体事件" [--output file]\nclips:peers --manifest candidates.json --output directory [--support]'); return;
    }
    const rootConfig = require('../../scripts/config-loader').getConfig();
    const runtime = require('../../scripts/workflow-runtime').loadWorkflow('clipping/peerCoverageRuntime');
    const api = runtime.createPeerApi(rootConfig.bilibili?.cookie || '');
    if (value('--probe')) {
        const account = await api.accountId(), videos = await api.search(value('--probe'), 3);
        const result = { mode: 'read_only_probe', authenticated: Boolean(account), count: videos.length,
            videos: videos.map((v: any) => ({ bvid: v.bvid, title: v.title, ownerId: v.ownerId })) };
        if (value('--output')) await fs.writeFile(path.resolve(value('--output')!), JSON.stringify(result, null, 2), 'utf8');
        console.log(JSON.stringify(result)); return;
    }
    const manifest = value('--manifest'), output = value('--output');
    if (!manifest || !output) throw new Error('Specify --probe, or --manifest and a new --output directory');
    const candidates: CoverageCandidate[] = JSON.parse(await fs.readFile(path.resolve(manifest), 'utf8')).candidates;
    if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('Invalid bounded candidate manifest');
    const directory = path.resolve(output);
    await fs.mkdir(directory); // Never overwrite a previous run's evidence.
    const settings = rootConfig.ownStreamClips?.enhancements || {};
    const decisions = await runtime.runPeerCuration({ candidates, settings: rootConfig.clipCuration,
        cookie: rootConfig.bilibili?.cookie || '', evidencePath: path.join(directory, 'PEER_COVERAGE.json'),
        statePath: path.resolve('data/runtime/clip_peer_support.json'), support: args.includes('--support') },
    async (phase: string, prompt: string) => {
        if (rootConfig.ai?.text?.enabled === false) throw new Error('AI is disabled');
        return (await require('../../scripts/clipping/enhancement_runner').requestStage(
            { ...settings.stageDefaults, ...settings.stages?.selection }, settings.budget,
            { roomId: candidates[0]?.roomId, sessionId: path.resolve(manifest) },
            `peer-cli-${phase}`, prompt)).text;
    }, api);
    console.log(JSON.stringify({ evidencePath: path.join(directory, 'PEER_COVERAGE.json'),
        decisions: decisions.map((row: any) => ({ candidateId: row.candidateId, status: row.status, reason: row.reason, bvid: row.peer?.bvid })) }));
}
if (require.main === module) main().catch(() => { console.error('Peer check unavailable; inspect configuration or platform access. No upload was authorized.'); process.exitCode = 1; });
