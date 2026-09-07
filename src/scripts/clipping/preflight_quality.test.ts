export {};
const { buildPreflightEvidence, buildPreflightInput } = require('./preflight_evidence');
const { normalizePreflightResponse } = require('./preflight_plan');
const { buildQualityAuditPrompt, applyQualityAudit, planFingerprint, buildQualityDraftPrompt } = require('./preflight_quality');
const { getClipTopicsConfig } = require('./topic_config');
const config = getClipTopicsConfig({ clipTopics: { keywords: ['SUI'] } });
const segments = [
  { start: 0, end: 8, text: 'The person and question are introduced.' },
  { start: 10, end: 18, text: 'SUI allegedly did it unconsciously.' },
  { start: 20, end: 32, text: 'No, I meant to write that name.' },
  { start: 35, end: 45, text: 'I misspelled the name and said it was deliberate.' },
  { start: 50, end: 60, text: 'They noticed the surprised expression.' }
];
const evidence = buildPreflightEvidence(segments);
const group = { index: 'E1', start: 0, end: 60, cues: evidence.cues,
  matchSegments: [{ ...segments[1], matchedKeywords: ['SUI'] }] };
const input = buildPreflightInput(group, evidence, config);
const rawClip = { id: 'E1-1', status: 'ready', startCueId: 'G1', endCueId: 'G5', hitIds: ['K1'], event: 'A disputed name',
  reason: 'The dispute has a payoff', score: 80, sourceKind: 'recount', warnings: [], extensionReason: '',
  evidenceCueIds: ['G2', 'G3', 'G4', 'G5'], evidenceDanmakuIds: [],
  title: 'SUI acted unconsciously', description: 'A name was misspelled.', coverText: 'A name\nA dispute', subtitleEdits: [] };
const plan = normalizePreflightResponse(JSON.stringify({ hits: [{ id: 'K1', verdict: 'mention',
  reason: 'The name is discussed', evidenceCueIds: ['G2'] }], clips: [rawClip] }), input, evidence, config);
const row = { clipId: 'E1-1', verdict: 'repair', issues: [{ kind: 'fact', reason: 'Draft ignores immediate denial', evidenceCueIds: ['G2', 'G3'] }],
  replacement: { ...rawClip, title: 'A misspelled name leads to a dispute', evidenceCueIds: ['G3', 'G4', 'G5'] } };
const audit = reviews => JSON.stringify({ reviews, missedEvent: false, missedEvidenceCueIds: [] });

test('independent audit sees the denial and final artifact, not model costs or speculative draft reasons', () => {
  const prompt = buildQualityAuditPrompt(plan, input);
  expect(prompt).toContain(segments[2].text);
  expect(prompt).not.toContain('The dispute has a payoff');
  expect(prompt).not.toContain('gpt-5.6');
  expect(prompt).not.toContain('promptTokens');
  expect(buildQualityDraftPrompt(input)).toContain('A teasing accusation');
});

test('ordinary first-person speech belongs to the host unless the source establishes an exception', () => {
  for (const prompt of [buildQualityDraftPrompt(input), buildQualityAuditPrompt(plan, input)]) {
    expect(prompt).toContain('HOST DEFAULT');
    expect(prompt).toContain('Do NOT require the host to say their own name');
    expect(prompt).toContain('positive source evidence');
    expect(prompt).toContain('guest, another person in playback');
  }
});

test('a source-supported repair is applied before rendering without mutating the original plan', () => {
  const fingerprint = planFingerprint(plan);
  const corrected = applyQualityAudit(audit([row]), plan, input, evidence, config);
  expect(corrected.clips[0].copy.title).toBe(row.replacement.title);
  expect(corrected.clips[0].qualityAudit.verdict).toBe('repair');
  expect(planFingerprint(plan)).toBe(fingerprint);
});

test.each([
  [], [row, row], [{ ...row, clipId: 'missing' }], [{ ...row, issues: [] }],
  [{ ...row, verdict: 'pass' }], [{ ...row, replacement: { ...row.replacement, id: 'E1-2' } }],
  [{ ...row, issues: [{ ...row.issues[0], evidenceCueIds: ['G999'] }] }]
].map(reviews => [reviews]))('rejects incomplete or ungrounded reviews: %j', reviews => {
  expect(() => applyQualityAudit(audit(reviews), plan, input, evidence, config)).toThrow();
});

test('hold and drop cannot authorize a render, and pass cannot erase a previous hold', () => {
  for (const verdict of ['hold', 'drop']) {
    expect(applyQualityAudit(audit([{ ...row, verdict, replacement: null }]), plan, input, evidence, config)
      .clips[0].status).toBe('needs_review');
  }
  const held = { ...plan, clips: [{ ...plan.clips[0], status: 'needs_review' }] };
  expect(applyQualityAudit(audit([{ clipId: 'E1-1', verdict: 'pass', issues: [], replacement: null }]),
    held, input, evidence, config).clips[0].status).toBe('needs_review');
});

test('a reviewer cannot smuggle unsupported quotes or subtitle edits into a ready plan', () => {
  const changed = { ...row, replacement: { ...row.replacement, title: 'They said "never spoken words"' } };
  expect(applyQualityAudit(audit([changed]), plan, input, evidence, config).clips[0].status).toBe('needs_review');
  const patch = { ...row, replacement: { ...row.replacement, subtitleEdits: [{ cueId: 'G2', original: 'unconsciously',
    replacement: 'intentionally', reason: 'Guess', evidenceCueIds: ['G2'] }] } };
  expect(applyQualityAudit(audit([patch]), plan, input, evidence, config).clips[0].status).toBe('needs_review');
});

test('an invalid repair holds only that clip and cannot suppress an independently valid clip', () => {
  const invalid = { ...row, replacement: { ...row.replacement, startCueId: 'G2', endCueId: 'G2' } };
  const two = { ...plan, clips: [plan.clips[0], { ...plan.clips[0], id: 'E1-2', start: 70, end: 130 }] };
  const audited = applyQualityAudit(audit([invalid, { clipId: 'E1-2', verdict: 'pass', issues: [], replacement: null }]),
    two, input, evidence, config);
  expect(audited.clips[0].status).toBe('needs_review');
  expect(audited.clips[0].qualityAudit.validationError).toContain('duration');
  expect(audited.clips[1].status).toBe('ready');
});

test('user-confirmed subtitle patches stay scoped to their exact source row', () => {
  const source = [{ start: 0, end: 40, text: '岁己SPG' }];
  const refs = buildPreflightEvidence(source);
  const packet = buildPreflightInput({ index: 'E1', start: 0, end: 40, cues: refs.cues, matchSegments: [{ ...source[0] }] }, refs, config,
    { verifiedFacts: ['User correction'], verifiedEdits: [{ start: 0, end: 40, original: '岁己SPG', replacement: '岁己 is pig' },
      { start: 50, end: 70, original: 'unrelated', replacement: 'different' }] });
  expect(packet.verifiedEdits).toHaveLength(1);
  const { applyPreflightSubtitleEdits } = require('./preflight_plan');
  const patched = applyPreflightSubtitleEdits([{ cueId: 'G1', original: '岁己SPG', replacement: '岁己 is pig',
    reason: 'User confirmed', evidenceCueIds: ['G1'] }], { start: 0, end: 40 }, refs, packet, []);
  expect(patched.segments[0].text).toBe('岁己 is pig');
  const normalized = normalizePreflightResponse(JSON.stringify({ hits: [{ id: 'K1', verdict: 'mention', reason: 'User confirmed',
    evidenceCueIds: ['G1'] }], clips: [{ ...rawClip, startCueId: 'G1', endCueId: 'G1',
    evidenceCueIds: ['G1'], subtitleEdits: [] }] }), packet, refs, config);
  expect(normalized.clips[0].subtitleSegments[0].text).toBe('岁己 is pig');
  expect(normalized.clips[0].subtitleEdits[0].authority).toBe('user');
});
