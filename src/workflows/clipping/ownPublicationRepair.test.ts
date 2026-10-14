import { createHash } from 'crypto';
import { repairOwnPublicCopy, copyRepairEligible, CopyRepairIO } from './ownPublicationRepair';
import type { Artifact } from './enhancement';
import type { PublicationSnapshot } from './publicationReview';

const config = { mode: 'auto' as const, roomIds: ['25788785'], activatedAt: '2026-10-03T00:00:00Z', authorizationNote: '授权自动投稿' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
    const artifact: Artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-04T00:00:00Z',
        source: { mediaPath: '/source.flv', srtPath: '/source.srt' }, window: { start: 10, end: 30, duration: 20 },
        copy: { title: '住几个月', coverText: '住几个月', description: '住几个月' }, uploadReady: true,
        output: { metadataPath: '/clip.json', mediaPath: '/clip.mp4', srtPath: '/clip.srt', coverPath: '/old.jpg', burnedSubtitles: true },
        publicationReview: { status: 'needs_review', checks: { content: false, attribution: true, subtitles: true, visuals: true, policy: true },
            technical: { passed: true }, issues: ['标题没有保留“可能住一个月”的条件语气', 'final_content_not_passed'] } };
    const snapshot = async (row: Artifact): Promise<PublicationSnapshot> => ({ source: { mediaPath: '/source.flv', mediaBytes: '500',
        mediaMtimeNs: '1000', srtPath: '/source.srt', srtSha256: digest('source'), xmlPath: null, xmlSha256: null },
        digests: { video: digest('video'), subtitles: digest('subtitles'), cover: digest(row.output.coverPath!), copy: digest(JSON.stringify(row.copy)) } });
    const io: CopyRepairIO = { snapshot: jest.fn(snapshot), reviewCopy: jest.fn(async row => ({ ...row,
        copy: { title: '可能住一个月', coverText: '可能住一个月', description: '设想住一个月' },
        attributionReview: { status: 'passed' }, publicCopyPending: false })),
        renderCover: jest.fn(async () => '/new.jpg'), reviewFinal: jest.fn(async row => ({ ...row,
            publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } })) };
    return { artifact, io };
}

test('copy-only repair inherits required review, regenerates a cover and waits for independent final approval', async () => {
    const { artifact, io } = fixture(), before = JSON.stringify(artifact);
    const result = await repairOwnPublicCopy(artifact, config, { attributionRequired: true }, io);
    expect(result.attributionRequired).toBe(true);
    expect(result.copy.title).toBe('可能住一个月');
    expect(result.output.mediaPath).toBe(artifact.output.mediaPath);
    expect(result.output.srtPath).toBe(artifact.output.srtPath);
    expect(result.automaticCopyRepair).toMatchObject({ authority: 'automatic', status: 'repaired', before: { copy: artifact.copy } });
    expect(io.reviewFinal).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ coverPath: '/new.jpg' }) }));
    expect(result.publicationDecision.action).toBe('auto_queue');
    expect(result.ownStreamHumanReview).toBeUndefined();
    expect(JSON.stringify(artifact)).toBe(before);
});

test('rejects a repair adapter that replaces the operator title even if it claims approval', async () => {
    const { artifact, io } = fixture();
    artifact.renderedSubtitles = { review: { note: '标题大意按我的意见', copy: { ...artifact.copy } } };
    await expect(repairOwnPublicCopy(artifact, config, {}, io)).rejects.toThrow('Operator title changed');
    expect(io.renderCover).not.toHaveBeenCalled();
    expect(io.reviewFinal).not.toHaveBeenCalled();
});

test('unresolved subtitle, policy, boundary, technical or historical issues never enter this copy repair', async () => {
    const { artifact, io } = fixture();
    for (const row of [
        { ...artifact, publicationReview: { ...artifact.publicationReview, checks: { ...artifact.publicationReview.checks, subtitles: false } } },
        { ...artifact, publicationReview: { ...artifact.publicationReview, status: 'rejected' } },
        { ...artifact, sourceExpansionRequest: {} }, { ...artifact, generatedAt: '2020-01-01T00:00:00Z' },
        { ...artifact, ownStreamHumanReview: { status: 'approved' } },
        { ...artifact, publicationReview: { ...artifact.publicationReview, issues: ['标题不支持；片尾不完整'] } }
    ]) {
        expect(copyRepairEligible(row, config)).toBe(false);
        await expect(repairOwnPublicCopy(row, config, {}, io)).resolves.toBe(row);
    }
    expect(io.reviewCopy).not.toHaveBeenCalled();
});

test('a public factual wording defect can be repaired even without a title or description keyword', async () => {
    const { artifact, io } = fixture();
    artifact.publicationReview.issues = ['称“终于开门了”，画面未见开门；删去门已打开的事实表述。', 'final_content_not_passed'];
    expect(copyRepairEligible(artifact, config)).toBe(true);
    io.reviewCopy = jest.fn(async row => ({ ...row, copy: { title: '草莓快开门', coverText: '草莓快开门', description: '跟着催开门' },
        attributionReview: { status: 'passed' }, publicCopyPending: false }));
    const result = await repairOwnPublicCopy(artifact, config, {}, io);
    expect(result.copy.description).toBe('跟着催开门');
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
    expect(result.output.mediaPath).toBe(artifact.output.mediaPath);
    artifact.publicationReview.checks.subtitles = false;
    expect(copyRepairEligible(artifact, config)).toBe(false);
});

test('a required quality gate cannot be discharged by copy repair or an unbound passed final stamp', async () => {
    const { artifact, io } = fixture();
    await expect(repairOwnPublicCopy(artifact, config, { qaRequired: true }, io)).rejects.toThrow('Required quality review');
    expect(io.reviewFinal).toHaveBeenCalledWith(expect.objectContaining({ qaRequired: true }));
});

test.each(['attribution', 'visuals'])('a copy-only %s classification is corrected and independently reviewed', async key => {
    const { artifact, io } = fixture();
    artifact.publicationReview.checks.content = true;
    artifact.publicationReview.checks[key] = false;
    artifact.publicationReview.issues = ['标题或封面把不确定的过去经历写成了确定行动', `final_${key}_not_passed`];
    expect(copyRepairEligible(artifact, config)).toBe(true);
    const result = await repairOwnPublicCopy(artifact, config, {}, io);
    expect(result.copy.title).toBe('可能住一个月');
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
});

test('a missing actor prerequisite may be freshly bound without changing copy or rerendering the media', async () => {
    const { artifact, io } = fixture();
    artifact.publicationReview = { status: 'needs_review', issues: ['attribution_not_passed'] };
    io.reviewCopy = jest.fn(async row => ({ ...row, attributionReview: { status: 'passed' }, publicCopyPending: false }));
    const result = await repairOwnPublicCopy(artifact, config, { attributionRequired: true }, io);
    expect(result.attributionRequired).toBe(true);
    expect(result.copy).toEqual(artifact.copy);
    expect(io.renderCover).not.toHaveBeenCalled();
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
});

test('a confirmed cover layout defect renders one new cover with unchanged copy and freshly reviews it', async () => {
    const { artifact, io } = fixture();
    artifact.attributionReview = { status: 'passed' };
    artifact.publicationReview = { status: 'needs_review', technical: { passed: true },
        checks: { content: true, attribution: true, subtitles: true, visuals: false, policy: true },
        issues: ['封面大字遮住主体面部', 'final_visuals_not_passed'] };
    artifact.automaticCopyRepair = { resultIdentity: '' };
    io.reviewFinal = jest.fn(async row => ({ ...row, publicationDecision: { action: 'needs_human' } }));
    const result = await repairOwnPublicCopy(artifact, config, {}, io);
    expect(result.copy).toEqual(artifact.copy);
    expect(result.output).toEqual({ ...artifact.output, coverPath: '/new.jpg' });
    expect(io.reviewCopy).not.toHaveBeenCalled();
    expect(io.renderCover).toHaveBeenCalledTimes(1);
    expect(io.renderCover).toHaveBeenCalledWith(expect.any(Object), { textPosition: 'bottom' });
    expect(io.reviewFinal).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ coverPath: '/new.jpg' }) }));
    expect(result.automaticCoverLayoutRepair.authority).toBe('automatic');
    await expect(repairOwnPublicCopy(result, config, {}, io)).resolves.toBe(result);
    expect(io.renderCover).toHaveBeenCalledTimes(1);
});

test('an already rendered clip held by actor review receives fresh actor and final reviews before queueing', async () => {
    const { artifact, io } = fixture();
    Object.assign(artifact, { uploadReady: false, publicCopyPending: true, attributionRequired: true,
        attributionReview: { status: 'needs_review' },
        publicationReview: { status: 'needs_review', issues: ['publicCopyPending', 'artifact_not_upload_ready', 'attribution_not_passed'] } });
    io.reviewCopy = jest.fn(async row => ({ ...row, uploadReady: true,
        attributionReview: { status: 'passed' }, publicCopyPending: false }));
    const result = await repairOwnPublicCopy(artifact, config, { attributionRequired: true }, io);
    expect(io.reviewCopy).toHaveBeenCalledTimes(1);
    expect(io.reviewFinal).toHaveBeenCalledTimes(1);
    expect(io.renderCover).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attributionRequired: true, publicCopyPending: false,
        attributionReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } });
    expect(result.output).toEqual(artifact.output);
    expect(result.ownStreamHumanReview).toBeUndefined();
});

test('pending copy alone or an additional content failure does not enter prerequisite repair', async () => {
    const { artifact, io } = fixture();
    for (const issues of [['publicCopyPending', 'artifact_not_upload_ready'],
        ['publicCopyPending', 'artifact_not_upload_ready', 'attribution_not_passed', '片尾缺失']]) {
        const pending = { ...artifact, uploadReady: false, publicCopyPending: true, attributionRequired: true,
            publicationReview: { status: 'needs_review', issues } };
        expect(copyRepairEligible(pending, config)).toBe(false);
        await expect(repairOwnPublicCopy(pending, config, {}, io)).resolves.toBe(pending);
    }
    expect(io.reviewCopy).not.toHaveBeenCalled();
    expect(io.reviewFinal).not.toHaveBeenCalled();
});

test('changed source, video, subtitle, boundary or authority cannot be approved by copy repair', async () => {
    for (const kind of ['boundary', 'media', 'authority', 'source']) {
        const { artifact, io } = fixture();
        if (kind !== 'source') io.reviewCopy = jest.fn(async row => ({ ...row, attributionReview: { status: 'passed' },
            ...(kind === 'boundary' ? { window: { ...row.window, end: 31 } } : {}),
            ...(kind === 'media' ? { output: { ...row.output, srtPath: '/changed.srt' } } : {}),
            ...(kind === 'authority' ? { ownStreamHumanReview: { status: 'approved' } } : {}) }));
        else {
            const snapshot = io.snapshot;
            let calls = 0;
            io.snapshot = async row => { const value = await snapshot(row); return ++calls === 1 ? value : { ...value, source: { ...value.source, srtSha256: digest('changed') } }; };
        }
        await expect(repairOwnPublicCopy(artifact, config, {}, io)).rejects.toThrow(/changed/u);
        expect(io.reviewFinal).not.toHaveBeenCalled();
    }
});

test('failed final review stays pending and the same repaired artifact is not retried blindly', async () => {
    const { artifact, io } = fixture();
    io.reviewFinal = jest.fn(async row => ({ ...row, publicationDecision: { action: 'needs_human' } }));
    const result = await repairOwnPublicCopy(artifact, config, {}, io);
    expect(result.publicationDecision.action).toBe('needs_human');
    expect(result.publicationReview.status).toBe('needs_review');
    await expect(repairOwnPublicCopy(result, config, {}, io)).resolves.toBe(result);
    expect(io.reviewCopy).toHaveBeenCalledTimes(1);
});
