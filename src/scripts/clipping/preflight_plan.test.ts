export {};
const { buildPreflightEvidence, buildPreflightInput } = require('./preflight_evidence');
const { normalizePreflightResponse, applyPreflightSubtitleEdits } = require('./preflight_plan');
const { getClipTopicsConfig } = require('./topic_config');
const { requestMatches } = require('./preflight_runner');
const config = getClipTopicsConfig({ clipTopics: { keywords: ['SUI'], minClipSeconds: 30 } });
const segments = [
  { start: 0, end: 8, text: 'Outside fact 9999.' },
  { start: 10, end: 20, text: 'SUI shared a prise.', asrEvidence: { sourceSpan: {
    start: 10, end: 20, rawText: 'SUI shared a price.', recognizedText: 'SUI shared a prise.' } } },
  { start: 21, end: 42, text: 'The full response is here.' },
  { start: 43, end: 54, text: 'An unrelated next event.' }
];
const evidence = buildPreflightEvidence(segments);
const group = { index: 'E1', start: 0, end: 54, cues: evidence.cues,
  matchSegments: [{ ...segments[1], matchedKeywords: ['SUI'] }] };
const input = buildPreflightInput(group, evidence, config);
const hit = { id: 'K1', verdict: 'mention', reason: 'Real person in context', evidenceCueIds: ['G2'] };
const edit = { cueId: 'G2', original: 'prise', replacement: 'price', reason: 'Original ASR supports price', evidenceCueIds: ['G2'] };
const clip = { id: 'E1-1', status: 'ready', startCueId: 'G2', endCueId: 'G3', hitIds: ['K1'],
  event: 'A price story', reason: 'Complete answer', score: 80, extensionReason: '', sourceKind: 'live_speech',
  evidenceCueIds: ['G2', 'G3'], evidenceDanmakuIds: [], warnings: [],
  title: 'A price story', description: 'A complete answer about the price.', coverText: 'The price\nFull response', subtitleEdits: [edit] };
const normalize = (value, options = {}) => normalizePreflightResponse(JSON.stringify(value), input, evidence, config, options);

test('preserves per-row boundaries and raw provenance without modifying source subtitles', () => {
  expect(evidence.cues).toHaveLength(4);
  expect(input.originalAsrSpans[0].rawText).toBe('SUI shared a price.');
  const before = JSON.stringify(segments);
  const plan = normalize({ hits: [hit], clips: [clip] });
  expect(plan.clips[0]).toMatchObject({ start: 10, end: 42, status: 'ready' });
  expect(plan.clips[0].subtitleSegments[0].text).toBe('SUI shared a price.');
  expect(plan.clips[0].subtitleSegments[0].start).toBe(10);
  expect(JSON.stringify(segments)).toBe(before);
});

test('normalizes a spoken purchase date during initial preflight using recording context', () => {
  const rows = [{ start: 10, end: 42, text: 'SUI说这是二零年十二月买的' }];
  const refs = buildPreflightEvidence(rows);
  const packet = buildPreflightInput({ index: 'E1', start: 10, end: 42, cues: refs.cues,
    matchSegments: [{ ...rows[0], matchedKeywords: ['SUI'] }] }, refs, config, { recordedAt: '2026-09-11 10:08:50' });
  const result = normalizePreflightResponse(JSON.stringify({
    hits: [{ ...hit, evidenceCueIds: ['G1'] }], clips: [{ ...clip, startCueId: 'G1', endCueId: 'G1',
      evidenceCueIds: ['G1'], subtitleEdits: [], description: '购于2020年12月' }]
  }), packet, refs, config);
  expect(result.clips[0].status).toBe('ready');
  expect(result.clips[0].grounding.referenceYear).toBe(2026);
});

test.each([
  { hits: [], clips: [] },
  { hits: [hit, hit], clips: [] },
  { hits: [{ ...hit, verdict: 'true' }], clips: [] },
  { hits: [{ ...hit, evidenceCueIds: ['G100'] }], clips: [] },
  { hits: [hit], clips: [{ ...clip, endCueId: 'G999' }] },
  { hits: [hit], clips: [{ ...clip, startCueId: 'G3', endCueId: 'G2' }] },
  { hits: [hit], clips: [{ ...clip, startCueId: 'G3', endCueId: 'G4' }] },
  { hits: [hit], clips: [clip, { ...clip, id: 'E1-2' }] }
])('rejects incomplete and invalid source plans: %j', value => {
  expect(() => normalize(value)).toThrow();
});

test('negative anchors can yield zero clips without a fallback render', () => {
  const result = normalize({ hits: [{ ...hit, verdict: 'false_match' }], clips: [] });
  expect(result.clips).toEqual([]);
  expect(result.hits[0].verdict).toBe('false_match');
  expect(() => normalize({ hits: [{ ...hit, verdict: 'false_match' }], clips: [clip] })).toThrow('eligible');
});

test.each([
  { ...edit, original: 'stale phrase' },
  { ...edit, replacement: 'unsupported fact' },
  { ...edit, evidenceCueIds: ['G1', 'G2'] },
  { ...edit, cueId: 'G1', original: 'Outside', replacement: 'Changed' }
])('rejects unsafe optional subtitle changes while keeping the original speech: %j', patch => {
  const result = normalize({ hits: [hit], clips: [{ ...clip, subtitleEdits: [patch] }] });
  expect(result.clips[0].status).toBe('ready');
  expect(result.clips[0].subtitleSegments[0].text).toBe(segments[1].text);
  expect(result.clips[0].rejectedSubtitleEdits).toHaveLength(1);
});

test('does not allow overlapping patches, uncertain identities or out-of-clip public claims', () => {
  expect(() => applyPreflightSubtitleEdits([edit, edit], { start: 10, end: 42 }, evidence, input, [hit])).toThrow('Overlapping');
  expect(normalize({ hits: [{ ...hit, verdict: 'uncertain' }], clips: [clip] }).clips[0].status).toBe('needs_review');
  expect(normalize({ hits: [hit], clips: [{ ...clip, title: 'A 9999 price story' }] }).clips[0].status).toBe('needs_review');
});

test('second-stage copy cannot silently move the locked edit', () => {
  const planned = normalize({ hits: [hit], clips: [clip] }, { phase: 'plan' });
  expect(planned.clips[0].copy).toBeNull();
  expect(planned.clips[0].subtitleSegments[0].text).toBe('SUI shared a price.');
  expect(() => normalize({ clips: [{ ...clip, endCueId: 'G4' }] }, {
    phase: 'finish', lockedClip: planned.clips[0], lockedHits: planned.hits
  })).toThrow('locked');
  const uncertain = normalize({ hits: [hit], clips: [{ ...clip, sourceKind: 'uncertain' }] }, { phase: 'plan' });
  expect(normalize({ clips: [{ ...clip, subtitleEdits: [] }] }, { phase: 'finish',
    lockedClip: uncertain.clips[0], lockedHits: uncertain.hits }).clips[0].status).toBe('needs_review');
});

test('an unrelated repeated word does not authorize negation, number or pronoun changes', () => {
  const source = [{ start: 0, end: 12, text: 'SUI不喜欢这个，价格十四元，他说的' },
    { start: 13, end: 40, text: '我喜欢别的，四十元是另一件商品，她在旁边' }];
  const refs = buildPreflightEvidence(source);
  const packet = buildPreflightInput({ index: 'E1', start: 0, end: 40, cues: refs.cues,
    matchSegments: [{ ...source[0], matchedKeywords: ['SUI'] }] }, refs, config);
  for (const [original, replacement] of [['不喜欢', '喜欢'], ['十四', '四十'], ['他', '她']]) {
    expect(() => applyPreflightSubtitleEdits([{ cueId: 'G1', original, replacement, reason: 'A nearby line contains it',
      evidenceCueIds: ['G1', 'G2'] }], { start: 0, end: 40 }, refs, packet, [])).toThrow('corroboration');
  }
});

test('a missing, downgraded or substituted runtime cannot pass model verification', () => {
  const settings = { primaryModel: 'gpt-5.6-sol', reasoningEffort: 'max' };
  const attempt = { model: 'gpt-5.6-sol', responseModel: 'gpt-5.6-sol', apiModeUsed: 'responses',
    reasoningEffortSent: 'max', reasoningEffortReturned: 'max' };
  expect(requestMatches({ meta: { attempts: [attempt] } }, settings)).toBe(true);
  expect(requestMatches({}, settings)).toBe(false);
  for (const patch of [{ model: 'gpt-5.6-luna' }, { reasoningEffortSent: 'high' },
    { reasoningEffortReturned: 'high' }, { apiModeUsed: 'chatCompletions' }]) {
    expect(requestMatches({ meta: { attempts: [{ ...attempt, ...patch }] } }, settings)).toBe(false);
  }
});

test('local word corroboration does not require changing an unrelated ASR name variant', () => {
  const source = [{ start: 0, end: 40, text: '能不能每天都让小岁摸一下我的毛呀' }];
  const refs = buildPreflightEvidence(source);
  const packet = buildPreflightInput({ index: 'E1', start: 0, end: 40, cues: refs.cues,
    matchSegments: [{ ...source[0], matchedKeywords: ['小岁'] }] }, refs, config, {}, [],
  [{ backend: 'independent', segments: [{ start: 0, end: 40, text: '能不能每天都让小C摸一下我的猫呀' }] }]);
  const edited = applyPreflightSubtitleEdits([{ cueId: 'G1', original: '我的毛', replacement: '我的猫',
    reason: 'Locally aligned independent ASR', evidenceCueIds: ['G1'] }], { start: 0, end: 40 }, refs, packet, []);
  expect(edited.segments[0].text).toBe('能不能每天都让小岁摸一下我的猫呀');
});

test('production topic clips inherit the established GPU burn settings with explicit topic overrides', () => {
  const production = require('../../../config/production.json');
  expect(getClipTopicsConfig(production)).toMatchObject({ subtitleVideoEncoder: 'h264_nvenc', subtitleHwaccel: 'cuda' });
  expect(getClipTopicsConfig({ ownStreamClips: { subtitleVideoEncoder: 'h264_nvenc' },
    clipTopics: { subtitleVideoEncoder: 'libx264' } }).subtitleVideoEncoder).toBe('libx264');
});

test('a rejected subtitle rewrite cannot become quoted evidence for the final copy', () => {
  const result = normalize({ hits: [hit], clips: [{ ...clip, title: 'SUI said "invented speech"',
    subtitleEdits: [{ ...edit, replacement: 'invented speech' }] }] });
  expect(result.clips[0].rejectedSubtitleEdits).toHaveLength(1);
  expect(result.clips[0].status).toBe('needs_review');
  expect(result.clips[0].grounding.issues.some(issue => issue.startsWith('unsupported_quote'))).toBe(true);
});
