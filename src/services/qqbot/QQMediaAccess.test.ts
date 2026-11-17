import { qqMediaOperator, validateQQMediaAccess } from './QQMediaAccess';
import { qqImageQuota } from './QQImagePolicy';
import { newQQState, validateQQState } from './QQState';

const now = Date.parse('2026-11-16T06:10:42Z');
const config = { dailyLimit: 300, userDailyLimit: 30 };

test('only configured authenticated digests grant a media operator profile', () => {
  const access = { mediaOperators: ['a'.repeat(64)] };
  expect(qqMediaOperator(access, 'a'.repeat(64))).toBe(true);
  expect(qqMediaOperator(access, 'b'.repeat(64))).toBe(false);
  expect(qqMediaOperator(access, '带鱼')).toBe(false);
  for (const users of [['带鱼'], ['a'.repeat(64), 'a'.repeat(64)], [42]]) {
    expect(() => validateQQMediaAccess({ mediaOperators: users as string[] })).toThrow();
  }
});

test('another user recent start explains the screenshot but does not throttle an operator', () => {
  const state = { images: 20, lastImageAt: now - 2000 };
  const user = { images: 12, imageStarts: [now - 120000] };
  expect(qqImageQuota(now, config, user, state)).toBeUndefined();
  expect(qqImageQuota(now, config, user, state, true)).toBeUndefined();
  expect(qqImageQuota(now, config, { ...user, imageStarts: [now - 2000] }, state, true)).toBeUndefined();
});

test('operator window, day, global day and durable state are still bounded', () => {
  const state = newQQState('900000001');
  state.users['a'.repeat(64)] = { count: 0, starts: [], images: 49, imageStarts: Array(49).fill(now - 60000) };
  expect(() => validateQQState(state, '900000001')).not.toThrow();
  expect(qqImageQuota(now, config, state.users['a'.repeat(64)], {}, true)).toBeUndefined();
  expect(qqImageQuota(now, config, { imageStarts: Array(50).fill(now - 60000) }, {}, true)?.reason).toBe('user_window');
  expect(qqImageQuota(now, config, { images: 150 }, {}, true)?.reason).toBe('user_daily');
  expect(qqImageQuota(now, config, {}, { images: 300 }, true)?.reason).toBe('global_daily');
});
