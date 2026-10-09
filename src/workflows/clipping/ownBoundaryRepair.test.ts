import { repairOwnBoundary, boundaryRepairEligible, BoundaryRepairIO } from './ownBoundaryRepair';
import type { Artifact } from './enhancement';

const config = { mode: 'auto' as const, roomIds: ['25788785'], activatedAt: '2026-10-01T00:00:00Z', authorizationNote: '自动审核' };
const cues = [
    { id: 'G1', start: 100, end: 110, text: '我对政治权谋没有兴趣' },
    { id: 'G2', start: 110, end: 120, text: '听不懂梗很正常啊，冰火是啥' },
    { id: 'G3', start: 121, end: 131, text: '冰火就是权游吧，权游我很喜欢' },
    { id: 'G4', start: 135, end: 145, text: '喝完了，喝水吧' },
    { id: 'G5', start: 220, end: 230, text: '更后面的独立话题' }
];
function fixture() {
    const source = { mediaPath: '/source.flv', srtPath: '/source.srt' };
    const snapshot = async (row: Artifact): Promise<any> => ({ source, digests: { video: row.output.mediaPath, subtitles: row.output.srtPath } });
    const artifact: Artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-07T00:00:00Z',
        source, window: { start: 100, end: 120, duration: 20 }, uploadReady: true,
        copy: { title: '聊剧', coverText: '聊剧', description: '说自己对剧的喜好' }, attributionRequired: true,
        output: { mediaPath: '/old.mp4', srtPath: '/old.srt', coverPath: '/old.jpg', metadataPath: '/stable.json', burnedSubtitles: true },
        publicationReview: { status: 'needs_review', source, digests: { video: '/old.mp4', subtitles: '/old.srt' },
            checks: { content: false, attribution: true, subtitles: true, visuals: true, policy: true },
            technical: { passed: true }, issues: ['片尾停在“冰火是啥”，紧接回答没有保留', 'final_content_not_passed'] } };
    const io: BoundaryRepairIO = {
        snapshot: jest.fn(snapshot), request: jest.fn(async () => JSON.stringify({ actions: [{ tool: 'recut', startCueId: 'G1', endCueId: 'G3', reason: '保留完整问答' }] })),
        replan: jest.fn(async window => [{ ...window, boundaryReview: { approved: true }, topicEditPlan: { continuation: 'next_topic' } }]),
        render: jest.fn(async (clip, original) => ({ ...original, publicationReview: undefined,
            window: { ...clip, duration: clip.end - clip.start }, qaRequired: clip.qaRequired,
            output: { mediaPath: '/new.mp4', srtPath: '/new.srt', coverPath: '/new.jpg', metadataPath: '/revision.json', burnedSubtitles: true } })),
        reviewFinal: jest.fn(async row => ({ ...row, publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } })),
        persist: jest.fn()
    };
    return { artifact, io };
}

test('3175-shaped ending invokes recut and independently reviews the new media under the stable identity', async () => {
    const { artifact, io } = fixture();
    const original = JSON.stringify(artifact);
    const result = await repairOwnBoundary(artifact, config, cues, [], io);
    expect(result.window.end).toBe(131);
    expect(result.output).toMatchObject({ mediaPath: '/new.mp4', srtPath: '/new.srt', metadataPath: '/stable.json' });
    expect(result.automaticBoundaryRepair).toMatchObject({ authority: 'automatic', status: 'repaired', before: { output: artifact.output } });
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
    expect(result.generatedAt).toBe(artifact.generatedAt);
    expect(JSON.stringify(artifact)).toBe(original);
    expect((io.persist as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((io.request as jest.Mock).mock.invocationCallOrder[0]);
    expect(await repairOwnBoundary(result, config, cues, [], io)).toBe(result);
    expect(io.request).toHaveBeenCalledTimes(1);
});

test('the model can fetch later source text before selecting a new window', async () => {
    const { artifact, io } = fixture();
    const request = io.request;
    io.request = jest.fn().mockResolvedValueOnce(JSON.stringify({ actions: [{ tool: 'read_context', beforeSeconds: 30, afterSeconds: 180, reason: '需要后续原话' }] }))
        .mockImplementationOnce(async prompt => { expect(prompt).toContain('更后面的独立话题'); return request(prompt); });
    const result = await repairOwnBoundary(artifact, config, cues, [], io);
    expect(result.automaticBoundaryRepair.tools[0]).toMatchObject({ tool: 'read_context', status: 'completed', cueIds: ['G1','G2','G3','G4','G5'] });
    expect(io.render).toHaveBeenCalledTimes(1);
});

test.each(['unknown', 'exhausted', 'overlap', 'unchanged', 'unapproved', 'media_reuse', 'stale', 'changed_source', 'hold'])('holds safely on %s without publication', async kind => {
    const { artifact, io } = fixture();
    let peers: Artifact[] = [];
    if (kind === 'unknown') io.request = jest.fn(async () => '{"actions":[{"tool":"shell","reason":"test"}]}');
    if (kind === 'exhausted') io.request = jest.fn(async () => '{"actions":[{"tool":"read_context","beforeSeconds":30,"afterSeconds":60,"reason":"test"}]}');
    if (kind === 'hold') io.request = jest.fn(async () => '{"actions":[{"tool":"hold","reason":"需要复听"}]}');
    if (kind === 'overlap') peers = [{ ...artifact, window: { start: 130, end: 145, duration: 15 } }];
    if (kind === 'unchanged') io.replan = jest.fn(async () => [{ start: 100, end: 120, boundaryReview: { approved: true }, topicEditPlan: {} }]);
    if (kind === 'unapproved') io.replan = jest.fn(async () => []);
    if (kind === 'media_reuse') io.render = jest.fn(async () => artifact);
    if (kind === 'stale') artifact.publicationReview.digests.video = 'changed';
    if (kind === 'changed_source') {
        const snapshot = io.snapshot; let calls = 0;
        io.snapshot = async row => { const value = await snapshot(row); return ++calls > 1 ? { ...value, source: { changed: true } } : value; };
    }
    const result = await repairOwnBoundary(artifact, config, cues, peers, io);
    expect(result.automaticBoundaryRepair.status).toBe('needs_review');
    expect(result.publicationDecision?.action).not.toBe('auto_queue');
    expect(result.output).toEqual(artifact.output);
    expect(io.reviewFinal).not.toHaveBeenCalled();
    expect(await repairOwnBoundary(result, config, cues, peers, io)).toBe(result);
});

test('a failed final review preserves the newly rendered revision as pending, without another render loop', async () => {
    const { artifact, io } = fixture(); artifact.qaRequired = true;
    io.reviewFinal = jest.fn(async row => ({ ...row, publicationReview: { status: 'needs_review' }, publicationDecision: { action: 'needs_human' } }));
    const result = await repairOwnBoundary(artifact, config, cues, [], io);
    expect(result.qaRequired).toBe(true);
    expect(result.output.mediaPath).toBe('/new.mp4');
    expect(result.automaticBoundaryRepair.status).toBe('needs_review');
    expect(await repairOwnBoundary(result, config, cues, [], io)).toBe(result);
    expect(io.render).toHaveBeenCalledTimes(1);
});

test('only new ordinary boundary-only failures enter; historical IDs and confirmed word edits are preserved', () => {
    const { artifact } = fixture();
    for (const changes of [{ uploadId: 3175 }, { timingRevision: {} }, { renderedTimingRepair: {} }, { automaticBoundaryRepair: { status: 'running' } }, { editPlan: {} },
        { generatedAt: '2020-01-01' }, { renderedSubtitles: { edits: [{}] } }, { humanReview: {} },
        { publicationReview: { ...artifact.publicationReview, issues: ['文案不实'], checks: { ...artifact.publicationReview.checks, subtitles: false } } }]) {
        expect(boundaryRepairEligible({ ...artifact, ...changes }, config)).toBe(false);
    }
});
