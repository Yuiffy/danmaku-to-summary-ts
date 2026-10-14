export {};
const { reviewFinals, inspectFinals } = require('./own_automatic_publication');

test('mandatory keyword actor review binds the same speaker-aware source hash and cue IDs as topic final review', async () => {
    const topic = require('../topic_clipper');
    const segments = [
        { start: 1, end: 2, text: '这嘴巴很萌', speaker: 'unknown', asrEvidence: { rawText: '这嘴巴很萌' } },
        { start: 2, end: 3, text: '好可爱呀', speaker: 'unknown', asrEvidence: { rawText: '好可爱呀' } }
    ];
    const canonical = require('./preflight_evidence').buildPreflightEvidence(segments);
    const parse = jest.spyOn(topic, 'parseTopicSrt').mockReturnValue({ segments });
    const roster = jest.spyOn(require('./participant_context'), 'loadRecordingParticipants').mockReturnValue({});
    const actor = jest.spyOn(require('./actor_review_runner'), 'reviewClipActors').mockImplementation(async (clips, _parsed, _audience, evidence) => {
        expect(evidence.sourceSha256).toBe(canonical.sourceSha256);
        expect(evidence.cues.map(cue => cue.id)).toEqual(['G1', 'G2']);
        return clips.map(clip => ({ ...clip, attributionRequired: false }));
    });
    const value = { publicationKind: 'keyword_topic', source: { srtPath: '/source.speaker.srt', mediaPath: '/source.flv' },
        copy: { title: '好可爱', description: '好可爱', coverText: '好可爱' }, window: { start: 1, end: 3 }, roomId: 'other' };
    try {
        const reviewed = await require('./own_automatic_publication').reviewArtifactCopy(value, [], {
            evidence: () => { throw new Error('Grouped own-stream evidence must not be used'); },
            rootConfig: {}, config: {}, info: { roomId: 'other' },
            copyHelpers: { buildClipDescription: row => `Recording 2026-10-10\n${row.description}` }
        });
        expect(reviewed.copy.description).toBe('好可爱');
        expect(parse).toHaveBeenCalledWith('/source.speaker.srt'); expect(actor).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); roster.mockRestore(); actor.mockRestore(); }
});

test('operator copy intent reaches the independent actor review and preserves generated header handling', async () => {
    const topic = require('../topic_clipper');
    const parse = jest.spyOn(topic, 'parseTopicSrt').mockReturnValue({ segments: [{ start: 1, end: 2, text: '视频很可爱' }] });
    const roster = jest.spyOn(require('./participant_context'), 'loadRecordingParticipants').mockReturnValue({});
    const actor = jest.spyOn(require('./actor_review_runner'), 'reviewClipActors').mockImplementation(async clips => {
        expect(clips[0].publicationRepairFeedback.operatorIntent).toMatchObject({ note: '标题大意改为看塔宝说你很可爱', requestedCopy: { title: '看塔宝说你很可爱' } });
        expect(clips[0].publicationRepairFeedback.instruction).toContain('不能重新换题');
        return clips.map(clip => ({ ...clip, attributionRequired: false }));
    });
    const value = { publicationKind: 'keyword_topic', source: { srtPath: '/source.srt', mediaPath: '/source.flv' },
        copy: { title: '看塔宝说你很可爱', description: '看视频的评论', coverText: '你很可爱' }, window: { start: 1, end: 2 },
        renderedSubtitles: { review: { note: '标题大意改为看塔宝说你很可爱', sourceKind: 'playback', copy: { title: '看塔宝说你很可爱' } } } };
    try {
        const result = await require('./own_automatic_publication').reviewArtifactCopy(value, ['旧问题'], {
            rootConfig: {}, config: {}, info: {}, copyHelpers: { buildClipDescription: row => row.description } });
        expect(result.copy.title).toBe(value.copy.title);
    } finally { parse.mockRestore(); roster.mockRestore(); actor.mockRestore(); }
});

function context(runtime) {
    return { runtime, automatic: {}, config: { selectionPolicy: { excludedCategories: [] }, enhancements: {} },
        rootConfig: {}, info: { roomId: '25788785' }, streamerName: '岁己SUI', options: {}, mediaConfig: {},
        evidence: jest.fn(), audience: jest.fn() };
}

test('the real resource scheduler preserves completed final-review results for subsequent registration', async () => {
    const results = [{ publicationReview: { status: 'passed' } }];
    const runtime = { reviewOwnPublications: jest.fn(async () => results) };
    await expect(reviewFinals(results, context(runtime))).resolves.toBe(results);
    expect(runtime.reviewOwnPublications).toHaveBeenCalledTimes(1);
});

test('a final-review failure preserves its original error instead of a scheduler cleanup error', async () => {
    const failure = new Error('current source evidence changed');
    const runtime = { reviewOwnPublications: jest.fn(async () => { throw failure; }) };
    await expect(reviewFinals([], context(runtime))).rejects.toBe(failure);
});

test('missing required quality review and final review reuse one current-media inspection', async () => {
    const snapshot = { source: { mediaPath: '/source.flv', srtPath: '/source.srt', srtSha256: 'a'.repeat(64) },
        digests: { video: 'a'.repeat(64), subtitles: 'b'.repeat(64), cover: 'c'.repeat(64), copy: 'd'.repeat(64) } };
    const inspection = { passed: true, issues: [], frames: ['cover', 'frame'], facts: { fullDecode: true } };
    const artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-04T00:00:00Z',
        qaRequired: true, attributionRequired: true, attributionReview: { status: 'passed' }, uploadReady: true,
        window: { index: 7, start: 0, end: 30, duration: 30 }, source: { mediaPath: '/source.flv', srtPath: '/source.srt' },
        copy: { title: '找座位', description: '找座位', coverText: '找座位' },
        output: { mediaPath: '/clip.mp4', srtPath: '/clip.srt', coverPath: '/cover.jpg', metadataPath: '/clip.json', burnedSubtitles: true } };
    const runtime = { publicationSnapshot: jest.fn(async () => snapshot), inspectPublicationMedia: jest.fn(async () => inspection),
        reviewOwnPublications: jest.fn(async (rows, _context, adapters) => {
            expect(rows[0]).toMatchObject({ qaRequired: true, attributionRequired: true, qaResult: { status: 'passed' } });
            expect(await adapters.inspect(rows[0], [])).toBe(inspection);
            return rows;
        }) };
    const current = context(runtime);
    current.automatic = { mode: 'auto', roomIds: ['25788785'], authorizationNote: '自动复核后投稿', activatedAt: '2026-10-03T00:00:00Z' };
    const parse = jest.spyOn(require('../topic_clipper'), 'parseTopicSrt').mockReturnValue({ segments: [{ start: 0, end: 10, text: '我想坐下' }] });
    const request = jest.spyOn(require('./enhancement_runner'), 'requestStage').mockResolvedValue({ text: JSON.stringify({ approved: true,
        checks: { meaning: true, attribution: true, title: true, cover: true, subtitles: true, completeStory: true }, issues: [] }) });
    try {
        const results = await inspectFinals([artifact], current);
        expect(results[0].qaResult.status).toBe('passed');
        expect(runtime.inspectPublicationMedia).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); request.mockRestore(); }
});

test('cover repair samples the original source window and moves obstructing text below the face', async () => {
    const topic = require('../topic_clipper');
    const cover = jest.spyOn(topic, 'generateClipCover').mockResolvedValue('/new-cover.jpg');
    const artifact = { source: { mediaPath: '/source.flv' }, output: { mediaPath: '/burned.mp4', metadataPath: '/clip.json' },
        window: { start: 100, duration: 30 }, copy: { title: '医生休假', coverText: '医生休假\n我很无语' },
        publicationReview: { issues: ['封面大字遮住主体面部'] }, streamerName: '小岁' };
    try {
        await require('./own_automatic_publication').renderCopyCover(artifact,
            { copyHelpers: { buildCoverTitle: (_title: string, text: string) => text } }, { textPosition: 'bottom' });
        expect(cover).toHaveBeenCalledWith('/burned.mp4', artifact.copy.coverText, expect.any(String),
            expect.objectContaining({ coverSourcePath: '/source.flv', clipStart: 100, clipDuration: 30,
                preferredTime: 110.5, textPosition: 'bottom' }));
    } finally { cover.mockRestore(); }
});

test('ordinary final boundary failure reaches the tool agent and then reviews only its fresh revision', async () => {
    const source = { mediaPath: '/source.flv', srtPath: '/source.srt' };
    const artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-07T00:00:00Z',
        uploadReady: true, attributionRequired: true, source, window: { index: 6, start: 10, end: 20, duration: 10 },
        copy: { title: '聊剧', coverText: '聊剧', description: '聊剧' },
        output: { metadataPath: '/clip.json', mediaPath: '/old.mp4', srtPath: '/old.srt', coverPath: '/old.jpg', burnedSubtitles: true } };
    const snapshot = async row => ({ source, digests: { video: row.output.mediaPath, subtitles: row.output.srtPath } });
    const review = { status: 'needs_review', ...(await snapshot(artifact)), technical: { passed: true },
        checks: { content: false, attribution: true, subtitles: true, visuals: true, policy: true },
        issues: ['片尾问题未回答', 'final_content_not_passed'] };
    const runtime = { publicationSnapshot: snapshot, reviewOwnPublications: jest.fn()
        .mockImplementationOnce(async rows => rows.map(row => ({ ...row, publicationReview: review })))
        .mockImplementationOnce(async rows => rows.map(row => ({ ...row, publicationReview: { status: 'passed' } }))) };
    const current: any = { ...context(runtime), persist: false,
        automatic: { mode: 'auto', roomIds: ['25788785'], authorizationNote: '自动复核', activatedAt: '2026-10-01T00:00:00Z' },
        boundaryCues: [{ id: 'G1', start: 10, end: 20, text: '冰火是什么' }, { id: 'G2', start: 21, end: 30, text: '权游，我喜欢的呀' }],
        boundaryTools: { replan: jest.fn(async window => [{ ...window, boundaryReview: { approved: true }, topicEditPlan: {} }]),
            render: jest.fn(async clip => ({ ...artifact, window: { index: 6, start: clip.start, end: clip.end, duration: clip.end - clip.start },
                output: { metadataPath: '/revision.json', mediaPath: '/new.mp4', srtPath: '/new.srt', coverPath: '/new.jpg', burnedSubtitles: true } })) } };
    const request = jest.spyOn(require('./selection_request'), 'requestSelectionText').mockResolvedValue({ text: JSON.stringify({
        actions: [{ tool: 'recut', startCueId: 'G1', endCueId: 'G2', reason: '完整问答' }] }) });
    try {
        const [result] = await reviewFinals([artifact], current);
        expect(result.automaticBoundaryRepair?.status).toBe('repaired');
        expect(result.output).toMatchObject({ mediaPath: '/new.mp4', metadataPath: '/clip.json' });
        expect(runtime.reviewOwnPublications).toHaveBeenCalledTimes(2);
        expect(current.boundaryTools.render).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0][1]).toMatchObject({ structuredOutputKey: 'actions' });
    } finally { request.mockRestore(); }
});
