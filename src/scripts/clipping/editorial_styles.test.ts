import { editorialEvidenceDigest } from '../../workflows/clipping/editorialEvidence';
const fs = require('fs'), os = require('os'), path = require('path');
const runtime = require('../workflow-runtime');
const { applyStyles, finishTopicStylesAndReview } = require('./editorial_styles');

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editorial-production-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(kind: string) {
    const put = (name, value) => { const file = path.join(directory, name); fs.writeFileSync(file, value); return file; };
    const srt = '1\n00:00:00,000 --> 00:00:03,000\n开场\n\n2\n00:00:08,000 --> 00:00:11,000\n重点\n';
    const baseline: any = { mode: kind === 'own' ? 'own_stream_fun_review' : 'local_review', status: 'success',
        ...(kind === 'topic' ? { publicationKind: 'keyword_topic', aiReview: { status: 'ready', applied: true }, editorial: { copyStatus: 'prepared' } } : {}),
        roomId: '25788785', generatedAt: '2026-10-22T00:00:00Z', source: { mediaPath: 'recording', srtPath: 'source' },
        window: { index: 1, start: 100, end: 130, duration: 30 }, uploadReady: true,
        copy: { title: '重点', description: '来源', coverText: '重点' }, qaResult: { status: 'passed' }, publicationReview: { status: 'passed' },
        output: { mediaPath: put('baseline.mp4', 'baseline'), srtPath: put('baseline.srt', srt), metadataPath: path.join(directory, 'baseline.json'),
            coverPath: put('cover.jpg', 'cover'), burnedSubtitles: true } };
    fs.writeFileSync(baseline.output.metadataPath, JSON.stringify(baseline));
    const io = { probe: jest.fn(async file => ({ duration: file === baseline.output.mediaPath ? 30 : file.endsWith('shikamochi-op.mp4') ? 6.487696 : 39.487696,
        width: 1920, height: 1080, audio: true })), render: jest.fn(async (_file, out) => fs.writeFileSync(out, 'part')),
        concat: jest.fn(async (_file, out) => fs.writeFileSync(out, 'final')) };
    jest.spyOn(runtime.loadWorkflow('clipping/editorialMedia'), 'editorialMediaIO').mockReturnValue(io);
    jest.spyOn(require('./enhancement_runner'), 'requestStage').mockResolvedValue({ text: JSON.stringify({ choices: [{ id: 1, style: 'highlight_first',
        reason: '完整反应', plan: { version: 1, highlights: [{ start: 8, end: 11 }], reason: '反应' } }] }) });
    const context = { config: { editorialStyles: { enabled: true, mode: 'auto' }, clipResourceAdaptive: { enabled: false } },
        rootConfig: {}, info: { roomId: '25788785' }, parsed: { segments: [] }, danmaku: [], options: { srtPath: 'source' },
        topic: { resolveFfprobePath: () => 'ffprobe' } };
    return { baseline, context, io };
}
test.each(['own', 'topic'])('%s preserves source/copy/preflight contracts and invalidates final approvals', async kind => {
    const f = fixture(kind), original = fs.readFileSync(f.baseline.output.metadataPath, 'utf8');
    const [result] = await applyStyles([f.baseline], f.context);
    expect(result.style).toBe('highlight_first');
    expect(result).toMatchObject({ mode: f.baseline.mode, status: 'success', source: f.baseline.source, copy: f.baseline.copy,
        window: { start: 100, end: 130, duration: 39.487696 }, qaRequired: true, qaResult: { status: 'pending' } });
    if (kind === 'topic') expect(result.aiReview).toEqual(f.baseline.aiReview);
    expect(result.publicationReview).toBeUndefined();
    expect(fs.readFileSync(f.baseline.output.metadataPath, 'utf8')).toBe(original);
    expect(editorialEvidenceDigest(result)).toMatch(/^[a-f0-9]{64}$/);
    result.editorialTimeline.pieces[0].end -= 1;
    expect(() => editorialEvidenceDigest(result)).toThrow(/timeline/);
});
test('source mutation during model selection cannot render a stale hook', async () => {
    const f = fixture('topic');
    const request = require('./enhancement_runner').requestStage, answer = await request();
    request.mockImplementation(async () => { fs.appendFileSync(f.baseline.output.srtPath, '\n'); return answer; });
    const [result] = await applyStyles([f.baseline], f.context);
    expect(result).toMatchObject({ style: 'ordinary', editorialStyle: { status: 'kept_original', failure: expect.stringContaining('changed') } });
    expect(f.io.render).not.toHaveBeenCalled();
});
test.each(['own', 'topic'].flatMap(kind => [0, .75].map(sample => [kind, sample] as const)))(
    '%s binds the selected OP at random sample %s for subsequent review', async (kind, sample) => {
        const f = fixture(kind);
        const pool = ['public/branding/shikamochi/OP-sad-v1.json', 'public/branding/shikamochi/OP-watch-v1.json'];
        Object.assign(f.context.config.editorialStyles, { opManifests: pool });
        const selected = path.resolve(pool[sample === 0 ? 0 : 1]);
        const manifest = JSON.parse(fs.readFileSync(selected, 'utf8'));
        const opMedia = path.resolve(path.dirname(selected), manifest.mediaPath);
        f.io.probe.mockImplementation(async file => ({ duration: file === f.baseline.output.mediaPath ? 30
            : file === opMedia ? manifest.duration : 33 + manifest.duration, width: 1920, height: 1080, audio: true }));
        const random = jest.spyOn(Math, 'random').mockReturnValue(sample);
        const [result] = await applyStyles([f.baseline], f.context);
        expect(result.style).toBe('highlight_first');
        expect(result.editorialTimeline.opManifest).toBe(selected);
        expect(result.editorialTimeline.op.id).toBe(manifest.id);
        expect(f.io.render).toHaveBeenCalledWith(opMedia, expect.any(String), 0, manifest.duration, expect.any(Object));
        const receipt = editorialEvidenceDigest(result);
        random.mockReturnValue(sample === 0 ? .75 : 0);
        expect(editorialEvidenceDigest(result)).toBe(receipt);
        expect(result.editorialTimeline.opManifest).toBe(selected);
        expect(fs.readFileSync(result.output.srtPath, 'utf8')).toContain(sample === 0 ? '鹿饼根本就没心' : '鹿饼的切片你都要看');
        expect(fs.readFileSync(result.output.srtPath, 'utf8')).not.toContain(sample === 0 ? '鹿饼的切片你都要看' : '鹿饼根本就没心');
    });
test('keyword precision receives the complete media facade and retains independent preflight evidence', async () => {
    const f = fixture('topic'); f.context.config.editorialStyles.mode = 'precision';
    const creative = jest.spyOn(require('./creative_runner'), 'runCreativeEnhancement').mockImplementation(async (row: any, context: any) => {
        expect(context.topic).toBe(f.context.topic); expect(context.clip.attributionRequired).toBeUndefined();
        expect(context.config.enhancements.workflow).toBe('creative');
        return { ...row, creativeResult: { status: 'edited' } };
    });
    const [result] = await applyStyles([f.baseline], f.context);
    expect(creative).toHaveBeenCalledTimes(1); expect(result.style).toBe('precision'); expect(result.aiReview).toEqual(f.baseline.aiReview);
});
test('topic style processing completes before final publication and registration can see it', async () => {
    const f = fixture('topic'), rows = [f.baseline], order: string[] = [];
    jest.spyOn(require('./topic_automatic_publication'), 'reviewTopicFinals').mockImplementation(async (finals: any) => {
        order.push('review'); expect(finals[0].style).toBe('highlight_first'); expect(finals[0].qaResult.status).toBe('pending'); return finals;
    });
    await finishTopicStylesAndReview(rows, { ...f.context, publicationActive: true }, { ...f.context.topic, isPendingTopicResult: () => false });
    expect(order).toEqual(['review']); expect(rows[0].style).toBe('highlight_first');
});

test('own precision keeps the reviewed factual copy separate from the source-prefixed publication copy', async () => {
    const f = fixture('own'); f.context.config.editorialStyles.mode = 'precision';
    const { copyDigest } = require('./actor_review');
    const original = { ...f.baseline.copy, description: '核对过的事件正文' };
    f.baseline.attributionRequired = true;
    f.baseline.attributionReview = { version: 1, status: 'passed', start: 100, end: 130, sourceSha256: 'source',
        copyDigest: copyDigest(original), claims: [{ cueIds: ['G1'] }] };
    f.context['clips'] = [{ ...original, start: 100, end: 130 }];
    f.context['evidence'] = { sourceSha256: 'source' };
    jest.spyOn(require('./creative_runner'), 'runCreativeEnhancement').mockImplementation(async (row: any, context: any) => {
        expect(runtime.loadWorkflow('clipping/experiment').experimentEligibility(context.clip, 'source')).toBeNull();
        expect(context.clip.description).toBe(original.description);
        return { ...row, creativeResult: { status: 'kept_original', reason: 'fixture' } };
    });
    const [result] = await applyStyles([f.baseline], f.context);
    expect(result.copy).toEqual(f.baseline.copy);
});
