import { selectSongExcerpt } from './activitySongEdit';

const event = { id: 'song', kind: 'song', start: 100, end: 1500, performance: 'full',
  verification: { decision: 'uncertain', nativeListening: { path: 'bound.json', sha256: 'original' } },
  reviewIssues: ['start_boundary_unconfirmed'] };

test('operator selection narrows a draft while preserving evidence and uncertainty', () => {
  const result = selectSongExcerpt(event, { activityId: 'song', start: 1150, end: 1490, note: '只保留最后一次演唱' });
  expect(result).toMatchObject({ start: 1150, end: 1490, performance: 'fragment', startObserved: false, endObserved: false,
    provisionalWindow: { start: 1150, end: 1490 }, verification: { decision: 'uncertain', nativeListening: event.verification.nativeListening },
    operatorBoundaryEdit: { automaticBoundaryApproved: false, sourceWindow: { start: 100, end: 1500 } } });
  expect(result.reviewIssues).toContain('media_verification_unconfirmed');
  expect(event.start).toBe(100);
});

test.each([
  { start: 99, end: 1490 }, { start: 1150, end: 1501 }, { start: 1200, end: 1100 },
  { start: NaN, end: 1490 }, { start: 100, end: 1500 }, { activityId: 'other', start: 1150, end: 1490 },
  { start: 1150, end: 1490, note: '' }
])('rejects expansion, invalid scope and missing feedback: %j', override => {
  expect(() => selectSongExcerpt(event, { activityId: 'song', start: 1150, end: 1490, note: 'feedback', ...override })).toThrow();
});

test('does not reopen independently confirmed songs', () => {
  expect(() => selectSongExcerpt({ ...event, verification: { decision: 'keep' } },
    { activityId: 'song', start: 1150, end: 1490, note: 'feedback' })).toThrow();
});
