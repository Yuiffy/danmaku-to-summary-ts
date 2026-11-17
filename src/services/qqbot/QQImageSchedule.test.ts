import { qqImageCanStart, qqImageQueueEstimate, qqImageWindowAt, QQScheduledImage } from './QQImageSchedule';

const now = 1000000;
const job = (key: string, status = 'queued', user = 'normal'): QQScheduledImage => ({ key, user, status, createdAt: now, startedAt: now });
test('ten starts may burst and the rolling boundary releases exactly, even across midnight/restart', () => {
  expect(qqImageWindowAt(now, Array(9).fill(now))).toBe(now);
  expect(qqImageWindowAt(now, Array(10).fill(now))).toBe(now + 600000);
  expect(qqImageWindowAt(now + 599999, Array(10).fill(now))).toBe(now + 600000);
  expect(qqImageWindowAt(now + 600000, Array(10).fill(now))).toBe(now + 600000);
});
test('operator slots remain available when ordinary slots are occupied', () => {
  const access = { mediaOperators: ['operator'] }, running = [job('a', 'running'), job('b', 'running')];
  expect(qqImageCanStart(job('c'), running, access)).toBe(false);
  expect(qqImageCanStart(job('c', 'queued', 'operator'), running, access)).toBe(true);
  running.push(...Array.from({ length: 4 }, (_, i) => job(String(i), 'running', 'operator')));
  expect(qqImageCanStart(job('d', 'queued', 'operator'), running, access)).toBe(false);
});
test('ETA simulates concurrency and rolling quota and leaves inputs unchanged', () => {
  const jobs = [job('a', 'running'), job('b', 'running'), ...Array.from({ length: 20 }, (_, i) => job(String(i)))];
  const before = structuredClone(jobs);
  expect(qqImageQueueEstimate('0', now, jobs, [], 180000, {})).toEqual({ position: 1, waitMs: 180000 });
  expect(qqImageQueueEstimate('0', now, jobs, Array(10).fill(now), 180000, {})).toEqual({ position: 1, waitMs: 600000 });
  expect(qqImageQueueEstimate('19', now, jobs, [], 180000, {}).waitMs).toBeGreaterThanOrEqual(1800000);
  expect(jobs).toEqual(before);
});
