import { selectWatchBoundary } from './activityWatchEdit';

const event = { id: 'movie', kind: 'watch', start: 8252, end: 14370, mediaKind: 'movie',
  name: null, verification: { decision: 'uncertain', method: 'independent_local_asr' },
  reviewIssues: ['media_verification_unconfirmed', 'watch_boundary_provisional'] };

test('explicit watch boundary repair expands the same session and preserves evidence', () => {
  const result = selectWatchBoundary(event, { activityId: 'movie', start: 8225, end: 14940,
    name: '电锯惊魂', publicName: '浴缸钥匙逃生局', note: '保留影片结尾后的连续讨论，直到切换到下一部剧' });
  expect(result).toMatchObject({ start: 8225, end: 14940, name: '电锯惊魂', publicName: '浴缸钥匙逃生局',
    startObserved: true, endObserved: true, verification: { decision: 'keep' },
    operatorBoundaryEdit: { automaticBoundaryApproved: false, sourceWindow: { start: 8252, end: 14370 } } });
  expect(result.reviewIssues).not.toContain('watch_boundary_provisional');
  expect(event.start).toBe(8252);
});

test.each([
  { start: 8252, end: 14370 }, { start: 8000, end: 14940 }, { start: 8225, end: 15300 },
  { start: 8225, end: 14300 }, { start: 8225, end: 14940, note: '' },
])('rejects invalid or unbounded watch repair: %j', override => {
  expect(() => selectWatchBoundary(event, { activityId: 'movie', start: 8225, end: 14940,
    note: 'manual', ...override })).toThrow();
});
