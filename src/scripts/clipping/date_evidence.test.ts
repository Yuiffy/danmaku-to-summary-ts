export {};
const { buildSubtitleEvidence, linkClipEvidence, revalidateClipEvidence } = require('./subtitle_evidence');

function checkDate(text: string, description: string, options: any = {}) {
  const source = buildSubtitleEvidence([{ start: 0, end: 10, text }]);
  return linkClipEvidence({ description, evidenceCueIds: ['G1'], sourceKind: 'live_speech' },
    { start: 0, end: 10 }, source, [], { referenceYear: 2026, ...options });
}

describe('spoken date evidence', () => {
  test.each([
    ['不对不对二零年十二月的时候买的', '购于2020年12月'],
    ['二零二零年十二月买的', '购于2020年12月'],
    ['二〇二〇年十二月买的', '购于2020年12月'],
    ['九月二十八号是生日', '生日是9月28日'],
    ['二零二零年十二月二十八日买的', '购于2020年12月'],
    ['一九九九年十二月', '1999年12月'],
    ['九九年十二月', '1999年12月'],
  ])('accepts a complete equivalent date: %s -> %s', (speech, copy) => {
    expect(checkDate(speech, copy).issues).toEqual([]);
  });

  test.each([
    ['二零年十二月', '2021年12月'],
    ['二零年十二月', '2020年11月'],
    ['二零年十二月', '共2020元，12次'],
    ['二十年十二个月', '2020年12月'],
    ['二零二零年十三月', '2020年13月'],
    ['二零二零年十二月三十二日', '2020年12月32日'],
    ['一万二零二零年十二月', '2020年12月'],
    ['二零二零年十一月和二零二一年十二月', '2020年12月'],
    ['二零二零年，十二月', '2020年12月'],
  ])('rejects mismatched, unitless or assembled dates: %s -> %s', (speech, copy) => {
    expect(checkDate(speech, copy).issues.some((issue: string) => issue.startsWith('unsupported_number:'))).toBe(true);
  });

  test('requires the recording year to resolve an abbreviated year', () => {
    expect(checkDate('二零年十二月', '2020年12月', { referenceYear: undefined }).issues)
      .toContain('unsupported_number:description:2020');
    expect(checkDate('二零年十二月', '2020年12月', { referenceYear: 1926 }).issues)
      .toContain('unsupported_number:description:2020');
    expect(checkDate('二零二零年十二月', '2020年12月', { referenceYear: undefined }).issues).toEqual([]);
  });

  test('preserves recording context when checking the same copy again', () => {
    const source = buildSubtitleEvidence([{ start: 0, end: 10, text: '二零年十二月买的' }]);
    const clip = { start: 0, end: 10, description: '2020年12月买的' };
    const grounding = linkClipEvidence({ ...clip, evidenceCueIds: ['G1'], sourceKind: 'live_speech' },
      clip, source, [], { referenceYear: 2026 });
    expect(revalidateClipEvidence({ ...clip, grounding }, source, []).grounding).toEqual(grounding);
  });

  test('uses only cited, provided, in-window rows and never joins dates across cues', () => {
    const source = buildSubtitleEvidence([
      { start: 0, end: 2, text: '二零二零年' }, { start: 5, end: 8, text: '十二月' },
      { start: 10, end: 15, text: '二零二零年十二月' }
    ], { groupSegments: false });
    const raw = { description: '2020年12月', sourceKind: 'live_speech' };
    for (const result of [
      linkClipEvidence({ ...raw, evidenceCueIds: ['G1', 'G2'] }, { start: 0, end: 8 }, source),
      linkClipEvidence({ ...raw, evidenceCueIds: ['G3'] }, { start: 0, end: 8 }, source),
      linkClipEvidence({ ...raw, evidenceCueIds: ['G3'] }, { start: 10, end: 15 }, source, [], { cueIds: new Set() }),
    ]) expect(result.issues).toContain('unsupported_number:description:2020');
  });
});
