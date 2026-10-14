import { retryBoundaryRequest, transientActivityFailure, reusableActivityPart, retainWatchPartBoundaries } from './activityRecovery';

test('a later unrelated revision preserves the custom split of an already extended activity', () => {
  const part = (start: number, end: number) => ({ activityId: 'watch', start, end, duration: end - start });
  const prior = [part(0, 1500), part(1500, 3000), part(3000, 4050), part(4050, 5100)];
  const even = [part(0, 1275), part(1275, 2550), part(2550, 3825), part(3825, 5100)];
  expect(retainWatchPartBoundaries(even, prior, 1500, 1800)).toEqual(prior);
  expect(retainWatchPartBoundaries(even, [{ ...prior[0], duration: 1 }, ...prior.slice(1)], 1500, 1800)).toEqual(even);
});

test('a corrected viewing end preserves earlier P boundaries and balances only the changed tail', () => {
  const part = (start: number, end: number) => ({ activityId: 'watch', start, end, duration: end - start });
  const old = [part(0, 1500), part(1500, 3000), part(3000, 4500)];
  const planned = [part(0, 1275), part(1275, 2550), part(2550, 3825), part(3825, 5100)];
  const result = retainWatchPartBoundaries(planned, old, 1500, 1800);
  expect(result).toEqual([part(0, 1500), part(1500, 3000), part(3000, 4050), part(4050, 5100)]);
  expect(result.every((p, i) => !i || p.start === result[i - 1].end)).toBe(true);
  expect(retainWatchPartBoundaries(planned, [part(0, 1500), part(1600, 3000)], 1500, 1800)).toEqual(planned);
  expect(retainWatchPartBoundaries(old, planned, 1500, 1800)).toEqual(old);
});

test.each([[600, 720], [3600, 4200]])('boundary revision retains %s-second review parts and only resplits the extended tail', (target, maximum) => {
  const part = (start: number, end: number) => ({ activityId: 'watch', start, end, duration: end - start });
  const old = [part(0, target), part(target, target * 2)];
  const planned = [part(0, target * .9), part(target * .9, target * 1.8), part(target * 1.8, target * 2.7)];
  expect(retainWatchPartBoundaries(old, old, target, maximum)).toEqual(old);
  const result = retainWatchPartBoundaries(planned, old, target, maximum);
  expect(result[0]).toEqual(old[0]);
  expect(result.at(-1)!.end).toBe(target * 2.7);
  expect(result.every((p, i) => p.duration <= maximum && (!i || p.start === result[i - 1].end))).toBe(true);
});

test('boundary review can reuse unchanged original Ps while changed intervals, sources and damaged files must render', () => {
  const part = { activityId: 'watch', start: 10, end: 110, duration: 100 };
  const source = { mediaPath: 'recording', mediaBytes: '500', mediaMtimeNs: '123' };
  const old = { ...part, mediaPath: 'P1.mp4', bytes: 100, sha256: 'verified', actualDuration: 100 };
  const previous = { sourceSnapshot: source, output: { parts: [old] } };
  const io = { size: () => 100, digest: () => 'verified' };
  expect(reusableActivityPart(part, previous, source, io)).toEqual(old);
  expect(reusableActivityPart({ ...part, end: 120 }, previous, source, io)).toBeNull();
  expect(reusableActivityPart(part, previous, { ...source, mediaMtimeNs: '456' }, io)).toBeNull();
  expect(reusableActivityPart(part, previous, source, { ...io, digest: () => 'damaged' })).toBeNull();
  expect(reusableActivityPart(part, previous, source, { ...io, size: () => { throw new Error('missing'); } })).toBeNull();
});

test.each(['network timeout at: http://localhost:8080/v1/chat/completions', 'Activity media verification HTTP 502'])
('temporary failure retries the same request with bounded backoff: %s', async message => {
  let spent = 0;
  const request = jest.fn(async () => { spent++; if (spent < 3) throw new Error(message); return 'verified'; });
  const wait = jest.fn(async () => undefined), failed = jest.fn();
  expect(await retryBoundaryRequest({ available: () => spent < 3, request, wait, failed })).toBe('verified');
  expect(wait.mock.calls).toEqual([[2000], [8000]]);
  expect(failed).toHaveBeenCalledTimes(2);
});

test('spent stream budget stops before any extra wait or request', async () => {
  let spent = 2;
  const request = jest.fn(async () => { spent++; throw new Error('Activity media verification HTTP 502'); });
  const wait = jest.fn(async () => undefined);
  await expect(retryBoundaryRequest({ available: () => spent < 3, request, wait, failed: jest.fn() })).rejects.toThrow('502');
  expect(request).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
});

test('a persistent outage stops after three calls even with more stream budget', async () => {
  const request = jest.fn(async () => { throw new Error('Activity media verification HTTP 429'); });
  const wait = jest.fn(async () => undefined);
  await expect(retryBoundaryRequest({ available: () => true, request, wait, failed: jest.fn() })).rejects.toThrow('429');
  expect(request).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(2);
});

test.each(['Activity media verification HTTP 401', 'Activity media verification HTTP 400: timeout in supplied evidence',
  'Invalid activity verification decision', 'Audible quotes do not match the source transcript', 'Original activity audio changed'])
('content, configuration and integrity errors never retry: %s', async message => {
  const request = jest.fn(async () => { throw new Error(message); }), wait = jest.fn(async () => undefined);
  await expect(retryBoundaryRequest({ available: () => true, request, wait, failed: jest.fn() })).rejects.toThrow(message);
  expect(request).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
});

test('structured transport errors are recognized', () => {
  expect(transientActivityFailure({ attempts: [{ httpStatus: 503 }] })).toBe(true);
  expect(transientActivityFailure({ code: 'ECONNRESET' })).toBe(true);
  expect(transientActivityFailure({ type: 'request-timeout' })).toBe(true);
  expect(transientActivityFailure({ attempts: [{ httpStatus: 403 }], message: 'network timeout' })).toBe(false);
});
