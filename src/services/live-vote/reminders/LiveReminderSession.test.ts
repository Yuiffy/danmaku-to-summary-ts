import { LiveReminderSession, ReminderAdapters, ReminderSend } from './LiveReminderSession';
import { initialReminderState, LiveReminderConfig, ReminderRecord, ReminderRoomStatus, ReminderState } from './ReminderPolicy';

const start = Date.parse('2026-10-10T20:00:00+08:00');
const config: LiveReminderConfig = { enabled: true, roomId: '100', statePath: '/unused/state', notificationConfigPath: '/unused/config' };

function fixture(saved = initialReminderState(), sendOverride?: ReminderSend, initialClock = start) {
  let now = initialClock;
  let stored = structuredClone(saved);
  let room: ReminderRoomStatus = { roomId: '100', live: true, startedAt: start, title: '晚上好', area: '虚拟日常', parentArea: '虚拟主播' };
  const sent: string[] = [];
  const records: ReminderRecord[] = [];
  const errors = jest.fn();
  const adapters: ReminderAdapters = {
    clock: () => now, load: () => structuredClone(stored),
    save: jest.fn(state => { stored = structuredClone(state); }),
    status: jest.fn(async () => room),
    notify: jest.fn(async record => { records.push(record); return true; }), onError: errors
  };
  const send = sendOverride || jest.fn(async (_roomId, text, current, beforeSend) => {
    if (!current()) return false;
    beforeSend?.();
    sent.push(text);
    return true;
  });
  const session = new LiveReminderSession(config, ['42'], '99', 40, send, adapters);
  session.setAvailable(true);
  return {
    session, adapters, sent, records, errors, state: () => stored,
    clock: (at: number) => { now = at; }, room: (next: Partial<ReminderRoomStatus>) => { room = { ...room, ...next }; },
    tick: async (at: number) => { now = at; session.tick(); await session.flush(); session.tick(); await session.flush(); },
    command: (text: string, uid = '42', lag = 0, roomId = '100') => session.ingest({ roomId, uid, text, sentAt: now - lag })
  };
}

it('sends the two separate reminders in the 15–60 minute window, ten minutes apart, once each per Shanghai day', async () => {
  const f = fixture();
  await f.tick(start);
  await f.tick(start + 15 * 60000 - 1);
  expect(f.sent).toEqual([]);
  await f.tick(start + 15 * 60000);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatch(/反流.*医嘱|医嘱.*反流/u);
  await f.tick(start + 25 * 60000 - 1);
  expect(f.sent).toHaveLength(1);
  await f.tick(start + 25 * 60000);
  expect(f.sent[1]).toContain('身体乳');
  for (const minutes of [35, 45, 59, 60, 80]) await f.tick(start + minutes * 60000);
  expect(f.sent).toHaveLength(2);
  expect(f.records.map(record => record.status)).toEqual(['sent', 'sent']);
  expect(f.state().receipts.every(receipt => receipt.notified)).toBe(true);
});

it.each([
  { title: '还在放OP' }, { title: '同步视听' }, { area: '单机游戏' },
  { parentArea: '网游' }, { title: '', area: '', parentArea: '' }
])('sends within the time window regardless of title or area: %j', async patch => {
  const f = fixture();
  f.room(patch);
  await f.tick(start);
  await f.tick(start + 15 * 60000);
  expect(f.sent).toHaveLength(1);
  expect(f.records[0].status).toBe('sent');
});

it.each([{ live: false }, { startedAt: 0 }, { startedAt: NaN }])('suppresses reminders without a valid live start: %j', async patch => {
  const f = fixture();
  f.room(patch);
  await f.tick(start);
  await f.tick(start + 15 * 60000);
  expect(f.sent).toEqual([]);
  expect(f.records).toEqual([]);
});

it('waits through busy danmaku and sends when the rolling minute becomes quiet', async () => {
  const f = fixture();
  await f.tick(start);
  for (let i = 0; i < 30; i++) {
    f.clock(start + 14 * 60000 + i * 1900);
    f.command('哈哈', '7');
  }
  await f.tick(start + 15 * 60000);
  expect(f.sent).toEqual([]);
  await f.tick(start + 16 * 60000);
  expect(f.sent).toHaveLength(1);
});

it('does not force a reminder at the window deadline or while metadata is unavailable', async () => {
  const f = fixture();
  await f.tick(start);
  (f.adapters.status as jest.Mock).mockRejectedValue(new Error('offline'));
  await f.tick(start + 15 * 60000);
  expect(f.sent).toEqual([]);
  expect(f.errors).toHaveBeenCalled();
  (f.adapters.status as jest.Mock).mockResolvedValue({ roomId: '100', live: true, startedAt: start, title: '', area: '杂谈', parentArea: '' });
  await f.tick(start + 60 * 60000);
  expect(f.sent).toEqual([]);
});

it('preserves daily receipts across restarts and permits the next day after warming the observation window', async () => {
  const f = fixture();
  await f.tick(start);
  await f.tick(start + 15 * 60000);
  const restarted = fixture(f.state(), undefined, start + 16 * 60000);
  await restarted.tick(start + 16 * 60000);
  expect(restarted.sent).toEqual([]);
  await restarted.tick(start + 25 * 60000);
  expect(restarted.sent).toHaveLength(1);
  expect(restarted.sent[0]).toContain('身体乳');
  restarted.room({ startedAt: start + 86400000 });
  await restarted.tick(start + 86400000 + 15 * 60000);
  expect(restarted.sent).toHaveLength(2);
});

it('restricts commands to fresh global-admin messages in the configured room and persists additions and switches', async () => {
  const f = fixture();
  await f.tick(start);
  for (const [uid, lag, roomId] of [['7', 0, '100'], ['99', 0, '100'], ['42', 11000, '100'], ['42', 0, '200']] as const) {
    expect(f.command('#关闭提醒 全部', uid, lag, roomId)).toBe(false);
  }
  expect(f.state().enabled).toBe(true);
  expect(f.command('＃新增提醒 喝水')).toBe(true);
  expect(f.state().items.at(-1)).toMatchObject({ id: 'custom-1', name: '喝水', enabled: true });
  f.command('#关闭提醒 吃药');
  expect(f.state().items[0].enabled).toBe(false);
  await f.tick(start + 15 * 60000);
  expect(f.records[0].name).toBe('身体乳');
  f.command('#关闭提醒');
  expect(f.state().items[1].enabled).toBe(false);
  f.command('#关闭提醒 全部');
  expect(f.state().enabled).toBe(false);
  f.command('#开启提醒 全部');
  f.command('#开启提醒 medicine');
  expect(f.state().enabled).toBe(true);
  expect(f.state().items[0].enabled).toBe(true);
  expect(f.state().items[1].enabled).toBe(false);
  await f.session.flush();
});

it('pauses the current stream durably and resumes when the actual start time changes', async () => {
  const f = fixture();
  await f.tick(start);
  f.command('#停止提醒');
  await f.tick(start + 15 * 60000);
  expect(f.records).toEqual([]);
  const restarted = fixture(f.state());
  await restarted.tick(start + 16 * 60000);
  expect(restarted.records).toEqual([]);
  restarted.room({ startedAt: start + 3600000 });
  await restarted.tick(start + 3600000 + 15 * 60000);
  expect(restarted.records).toHaveLength(1);
});

it.each(['disconnect', 'disable', 'game', 'expired'])('rechecks time and controls while ignoring activity changes in the send queue: %s', async reason => {
  let release!: () => void;
  let queued!: () => boolean;
  let sendIntent!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(initialReminderState(), async (_id, _text, current, beforeSend) => {
    if (!beforeSend) return true;
    queued = current; sendIntent = beforeSend;
    await blocker;
    if (!current()) return false;
    beforeSend();
    return true;
  });
  await f.tick(start);
  await f.tick(start + 14 * 60000 + 40000);
  f.clock(start + 15 * 60000);
  f.session.tick();
  if (reason === 'disconnect') f.session.setAvailable(false);
  if (reason === 'disable') f.command('#关闭提醒 全部');
  if (reason === 'expired') f.clock(start + 60 * 60000);
  if (reason === 'game') {
    f.room({ area: '单机游戏' }); f.clock(start + 16 * 60000); f.session.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  expect(sendIntent).toBeDefined();
  expect(queued()).toBe(reason === 'game');
  release();
  await f.session.flush();
  expect(f.state().receipts).toHaveLength(reason === 'game' ? 1 : 0);
  expect(f.records).toHaveLength(reason === 'game' ? 1 : 0);
});

it('records ambiguous send failures before any retry and never repeats that daily item after restart', async () => {
  const f = fixture(initialReminderState(), async (_id, _text, current, beforeSend) => {
    if (!current()) return false;
    beforeSend?.();
    throw new Error('request timed out');
  });
  await f.tick(start);
  await f.tick(start + 15 * 60000);
  expect(f.state().receipts[0]).toMatchObject({ id: 'medicine', status: 'attempted' });
  expect(f.records[0].status).toBe('attempted');
  const restarted = fixture(f.state());
  await restarted.tick(start + 25 * 60000);
  expect(restarted.sent[0]).toContain('身体乳');
});

it('does not resend successful danmaku when the WeChat Work notification fails', async () => {
  const f = fixture();
  (f.adapters.notify as jest.Mock).mockResolvedValue(false);
  await f.tick(start);
  await f.tick(start + 15 * 60000);
  await f.tick(start + 16 * 60000);
  expect(f.sent).toHaveLength(1);
  expect(f.state().receipts[0]).toMatchObject({ status: 'sent', notified: false });
  expect(f.errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('will not be resent') }));
});

it('fails closed for invalid durable state rather than discarding reminder history', () => {
  expect(() => fixture({ ...initialReminderState(), version: 2 } as unknown as ReminderState)).toThrow('Invalid live reminder state');
});

it('cancels a queued send after a web switch and acknowledges a replay without resetting receipts', async () => {
  let release!: () => void, current!: () => boolean;
  const f = fixture(initialReminderState(), async (_id, _text, isCurrent, beforeSend) => {
    current = isCurrent;
    await new Promise<void>(resolve => { release = resolve; });
    if (!isCurrent()) return false;
    beforeSend?.(); return true;
  });
  await f.tick(start); await f.tick(start + 14 * 60000 + 40000);
  f.clock(start + 15 * 60000); f.session.tick();
  const command = { id: '11111111-1111-1111-1111-111111111111', createdAt: new Date(start).toISOString(), edit: { action: 'switch' as const, enabled: false } };
  f.adapters.commands = () => [command]; f.adapters.completeCommand = jest.fn();
  f.session.tick(); expect(current()).toBe(false); release(); await f.session.flush();
  expect(f.state().receipts).toEqual([]); expect(f.state().enabled).toBe(false);
  const writes = (f.adapters.save as jest.Mock).mock.calls.length;
  f.session.tick();
  expect(f.state().appliedCommandIds).toEqual([command.id]); expect(f.adapters.completeCommand).toHaveBeenCalledTimes(2);
  expect(f.adapters.save).toHaveBeenCalledTimes(writes);
});

it('retains the in-flight receipt when a web edit arrives after the HTTP send intent', async () => {
  let release!: () => void;
  const f = fixture(initialReminderState(), async (_id, _text, isCurrent, beforeSend) => {
    if (!isCurrent()) return false;
    beforeSend?.(); await new Promise<void>(resolve => { release = resolve; }); return true;
  });
  await f.tick(start); await f.tick(start + 14 * 60000 + 40000);
  f.clock(start + 15 * 60000); f.session.tick();
  expect(f.state().receipts[0].status).toBe('attempted');
  f.adapters.commands = () => [{ id: '22222222-2222-2222-2222-222222222222', createdAt: new Date(start).toISOString(), edit: { action: 'switch', enabled: false } }];
  f.adapters.completeCommand = jest.fn(); f.session.tick(); release(); await f.session.flush();
  expect(f.state().receipts).toHaveLength(1); expect(f.state().receipts[0]).toMatchObject({ status: 'sent', notified: true });
});
