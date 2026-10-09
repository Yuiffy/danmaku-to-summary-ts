import { endingTimingIssues, withPreflightEndingHold } from './preflightEnding';

const clip = { start: 10, end: 40, status: 'ready' };
const cues = [{ id: 'G1', start: 10, end: 40 }, { id: 'G2', start: 45, end: 50 }];

test('coarse ASR segment splitting cannot certify the ending while a complete segment can', () => {
  const input = { subtitles: [{ id: 'G1', start: 10, end: 40, rawRef: 'R1' }],
    originalAsrSpans: [{ id: 'R1', start: 10, end: 45, timingPrecision: 'segment' }] };
  expect(endingTimingIssues({ ...clip, endCueId: 'G1' }, input)).toHaveLength(1);
  expect(endingTimingIssues({ ...clip, end: 45, endCueId: 'G1' }, input)).toEqual([]);
  expect(endingTimingIssues({ ...clip, end: 44.999, endCueId: 'G1' }, input)).toEqual([]);
  expect(endingTimingIssues({ ...clip, endCueId: 'G1' }, { ...input,
    originalAsrSpans: [{ ...input.originalAsrSpans[0], timingPrecision: 'word' }] })).toEqual([]);
  expect(endingTimingIssues({ ...clip, endCueId: 'G1' }, { subtitles: input.subtitles })).toEqual([]);
});

test('retains existing breathing room and stops before excluded, touching or overlapping speech', () => {
  expect(withPreflightEndingHold(clip, cues, 60, 100)).toMatchObject({ end: 43,
    endingHold: { speechEnd: 40, seconds: 3 } });
  expect(withPreflightEndingHold(clip, [{ ...cues[1], start: 41 }], 60, 100)).toMatchObject({ end: 40.92 });
  for (const start of [39, 40, 40.04]) {
    expect(withPreflightEndingHold(clip, [{ ...cues[1], start }], 60, 100)).toMatchObject({ end: 40 });
  }
  expect(clip.end).toBe(40);
});

test('padding respects context, duration and sibling clips and never expands a held candidate', () => {
  expect(withPreflightEndingHold(clip, [], 41, 100)).toMatchObject({ end: 41 });
  expect(withPreflightEndingHold(clip, [], 60, 31)).toMatchObject({ end: 41 });
  expect(withPreflightEndingHold(clip, [], 60, 100, 42)).toMatchObject({ end: 42 });
  expect(withPreflightEndingHold({ ...clip, status: 'needs_review' }, cues, 60, 100)).toMatchObject({ end: 40 });
  expect(withPreflightEndingHold(clip, [], NaN, 100)).toBe(clip);
});
