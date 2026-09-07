export {};
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildTopicQualityEvidence, buildTopicQualityPrompt, normalizeTopicQualityReview } = require('./topic_quality_review');

describe('independent topic quality review', () => {
  const segments = [
    { start: 0, end: 8, text: 'Outside: the next card is worth 9999.' },
    { start: 10, end: 22, text: 'SUI mentioned a card.' },
    { start: 24, end: 36, text: 'The card price is high.' },
    { start: 38, end: 50, text: 'The actual sale is much cheaper.' },
    { start: 54, end: 64, text: 'Outside: a new unrelated event.' }
  ];
  const evidence = buildSubtitleEvidence(segments);
  const clip = { window: { index: 'test', start: 10, end: 50, matchSegments: [segments[1]] },
    copy: { title: 'Draft', description: 'Draft', coverText: 'First\nSecond' } };
  const input = buildTopicQualityEvidence(clip, evidence);
  const valid = { clipId: 'test', status: 'revise',
    issues: [{ field: 'title', reason: 'Draft not supported', evidenceCueIds: ['G3'] }],
    proposedCopy: { clipId: 'test', title: 'The card price is high', description: 'Actual sale is cheaper.',
      coverText: 'High price\nCheaper sale', sourceKind: 'live_speech', evidenceCueIds: ['G3', 'G4'] },
    subtitleSuggestions: [], boundaryProposal: null };
  const normalize = value => normalizeTopicQualityReview(JSON.stringify(value), clip, evidence, input);

  test('clearly separates outside context from in-clip evidence and never applies suggestions', () => {
    expect(input.inClip.map(cue => cue.id)).toEqual(['G2', 'G3', 'G4']);
    expect(input.outsideContext.map(cue => cue.id)).toEqual(['G1', 'G5']);
    expect(buildTopicQualityPrompt(input)).toContain('cannot license new public claims');
    const result = normalize(valid);
    expect(result).toMatchObject({ status: 'revise', applied: false,
      proposedCopy: { title: 'The card price is high' }, window: { start: 10, end: 50 } });
    expect(clip.copy.title).toBe('Draft');
  });

  test('outside context can justify a boundary suggestion but not a public factual claim', () => {
    expect(normalize({ ...valid, boundaryProposal: { startCueId: 'G1', endCueId: 'G4', reason: 'Missing setup' } })
      .boundaryProposal).toMatchObject({ start: 0, end: 50, applied: false });
    const outside = normalize({ ...valid, proposedCopy: { ...valid.proposedCopy,
      title: 'The card cost 9999', evidenceCueIds: ['G1'] } });
    expect(outside.proposedCopy).toBeNull();
    expect(outside.proposalErrors).toHaveLength(1);
    expect(outside.issues).toEqual(valid.issues);
    expect(normalize({ ...valid, proposedCopy: { ...valid.proposedCopy, title: 'The card cost 9999' } }).proposedCopy).toBeNull();
  });

  test.each([
    { clipId: 'another' },
    { issues: [{ field: 'title', reason: 'No evidence', evidenceCueIds: ['G999'] }] },
    { status: 'pass' },
    { boundaryProposal: { startCueId: 'G4', endCueId: 'G2', reason: 'Reverse' } },
    { boundaryProposal: { startCueId: 'G3', endCueId: 'G4', reason: 'Drops anchor' } },
    { boundaryProposal: { startCueId: 'G2', endCueId: 'G999', reason: 'Unknown' } },
    { subtitleSuggestions: [{ cueId: 'G1', proposedText: 'Outside change', reason: 'Not in clip' }] }
  ])('rejects malformed, unsupported and conflicting reviews: %j', patch => {
    expect(() => normalize({ ...valid, ...patch })).toThrow();
  });

  test('an actual pass contains no issues or rewrites', () => {
    expect(normalize({ ...valid, status: 'pass', issues: [], proposedCopy: null }).status).toBe('pass');
  });

  test('accepts a JSON object after provider commentary without relaxing evidence validation', () => {
    const text = 'Review follows.\n```json\n' + JSON.stringify(valid) + '\n```';
    expect(normalizeTopicQualityReview(text, clip, evidence, input).proposedCopy.title).toBe(valid.proposedCopy.title);
  });
});
