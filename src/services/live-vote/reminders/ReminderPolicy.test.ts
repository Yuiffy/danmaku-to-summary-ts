import { initialReminderState, isReminderChat, parseReminderCommand, quietReminderWindow, reminderOptions, shanghaiDay, validateReminderState } from './ReminderPolicy';

const options = reminderOptions({ enabled: true, roomId: '100', statePath: '/state', notificationConfigPath: '/config' });

it('uses Shanghai midnight for daily quotas independent of the host timezone', () => {
  expect(shanghaiDay(Date.parse('2026-10-10T15:59:59Z'))).toBe('2026-10-10');
  expect(shanghaiDay(Date.parse('2026-10-10T16:00:00Z'))).toBe('2026-10-11');
});

it('accepts a relative lull in busy rooms after a full baseline minute', () => {
  const now = 300000;
  const samples = [...Array.from({ length: 200 }, (_, i) => 100 + i * 1190),
    ...Array.from({ length: 20 }, (_, i) => 240100 + i * 2900)];
  expect(quietReminderWindow(samples, 0, now, options)).toBe(true);
  expect(quietReminderWindow(Array.from({ length: 100 }, (_, i) => 240100 + i * 590), 0, now, options)).toBe(false);
  expect(quietReminderWindow([], 0, 59999, options)).toBe(false);
});

it('rejects unsafe configuration and keeps all default templates within the smallest supported message limit', () => {
  validateReminderState(initialReminderState(), 20);
  for (const patch of [{ startMinutes: 0 }, { endMinutes: 61 }, { minGapMinutes: 0 }, { quietRatio: 0 }, { roomId: 'x' }]) {
    expect(() => reminderOptions({ ...options, ...patch })).toThrow('Invalid live reminders');
  }
});

it('normalizes fullwidth commands and rejects embedded control characters', () => {
  expect(parseReminderCommand('＃关闭提醒 全部')).toEqual({ action: '关闭提醒', argument: '全部' });
  expect(parseReminderCommand('#新增提醒 喝水\n喝水')).toBeUndefined();
  expect(parseReminderCommand('别人说#关闭提醒')).toBeUndefined();
  expect(isReminderChat({ roomId: '100', live: true, startedAt: 1, title: '放OP', area: '单机游戏', parentArea: '网游' })).toBe(true);
});
