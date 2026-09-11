export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const topic = require('../topic_clipper');
const { buildPreflightEvidence } = require('./preflight_evidence');
const { ensureCandidateDraft, correctCandidateDraft } = require('./candidate_subtitles');
const { ensureCandidatePreview, syncPreviewSubtitles, reusablePreview } = require('./candidate_preview');

describe('candidate rough preview', () => {
  let dir, metadata, evidence, mediaApi, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-preview-'));
    file = path.join(dir, 'candidate.json');
    const mediaPath = path.join(dir, 'source.mp4');
    fs.writeFileSync(mediaPath, 'source');
    evidence = buildPreflightEvidence([{ start: 10, end: 13, text: 'Context' },
      { start: 20, end: 25, text: 'Original word' }, { start: 29, end: 32, text: 'Closing' }]);
    metadata = { status: 'pending_preflight', uploadReady: false,
      source: { mediaPath, srtPath: path.join(dir, 'source.srt'), sourceKind: 'video' },
      window: { start: 20, end: 30 }, output: { mediaPath: null },
      copy: { title: 'Original word' },
      aiReview: { sourceSha256: evidence.sourceSha256, subtitleEdits: [], keyword: { hits: [] } } };
    ensureCandidateDraft(metadata, file, evidence);
    mediaApi = { ...topic,
      runFfmpeg: jest.fn(async args => fs.writeFileSync(args.at(-1), 'rough video')),
      probeRoughCutSourceStart: jest.fn(async () => 10),
      probeVideoPacketsWithHashes: jest.fn(async () => [{ pts_time: '0.04' }]),
      probeMediaDuration: jest.fn(async () => 22.08) };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('aligns same-name SRT to actual keyframe PTS with context while keeping approval blocked', async () => {
    const draftBytes = fs.readFileSync(metadata.candidateSubtitles.path);
    const preview = await ensureCandidatePreview(metadata, file, evidence, {}, mediaApi);
    expect(preview.sourceTimeOrigin).toBeCloseTo(9.96);
    expect(preview.clipStart).toBeCloseTo(10.04);
    expect(path.basename(preview.srtPath, '.srt')).toBe(path.basename(preview.mediaPath, '.mp4'));
    const subtitles = fs.readFileSync(preview.srtPath, 'utf8');
    expect(subtitles).toContain('00:00:00,040 --> 00:00:03,040\nContext');
    expect(subtitles).toContain('00:00:10,040 --> 00:00:15,040\nOriginal word');
    expect(fs.readFileSync(metadata.candidateSubtitles.path)).toEqual(draftBytes);
    expect(metadata).toMatchObject({ status: 'pending_preflight', uploadReady: false, output: { mediaPath: null } });
    expect(metadata.candidateSubtitles.approval).toBeUndefined();
  });

  test('reuses video on repeated preparation and updates preview words from the current revision', async () => {
    await ensureCandidatePreview(metadata, file, evidence, {}, mediaApi);
    const video = metadata.reviewPreview.mediaPath;
    correctCandidateDraft(metadata, file, evidence, { from: 'Original', to: 'Corrected', reviewNote: 'heard' });
    expect(syncPreviewSubtitles(metadata, evidence)).toBe(true);
    await ensureCandidatePreview(metadata, file, evidence, {}, mediaApi);
    expect(mediaApi.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(metadata.reviewPreview.mediaPath).toBe(video);
    expect(fs.readFileSync(metadata.reviewPreview.srtPath, 'utf8')).toContain('Corrected word');
    expect(metadata.reviewPreview.candidateRevision).toBe(1);
    const review = topic.buildTopicReviewMarkdown([{ ...metadata, candidateId: 17 }]);
    expect(review).toContain('打开视频');
    expect(review).toContain('候选ID: 17');
    expect(review).not.toContain('上传ID: 17');
  });

  test('changed window, modified preview or source invalidates reuse and retains old media', async () => {
    await ensureCandidatePreview(metadata, file, evidence, {}, mediaApi);
    const old = metadata.reviewPreview.mediaPath;
    expect(reusablePreview(metadata.reviewPreview, metadata.source.mediaPath, { start: 19, end: 30 })).toBe(false);
    fs.appendFileSync(old, 'changed');
    expect(reusablePreview(metadata.reviewPreview, metadata.source.mediaPath, metadata.window)).toBe(false);
    await ensureCandidatePreview(metadata, file, evidence, {}, mediaApi);
    expect(metadata.reviewPreview.mediaPath).not.toBe(old);
    expect(fs.existsSync(old)).toBe(true);
    fs.appendFileSync(metadata.source.mediaPath, 'changed');
    expect(reusablePreview(metadata.reviewPreview, metadata.source.mediaPath, metadata.window)).toBe(false);
  });

  test('probe or media failures leave a retryable candidate without a ready preview', async () => {
    mediaApi.probeMediaDuration.mockResolvedValue(1);
    await expect(ensureCandidatePreview(metadata, file, evidence, {}, mediaApi)).rejects.toThrow('cover');
    expect(metadata.reviewPreview.status).toBe('failed');
    expect(metadata.output.mediaPath).toBeNull();
    expect(fs.readdirSync(dir).some(name => name.includes('.partial.'))).toBe(false);
    expect(fs.existsSync(metadata.candidateSubtitles.path)).toBe(true);
  });
});

const realMediaTest = process.env.DANMAKU_TEST_REAL_MEDIA === '1' ? test : test.skip;
realMediaTest('real GOP-aligned preview is reused for a precise subtitle burn and survives cover cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-preview-media-'));
  try {
    const source = path.join(dir, 'source.mp4');
    const options = { timeoutMs: 60000, resourceConfig: { threads: 2, cpuGuard: { enabled: false } } };
    await topic.runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '18',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '90', '-c:a', 'aac', source], options);
    const evidence = buildPreflightEvidence([{ start: 10.2, end: 12, text: 'Review subtitle' },
      { start: 12.1, end: 14.2, text: 'Closing subtitle' }]);
    const file = path.join(dir, 'candidate.json');
    const metadata = { source: { sourceKind: 'video', mediaPath: source, srtPath: path.join(dir, 'source.srt') },
      window: { start: 10.2, end: 14.2, duration: 4 }, output: {},
      aiReview: { sourceSha256: evidence.sourceSha256, subtitleEdits: [], keyword: { hits: [] } } };
    ensureCandidateDraft(metadata, file, evidence);
    const preview = await ensureCandidatePreview(metadata, file, evidence, { ffmpegTimeoutMs: 60000 });
    expect(reusablePreview(preview, source, metadata.window)).toBe(true);
    const output = path.join(dir, 'burned.mp4');
    const config = { ...require('../manual_clip_queue').buildQueueMediaConfig(require('../config-loader').getConfig()),
      reviewPreview: preview, resourceConfig: options.resourceConfig };
    const result = await topic.cutClipMedia({ kind: 'video', mediaPath: source }, metadata.window,
      metadata.candidateSubtitles.path, output, config);
    expect(result.burnedSubtitles).toBe(true);
    expect(result.reusedReviewPreview).toBe(true);
    expect(result.coverSourcePath).toBe(preview.mediaPath);
    expect(result.roughTrimOffset).toBeCloseTo(preview.clipStart);
    expect(await topic.probeMediaDuration(output)).toBeCloseTo(4, 0);
    expect(fs.existsSync(path.join(dir, 'burned.source.tmp.mp4'))).toBe(false);
    topic.cleanupTemporaryCoverSource(result);
    expect(fs.existsSync(preview.mediaPath)).toBe(true);
    expect(fs.existsSync(preview.srtPath)).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120000);
