export {};
const { reviewFinals, inspectFinals } = require('./own_automatic_publication');

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
            expect.objectContaining({ coverSourcePath: '/source.flv', clipStart: 100, clipDuration: 30, textPosition: 'bottom' }));
    } finally { cover.mockRestore(); }
});
