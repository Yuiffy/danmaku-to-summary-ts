import { createHash } from 'crypto';
import { reviewOwnRequiredQa, RequiredQaIO } from './ownRequiredReview';
import type { Artifact } from './enhancement';
import type { PublicationSnapshot } from './publicationReview';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const config = { mode: 'auto' as const, roomIds: ['25788785'], authorizationNote: '允许复核后投稿', activatedAt: '2026-10-03T00:00:00Z' };
const checks = { meaning: true, attribution: true, title: true, cover: true, subtitles: true, completeStory: true };
function fixture() {
    const artifact: Artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-04T00:00:00Z', qaRequired: true,
        attributionRequired: true, attributionReview: { status: 'passed' }, uploadReady: true,
        copy: { title: '问哪站下车，只为等座位', description: '回忆地铁找座位', coverText: '你哪站下？\n我想坐下' },
        window: { start: 20, end: 70, duration: 50 },
        output: { metadataPath: '/clip.json', mediaPath: '/clip.mp4', srtPath: '/clip.srt', coverPath: '/cover.jpg', burnedSubtitles: true } };
    const snapshot: PublicationSnapshot = { source: { mediaPath: '/source.flv', mediaBytes: '50', mediaMtimeNs: '1000',
        srtPath: '/source.srt', srtSha256: digest('source'), xmlPath: null, xmlSha256: null },
        digests: { video: digest('video'), subtitles: digest('subs'), cover: digest('cover'), copy: digest('copy'), timingAudio: digest('audio') } };
    const io: RequiredQaIO = { snapshot: jest.fn(async () => snapshot),
        inspect: jest.fn(async () => ({ passed: true, issues: [], frames: ['cover', 'video'], facts: { fullDecode: true } })),
        request: jest.fn(async () => ({ text: JSON.stringify({ approved: true, checks, issues: [] }), meta: { responseId: 'qa-current' } })) };
    const evidence = { speech: [{ start: 20, end: 30, text: '请问你在哪站下车' }],
        retained: [{ start: 0, end: 10, text: '请问你在哪站下车' }], excludedCategories: ['主播现实家庭关系'] };
    return { artifact, snapshot, io, evidence };
}

test('a missing inherited quality gate is explicitly rerun against the current media and retains required flags', async () => {
    const f = fixture(), before = JSON.stringify(f.artifact);
    const result = await reviewOwnRequiredQa(f.artifact, config, f.evidence, f.io);
    expect(result).toMatchObject({ qaRequired: true, attributionRequired: true,
        automaticQaRepair: { authority: 'automatic' }, qaResult: { status: 'passed', checks, reviewer: { responseId: 'qa-current' } } });
    expect(Object.keys(result.qaResult.digests).sort()).toEqual(['copy', 'cover', 'subtitles', 'video']);
    expect(result.qaResult.source).toEqual(f.snapshot.source);
    expect(result.publicationDecision).toBeUndefined();
    expect(result.ownStreamHumanReview).toBeUndefined();
    expect(JSON.stringify(f.artifact)).toBe(before);
    expect(f.io.request).toHaveBeenCalledTimes(1);
    const prompt = (f.io.request as jest.Mock).mock.calls[0][0];
    expect(prompt).toContain('不要求逐字零错');
    expect(prompt).toContain('不能把每一句话都视为核心事实');
    expect(prompt).toContain('请问你在哪站下车');
    await expect(reviewOwnRequiredQa(result, config, f.evidence, f.io)).resolves.toBe(result);
    expect(f.io.inspect).toHaveBeenCalledTimes(1);
});

test.each(['technical', 'meaning', 'missing-check', 'provider'])('a %s failure keeps the gate and is not retried for identical artifacts', async kind => {
    const f = fixture();
    if (kind === 'technical') f.io.inspect = jest.fn(async () => ({ passed: false, issues: ['音轨缺失'], frames: [] }));
    if (kind === 'meaning') f.io.request = jest.fn(async () => ({ text: JSON.stringify({ approved: true,
        checks: { ...checks, meaning: false }, issues: ['关键否定没有保留'] }) }));
    if (kind === 'missing-check') f.io.request = jest.fn(async () => ({ text: JSON.stringify({ approved: true, checks: {}, issues: [] }) }));
    if (kind === 'provider') f.io.request = jest.fn(async () => { throw new Error('provider unavailable'); });
    const result = await reviewOwnRequiredQa(f.artifact, config, f.evidence, f.io);
    expect(result.qaResult.status).toBe('failed');
    expect(result.qaRequired).toBe(true);
    expect(result.qaResult.issues.length).toBeGreaterThan(0);
    await expect(reviewOwnRequiredQa(result, config, f.evidence, f.io)).resolves.toBe(result);
    expect(f.io.inspect).toHaveBeenCalledTimes(1);
});

test.each(['source', 'video', 'cover', 'copy'])('changing %s during quality review cannot save approval', async kind => {
    const f = fixture();
    f.io.request = jest.fn(async () => {
        if (kind === 'source') f.snapshot.source.srtSha256 = digest('changed');
        else f.snapshot.digests[kind] = digest('changed');
        return { text: JSON.stringify({ approved: true, checks, issues: [] }) };
    });
    // A real snapshot is a fresh value, even if a test adapter internally reuses storage.
    const snapshot = f.io.snapshot;
    f.io.snapshot = async row => JSON.parse(JSON.stringify(await snapshot(row)));
    await expect(reviewOwnRequiredQa(f.artifact, config, f.evidence, f.io)).rejects.toThrow('evidence changed');
});

test.each(['historical', 'disabled', 'human', 'boundary', 'subtitle', 'attribution'])('%s is not repaired by an ordinary quality recheck', async kind => {
    const f = fixture();
    if (kind === 'historical') f.artifact.generatedAt = '2026-10-01T00:00:00Z';
    if (kind === 'human') f.artifact.ownStreamHumanReview = { status: 'approved' };
    if (kind === 'boundary') f.artifact.sourceExpansionRequest = { minimumEnd: 80 };
    if (kind === 'subtitle') f.artifact.subtitleProofreading = { reviewGroups: [{ type: 'possible_foreign_audio' }] };
    if (kind === 'attribution') delete f.artifact.attributionReview;
    await expect(reviewOwnRequiredQa(f.artifact, kind === 'disabled' ? { ...config, mode: 'off' } : config, f.evidence, f.io)).resolves.toBe(f.artifact);
    expect(f.io.request).not.toHaveBeenCalled();
});
