import { confirmedCoverage, CoverageCandidate, CoverageIO, curateCandidates, PeerVideo } from './peerCoverage';

const candidate: CoverageCandidate = { id: '1', roomId: '25788785', host: '岁己', source: 'source.mp4', start: 10, end: 50,
    title: '晕车的故事', cues: [
        { id: 'S1', start: 10, end: 20, text: '小时候我坐车总是晕车' },
        { id: 'S2', start: 20, end: 30, text: '后来发现看窗外就会好一点' },
        { id: 'S3', start: 30, end: 45, text: '最后一路看窗外终于没吐' } ] };
const peer: PeerVideo = { bvid: 'BV1234567890', aid: '123', ownerId: '456', title: '不同的标题', description: '',
    duration: 40, publishedAt: 1, complete: true, cues: candidate.cues.map((row, index) => ({ ...row, id: `P${index + 1}`, start: index * 10, end: index * 10 + 9 })) };
const comparison = { sameEvent: true, complete: true, quality: true, reason: '相同经历的起因和解决过程已完整覆盖',
    anchors: [{ sourceId: 'S1', peerId: 'P1', quote: '小时候我坐车总是晕车' },
        { sourceId: 'S2', peerId: 'P2', quote: '后来发现看窗外就会好一点' }],
    beats: { setup: { sourceId: 'S1', peerId: 'P1' }, development: { sourceId: 'S2', peerId: 'P2' }, payoff: { sourceId: 'S3', peerId: 'P3' } } };
const assessment = { worthPublishing: true, score: 95, reason: '有完整经历与解决办法', queries: ['岁己 晕车 看窗外'] };
function adapters(): CoverageIO & { [key: string]: any } {
    return { accountId: '999', search: jest.fn(async () => [peer]), read: jest.fn(async p => p),
        request: jest.fn(async phase => JSON.stringify(phase.startsWith('assess') ? assessment : comparison)),
        support: jest.fn(async () => ({ status: 'confirmed' })), save: jest.fn(async () => undefined) };
}
test('coverage requires independent exact anchors and complete story beats, never matching titles', () => {
    expect(confirmedCoverage(candidate, peer, comparison, '999')).toBe(true);
    expect(confirmedCoverage(candidate, peer, comparison, '456')).toBe(false);
    for (const change of [{ beats: {} }, { anchors: [{ ...comparison.anchors[0], quote: '虚构并不存在的原话' }, comparison.anchors[1]] },
        { complete: false }, { anchors: [comparison.anchors[0], comparison.anchors[0]] },
        { beats: { ...comparison.beats, payoff: { sourceId: 'S3', peerId: 'P404' } } }]) {
        expect(confirmedCoverage(candidate, peer, { ...comparison, ...change }, '999')).toBe(false);
    }
});
test('confirmed other-author coverage is saved before support and frees a place for an original candidate', async () => {
    const io = adapters(), saved: any[] = [];
    io.save.mockImplementation(async rows => { saved.push(JSON.parse(JSON.stringify(rows))); });
    io.search.mockImplementation(async query => query.includes('另一个') ? [] : [peer]);
    io.request.mockImplementation(async (phase, prompt) => phase.startsWith('assess')
        ? JSON.stringify({ ...assessment, queries: [prompt.includes('"id":"2"') ? '岁己 另一个完整故事' : assessment.queries[0]] })
        : JSON.stringify(comparison));
    io.support.mockImplementation(async () => { expect(saved.at(-1)[0].status).toBe('covered'); return { status: 'confirmed' }; });
    const results = await curateCandidates([candidate, { ...candidate, id: '2', title: '另一个完整故事', cues: candidate.cues.map(cue => ({ ...cue, text: `另一个${cue.text}` })) }, { ...candidate, id: '3', title: '第三个完整故事', cues: candidate.cues.map(cue => ({ ...cue, text: `第三个${cue.text}` })) }], { maxStandalone: 1 }, io);
    expect(results.map(row => row.status)).toEqual(['covered', 'original', 'budget']);
    expect(io.support).toHaveBeenCalledTimes(1);
});

test('deterministic title and source-cue searches retain an unverified Bilibili hit for Web review', async () => {
    const io = adapters();
    io.request.mockImplementation(async phase => JSON.stringify(phase.startsWith('assess')
        ? { ...assessment, queries: ['完全无关的模型词'] }
        : comparison));
    io.search.mockImplementation(async query => query.includes(candidate.title) || query.includes('小时候我坐车总是晕车')
        ? [{ ...peer, title: '抢着发链接，最后才发现要中文版' }] : []);
    io.read.mockResolvedValue({ ...peer, complete: false, cues: [] });
    const [result] = await curateCandidates([candidate], {}, io);
    expect(result.status).toBe('needs_review');
    expect(result.matches).toEqual([expect.objectContaining({ bvid: peer.bvid, status: 'subtitle_unavailable',
        url: `https://www.bilibili.com/video/${peer.bvid}/` })]);
    expect(result.searches?.some(search => search.query.includes(candidate.title))).toBe(true);
    expect(io.support).not.toHaveBeenCalled();
});

test('a later platform failure preserves earlier search evidence for review', async () => {
    const io = adapters(); let calls = 0;
    io.search.mockImplementation(async () => { calls += 1; if (calls === 1) return [{ ...peer, complete: false, cues: [] }]; throw new Error('blocked'); });
    const [result] = await curateCandidates([candidate], {}, io);
    expect(result.status).toBe('needs_review');
    expect(result.matches?.[0]).toMatchObject({ bvid: peer.bvid, status: 'subtitle_unavailable' });
    expect(result.searches?.length).toBe(1);
});
test('different event with identical title is eligible; our own search hit never triggers interaction', async () => {
    const io = adapters();
    io.search.mockResolvedValue([{ ...peer, ownerId: '999' }, { ...peer, title: candidate.title }]);
    io.request.mockImplementation(async phase => JSON.stringify(phase.startsWith('assess') ? assessment
        : { sameEvent: false, complete: false, quality: true, reason: '同名主题但实际事件不同' }));
    expect((await curateCandidates([candidate], {}, io))[0].status).toBe('original');
    expect(io.read).toHaveBeenCalledTimes(1); expect(io.support).not.toHaveBeenCalled();
});
test('missing subtitles and unsupported positive matches remain unknown, not covered or clear', async () => {
    const io = adapters(); io.read.mockResolvedValue({ ...peer, cues: [], complete: false });
    expect((await curateCandidates([candidate], {}, io))[0].status).toBe('needs_review');
    io.read.mockResolvedValue(peer); io.request.mockImplementation(async phase => JSON.stringify(phase.startsWith('assess') ? assessment : { ...comparison, beats: {} }));
    expect((await curateCandidates([candidate], {}, io))[0].status).toBe('needs_review');
    expect(io.support).not.toHaveBeenCalled();
});
test('a platform failure stops the batch and never becomes no matching clips', async () => {
    const io = adapters(); io.search.mockRejectedValue(new Error('blocked'));
    const results = await curateCandidates([candidate, { ...candidate, id: '2' }], {}, io);
    expect(results.every(row => row.status === 'needs_review')).toBe(true);
    expect(io.search).toHaveBeenCalledTimes(1); expect(io.support).not.toHaveBeenCalled();
});
test('zero worthwhile candidates is valid and performs no platform reads or writes', async () => {
    const io = adapters(); io.request.mockResolvedValue(JSON.stringify({ ...assessment, worthPublishing: false, score: 89 }));
    expect((await curateCandidates([candidate], {}, io))[0].status).toBe('rejected');
    expect(io.search).not.toHaveBeenCalled(); expect(io.support).not.toHaveBeenCalled();
});
test('manual coverage can skip editorial rejection and still use deterministic source searches', async () => {
    const io = adapters();
    io.request.mockImplementation(async phase => phase.startsWith('compare') ? JSON.stringify(comparison) : JSON.stringify({
        worthPublishing: false, score: 8, reason: '普通自动筛选会跳过', queries: []
    }));
    const [result] = await curateCandidates([candidate], {}, io, { skipEditorialAssessment: true });
    expect(result.status).toBe('covered');
    expect(io.request.mock.calls.some(([phase]) => String(phase).startsWith('assess'))).toBe(false);
    expect(io.search).toHaveBeenCalled();
});
test('a failed like/favorite never converts confirmed coverage back into a duplicate upload', async () => {
    const io = adapters(); io.support.mockRejectedValue(new Error('timeout'));
    expect((await curateCandidates([candidate], {}, io))[0]).toMatchObject({ status: 'covered', support: { status: 'unavailable' } });
});
