export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const topic = require('./topic_clipper');
const manual = require('./manual_clip_queue');
const { buildPreflightEvidence } = require('./clipping/preflight_evidence');
const { prepareCandidate, renderCandidate, refreshSourceReview, updateCandidate, previewCandidate } = require('./render_topic_candidate');

describe('render held topic candidate by reserved ID', () => {
  let dir, metadata, parse;
  const segments = [
    { start: 0, end: 10, text: 'SUI has a price.', asrEvidence: { sourceSpan: { rawText: 'SUI has a price.' } } },
    { start: 10, end: 20, text: 'The prise is clear.', asrEvidence: { sourceSpan: { rawText: 'The price is clear.' } } },
    { start: 20, end: 30, text: 'Closing reply.' }
  ];
  const options = { candidateId: '17', reviewNote: 'Checked the source', description: 'Source-backed description' };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-candidate-'));
    parse = jest.spyOn(topic, 'parseTopicSrt').mockReturnValue({ segments });
    metadata = {
      status: 'pending_preflight', source: { sourceKind: 'video', srtPath: path.join(dir, 'source.srt'), mediaPath: 'source.mp4' },
      window: { index: 'E1-1', start: 0, end: 30, matchSegments: [] },
      roomId: 'room', streamerName: 'Host', upload: { prefix: '[Host]', tags: ['Host'], source: 'Host stream' },
      copy: { title: 'Source title', description: '"Unsupported quote"', coverText: 'Source\nCover' },
      aiReview: { mode: 'preflight', status: 'needs_review', sourceSha256: buildPreflightEvidence(segments).sourceSha256,
        keyword: { status: 'confirmed', hits: [] }, quality: { issues: ['unsupported_quote:description:Unsupported quote'] },
        subtitleEdits: [{ cueId: 'G2', original: 'prise', replacement: 'price', reason: 'Raw ASR', evidenceCueIds: ['G2'] }],
        rejectedSubtitleEdits: [{ cueId: 'G3', original: 'Closing', replacement: 'Wrong' }] },
      editorial: { copyGrounding: { status: 'linked', issues: [], sourceKind: 'live_speech', subtitleIds: ['G1', 'G2', 'G3'], danmakuIds: [], audience: [] } },
      output: { metadataPath: path.join(dir, 'candidate.json'), mediaPath: null }
    };
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('preview tolerates unresolved copy, never approves, and tracks later corrections', async () => {
    metadata.source.mediaPath = path.join(dir, 'source.mp4');
    fs.writeFileSync(metadata.source.mediaPath, 'source');
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const run = jest.spyOn(topic, 'runFfmpeg').mockImplementation(async args => fs.writeFileSync(args.at(-1), 'preview'));
    jest.spyOn(topic, 'probeRoughCutSourceStart').mockResolvedValue(0);
    jest.spyOn(topic, 'probeVideoPacketsWithHashes').mockResolvedValue([{ pts_time: '0' }]);
    jest.spyOn(topic, 'probeMediaDuration').mockResolvedValue(32);
    const result = await previewCandidate(metadata.output.metadataPath, { candidateId: 17, approveUpload: 'yes' }, {});
    const saved = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    expect(saved.status).toBe('pending_preflight');
    expect(saved.copy).toEqual(metadata.copy);
    expect(saved.candidateSubtitles.approval).toBeUndefined();
    expect(saved.output.mediaPath).toBeNull();
    expect(fs.existsSync(`${metadata.output.metadataPath}.cut.lock`)).toBe(false);
    updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct', from: 'price', to: 'cost' }, {});
    expect(fs.readFileSync(result.reviewPreview.srtPath, 'utf8')).toContain('The cost is clear.');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('keeps the candidate ID and source host and applies only corroborated edits', () => {
    const task = prepareCandidate(metadata, metadata.output.metadataPath, options, {});
    expect(task.upload).toEqual(metadata.upload);
    expect(task.sourceMetadata.candidateId).toBe(17);
    expect(task.sourceMetadata.autoUploadEnabled).toBe(false);
    expect(task.subtitleSegments[1].text).toBe('The price is clear.');
    expect(task.subtitleSegments[2].text).toBe('Closing reply.');
    expect(task.sourceMetadata.aiReview.status).toBe('needs_review');
    expect(task.sourceMetadata.humanReview.copyGrounding.issues).toEqual([]);
    expect(task.sourceMetadata.humanReview.originalCopy.description).toBe('"Unsupported quote"');
    expect(segments[1].text).toBe('The prise is clear.');
  });

  test('checks an approved spoken date using the recording year without changing subtitles or copy', () => {
    const rows = [{ start: 0, end: 30, text: '不对不对二零年十二月的时候买的' }];
    parse.mockReturnValue({ segments: rows });
    metadata.recordedAt = '2026-09-11 10:08:50';
    metadata.aiReview.sourceSha256 = buildPreflightEvidence(rows).sourceSha256;
    metadata.aiReview.subtitleEdits = [];
    metadata.editorial.copyGrounding.subtitleIds = ['G1'];
    metadata.copy.description = '购于2020年12月';
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const approved = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'approve',
      reviewNote: 'User requested upload' }, {});
    metadata = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    const before = fs.readFileSync(approved.candidateSrtPath);
    const task = prepareCandidate(metadata, metadata.output.metadataPath, { candidateId: 17,
      reviewNote: 'User requested upload', requireApproval: true, expectedSha256: approved.candidateSrtSha256 }, {});
    expect(task.description).toBe(metadata.copy.description);
    expect(task.sourceMetadata.humanReview.copyGrounding.issues).toEqual([]);
    expect(fs.readFileSync(approved.candidateSrtPath).equals(before)).toBe(true);
  });

  test('rejects changed source, unresolved copy, unknown identity and blank review notes', () => {
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, { ...options, reviewNote: '' }, {})).toThrow('review note');
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, { ...options, description: undefined }, {})).toThrow('Public copy');
    metadata.aiReview.keyword.status = 'uncertain';
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, options, {})).toThrow('identity');
    metadata.aiReview.keyword.status = 'confirmed';
    metadata.aiReview.sourceSha256 = 'stale';
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, options, {})).toThrow('Source evidence changed');
  });

  test('rejects stale edits and invalid candidate IDs', () => {
    metadata.candidateId = 99;
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, options, {})).toThrow('does not match');
    metadata.candidateId = 17;
    metadata.aiReview.subtitleEdits[0].original = 'absent';
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, options, {})).toThrow('stale');
  });

  test('user correction and upload approval resolve AI uncertainty without another ASR or planning call', () => {
    metadata.aiReview.keyword.status = 'needs_review';
    metadata.aiReview.quality.issues = ['Model requests human review or identity remains uncertain'];
    metadata.copy = { title: 'SUI has a price', description: 'Source-backed description', coverText: 'price\nSUI' };
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const edited = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct',
      from: 'price', to: '睡睡睡', reviewNote: 'User confirmed the word', approveUpload: 'yes' }, {});
    metadata = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    const task = prepareCandidate(metadata, metadata.output.metadataPath, {
      candidateId: 17, reviewNote: 'User requested upload', requireApproval: true, expectedSha256: edited.candidateSrtSha256 }, {});
    expect(task.subtitleSegments[0].text).toContain('睡睡睡');
    expect(task.sourceMetadata.humanReview.userSubtitleEdits[0].authority).toBe('user');
    expect(task.sourceMetadata.humanReview.subtitleApproval.sha256).toBe(edited.candidateSrtSha256);
    expect(task.upload.prefix).toBe('[Host]');
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, { candidateId: 17,
      reviewNote: 'Changed snapshot', requireApproval: true, expectedSha256: 'different' }, {})).toThrow('matching upload approval');
  });

  test('uses the shared media path and releases the per-candidate lock after failure', async () => {
    const file = metadata.output.metadataPath;
    fs.writeFileSync(file, JSON.stringify(metadata));
    const cut = jest.spyOn(manual, 'cutTask').mockRejectedValue(new Error('media failed'));
    await expect(renderCandidate(file, options, {})).rejects.toThrow('media failed');
    expect(cut).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${file}.cut.lock`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file)).status).toBe('pending_preflight');
  });

  test('recovers the already rendered artifact without cutting or enqueuing again', async () => {
    metadata.mode = 'topic_candidate_manual_cut';
    metadata.status = 'success';
    metadata.candidateId = 17;
    metadata.output.mediaPath = path.join(dir, 'rendered.mp4');
    fs.writeFileSync(metadata.output.mediaPath, 'rendered');
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const cut = jest.spyOn(manual, 'cutTask');
    await renderCandidate(metadata.output.metadataPath, options, {});
    expect(cut).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  test('refreshes the source review without replacing a newer recording latest review', () => {
    const review = path.join(dir, 'source_REVIEW.md');
    const registry = path.join(dir, 'registry.json');
    const latest = path.join(dir, 'REVIEW.md');
    metadata.status = 'success';
    metadata.uploadReady = true;
    metadata.output.mediaPath = path.join(dir, 'clip.mp4');
    metadata.humanReview = { sourceSha256: metadata.aiReview.sourceSha256,
      copyGrounding: { issues: [] }, note: 'Quote corrected' };
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    fs.writeFileSync(registry, JSON.stringify({ clips: { 17: { id: 17, reviewPath: 'isolated.md',
      candidateReviewPath: review, metadataPath: metadata.output.metadataPath } } }));
    fs.writeFileSync(review, 'old pending candidate\n## 失败与降级记录\nother candidate failed');
    fs.writeFileSync(latest, 'newer recording');
    refreshSourceReview(registry, review);
    expect(fs.readFileSync(review, 'utf8')).toContain('上传ID: 17');
    expect(fs.readFileSync(review, 'utf8')).toContain('人工复核: 已核对');
    expect(fs.readFileSync(review, 'utf8')).not.toContain('待核查:');
    expect(fs.readFileSync(review, 'utf8')).toContain('other candidate failed');
    expect(fs.readFileSync(latest, 'utf8')).toBe('newer recording');
    fs.writeFileSync(latest, fs.readFileSync(review));
    metadata.copy.title = 'Updated title';
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    refreshSourceReview(registry, review);
    expect(fs.readFileSync(latest, 'utf8')).toContain('Updated title');
  });
});
