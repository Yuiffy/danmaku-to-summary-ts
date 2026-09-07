const { collectSpokenClockValues, supportedClockSpans } = require('./clock_evidence');
const { buildSubtitleEvidence, linkClipEvidence } = require('./subtitle_evidence');

describe('spoken clock evidence', () => {
  test.each([
    ['\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206', '19:52'],
    ['\u4e09\u70b9\u96f6\u4e94\u5206', '03:05'],
    ['\u4e24\u65f6\u5341\u5206', '2:10'],
    ['\u3007\u70b9\u3007\u4e8c\u5206', '00:02'],
    ['19\u70b95\u5206', '19:05'],
    ['\u4e8c\u5341\u4e09\u65f6\u4e94\u5341\u4e5d\u5206\u56db\u5341\u4e8c\u79d2', '23:59:42'],
  ])('matches only the equivalent complete clock: %s -> %s', (source, copy) => {
    expect(supportedClockSpans(copy, collectSpokenClockValues([source])))
      .toEqual([{ start: 0, end: copy.length }]);
  });

  test.each([
    '\u4e8c\u5341\u56db\u70b9\u96f6\u5206',
    '\u5341\u4e5d\u70b9\u516d\u5341\u5206',
    '\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206\u516d\u5341\u79d2',
    '\u4e00\u767e\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206',
    '\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206\u949f',
    '\u5341\u4e5d \u70b9 \u4e94\u5341\u4e8c \u5206 \u949f',
    '\u5341\u4e5d\u70b9\u4e94\u4e8c\u5206',
    '19.52\u5206',
  ])('does not accept invalid, duration-like or decimal-like input: %s', source => {
    expect(collectSpokenClockValues([source]).size).toBe(0);
  });

  test('does not combine pieces from different cues or mix hours and minutes from different clocks', () => {
    expect(collectSpokenClockValues(['\u5341\u4e5d\u70b9', '\u4e94\u5341\u4e8c\u5206']).size).toBe(0);
    const values = collectSpokenClockValues(['\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206', '\u4e8c\u5341\u70b9\u56db\u5341\u5206']);
    expect(supportedClockSpans('19:40', values)).toEqual([]);
    expect(supportedClockSpans('119:52 19:52.5 19:52:99', values)).toEqual([]);
    expect(supportedClockSpans('time:19:52.', values)).toEqual([{ start: 5, end: 10 }]);
  });

  test('seconds may be omitted but cannot be invented or borrowed', () => {
    const seconds = collectSpokenClockValues(['\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206\u4e09\u5341\u79d2']);
    expect(supportedClockSpans('19:52', seconds)).toHaveLength(1);
    expect(supportedClockSpans('19:52:31', seconds)).toEqual([]);
    expect(supportedClockSpans('19:52:30', collectSpokenClockValues(['\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206']))).toEqual([]);
  });

  test('permits spacing around units without concatenating separate numeric tokens', () => {
    const spaced = collectSpokenClockValues(['\u5341\u4e5d \u70b9 \u4e94\u5341\u4e8c \u5206']);
    expect(supportedClockSpans('19:52', spaced)).toHaveLength(1);
    const separate = collectSpokenClockValues(['1 9\u70b952\u5206']);
    expect(supportedClockSpans('19:52', separate)).toEqual([]);
    expect(supportedClockSpans('9:52', separate)).toHaveLength(1);
  });

  const source = buildSubtitleEvidence([{ start: 0, end: 10, text: '\u6700\u540e\u4e00\u6b21\u4fee\u6539\u662f\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206' },
    { start: 20, end: 30, text: 'A different statement.' }]);
  const raw = { title: 'Last edited at 19:52', description: 'Last edited at 19:52.', coverText: '19:52\nLast edit',
    evidenceCueIds: ['G1'], sourceKind: 'live_speech' };

  test('accepts a cited in-clip spoken clock without changing copy or allowing its standalone components', () => {
    const before = JSON.stringify(raw);
    expect(linkClipEvidence(raw, { start: 0, end: 10 }, source).status).toBe('linked');
    expect(JSON.stringify(raw)).toBe(before);
    const otherNumber = linkClipEvidence({ ...raw, description: 'Changed it 52 times.' }, { start: 0, end: 10 }, source);
    expect(otherNumber.issues).toContain('unsupported_number:description:52');
  });

  test('does not take clock support from an uncited, unprovided or out-of-clip source', () => {
    const cases = [
      linkClipEvidence({ ...raw, evidenceCueIds: ['G2'] }, { start: 20, end: 30 }, source),
      linkClipEvidence(raw, { start: 0, end: 10 }, source, [], { cueIds: new Set() }),
      linkClipEvidence(raw, { start: 20, end: 30 }, source),
    ];
    cases.forEach(result => {
      expect(result.status).toBe('needs_review');
      expect(result.issues).toContain('unsupported_number:title:19');
      expect(result.issues).toContain('unsupported_number:title:52');
    });
    expect(cases[1].issues).toContain('unseen_subtitle:G1');
    expect(cases[2].issues).toContain('subtitle_outside_clip:G1');
  });

  test('requires a cited, provided and in-clip audience row for an audience clock', () => {
    const audience = [{ time: 22, text: '\u5341\u4e5d\u70b9\u4e94\u5341\u4e8c\u5206' }];
    const clip = { ...raw, evidenceCueIds: ['G2'], evidenceDanmakuIds: ['D1'] };
    expect(linkClipEvidence(clip, { start: 20, end: 30 }, source, audience, { danmakuIds: new Set(['D1']) }).status).toBe('linked');
    const unseen = linkClipEvidence(clip, { start: 20, end: 30 }, source, audience, { danmakuIds: new Set() });
    expect(unseen.issues).toContain('unsupported_number:title:19');
    const outside = linkClipEvidence(clip, { start: 20, end: 30 }, source, [{ ...audience[0], time: 10 }]);
    expect(outside.issues).toContain('danmaku_outside_clip:D1');
    expect(outside.issues).toContain('unsupported_number:title:19');
  });
});
