export {};
const { buildKeywordEvidence, buildKeywordReviewPrompt, normalizeKeywordReview } = require('./keyword_review');
const { getClipTopicsConfig } = require('./topic_config');
const { runTopicShadowReview, topicReviewLines } = require('./topic_review_runner');
const generator = require('../ai_text_generator');
const fs = require('fs');
const os = require('os');
const path = require('path');
const topicClipper = require('../topic_clipper');

test('dense legacy burst sampling retains consecutive sentences around the keyword', () => {
  const source = Array.from({ length: 1000 }, (_, index) => ({ start: index, end: index + 0.8,
    text: index === 600 ? 'SUI' : `Sentence ${index}` }));
  const matches = [{ index: 600, segment: source[600], matchedKeywords: ['SUI'] }];
  const [burst] = topicClipper.buildTopicBursts(source, matches, { maxSegmentsPerBurst: 200,
    contextPrePaddingSeconds: 180, contextPostPaddingSeconds: 300 });
  expect(burst.contextSampled).toBe(true);
  expect(burst.allSegments).toHaveLength(200);
  for (let index = 556; index <= 644; index += 1) expect(burst.allSegments).toContain(source[index]);
});

describe('keyword review evidence and decisions', () => {
  const segments = Array.from({ length: 80 }, (_, index) => ({ start: index * 5, end: index * 5 + 3,
    text: index === 60 ? 'SUI mentioned here' : `Sentence ${index}` }));
  const matches = [{ segment: segments[60], matchedKeywords: ['SUI'] }];
  const evidence = buildKeywordEvidence(segments, matches);
  const hit = { id: 'K1', verdict: 'confirmed', reason: 'Source identifies the person',
    alternative: '', evidenceCueIds: ['S61'] };
  const response = hits => JSON.stringify({ hits });

  test('keeps contiguous hit-centered context instead of the beginning of the recording', () => {
    expect(evidence.subtitles.map(row => row.id)).toContain('S61');
    expect(evidence.subtitles.at(-1).start).toBeGreaterThan(segments[60].end);
    expect(evidence.subtitles[0].id).not.toBe('S1');
    expect(buildKeywordReviewPrompt(evidence)).toContain('NOT independent evidence');
    expect(() => buildKeywordEvidence(segments, matches, { maxEvidenceChars: 1 })).toThrow('budget');
    expect(() => buildKeywordEvidence(segments, [])).toThrow('No keyword');
  });

  test('keeps all three verdicts and does not coerce strings to booleans', () => {
    expect(normalizeKeywordReview(response([hit]), evidence).status).toBe('confirmed');
    expect(normalizeKeywordReview(response([{ ...hit, verdict: 'rejected' }]), evidence).status).toBe('rejected');
    expect(normalizeKeywordReview(response([{ ...hit, verdict: 'uncertain' }]), evidence).status).toBe('needs_review');
    expect(() => normalizeKeywordReview(response([{ ...hit, verdict: 'false' }]), evidence)).toThrow();
  });

  test.each([
    [], [hit, hit], [{ ...hit, id: 'unknown' }], [{ ...hit, reason: '' }],
    [{ ...hit, evidenceCueIds: ['S900'] }], [{ ...hit, evidenceCueIds: [] }],
    [{ ...hit, evidenceCueIds: ['S62'] }]
  ].map(hits => [hits]))('rejects missing, duplicate or ungrounded assessments: %j', hits => {
    expect(() => normalizeKeywordReview(response(hits), evidence)).toThrow();
  });

  test('passes through original evidence but does not invent it for old subtitles', () => {
    expect(evidence.subtitles[0].asr.status).toBe('unavailable');
    const withSource = segments.map(row => ({ ...row, asrEvidence: { status: 'available',
      sourceSpan: { rawText: 'sleep a few hours', phonemeCorrections: [{ score: 0.98 }] } } }));
    const input = buildKeywordEvidence(withSource, matches);
    expect(input.subtitles[0].asr.sourceSpan.rawText).toBe('sleep a few hours');
    expect(buildKeywordReviewPrompt(input)).toContain('NOT a probability');
  });

  test('shadow mode does not turn a rejected keyword or provider failure into changed copy or media', async () => {
    const clip = { window: { index: 'test', start: 295, end: 335, matchSegments: [segments[60]] },
      copy: { title: 'Existing title', description: 'Existing description', coverText: 'First\nSecond' } };
    const original = JSON.stringify(clip);
    const request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('Decide whether EACH')) return { text: response([{ ...hit, verdict: 'rejected' }]) };
      throw new Error('quality request unavailable');
    });
    const config = getClipTopicsConfig({ clipTopics: { review: { enabled: true } } });
    const diagnostics = { requests: [], failures: [] };
    try {
      const review = await runTopicShadowReview(clip, segments, config, { ai: { text: { provider: 'daiYu' } } }, {}, diagnostics);
      expect(review).toMatchObject({ mode: 'shadow', applied: false,
        keyword: { status: 'rejected' }, quality: { status: 'unavailable' } });
      expect(diagnostics.failures).toHaveLength(1);
      expect(JSON.stringify(clip)).toBe(original);
      expect(topicReviewLines(review).join(' ')).toContain('rejected');
    } finally { request.mockRestore(); }
  });

  test('default-off and globally disabled AI never trigger review calls', async () => {
    expect(await runTopicShadowReview({}, [], getClipTopicsConfig({}), {}, {}, {})).toBeNull();
    const config = getClipTopicsConfig({ clipTopics: { review: { enabled: true } } });
    expect(await runTopicShadowReview({}, [], config, { ai: { text: { enabled: false } } }, {}, {})).toBeNull();
  });

  test('enabled review reaches metadata and REVIEW without changing the final edit or upload authorization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-shadow-workflow-'));
    const mediaPath = path.join(dir, 'recording.mp4');
    const srtPath = path.join(dir, 'recording.srt');
    fs.writeFileSync(mediaPath, 'fake');
    const source = [
      { start: 0, end: 12, text: 'Complete setup.' },
      { start: 15, end: 20, text: 'SUI in a questionable sentence.' },
      { start: 21, end: 40, text: 'Complete ending.' }
    ];
    topicClipper.writeClipSrt(source, { start: 0, end: 40 }, srtPath);
    const request = jest.spyOn(generator, 'generateTextWithDaiYu').mockImplementation(async (prompt: string) => {
      const body = JSON.parse(prompt.split('\n').at(-1));
      if (prompt.startsWith('Decide whether EACH')) return { text: JSON.stringify({ hits: body.hits.map(item => ({
        id: item.id, verdict: 'rejected', reason: 'Synthetic negative', alternative: 'ordinary phrase', evidenceCueIds: [item.cueId]
      })) }) };
      return { text: JSON.stringify({ clipId: body.clipId, status: 'uncertain',
        issues: [{ field: 'keyword', reason: 'Needs listening', evidenceCueIds: [body.inClip.match(/^G\d+/)[0]] }],
        proposedCopy: null, subtitleSuggestions: [], boundaryProposal: null }) };
    });
    const mediaGenerator = jest.fn(async (_source, _window, _srt, output) => {
      fs.writeFileSync(output, 'fake clip'); return { path: output, burnedSubtitles: true };
    });
    const register = jest.fn(() => ({ clipIds: [123] }));
    try {
      const results = await topicClipper.generateTopicClips({ originalMediaPath: mediaPath, srtPath,
        config: { ai: { text: { provider: 'daiYu' } }, clipTopics: {
          enabled: true, keywords: ['SUI'], aiSegmentBurst: false, review: { enabled: true }
        } },
        mediaGenerator, coverGenerator: async () => null, registerReviewForUpload: register,
        notifyTopicClipResults: async () => true,
        titleGenerator: async () => 'Original copy', descriptionGenerator: async () => 'Original description' });
      expect(results).toHaveLength(1);
      expect(results[0].aiReview).toMatchObject({ applied: false, keyword: { status: 'rejected' } });
      expect(results[0].copy.title).toBe('Original copy');
      expect(results[0].autoUploadEnabled).toBe(false);
      expect([results[0].window.start, results[0].window.end]).toEqual([mediaGenerator.mock.calls[0][1].start, mediaGenerator.mock.calls[0][1].end]);
      expect(fs.readFileSync(path.join(dir, 'topic_clips', 'REVIEW.md'), 'utf8')).toContain('rejected');
      expect(register).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally { request.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
