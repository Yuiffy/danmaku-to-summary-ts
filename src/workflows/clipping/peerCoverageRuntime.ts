import { CoverageCandidate, CoverageDecision, CoverageSettings, curateCandidates, coverageSettings } from './peerCoverage';
import { createPeerApi, PeerApi } from './peerCoverageApi';
import { supportPeer, writeCoverageJson } from './peerSupport';
import { coverageDigest } from './peerCoverage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export { createPeerApi } from './peerCoverageApi';
export { coverageDigest, coverageSettings } from './peerCoverage';
export async function runPeerCuration(input: {
    candidates: CoverageCandidate[]; settings: CoverageSettings; cookie: string;
    evidencePath: string; statePath: string; support: boolean;
}, request: (phase: string, prompt: string) => Promise<string>, api: PeerApi = createPeerApi(input.cookie)): Promise<CoverageDecision[]> {
    const save = (decisions: CoverageDecision[]) => writeCoverageJson(input.evidencePath, { version: 1,
        checkedAt: new Date().toISOString(), scope: 'bounded_platform_subtitle_comparison',
        candidates: input.candidates, decisions });
    if (!input.candidates.length) { await save([]); return []; }
    let uid: string;
    try { uid = await api.accountId(); }
    catch {
        const decisions: CoverageDecision[] = input.candidates.map(candidate => ({ candidateId: candidate.id,
            inputDigest: coverageDigest(candidate), status: 'needs_review', reason: '平台登录态或检索不可用，待核同题覆盖' }));
        await save(decisions); return decisions;
    }
    const cache = new Map<string, Awaited<ReturnType<PeerApi['read']>>>();
    return curateCandidates(input.candidates, input.settings, {
        accountId: uid, search: api.search, request, save,
        read: async video => {
            if (!cache.has(video.bvid)) cache.set(video.bvid, await api.read(video));
            return cache.get(video.bvid)!;
        },
        support: video => input.support ? supportPeer(video, input.settings, api, input.statePath)
            : Promise.resolve({ status: 'disabled', reason: '仅规划或只读核查，没有执行互动' })
    });
}

/** Source-CLI facade: both producers supply parsed original speech and the existing stage-request adapter. */
export async function curateClipWindows<T extends Record<string, any>>(clips: T[], input: {
    kind: 'own' | 'topic'; config: Record<string, any>; info: Record<string, any>; sourceSrt: string; sourceMedia: string;
    outputRoot: string; statePath: string; segments: Array<{ start: number; end: number; text: string }>; planOnly?: boolean;
}, request: (phase: string, prompt: string) => Promise<string>, api?: PeerApi): Promise<T[]> {
    const settings = input.config.clipCuration;
    if (!settings?.enabled || input.kind === 'own' && !settings.roomIds?.map(String).includes(String(input.info.roomId))
        || input.kind === 'topic' && settings.includeKeywordTopics !== true) return clips;
    const hashFile = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const sourceSrtSha256 = await hashFile(input.sourceSrt);
    const policy = coverageSettings(settings);
    // Peer coverage is an independent duplicate check. A topic can be pending
    // preflight because of an unresolved wording/attribution issue and still
    // benefit from seeing an existing Bilibili clip in the review page.
    const eligible = clips.map((clip, index) => ({ clip, index })).filter(({ clip }) => input.kind === 'topic'
        ? Number.isFinite(Number((clip.window || clip).start)) && Number.isFinite(Number((clip.window || clip).end))
            && Number((clip.window || clip).end) > Number((clip.window || clip).start)
        : ['model_global_rerank', 'model_full_context', 'model_chunked'].includes(clip.selectionSource)
            && (clip.globalSelection?.score ?? (clip.selectionSource === 'model_chunked' ? clip.modelScore : clip.score)) >= policy.minScore);
    if (input.kind === 'own') eligible.sort((a, b) => (b.clip.globalSelection?.score ?? b.clip.modelScore ?? b.clip.score)
        - (a.clip.globalSelection?.score ?? a.clip.modelScore ?? a.clip.score) || a.clip.start - b.clip.start);
    const candidates: CoverageCandidate[] = eligible.map(({ clip, index }) => {
        const window = clip.window || clip;
        return { id: String(index + 1), roomId: String(input.info.roomId), host: String(input.info.streamerName || input.info.roomName || ''),
            source: input.sourceMedia, start: window.start, end: window.end, title: clip.aiTitle || clip.title || clip.copy?.title || '',
            cues: input.segments.filter(row => row.start >= window.start - .001 && row.end <= window.end + .001)
                .map((row, cueIndex) => ({ id: `S${cueIndex + 1}`, start: row.start, end: row.end, text: row.text })) };
    });
    const evidencePath = path.join(input.outputRoot, 'peer_coverage', `${input.kind}-${randomUUID()}.json`);
    const decisions = await runPeerCuration({ candidates, settings: policy, cookie: input.config.bilibili?.cookie || '', evidencePath,
        statePath: input.statePath,
        support: !input.planOnly }, request, api);
    if (await hashFile(input.sourceSrt) !== sourceSrtSha256) throw new Error('Source subtitles changed during peer coverage check');
    const evidenceSha256 = await hashFile(evidencePath);
    const byIndex = new Map(eligible.map(({ index }, position) => [index, position]));
    return clips.map((clip, index) => {
        const position = byIndex.get(index);
        if (position === undefined) return clip;
        return { ...clip, curation: { version: 1, ...decisions[position], evidencePath, evidenceSha256,
            sourceSrtSha256, sourceMediaPath: input.sourceMedia,
            sourceWindow: { start: candidates[position].start, end: candidates[position].end } } };
    });
}
