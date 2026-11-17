import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { curateClipWindows, runPeerCuration } from './peerCoverageRuntime';
import type { PeerApi } from './peerCoverageApi';

function apiFixture(): PeerApi {
    return { accountId: jest.fn(async () => '1'), search: jest.fn(async () => []), read: jest.fn(),
        has: jest.fn(), act: jest.fn(), defaultFolder: jest.fn() };
}

test.each([
    ['4554', '没有小栞也没有小岁，回应一句不可拆散', '看自由绿绿和好吧，羽哒念了一堆人都没我！也没岁己？太好了！', 14],
    ['4555', '小岁电脑有英伟达显卡吗？拆下来我帮你处理掉', '赶紧把岁己的5070处理掉，用这个都是潜在的出轨栅栏', 1],
    ['4556', '泳装照不给看，还直说就是故意让你抓心挠肝', '我故意的让你抓心挠肝呀', 12],
    ['second-page', '另一个候选标题', '第二页的同一具体事件', 34]
])('recent canonical-host recall finds rewritten titles for candidate %s', async (id, title, peerTitle, position) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-recent-'));
    try {
        const api = apiFixture();
        const hits = Array.from({ length: 40 }, (_, index) => ({ bvid: `BV${String(index).padStart(10, '0')}`,
            aid: String(index + 1), ownerId: '3', title: index === position ? peerTitle : '栞栞另一个事件',
            description: '', publishedAt: 1, duration: 0, cues: [], complete: false }));
        (api.search as jest.Mock).mockImplementation(async (query, _limit, options) =>
            query === '栞栞' && options?.order === 'pubdate' ? hits.slice((options.page - 1) * 20, options.page * 20) : []);
        (api.read as jest.Mock).mockImplementation(async peer => peer);
        const request = jest.fn(async (_phase, prompt) => {
            const rows = JSON.parse(prompt.split('\n').find(line => line.startsWith('RESULTS '))?.slice(8) || '[]');
            return JSON.stringify({ items: rows.map(row => ({ bvid: row.bvid, relevant: row.title === peerTitle,
                score: row.title === peerTitle ? 95 : 5, reason: '按具体事件判断' })) });
        });
        const [decision] = await runPeerCuration({ candidates: [{ id, title, host: '小栞', roomId: '26966466',
            source: 'source.mp4', start: 0, end: 10, cues: [{ id: 'S1', start: 0, end: 5, text: '[UNKNOWN 0.75] 完整的源字幕原话' }] }],
            settings: {}, cookie: '', support: false, skipEditorialAssessment: true, rerankPeers: true,
            streamerRegistry: { shiori: { roomIds: ['26966466'], displayName: '栞栞', searchTags: ['栞栞', '栞栞Shiori'], aiClipName: '小栞' } },
            evidencePath: path.join(root, 'evidence.json'), statePath: path.join(root, 'support.json') }, request, api);
        expect(decision.status).toBe('needs_review');
        expect(decision.matches).toContainEqual(expect.objectContaining({ title: peerTitle, status: 'subtitle_unavailable' }));
        expect(api.read).toHaveBeenCalledTimes(1);
        expect(api.act).not.toHaveBeenCalled();
        expect(decision.searches?.[0]).toMatchObject({ query: '栞栞', order: 'pubdate', page: 1, limit: 20 });
        if (position >= 20) expect(decision.searches?.[1]).toMatchObject({ query: '栞栞', order: 'pubdate', page: 2 });
        expect((api.search as jest.Mock).mock.calls.every(([query]) => !query.includes('UNKNOWN'))).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('one batch reuses recent searches across different source candidates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-batch-'));
    try {
        const api = apiFixture();
        const candidates = ['1', '2'].map(id => ({ id, title: `事件${id}`, roomId: '2', host: '栞栞', source: 'source.mp4',
            start: 0, end: 5, cues: [{ id: 'S1', start: 0, end: 4, text: '完整源字幕' }] }));
        const results = await runPeerCuration({ candidates, settings: { maxSearchQueries: 2 }, cookie: '', support: false,
            skipEditorialAssessment: true, rerankPeers: true, evidencePath: path.join(root, 'evidence.json'),
            statePath: path.join(root, 'support.json') }, jest.fn(), api);
        expect(results.map(row => row.status)).toEqual(['original', 'original']);
        expect(api.search).toHaveBeenCalledTimes(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a forty-result cached index is reranked in complete bounded batches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-index-'));
    try {
        const api = apiFixture();
        const peers = Array.from({ length: 40 }, (_, i) => ({ bvid: `BV${String(i).padStart(10, '0')}`, aid: String(i + 1),
            ownerId: '3', title: `事件${i}`, description: '', publishedAt: 1, duration: 0, cues: [], complete: false }));
        (api.search as jest.Mock).mockResolvedValue(peers);
        (api.read as jest.Mock).mockImplementation(async peer => peer);
        const request = jest.fn(async (_phase, prompt) => {
            const rows = JSON.parse(prompt.split('\n').find(line => line.startsWith('RESULTS '))!.slice(8));
            expect(rows.length).toBeLessThanOrEqual(20);
            return JSON.stringify({ items: rows.map(row => ({ bvid: row.bvid, relevant: row.title === '事件39',
                score: row.title === '事件39' ? 95 : 5, reason: '具体事件比较' })) });
        });
        const [result] = await runPeerCuration({ candidates: [{ id: '1', title: '事件39', roomId: '2', host: '栞栞', source: 'source.mp4',
            start: 0, end: 5, cues: [{ id: 'S1', start: 0, end: 4, text: '完整源字幕' }] }], settings: {}, cookie: '',
            support: false, skipEditorialAssessment: true, rerankPeers: true, searchQueries: () => ['栞栞'],
            evidencePath: path.join(root, 'evidence.json'), statePath: path.join(root, 'support.json') }, request, api);
        expect(result.status).toBe('needs_review');
        expect(result.matches).toContainEqual(expect.objectContaining({ title: '事件39', status: 'subtitle_unavailable' }));
        expect(request).toHaveBeenCalledTimes(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('own facade preserves all candidates, prioritizes model scores, and creates immutable reports on repeat', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-runtime-'));
    try {
        const sourceSrt = path.join(root, 'source.srt'); await fs.writeFile(sourceSrt, 'source evidence');
        const clips = [89, 95, 94].map((score, index) => ({ title: `事件${index}`, start: index * 10, end: index * 10 + 8,
            score, selectionSource: 'model_global_rerank' }));
        const api = apiFixture(), request = jest.fn(async phase => phase.startsWith('rerank-')
            ? JSON.stringify({ items: [] })
            : JSON.stringify({ worthPublishing: true, score: 95, reason: '完整独立事件', queries: ['岁己 具体事件'] }));
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
            ? { worthPublishing: true, score: 95, reason: '完整事件', queries: ['具体事件'] }
            : phase.startsWith('rerank-') ? { items: [] } : {}));
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
            ? { worthPublishing: true, score: 95, reason: '完整问答', queries: ['小栞 小岁 机箱'] }
            : phase.startsWith('rerank-') ? { items: [{ bvid: peer.bvid, relevant: true, score: 95, reason: '标题与源字幕均指向同一机箱问答' }] }
            : comparison));
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
