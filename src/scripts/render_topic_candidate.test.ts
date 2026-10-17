export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const topic = require('./topic_clipper');
const mediaRuntime = require('./clipping/media_runtime');
const manual = require('./manual_clip_queue');
const generator = require('./ai_text_generator');
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
    const run = jest.spyOn(mediaRuntime, 'runFfmpeg').mockImplementation(async args => fs.writeFileSync(args.at(-1), 'preview'));
    jest.spyOn(mediaRuntime, 'probeRoughCutSourceStart').mockResolvedValue(0);
    jest.spyOn(mediaRuntime, 'probeVideoPacketsWithHashes').mockResolvedValue([{ pts_time: '0' }]);
    jest.spyOn(mediaRuntime, 'probeMediaDuration').mockResolvedValue(32);
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

  test('pending numeric replan keeps corrected words and old bytes without approving the expanded window', () => {
    metadata.candidateId = 17;
    metadata.window.end = 20;
    metadata.window.matchSegments = [{ ...segments[1], matchedKeywords: ['SUI'] }];
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const old = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct', from: 'price', to: 'cost' }, {});
    const bytes = fs.readFileSync(old.candidateSrtPath);
    const registryPath = path.join(dir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 17: { id: 17, metadataPath: metadata.output.metadataPath, pendingCut: true } } }));
    const prepared = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'prepare',
      replan: 'yes', start: 0, end: 30, reviewNote: 'Retain the complete closing response', registryPath }, {});
    const saved = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    expect(prepared.candidateRevision).toBe(2);
    expect(prepared.approval).toBeNull();
    expect(prepared.cues.map(cue => cue.text)).toEqual(['SUI has a cost.', 'The cost is clear.', 'Closing reply.']);
    expect(saved.candidateWindowRepair).toMatchObject({ start: 0, end: 30 });
    expect(saved.aiReview.status).toBe('needs_review');
    expect(saved.humanReview).toBeNull();
    expect(fs.readFileSync(old.candidateSrtPath).equals(bytes)).toBe(true);
  });

  test('automatic review never records human approval and refuses unresolved preflight', () => {
    const opts = { ...options, automaticReview: 'yes' };
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath, opts, {})).toThrow('fresh ready preflight');
    metadata.aiReview.status = 'ready'; metadata.aiReview.quality.issues = [];
    const task = prepareCandidate(metadata, metadata.output.metadataPath, opts, {});
    expect(task.sourceMetadata.humanReview).toBeUndefined();
    expect(task.sourceMetadata.aiReview.applied).toBe(true);
  });

  test('explicit feedback accepts the current draft while preserving advisory AI findings', () => {
    metadata.aiReview.keyword.status = 'uncertain';
    const task = prepareCandidate(metadata, metadata.output.metadataPath,
      { ...options, feedbackAuthorized: 'yes', description: metadata.copy.description }, {});
    expect(task.sourceMetadata.humanReview).toMatchObject({ authority: 'user', acceptanceMode: 'feedback', audioVisualReviewed: false });
    expect(task.sourceMetadata.humanReview.originalIssues).toEqual(metadata.aiReview.quality.issues);
    expect(task.sourceMetadata.humanReview.copyGrounding.issues.length).toBeGreaterThan(0);
    expect(task.subtitleSegments[1].text).toBe('The price is clear.');
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath,
      { ...options, feedbackAuthorized: 'yes', automaticReview: 'yes' }, {})).toThrow();
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

  test('checks an approved Chinese SC amount without changing its subtitle revision, approval or remaining AI review', () => {
    const rows = [{ start: 0, end: 30, text: 'Sc要三十块钱喊两句咋了' }];
    parse.mockReturnValue({ segments: rows });
    metadata.aiReview.sourceSha256 = buildPreflightEvidence(rows).sourceSha256;
    metadata.aiReview.subtitleEdits = [];
    metadata.aiReview.quality.issues = ['unsupported_number:title:30', 'unsupported_number:description:30'];
    metadata.editorial.copyGrounding.subtitleIds = ['G1'];
    metadata.copy = { title: '30元SC喊两句，礼礼说刚刚声音很正常',
      description: '礼礼提到30元SC喊两句，随后强调刚刚没有发出很大的声音。',
      coverText: '三十块喊两句\n我刚刚声音很正常' };
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const approved = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'approve',
      reviewNote: 'User requested upload' }, {});
    metadata = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    const before = fs.readFileSync(approved.candidateSrtPath);
    const revision = JSON.stringify(metadata.candidateSubtitles);
    const task = prepareCandidate(metadata, metadata.output.metadataPath, { candidateId: 17,
      reviewNote: 'User requested upload', requireApproval: true, expectedSha256: approved.candidateSrtSha256 }, {});
    expect(task.title).toBe(metadata.copy.title);
    expect(task.description).toBe(metadata.copy.description);
    expect(task.sourceMetadata.humanReview.copyGrounding.issues).toEqual([]);
    expect(task.sourceMetadata.aiReview.status).toBe('needs_review');
    expect(JSON.stringify(metadata.candidateSubtitles)).toBe(revision);
    expect(fs.readFileSync(approved.candidateSrtPath).equals(before)).toBe(true);
    expect(() => prepareCandidate(metadata, metadata.output.metadataPath,
      { ...options, description: '50元SC' }, {})).toThrow('unsupported_number:description:50');
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

  test('recovers only the exact confirmed external correction into a new immutable revision', () => {
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const draft = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'inspect' }, {});
    const bytes = fs.readFileSync(draft.candidateSrtPath, 'utf8');
    fs.writeFileSync(draft.candidateSrtPath, bytes.replace(/price/g, 'cost'));
    expect(() => updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'approve', reviewNote: 'Publish' }, {}))
      .toThrow('outside the correction');
    const edited = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct',
      from: 'price', to: 'cost', reviewNote: 'User confirmed cost' }, {});
    expect(edited.candidateRevision).toBe(1);
    expect(edited.candidateSrtPath).not.toBe(draft.candidateSrtPath);
    expect(edited.edits[0]).toMatchObject({ original: 'price', replacement: 'cost', authority: 'user' });
    fs.appendFileSync(edited.candidateSrtPath, '\n999\n00:00:00,000 --> 00:00:01,000\nUnrelated\n');
    expect(() => updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct',
      from: 'cost', to: 'value', reviewNote: 'Another correction' }, {})).toThrow('outside the correction');
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

  test('saves reviewed public copy and tags with a candidate subtitle correction', () => {
    fs.writeFileSync(metadata.output.metadataPath, JSON.stringify(metadata));
    const result = updateCandidate(metadata.output.metadataPath, { candidateId: 17, action: 'correct',
      from: 'price', to: 'cost', cue: 1, reviewNote: 'Checked the spoken name',
      title: 'Revised source title', description: 'Revised source description',
      tags: 'Host,VR clips' }, {});
    const saved = JSON.parse(fs.readFileSync(metadata.output.metadataPath, 'utf8'));
    expect(saved.candidateSubtitles.cues[0].text).toContain('cost');
    expect(saved.copy.title).toBe('Revised source title');
    expect(saved.upload.tags).toEqual(['Host', 'VR clips']);
    expect(result.uploadTags).toEqual(['Host', 'VR clips']);
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

  test('queued boundary failure replans, versions and renders the same ID with fresh evidence and copy', async () => {
    const root = { ai: { text: { provider: 'daiYu' } }, clipTopics: { keywords: ['SUI'],
      review: { enabled: true, mode: 'preflight', strategy: 'single', qualityRules: true,
        model: 'gpt-6-luna', reasoningEffort: 'high' }, ai: { selectionCacheEnabled: false } } };
    metadata.source.mediaPath = path.join(dir, 'source.mp4');
    fs.writeFileSync(metadata.source.mediaPath, 'source');
    metadata.candidateId = 17;
    metadata.window = { ...metadata.window, start: 10, end: 30,
      matchSegments: [{ ...segments[0], start: 10, end: 20, text: segments[1].text, matchedKeywords: ['SUI'] }] };
    metadata.aiReview.reason = 'Preflight duration outside limits';
    metadata.aiReview.keyword = { status: 'needs_review', hits: [] };
    metadata.aiReview.quality.issues = ['Preflight duration outside limits'];
    metadata.editorial.copyGrounding = null;
    metadata.copy = { title: 'Pending candidate', description: '', coverText: '' };
    const file = metadata.output.metadataPath;
    fs.writeFileSync(file, JSON.stringify(metadata));
    const approved = updateCandidate(file, { candidateId: 17, action: 'approve', reviewNote: 'User requested upload' }, root);
    const before = fs.readFileSync(approved.candidateSrtPath);
    const registryPath = path.join(dir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ clips: { 17: { id: 17, metadataPath: file, pendingCut: true } } }));
    const request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async prompt => {
      const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
      return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention',
        reason: 'Source-backed mention', evidenceCueIds: [hit.cueId] })), clips: [{ id: 'E1-1',
        status: 'ready', startCueId: 'G1', endCueId: 'G3', hitIds: ['K1'], event: 'Complete event',
        reason: 'Setup and closure', score: 80, extensionReason: '', sourceKind: 'live_speech',
        evidenceCueIds: ['G1', 'G2', 'G3'], evidenceDanmakuIds: [], warnings: [],
        title: 'SUI has a price', description: 'The price is clear', coverText: 'price\nSUI', subtitleEdits: [],
        boundaryReview: { setupCueId: 'G1', closureCueId: 'G3', startReason: 'Full setup',
          endReason: 'Full closure', dependencies: [], unresolvedCueIds: [] } }] }),
        meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna', responseModel: 'gpt-6-luna',
          apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } };
    });
    const cut = jest.spyOn(manual, 'cutTask').mockImplementation(async task => {
      expect(task.id).toBe('17');
      expect(task.start).toBe(0);
      expect(task.end).toBe(30);
      expect(task.sourceMetadata.humanReview.authority).toBe('ai_replan');
      const output = { mediaPath: path.join(dir, 'rendered.mp4'), srtPath: path.join(dir, 'rendered.srt'),
        coverPath: path.join(dir, 'cover.jpg'), burnedSubtitles: true };
      for (const file of [output.mediaPath, output.srtPath, output.coverPath]) fs.writeFileSync(file, 'artifact');
      fs.writeFileSync(task.reviewPath, 'Review');
      fs.writeFileSync(metadata.output.metadataPath, JSON.stringify({ ...task.sourceMetadata,
        mode: 'topic_candidate_manual_cut', status: 'success', output }));
      return { output };
    });
    const queued = { candidateId: 17, reviewNote: 'User requested upload', registryPath,
      requireApproval: true, expectedSha256: approved.candidateSrtSha256 };
    await renderCandidate(file, queued, root);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.candidateRecovery.status).toBe('ready');
    expect(saved.candidateRecovery.original.window.start).toBe(10);
    expect(saved.candidateSubtitles.revision).toBe(1);
    expect(saved.candidateSubtitles.approval).toBeNull();
    expect(saved.aiReview.status).toBe('ready');
    expect(fs.readFileSync(approved.candidateSrtPath).equals(before)).toBe(true);
    await renderCandidate(file, queued, root);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cut).toHaveBeenCalledTimes(1);
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
