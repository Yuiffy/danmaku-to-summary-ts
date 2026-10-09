export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const asr = require('../asr/asr_backends');
const topic = require('../topic_clipper');
const generator = require('../ai_text_generator');
const { preflightRequestOptions } = require('./preflight_runner');

test('preflight allows ten minutes by default and preserves explicit timeout overrides', () => {
  expect(preflightRequestOptions({ review: {} }).timeoutMs).toBe(600000);
  expect(preflightRequestOptions(topic.getClipTopicsConfig({})).timeoutMs).toBe(600000);
  for (const environment of ['default', 'production']) {
    const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../config/${environment}.json`), 'utf8'));
    expect(preflightRequestOptions(topic.getClipTopicsConfig(root)).timeoutMs).toBe(600000);
  }
  expect(preflightRequestOptions({ review: { timeoutMs: 720000 } }).timeoutMs).toBe(720000);
});

describe('pre-render topic workflow', () => {
  let dir: string;
  let media: string;
  let srt: string;
  let request: any;
  let timeline: string[];
  const config = { ai: { text: { provider: 'daiYu' } }, clipTopics: {
    enabled: true, keywords: ['SUI'], review: { enabled: true, mode: 'preflight', strategy: 'single',
      model: 'gpt-6-luna', reasoningEffort: 'max' }, ai: { selectionCacheEnabled: false } } };

  beforeEach(() => {
    timeline = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-workflow-'));
    media = path.join(dir, 'recording.mp4');
    srt = path.join(dir, 'recording.srt');
    fs.writeFileSync(media, 'fake source');
    const source = [
      { start: 0, end: 8, text: 'Setup.' },
      { start: 10, end: 20, text: 'SUI has a prise.', raw_text: 'SUI has a price.' },
      { start: 21, end: 42, text: 'That is the full response.' },
      { start: 1000, end: 1008, text: 'Second setup.' },
      { start: 1010, end: 1020, text: 'SUI has a second story.' },
      { start: 1021, end: 1042, text: 'That closes the second story.' }
    ];
    asr.writeSrt(asr.normalizeAsrResult({ backend: 'test', segments: source }), srt, { write_evidence: true });
    request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
      timeline.push(`model:${input.groupId}`);
      return { text: JSON.stringify({ hits: input.hits.map(hit => ({ id: hit.id, verdict: 'mention',
        reason: 'Person in context', evidenceCueIds: [hit.cueId] })), clips: [{ id: `${input.groupId}-1`, status: 'ready',
        startCueId: input.subtitles[0].id, endCueId: input.subtitles.at(-1).id, hitIds: input.hits.map(hit => hit.id),
        event: 'A complete event', reason: 'Complete setup and payoff', score: 80, extensionReason: '', sourceKind: 'live_speech',
        evidenceCueIds: input.hits.map(hit => hit.cueId), evidenceDanmakuIds: [], warnings: [],
        title: 'Prepared title', description: 'Prepared description', coverText: 'Prepared\nCover',
        ...(input.boundaryReviewRequired ? { boundaryReview: {
          setupCueId: input.subtitles[0].id, closureCueId: input.subtitles.at(-1).id,
          startReason: 'The setup introduces the event', endReason: 'The answer closes this event',
          dependencies: [], unresolvedCueIds: [] } } : {}),
        subtitleEdits: input.groupId === 'E1' ? [{ cueId: input.hits[0].cueId, original: 'prise', replacement: 'price',
          reason: 'Original ASR corroborates the word', evidenceCueIds: [input.hits[0].cueId] }] : []
      }] }), meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna',
        reasoningEffortSent: 'max', apiModeUsed: 'responses', responseModel: 'gpt-6-luna' }] } };
    });
  });
  afterEach(() => { request.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

  function run(overrides = {}) {
    const mediaGenerator = jest.fn(async (_source, window, subtitlePath, output) => {
      timeline.push('media');
      expect(timeline.slice(0, 2)).toEqual(['model:E1', 'model:E2']);
      expect(fs.existsSync(path.join(dir, 'topic_clips', 'recording_TOPIC_PLAN.json'))).toBe(true);
      if (window.start === 0) expect(fs.readFileSync(subtitlePath, 'utf8')).toContain('price');
      fs.writeFileSync(output, 'fake rendered clip');
      return { path: output, burnedSubtitles: true };
    });
    const coverGenerator = jest.fn(async () => { timeline.push('cover'); return null; });
    const previewGenerator = jest.fn(async metadata => {
      const preview = path.join(dir, `${metadata.window.start}_preview.mp4`);
      fs.writeFileSync(preview, 'rough preview');
      fs.copyFileSync(metadata.candidateSubtitles.path, preview.replace('.mp4', '.srt'));
      metadata.reviewPreview = { status: 'ready', mediaPath: preview, srtPath: preview.replace('.mp4', '.srt'),
        clipStart: 0, clipEnd: metadata.window.end - metadata.window.start };
    });
    const register = jest.fn((_path, results) => ({ clipIds: results.map((_r, i) => 700 + i) }));
    return { mediaGenerator, coverGenerator, previewGenerator, register, promise: topic.generateTopicClips({ config,
      originalMediaPath: media, srtPath: srt, mediaGenerator, coverGenerator, previewGenerator,
      registerReviewForUpload: register, notifyTopicClipResults: async () => true, ...overrides }) };
  }

  test('all AI planning and subtitle edits finish before the first burn or cover', async () => {
    const original = fs.readFileSync(srt, 'utf8');
    const job = run();
    const results = await job.promise;
    expect(results).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call: any[]) => call[1].timeoutMs === 600000)).toBe(true);
    expect(job.mediaGenerator).toHaveBeenCalledTimes(2);
    expect(job.coverGenerator).toHaveBeenCalledTimes(2);
    expect(results.every(result => result.aiReview.mode === 'preflight' && result.aiReview.status === 'ready')).toBe(true);
    expect(results.every(result => result.autoUploadEnabled === false)).toBe(true);
    expect(results[0].copy.title).toBe('Prepared title');
    expect(fs.readFileSync(srt, 'utf8')).toBe(original);
  });

  test('provider failure prepares review previews but does not burn or approve fallback clips', async () => {
    request.mockRejectedValue(new Error('provider failed'));
    const job = run();
    const results = await job.promise;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(result => result.status === 'pending_preflight' && !result.uploadReady && !result.output.mediaPath)).toBe(true);
    expect(results.every(result => fs.existsSync(result.candidateSubtitles.path))).toBe(true);
    expect(results.every(result => result.output.srtPath === result.candidateSubtitles.path && !result.candidateSubtitles.approval)).toBe(true);
    expect(job.mediaGenerator).not.toHaveBeenCalled();
    expect(job.previewGenerator).toHaveBeenCalledTimes(results.length);
    expect(results.every(result => fs.existsSync(result.reviewPreview.mediaPath))).toBe(true);
    expect(job.coverGenerator).not.toHaveBeenCalled();
    expect(job.register).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.candidateId)).toEqual(results.map((_result, index) => 700 + index));
    expect(results.every(result => !result.uploadId)).toBe(true);
    const review = fs.readFileSync(path.join(dir, 'topic_clips/REVIEW.md'), 'utf8');
    expect(review).toContain('候选ID: 700');
    expect(review).toContain('打开视频');
    expect(review).not.toContain('上传短ID:');
    expect(JSON.parse(fs.readFileSync(results[0].output.metadataPath, 'utf8')).candidateId).toBe(700);
  });

  test('returns an invalid duration to the same editor for one source-grounded boundary repair', async () => {
    const { buildPreflightEvidence } = require('./preflight_evidence');
    const { prepareTopicGroup } = require('./preflight_runner');
    const evidence = buildPreflightEvidence(topic.parseTopicSrt(srt).segments);
    const matches = [{ ...evidence.cues[1].items[0], matchedKeywords: ['SUI'] }];
    const group = { index: 'E1', start: 0, end: 42, cues: evidence.cues.slice(0, 3),
      matchSegments: matches, bursts: [{ start: 0, end: 42, matchSegments: matches }] };
    const ordinary = request.getMockImplementation();
    let count = 0;
    request.mockImplementation(async (...args) => {
      const result = await ordinary(...args);
      if (count++ === 0) {
        const raw = JSON.parse(result.text);
        raw.clips[0].startCueId = 'G2';
        raw.clips[0].endCueId = 'G2';
        result.text = JSON.stringify(raw);
      }
      return result;
    });
    const diagnostics = { failures: [], requests: [] };
    const plan = await prepareTopicGroup(group, evidence, topic.getClipTopicsConfig(config), config,
      { srtPath: srt, streamerName: 'Host' }, diagnostics);
    expect(plan.clips[0].status).toBe('ready');
    expect(plan.clips[0].start).toBe(0);
    expect(plan.clips[0].end).toBe(42);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('Preflight duration outside limits');
    expect(request.mock.calls[1][0]).toContain('G2');
    expect(request.mock.calls[1][1].primaryModel).toBe('gpt-6-luna');
    expect(plan.record.responses).toHaveLength(2);
    expect(fs.readFileSync(srt, 'utf8')).toContain('SUI has a prise.');
  });

  test.each([true, false])('an oversized prompt only packs identical ASR text, without dropping context (duplicate=%s)', async duplicate => {
    const { buildPreflightEvidence, buildPreflightInput } = require('./preflight_evidence');
    const { buildQualityDraftPrompt } = require('./preflight_quality');
    const { prepareTopicGroup } = require('./preflight_runner');
    const rawText = 'Original source text with unchanged context. '.repeat(180);
    const rows = topic.parseTopicSrt(srt).segments.slice(0, 3).map(row => ({ ...row,
      asrEvidence: { sourceSpan: { start: row.start, end: row.end, rawText,
        recognizedText: duplicate ? rawText : `${rawText}A distinct recognition.`, timingPrecision: 'segment', words: null } } }));
    const evidence = buildPreflightEvidence(rows);
    const matches = [{ ...evidence.cues[1].items[0], matchedKeywords: ['SUI'] }];
    const group = { index: 'E2', start: 0, end: 42, cues: evidence.cues, matchSegments: matches,
      bursts: [{ start: 0, end: 42, matchSegments: matches }] };
    const root = { ...config, clipTopics: { ...config.clipTopics, review: { ...config.clipTopics.review, qualityRules: true } } };
    const settings = topic.getClipTopicsConfig(root);
    const source = { srtPath: srt, streamerName: 'Host' };
    const input = buildPreflightInput(group, evidence, settings, source);
    settings.review.maxEvidenceChars = buildQualityDraftPrompt(input).length - 500;
    const before = JSON.stringify(evidence.cues);
    const plan = await prepareTopicGroup(group, evidence, settings, root, source, { requests: [], failures: [] });
    expect(JSON.stringify(evidence.cues)).toBe(before);
    expect(plan.input.originalAsrSpans).toEqual(input.originalAsrSpans);
    if (duplicate) {
      expect(plan.clips[0].status).toBe('ready');
      expect(request).toHaveBeenCalledTimes(1);
      const prompt = request.mock.calls[0][0];
      expect(prompt.length).toBeLessThanOrEqual(settings.review.maxEvidenceChars);
      const packed = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
      expect(packed.subtitles).toEqual(input.subtitles);
      expect(packed.hits).toEqual(input.hits);
      expect(packed.originalAsrSpans).toHaveLength(input.originalAsrSpans.length);
      expect(packed.originalAsrSpans[0].rawText).toBe(rawText);
      expect(packed.originalAsrSpans[0].recognizedText).toBeUndefined();
    } else {
      expect(plan.record.errors[0].error).toBe('Preflight source exceeds request budget');
      expect(request).not.toHaveBeenCalled();
    }
  });

  test('preview failure keeps candidates registered and does not prevent other previews', async () => {
    request.mockRejectedValue(new Error('provider failed'));
    const previewGenerator = jest.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce(null);
    const job = run({ previewGenerator });
    const results = await job.promise;
    expect(previewGenerator).toHaveBeenCalledTimes(2);
    expect(results[0].reviewPreview).toMatchObject({ status: 'failed', error: 'disk unavailable' });
    expect(results.every(result => result.status === 'pending_preflight' && result.candidateId && !result.uploadReady)).toBe(true);
    expect(job.mediaGenerator).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, 'topic_clips/REVIEW.md'), 'utf8')).toContain('粗剪失败: disk unavailable');
  });

  test('single-call quality preparation preserves unresolved dependencies and never burns them', async () => {
    const original = request.getMockImplementation();
    request.mockImplementation(async (prompt: string, options) => {
      const result = await original(prompt, options);
      const data = JSON.parse(result.text);
      data.clips[0].boundaryReview.unresolvedCueIds = [data.clips[0].endCueId];
      return { ...result, text: JSON.stringify(data) };
    });
    const job = run({ config: { ...config, clipTopics: { ...config.clipTopics,
      review: { ...config.clipTopics.review, qualityRules: true } } } });
    const results = await job.promise;
    expect(request).toHaveBeenCalledTimes(4); // One draft and one bounded boundary repair per held group.
    expect(job.mediaGenerator).not.toHaveBeenCalled();
    expect(results.every(result => result.status === 'pending_preflight'
      && result.aiReview.boundaryReview.status === 'needs_review')).toBe(true);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips', 'recording_TOPIC_PLAN.json'), 'utf8'));
    expect(plan.groups.every(group => group.clips[0].boundaryReview.unresolvedCueIds.length === 1)).toBe(true);
  });

  test('retries only selected planning groups without regenerating successful groups', async () => {
    const mediaGenerator = jest.fn(async (_source, _window, _subtitles, output) => {
      fs.writeFileSync(output, 'selected group clip');
      return { path: output, burnedSubtitles: true };
    });
    const job = run({ planningGroupIds: ['E2'], mediaGenerator });
    const results = await job.promise;
    expect(request).toHaveBeenCalledTimes(1);
    expect(timeline.filter(item => item.startsWith('model:'))).toEqual(['model:E2']);
    expect(mediaGenerator).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.window.index)).toEqual(['E2-1']);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'topic_clips/recording_TOPIC_PLAN.json'), 'utf8'));
    expect(plan.groups.map(group => group.groupId)).toEqual(['E2']);
  });

  test.each([{ planningGroupIds: [] }, { planningGroupIds: ['missing-group'] }])('rejects invalid retry selectors before making AI requests (%j)', async ({ planningGroupIds }) => {
    const job = run({ planningGroupIds });
    await expect(job.promise).rejects.toThrow(/planningGroupIds|Unknown planning group IDs/);
    expect(request).not.toHaveBeenCalled();
    expect(job.mediaGenerator).not.toHaveBeenCalled();
  });

  test('source-scoped user facts and host rules reach planning and only patch clip copies', async () => {
    const crypto = require('crypto');
    const originalSrt = fs.readFileSync(srt, 'utf8');
    const registry = path.join(dir, 'verified.json');
    fs.writeFileSync(registry, JSON.stringify({ version: 1, entries: [{ srtPath: srt,
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(srt)).digest('hex'),
      start: 0, end: 50, authority: 'user', facts: ['The host confirmed the prize.'],
      edits: [{ start: 10, end: 20, original: 'prise', replacement: 'prize' }] }] }));
    const original = request.getMockImplementation();
    request.mockImplementation(async (prompt: string, options) => {
      expect(prompt).toContain('HOST DEFAULT');
      const packet = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
      expect(packet.source.verifiedFacts).toHaveLength(packet.groupId === 'E1' ? 1 : 0);
      return original(prompt, options);
    });
    const burns = jest.fn(async (_source, window, subtitles, output) => {
      if (window.start === 0) expect(fs.readFileSync(subtitles, 'utf8')).toContain('prize');
      fs.writeFileSync(output, 'fake');
      return { path: output, burnedSubtitles: true };
    });
    const job = run({ config: { ...config, clipTopics: { ...config.clipTopics,
      review: { ...config.clipTopics.review, qualityRules: true, verifiedFactsPath: registry } } }, mediaGenerator: burns });
    const results = await job.promise;
    expect(burns).toHaveBeenCalledTimes(2);
    expect(results[0].aiReview.subtitleEdits[0].authority).toBe('user');
    expect(fs.readFileSync(srt, 'utf8')).toBe(originalSrt);
  });

  test('source changes during AI planning hold every candidate', async () => {
    const original = request.getMockImplementation();
    request.mockImplementation(async (...args) => { const result = await original(...args); fs.appendFileSync(srt, '\n'); return result; });
    const job = run();
    const results = await job.promise;
    expect(results.every(result => result.status === 'pending_preflight')).toBe(true);
    expect(job.mediaGenerator).not.toHaveBeenCalled();
  });

  test('a plan that cannot be persisted cannot start media rendering', async () => {
    const rename = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('_TOPIC_PLAN.json')) throw new Error('plan write denied');
      return rename(from, to);
    });
    try {
      const job = run();
      const results = await job.promise;
      expect(results.every(result => result.status === 'pending_preflight')).toBe(true);
      expect(job.mediaGenerator).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('staged mode finishes corrected speech and copy for every group before rendering', async () => {
    const original = request.getMockImplementation();
    request.mockImplementation(async (prompt: string, options) => {
      if (prompt.includes('LOCKED EVENT:')) {
        const locked = JSON.parse(prompt.split('LOCKED EVENT: ')[1].split('\n')[0]);
        const input = JSON.parse(prompt.split('SOURCE EVIDENCE:\n')[1]);
        const inClip = input.subtitles.filter(row => row.start >= input.subtitles[0].start && row.end <= input.subtitles.at(-1).end);
        if (input.groupId === 'E1') expect(inClip.some(row => row.text.includes('price'))).toBe(true);
        expect(locked).not.toHaveProperty('event');
        expect(locked).not.toHaveProperty('reason');
        const result = await original(prompt, options);
        const data = JSON.parse(result.text);
        delete data.hits;
        data.clips[0].subtitleEdits = [];
        return { ...result, text: JSON.stringify(data) };
      }
      return original(prompt, options);
    });
    const burns = jest.fn(async (_source, window, subtitlePath, output) => {
      expect(request).toHaveBeenCalledTimes(4);
      if (window.start === 0) expect(fs.readFileSync(subtitlePath, 'utf8')).toContain('price');
      fs.writeFileSync(output, 'fake'); return { path: output, burnedSubtitles: true };
    });
    const job = run({ config: { ...config, clipTopics: { ...config.clipTopics,
      review: { ...config.clipTopics.review, strategy: 'staged' } } }, mediaGenerator: burns });
    const results = await job.promise;
    expect(results).toHaveLength(2);
    expect(burns).toHaveBeenCalledTimes(2);
    expect(results[0].aiReview.subtitleEdits[0].replacement).toBe('price');
  });

  test.each([false, true])('independent quality audit gates every render (audit failure=%s)', async failAudit => {
    const original = request.getMockImplementation();
    request.mockImplementation(async (prompt: string, options) => {
      if (!prompt.startsWith('Independently audit')) return original(prompt, options);
      if (failAudit) throw new Error('audit unavailable');
      const drafts = JSON.parse(prompt.split('DRAFTS: ')[1].split('\n')[0]);
      return { text: JSON.stringify({ reviews: drafts.map(clip => ({ clipId: clip.id,
        verdict: 'pass', issues: [], replacement: null })), missedEvent: false, missedEvidenceCueIds: [] }),
      meta: { model: 'gpt-6-luna', attempts: [{ model: 'gpt-6-luna', responseModel: 'gpt-6-luna',
        reasoningEffortSent: 'max', apiModeUsed: 'responses' }] } };
    });
    const burns = jest.fn(async (_source, _window, _srt, output) => {
      expect(request).toHaveBeenCalledTimes(4);
      fs.writeFileSync(output, 'fake'); return { path: output, burnedSubtitles: true };
    });
    const job = run({ config: { ...config, clipTopics: { ...config.clipTopics,
      review: { ...config.clipTopics.review, strategy: 'audited' } } }, mediaGenerator: burns });
    const results = await job.promise;
    expect(results).toHaveLength(2);
    expect(burns).toHaveBeenCalledTimes(failAudit ? 0 : 2);
    expect(results.every(result => failAudit ? result.status === 'pending_preflight'
      : result.aiReview.qualityAudit.verdict === 'pass')).toBe(true);
  });
});
