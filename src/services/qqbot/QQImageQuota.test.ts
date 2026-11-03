import { qqImageQuota, QQ_IMAGE_LIMITS } from './QQImagePolicy';

const config = { userDailyLimit: 30, dailyLimit: 300 };
const now = Date.parse('2026-10-30T19:34:29+08:00');
const minute = 60000;
const window = QQ_IMAGE_LIMITS.userWindowMs;

test('personal window uses the earliest releasing attempt regardless of order, rounding the displayed minute up', () => {
  const first = Date.parse('2026-10-30T18:20:55+08:00');
  const starts = Array.from({ length: 10 }, (_, index) => first + index * minute).reverse();
  const original = [...starts];
  expect(qqImageQuota(now, config, { images: 10, imageStarts: starts }, { images: 20 })).toEqual({
    reason: 'user_window', retryAt: first + window,
    message: '你生太多了，请在23:21后再尝试吧～'
  });
  expect(starts).toEqual(original);
});

test.each([-1, 0])('window admits at exactly five hours rather than at the rounded display time (%i ms)', offset => {
  const result = qqImageQuota(now, config, { imageStarts: Array(10).fill(now - window - offset) }, {});
  expect(result?.reason).toBe(offset === 0 ? undefined : 'user_window');
});

test('expired entries and another member do not consume personal window slots', () => {
  const user = { imageStarts: [now - window, ...Array(9).fill(now - minute)] };
  expect(qqImageQuota(now, config, user, { images: 299 })).toBeUndefined();
  expect(qqImageQuota(now, config, {}, { images: 10 })).toBeUndefined();
});

test('window retry after Shanghai midnight is labelled tomorrow', () => {
  const starts = Array(10).fill(Date.parse('2026-10-30T19:20:55+08:00'));
  expect(qqImageQuota(now, config, { imageStarts: starts }, {})?.message)
    .toBe('你生太多了，请在明天00:21后再尝试吧～');
});

test.each(['user_daily', 'global_daily'] as const)('%s quota explains whose daily attempts ran out', reason => {
  expect(qqImageQuota(now, config, { images: reason === 'user_daily' ? 30 : 0 }, { images: reason === 'global_daily' ? 300 : 0 }))
    .toEqual({ reason, retryAt: Date.parse('2026-10-31T00:00:00+08:00'),
      message: `${reason === 'user_daily' ? '你今天的生图次数用完了' : '今天大家的生图次数用完了'}，请在明天00:00后再尝试吧～` });
});

test('overlapping daily and window quotas never promise midnight if the personal window lasts longer', () => {
  const at = Date.parse('2026-10-31T23:55:00+08:00');
  const first = Date.parse('2026-10-31T23:00:01+08:00');
  const result = qqImageQuota(at, config, { images: 30, imageStarts: Array(10).fill(first) }, { images: 300, lastImageAt: at });
  expect(result).toEqual({ reason: 'user_daily', retryAt: first + window,
    message: '你今天的生图次数用完了，请在明天04:01后再尝试吧～' });
});

test('a global daily limit can outlast a personal rolling window', () => {
  const result = qqImageQuota(now, config, { imageStarts: Array(10).fill(now - window + minute) }, { images: 300 });
  expect(result?.reason).toBe('user_window');
  expect(result?.retryAt).toBe(Date.parse('2026-10-31T00:00:00+08:00'));
  expect(result?.message).toContain('明天00:00');
});

test('one-minute global interval remains distinct and releases at the exact boundary', () => {
  expect(qqImageQuota(now, config, {}, { lastImageAt: now - minute + 1 }))
    .toEqual({ reason: 'interval', retryAt: now + 1, message: '你生太快了，晚点再来。' });
  expect(qqImageQuota(now, config, {}, { lastImageAt: now - minute })).toBeUndefined();
});
