import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { curateClipWindows } from './peerCoverageRuntime';
import type { PeerApi } from './peerCoverageApi';

function apiFixture(): PeerApi {
    return { accountId: jest.fn(async () => '1'), search: jest.fn(async () => []), read: jest.fn(),
        has: jest.fn(), act: jest.fn(), defaultFolder: jest.fn() };
}
test('own facade preserves all candidates, prioritizes model scores, and creates immutable reports on repeat', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-runtime-'));
    try {
        const sourceSrt = path.join(root, 'source.srt'); await fs.writeFile(sourceSrt, 'source evidence');
        const clips = [89, 95, 94].map((score, index) => ({ title: `事件${index}`, start: index * 10, end: index * 10 + 8,
            score, selectionSource: 'model_global_rerank' }));
        const api = apiFixture(), request = jest.fn(async () => JSON.stringify({ worthPublishing: true, score: 95, reason: '完整独立事件', queries: ['岁己 具体事件'] }));
        const input = { kind: 'own' as const, config: { clipCuration: { enabled: true, roomIds: ['25788785'], maxStandalone: 1 } },
            info: { roomId: '25788785' }, sourceSrt, sourceMedia: 'source.mp4', outputRoot: root,
            statePath: path.join(root, 'support.json'), planOnly: true,
            segments: clips.map(row => ({ ...row, text: '这一段是完整的源台词' })) };
        const first = await curateClipWindows(clips, input, request, api);
        expect(first).toHaveLength(3);
        expect(first[0]).toBe(clips[0]);
        expect(first[1].curation).toMatchObject({ status: 'original', sourceWindow: { start: 10, end: 18 } });
        expect(first[2].curation.status).toBe('budget');
        const before = await fs.readFile(first[1].curation.evidencePath, 'utf8');
        const second = await curateClipWindows(clips, input, request, api);
        expect(second[1].curation.evidencePath).not.toBe(first[1].curation.evidencePath);
        expect(await fs.readFile(first[1].curation.evidencePath, 'utf8')).toBe(before);
        expect(api.act).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('topic facade checks unresolved preflight drafts when the source window is complete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-topic-runtime-'));
    try {
        const sourceSrt = path.join(root, 'source.srt'); await fs.writeFile(sourceSrt, 'evidence');
        const clips = [{ window: { start: 0, end: 10 }, preflight: { status: 'needs_review' } }], api = apiFixture();
        const request = jest.fn(async phase => JSON.stringify(phase.startsWith('assess')
            ? { worthPublishing: true, score: 95, reason: '完整事件', queries: ['具体事件'] } : {}));
        const result = await curateClipWindows(clips, { kind: 'topic', config: { clipCuration: { enabled: true, includeKeywordTopics: true } },
            info: { roomId: '2' }, sourceSrt, sourceMedia: 'source.mp4', outputRoot: root, statePath: path.join(root, 'support.json'),
            segments: [{ start: 0, end: 5, text: '完整的源台词' }] }, request, api);
        expect(result[0].curation).toMatchObject({ status: 'original', sourceWindow: { start: 0, end: 10 } });
        expect(api.accountId).toHaveBeenCalled(); expect(api.search).toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('keyword topics in another room use the same covered decision and explicit interaction settings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-topic-covered-'));
    try {
        const sourceSrt = path.join(root, 'source.srt'); await fs.writeFile(sourceSrt, 'original evidence');
        const segments = ['我先问了小岁机箱有多重', '随后我们聊了玻璃机箱', '最后说装齐硬件确实很重']
            .map((text, i) => ({ start: i * 10, end: i * 10 + 8, text }));
        const peer = { bvid: 'BV1234567890', aid: '2', ownerId: '3', title: '另一标题', description: '', duration: 30,
            publishedAt: 1, complete: true, cues: segments.map((cue, i) => ({ ...cue, id: `P${i + 1}` })) };
        const api = apiFixture(); (api.search as jest.Mock).mockResolvedValue([peer]); (api.read as jest.Mock).mockResolvedValue(peer);
        const comparison = { sameEvent: true, complete: true, quality: true, reason: '同一段完整问答已覆盖',
            anchors: segments.slice(0, 2).map((cue, i) => ({ sourceId: `S${i + 1}`, peerId: `P${i + 1}`, quote: cue.text })),
            beats: Object.fromEntries(['setup', 'development', 'payoff'].map((key, i) => [key, { sourceId: `S${i + 1}`, peerId: `P${i + 1}` }])) };
        const request = jest.fn(async phase => JSON.stringify(phase.startsWith('assess')
            ? { worthPublishing: true, score: 95, reason: '完整问答', queries: ['小栞 小岁 机箱'] } : comparison));
        const [result] = await curateClipWindows([{ window: { start: 0, end: 30 }, preflight: { status: 'ready' } }], {
            kind: 'topic', config: { clipCuration: { enabled: true, roomIds: ['25788785'], includeKeywordTopics: true,
                supportActions: ['like', 'favorite', 'repost'] } }, info: { roomId: '26966466' },
            sourceSrt, sourceMedia: 'recording.mp4', outputRoot: root, statePath: path.join(root, 'support.json'),
            segments, planOnly: true
        }, request, api);
        expect(result.curation).toMatchObject({ status: 'covered', peer: { bvid: peer.bvid }, support: { status: 'disabled' } });
        expect(api.search).toHaveBeenCalledTimes(1); expect(api.act).not.toHaveBeenCalled();
        const report = JSON.parse(await fs.readFile(result.curation.evidencePath, 'utf8'));
        expect(report.decisions[0].status).toBe('covered');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
