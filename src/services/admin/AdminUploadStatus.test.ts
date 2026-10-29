import { uploadQueueStatus } from './AdminUploadStatus';

const now = Date.parse('2026-10-24T10:00:00Z'), hour = 3600000;
const at = (delta: number) => new Date(now + delta).toISOString();
const job = (id: string, extra = {}) => ({ id, status: 'pending', clipIds: [Number(id)], ...extra });
const event = (id: number, delta: number) => ({ at: at(delta), bvid: `BV${id}`, title: `视频 ${id}` });

it('shows cancellation acknowledgement and final submission separately, excluding withdrawn clips from waiting counts', () => {
  const result = uploadQueueStatus({ jobs: [job('1', { status: 'running', clipIds: [1, 2, 3],
    cancellationRequests: { 1: { reason: '撤回' }, 2: { reason: '撤回' } },
    cancellationAcknowledgedIds: [2], submissionStartedClipIds: [3] })] }, {}, now);
  expect(result.queuedClips).toBe(1);
  expect(result.queue[0].clips[0]).toMatchObject({ cancelled: true, cancelling: true });
  expect(result.queue[0].clips[1]).toMatchObject({ cancelled: true, cancelling: false });
  expect(result.queue[0].clips[2]).toMatchObject({ submissionStarted: true });
  expect(result.lastSubmission).toBeUndefined();
});

it('combines both account constraints and job retries, skipping later retries like the worker scan', () => {
  const queue = { jobs: [job('1', { status: 'retry_wait', retryAt: at(4 * hour) }), job('2')],
    accountRollingUploadGuard: { events: Array.from({ length: 90 }, (_, i) => event(i, -22 * hour)), lastRemoteSyncAt: at(-hour) },
    submissionRateLimit: { code: 137022, cooldownUntil: at(3 * hour), updatedAt: at(0), streak: 2 } };
  const result = uploadQueueStatus(queue, {}, now);
  expect(result).toMatchObject({ state: 'waiting', queuedJobs: 2, nextJobId: '2', nextAttemptAt: at(3 * hour),
    rolling: { count: 90, remaining: 0, blockedUntil: at(2 * hour + 5000), nextDecreaseAt: at(2 * hour) }, rateLimit: { active: true } });
  expect(result.reasons).toHaveLength(2);
  expect(result.queue.map(next => next.id)).toEqual(['2', '1']);
  expect(result.rolling.releases).toEqual([{ at: at(2 * hour), count: 90, remainingCount: 0 }]);
});

it('deduplicates account and registry receipts, keeping the later timestamp, excluding expired entries', () => {
  const result = uploadQueueStatus({ accountRollingUploadGuard: { events: [event(1, -hour), event(2, -24 * hour), { at: 'invalid' }] } }, {
    1: { id: 1, status: 'uploaded', uploadState: { bvid: 'BV1', submittedAt: at(-hour / 2), onlineTitle: '最终标题' } },
    2: { id: 2, status: 'uploading', updatedAt: at(0) },
    3: { id: 3, status: 'uploaded', uploadedAt: at(-25 * hour), title: '旧投稿' }
  }, now);
  expect(result.rolling).toMatchObject({ count: 1, remaining: 89, nextDecreaseAt: at(23.5 * hour) });
  expect(result.lastSubmission).toMatchObject({ at: at(-hour / 2), title: '最终标题', bvid: 'BV1' });
  expect(result.rolling.events).toHaveLength(1);
});

it('requires enough events to expire when history exceeds 90 and retains the worker boundary buffer', () => {
  const events = Array.from({ length: 92 }, (_, i) => event(i, -23 * hour + i * 1000));
  const queue = { jobs: [job('1')], accountRollingUploadGuard: { events } };
  expect(uploadQueueStatus(queue, {}, now).nextAttemptAt).toBe(at(hour + 7000));
  const after = now + hour + 2000;
  expect(uploadQueueStatus({ ...queue, accountRollingUploadGuard: { events, blockedUntil: at(hour + 7000) } }, {}, after))
    .toMatchObject({ state: 'waiting', rolling: { count: 89, blockedUntil: at(hour + 7000) } });
  expect(uploadQueueStatus({ ...queue, accountRollingUploadGuard: { events, blockedUntil: at(hour + 7000) } }, {}, now + hour + 7000).state).toBe('ready');
});

it('projects all pending jobs beyond the old 200-row history, excludes done and failed-render clips, and preserves input', () => {
  const queue = { jobs: [job('1', { clipIds: [1, 2, 3], renderFailures: { 3: 'failed' } }),
    ...Array.from({ length: 220 }, (_, i) => job(String(i + 4), { status: 'done' })), job('2', { status: 'blocked' })] };
  const before = JSON.stringify(queue);
  const result = uploadQueueStatus(queue, { 1: { id: 1, status: 'uploaded', uploadedAt: at(-hour) } }, now);
  expect(result).toMatchObject({ queuedJobs: 1, queuedClips: 1, blockedJobs: 1, nextJobId: '1' });
  expect(result.queue.map(entry => entry.id)).toEqual(['1', '2']);
  expect(JSON.stringify(queue)).toBe(before);
});

it('does not promise a next-attempt time while a task is running or confuse transfer with submission', () => {
  const result = uploadQueueStatus({ jobs: [job('1', { status: 'running', phase: 'rendering', retryAt: at(-hour), lastOutput: 'submission outcome unknown' }), job('2')] },
    { 1: { id: 1, status: 'uploading', updatedAt: at(0), uploadProgress: { percent: 100 } } }, now);
  expect(result).toMatchObject({ state: 'running', activeJobs: 1, queuedJobs: 1, queuedClips: 2 });
  expect(result.nextAttemptAt).toBeUndefined(); expect(result.lastSubmission).toBeUndefined();
  expect(result.queue[0].reason).toBe('正在制作成片');
  expect(result.queue[0].retryAt).toBeUndefined();
});

it('distinguishes last completed attempt, preupload rate limiting, unknown outcomes, and 137022 cooldown', () => {
  const result = uploadQueueStatus({ jobs: [job('1', { status: 'retry_wait', startedAt: at(-hour), updatedAt: at(-hour / 2), retryAt: at(hour),
    lastOutput: '[rate-limit] 您上传视频过快\nsubmission outcome unknown' }),
    job('2', { status: 'running', startedAt: at(0), updatedAt: at(0) })] }, {}, now);
  expect(result.lastAttempt).toMatchObject({ jobId: '1', submissionRateLimited: false, preuploadRateLimited: true, outcomeUnknown: true });
  expect(result.rateLimit).toBeUndefined();
  const limited = uploadQueueStatus({ jobs: [job('1', { status: 'retry_wait', startedAt: at(-hour), updatedAt: at(0), retryKind: 'bilibili_submission_rate_limit' })] }, {}, now);
  expect(limited.lastAttempt?.submissionRateLimited).toBe(true);
});

it('keeps FIFO ties, normalizes Python naive UTC/microseconds and handles malformed/missing retry state honestly', () => {
  const result = uploadQueueStatus({ jobs: [job('1', { status: 'retry_wait' }), job('2', { status: 'retry_wait', retryAt: 'broken' }), job('3')],
    accountRollingUploadGuard: { events: [{ at: '2026-10-24T09:00:00.123456', bvid: 'BV1' }], lastRemoteSyncError: 'private implementation details' } }, {}, now);
  expect(result.queue.map(entry => entry.id)).toEqual(['2', '3', '1']);
  expect(result.rolling.events[0].at).toBe('2026-10-24T09:00:00.123Z');
  expect(result.rolling.syncFailed).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private implementation details');
  expect(uploadQueueStatus({ jobs: [job('1', { status: 'retry_wait' })] }, {}, now)).toMatchObject({ state: 'blocked', nextAttemptAt: undefined });
  expect(uploadQueueStatus(null, null, now)).toMatchObject({ state: 'idle', rolling: { available: false } });
});

it('retains the last successful submission even outside the rolling window and ignores expired cooldowns', () => {
  const result = uploadQueueStatus({ jobs: [job('1', { status: 'retry_wait', retryAt: at(hour) })], submissionRateLimit: { cooldownUntil: at(-hour) } },
    { 1: { id: 1, status: 'uploaded', uploadedAt: at(-48 * hour) } }, now);
  expect(result.lastSubmission?.at).toBe(at(-48 * hour)); expect(result.rolling.count).toBe(0);
  expect(result.rateLimit?.active).toBe(false); expect(result.nextAttemptAt).toBe(at(hour));
  expect(result.reasons).toEqual(['待处理任务尚未到各自重试时间']);
});
