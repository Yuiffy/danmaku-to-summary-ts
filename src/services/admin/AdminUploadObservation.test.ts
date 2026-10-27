import { uploadQueueStatus } from './AdminUploadStatus';
import { uploadObservation } from './AdminUploadObservation';
import { UploadTelemetry } from './AdminUploadTelemetry';

const now = Date.parse('2026-10-27T12:00:00Z'), hour = 3600000;
const at = (hours: number) => new Date(now + hours * hour).toISOString();
const submissions = [-96, -50, -48, -25, -24, -3, -2, 0, 1].map(hours => ({ at: at(hours), title: String(hours) }));
const ledger = (events: UploadTelemetry['events']): UploadTelemetry => ({ available: true, truncated: false, since: at(-96), events });

it('calculates exact rolling boundaries and historical lookback without future receipts', () => {
  const data = uploadObservation(submissions, {}, now);
  expect(data.windows.map(row => row.count)).toEqual([2, 3, 5]);
  const wide = data.windows[2];
  expect(wide.points[0]).toEqual({ at: at(-48), count: 2 });
  expect(wide.points.find(row => row.at === at(-2))).toEqual({ at: at(-2), count: 5 });
  expect(data.windows[0].points.find(row => row.at === at(-21))).toEqual({ at: at(-21), count: 0 });
});

it('joins per-account initialization density and merges duplicate outer 406 failures', () => {
  const events = [
    { id: 1, accountId: 'one', at: at(-1 - 5 / 60), event: 'preupload_start', stage: 'preupload' },
    { id: 2, accountId: 'one', at: at(-1 - 1 / 60), event: 'preupload_start', stage: 'preupload' },
    { id: 3, accountId: 'two', at: at(-1 - 1 / 60), event: 'preupload_start', stage: 'preupload' },
    { id: 4, accountId: 'one', at: at(-1), event: 'preupload_failed', stage: 'preupload', httpStatus: 406, partIndex: 2 },
    { id: 5, accountId: 'one', at: new Date(now - hour + 1000).toISOString(), event: 'upload_failed', stage: 'preupload', httpStatus: 406 },
    { id: 6, accountId: 'two', at: at(-1), event: 'upload_failed', stage: 'chunk', httpStatus: 406 }
  ];
  const data = uploadObservation(submissions, {}, now, ledger(events));
  expect(data.incidents).toHaveLength(2);
  expect(data.incidents[0]).toMatchObject({ id: 'ledger-4', kind: 'http406', preupload5m: 1, partIndex: 2, counts: [2, 3, 5] });
  expect(data.incidents[1]).toMatchObject({ id: 'ledger-6', accountId: 'two', preupload5m: 1 });
});

it('preserves multiple exact 137022 attempts, deduplicates snapshots, and labels legacy evidence', () => {
  const queue = { submissionRateLimitHistorySince: at(-3), submissionRateLimitHistory: [
    { at: at(-3), code: 137022, jobId: 'a' }, { at: at(-2), code: 137022, jobId: 'a' },
    { at: at(1), code: 137022, jobId: 'future' }, { at: 'broken', code: 137022 } ],
    submissionRateLimit: { code: 137022, updatedAt: at(-2), jobId: 'a' },
    jobs: [{ id: 'a', status: 'retry_wait', startedAt: at(-3), updatedAt: at(-2), retryKind: 'bilibili_submission_rate_limit' },
      { id: 'b', status: 'blocked', startedAt: at(-1), updatedAt: at(-1), lastOutput: 'HTTP 406' },
      { id: 'c', status: 'retry_wait', startedAt: at(-1), updatedAt: at(-1), lastOutput: '1370221' }] };
  const before = JSON.stringify(queue);
  const data = uploadObservation(submissions, queue, now);
  expect(data.incidents.map(row => row.source)).toEqual(['history', 'history', 'snapshot']);
  expect(data.incidents.map(row => row.kind)).toEqual(['submission137022', 'submission137022', 'http406']);
  expect(data.historySince).toBe(at(-3));
  expect(data.telemetry.available).toBe(false);
  expect(JSON.stringify(queue)).toBe(before);
});

it('uses the same deduplicated receipts for the guard and historical curves, leaving release behavior intact', () => {
  const result = uploadQueueStatus({ accountRollingUploadGuard: { events: [{ at: at(-2), bvid: 'BV1' }] } }, {
    1: { id: 1, status: 'uploaded', uploadState: { bvid: 'BV1', submittedAt: at(-1) } },
    2: { id: 2, status: 'uploaded', uploadedAt: at(-30) },
    3: { id: 3, status: 'uploaded', uploadedAt: at(1) }
  }, now);
  expect(result.observation?.windows.map(row => row.count)).toEqual([1, 1, 2]);
  expect(result.rolling.count).toBe(1);
  expect(result.rolling.releases).toEqual([{ at: at(23), count: 1, remainingCount: 0 }]);
});
