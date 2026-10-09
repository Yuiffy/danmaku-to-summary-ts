import { createHash } from 'crypto';
import type { Artifact } from './enhancement';
import type { PublicationSnapshot } from './publicationReview';
import { repairTopicPublicCopy, topicCopyRepairEligible, topicCopyRepairInstructions, TopicCopyRepairIO } from './topicPublicationRepair';

const config = { mode: 'auto' as const, policyVersion: 'topic-v1', scope: 'configured_keywords' as const,
    enabled: true, keywords: ['岁己'], ignoredRoomIds: ['25788785'], activatedAt: '2026-10-04T00:00:00Z', authorizationNote: '授权关键词自动投稿' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
    const artifact: Artifact = { mode: 'local_review', publicationKind: 'keyword_topic', status: 'success', roomId: '1791260716',
        generatedAt: '2026-10-06T04:30:55Z', window: { start: 1557.9, end: 1610.35, duration: 52.45 },
        source: { mediaPath: '/source.flv', srtPath: '/source.srt' }, uploadReady: true,
        aiReview: { status: 'ready', applied: true, sourceSha256: digest('speech') },
        copy: { title: '小绒念叨想小岁', description: '犬绒说想小岁', coverText: '小绒\n想小岁' },
        editorial: { sourceKind: 'live_speech' },
        output: { mediaPath: '/clip.mp4', srtPath: '/clip.srt', metadataPath: '/clip.json', coverPath: '/old.jpg', burnedSubtitles: true },
        publicationReview: { policyVersion: 'topic-v1', status: 'needs_review', technical: { passed: true },
            checks: { content: true, attribution: false, subtitles: true, visuals: true, policy: true },
            issues: ['文案称“小绒念叨”，但相关原始行身份未确认。', 'final_attribution_not_passed'] },
        publicationDecision: { action: 'needs_human' } };
    const snapshot = (row: Artifact): PublicationSnapshot => ({ source: { mediaPath: '/source.flv', mediaBytes: '500',
        mediaMtimeNs: '1000', srtPath: '/source.srt', srtSha256: digest('source'), xmlPath: null, xmlSha256: null },
        digests: { video: digest('video'), subtitles: digest('subtitles'), copy: digest(JSON.stringify(row.copy)), cover: digest(row.output.coverPath!) } });
    Object.assign(artifact.publicationReview, snapshot(artifact));
    const io: TopicCopyRepairIO = { snapshot: jest.fn(async row => snapshot(row)),
        prepareCopy: jest.fn(async () => ({ copy: { title: '想小岁了，接着说好喜欢他们', description: '聊到想念，随后说好喜欢他们', coverText: '想小岁了\n好喜欢他们' },
            grounding: { status: 'linked', issues: [], sourceKind: 'live_speech', sourceSha256: digest('speech'), subtitleIds: ['G260', 'G262'] } })),
        renderCover: jest.fn(async () => '/new.jpg'), reviewFinal: jest.fn(async row => ({ ...row,
            publicationReview: { status: 'passed', ...snapshot(row) }, publicationDecision: { action: 'auto_queue' } })) };
    return { artifact, io };
}

test('copy-only attribution hold receives one new cover and an independent final review, preserving media and authority', async () => {
    const { artifact, io } = fixture();
    const result = await repairTopicPublicCopy(artifact, config, io);
    expect(result.publicationDecision.action).toBe('auto_queue');
    expect(result.copy.title).toBe('想小岁了，接着说好喜欢他们');
    expect(result.window).toEqual(artifact.window); expect(result.aiReview).toEqual(artifact.aiReview);
    expect(result.source).toEqual(artifact.source); expect(result.output.mediaPath).toBe(artifact.output.mediaPath);
    expect(result.output.srtPath).toBe(artifact.output.srtPath); expect(result.output.coverPath).toBe('/new.jpg');
    expect(result.humanReview).toBeUndefined(); expect(result.ownStreamHumanReview).toBeUndefined();
    expect(io.reviewFinal).toHaveBeenCalledWith(expect.not.objectContaining({ publicationDecision: expect.anything() }));
    expect(artifact.copy.title).toBe('小绒念叨想小岁');
    await expect(repairTopicPublicCopy(result, config, io)).resolves.toBe(result);
    expect(io.prepareCopy).toHaveBeenCalledTimes(1);
});

test.each(['关键词身份未核实，文案不能确认目标。', '字幕中关键人名未确认。', '文案对应的片尾缺少收尾。', '发言者提到的目标身份不明，归属无法确认。'])('material evidence failure is never rewritten away: %s', async issue => {
    const { artifact, io } = fixture(); artifact.publicationReview.issues.push(issue);
    expect(topicCopyRepairEligible(artifact, config)).toBe(false);
    await expect(repairTopicPublicCopy(artifact, config, io)).resolves.toBe(artifact);
    expect(io.prepareCopy).not.toHaveBeenCalled();
});

test('speaker hold without a title/copy keyword can repair copy, but still needs a fresh final approval', async () => {
    const { artifact, io } = fixture();
    artifact.publicationReview.issues = ['两句说话人均未知，无法确认“小绒接话”；去掉归属或核实发言者。', 'final_attribution_not_passed'];
    expect(topicCopyRepairEligible(artifact, config)).toBe(true);
    const result = await repairTopicPublicCopy(artifact, config, io);
    expect(result.publicationDecision.action).toBe('auto_queue');
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
    expect(result.automaticTopicCopyRepair.before.publicationReview.issues).toEqual(artifact.publicationReview.issues);
    const prompt = topicCopyRepairInstructions(artifact, artifact.publicationReview.issues);
    expect(prompt).toContain('overrides generic named-host or first-person style preferences');
    expect(prompt).toContain('not the previous copy with new evidence IDs');
});

test('an unchanged proposal stays held with a specific diagnostic and no automatic retry or cover render', async () => {
    const { artifact, io } = fixture(), prepare = io.prepareCopy;
    io.prepareCopy = jest.fn(async (...args) => ({ ...await prepare(...args), copy: artifact.copy }));
    const result = await repairTopicPublicCopy(artifact, config, io);
    expect(result.automaticTopicCopyRepair.error).toBe('Topic copy repair returned unchanged public copy');
    expect(result.automaticTopicCopyRepair.proposal.copy).toEqual(artifact.copy);
    expect(result.publicationDecision.action).toBe('needs_human');
    expect(io.renderCover).not.toHaveBeenCalled(); expect(io.reviewFinal).not.toHaveBeenCalled();
    await expect(repairTopicPublicCopy(result, config, io)).resolves.toBe(result);
    expect(io.prepareCopy).toHaveBeenCalledTimes(1);
});

test.each(['off', 'old', 'ignored', 'manual', 'policy', 'subtitles', 'content', 'unavailable'])('%s stays outside automatic copy repair', async reason => {
    const { artifact, io } = fixture(); let policy = config;
    if (reason === 'off') policy = { ...config, mode: 'off' as any };
    if (reason === 'old') artifact.generatedAt = '2026-10-03T00:00:00Z';
    if (reason === 'ignored') artifact.roomId = '25788785';
    if (reason === 'manual') artifact.humanReview = { status: 'approved' };
    if (['policy', 'subtitles', 'content'].includes(reason)) artifact.publicationReview.checks[reason] = false;
    if (reason === 'unavailable') artifact.publicationReview.status = 'unavailable';
    await expect(repairTopicPublicCopy(artifact, policy, io)).resolves.toBe(artifact);
    expect(io.prepareCopy).not.toHaveBeenCalled();
});

test.each(['source', 'video', 'subtitles', 'stale', 'cover', 'provider', 'grounding'])('failed %s repair remains held without inheriting approval', async kind => {
    const { artifact, io } = fixture();
    if (['source', 'video', 'subtitles'].includes(kind)) {
        const snapshot = io.snapshot; let calls = 0;
        io.snapshot = async row => {
            const value = await snapshot(row);
            if (++calls > 1) {
                if (kind === 'source') value.source.srtSha256 = digest('changed');
                else value.digests[kind as 'video' | 'subtitles'] = digest('changed');
            }
            return value;
        };
    }
    if (kind === 'stale') artifact.publicationReview.digests.copy = digest('changed');
    if (kind === 'cover') io.renderCover = async () => artifact.output.coverPath!;
    if (kind === 'provider') io.prepareCopy = async () => { throw new Error('Provider unavailable'); };
    if (kind === 'grounding') { const prepare = io.prepareCopy; io.prepareCopy = async (...args) => ({ ...await prepare(...args), grounding: { issues: ['uncertain_source'] } }); }
    const result = await repairTopicPublicCopy(artifact, config, io);
    expect(result.copy).toEqual(artifact.copy); expect(result.output).toEqual(artifact.output);
    expect(result.publicationDecision.action).toBe('needs_human');
    expect(result.automaticTopicCopyRepair.error).toBeTruthy(); expect(io.reviewFinal).not.toHaveBeenCalled();
    await expect(repairTopicPublicCopy(result, config, io)).resolves.toBe(result);
});

test('failed independent final stays held and is not retried on the same revision', async () => {
    const { artifact, io } = fixture();
    io.reviewFinal = jest.fn(async row => ({ ...row, publicationReview: { status: 'needs_review' }, publicationDecision: { action: 'needs_human' } }));
    const result = await repairTopicPublicCopy(artifact, config, io);
    expect(result.publicationDecision.action).toBe('needs_human');
    await expect(repairTopicPublicCopy(result, config, io)).resolves.toBe(result);
    expect(io.prepareCopy).toHaveBeenCalledTimes(1); expect(io.reviewFinal).toHaveBeenCalledTimes(1);
});
