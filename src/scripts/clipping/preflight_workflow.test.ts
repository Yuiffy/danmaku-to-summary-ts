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
      model: 'gpt-5.6-luna', reasoningEffort: 'max' }, ai: { selectionCacheEnabled: false } } };

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
        subtitleEdits: input.groupId === 'E1' ? [{ cueId: input.hits[0].cueId, original: 'prise', replacement: 'price',
          reason: 'Original ASR corroborates the word', evidenceCueIds: [input.hits[0].cueId] }] : []
      }] }), meta: { model: 'gpt-5.6-luna', attempts: [{ model: 'gpt-5.6-luna',
        reasoningEffortSent: 'max', apiModeUsed: 'responses', responseModel: 'gpt-5.6-luna' }] } };
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
    const register = jest.fn((_path, results) => ({ clipIds: results.map((_r, i) => 700 + i) }));
    return { mediaGenerator, coverGenerator, register, promise: topic.generateTopicClips({ config,
      originalMediaPath: media, srtPath: srt, mediaGenerator, coverGenerator,
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

  test('provider failure does not silently render unreviewed fallback clips', async () => {
    request.mockRejectedValue(new Error('provider failed'));
    const job = run();
    const results = await job.promise;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(result => result.status === 'pending_preflight' && !result.uploadReady && !result.output.mediaPath)).toBe(true);
    expect(job.mediaGenerator).not.toHaveBeenCalled();
    expect(job.coverGenerator).not.toHaveBeenCalled();
    expect(job.register).not.toHaveBeenCalled();
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
      meta: { model: 'gpt-5.6-luna', attempts: [{ model: 'gpt-5.6-luna', responseModel: 'gpt-5.6-luna',
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
