import { commentImageLimitMessage, reserveCommentImage } from './CommentImageQuota';
import { CommentImageConfig, privateMessageEvent, shanghaiDay } from './CommentPolicy';
import { newCommentState } from './CommentState';

const config: CommentImageConfig = { enabled: true, model: 'gpt-image-2', quality: 'high', timeoutMs: 1000,
  trustedUids: ['1954091502', '14279'], trustedHourlyLimit: 2, trustedDailyLimit: 3, otherUserDailyLimit: 1, otherGlobalDailyLimit: 2 };

test('private image admission accepts only configured trusted senders and parses bounded text', () => {
  const row = { sender_uid: 1954091502, msg_key: 123, timestamp: 1792627200, content: JSON.stringify({ content: '生成一张图' }) };
  expect(privateMessageEvent(row, '412141275', config.trustedUids)).toMatchObject({ uid: '1954091502', channel: 'private', type: 0, text: '生成一张图' });
  expect(privateMessageEvent({ ...row, sender_uid: 1 }, '412141275', config.trustedUids)).toBeUndefined();
});

test('private chat without an explicit image request is ignored by the image worker', async () => {
  const { CommentWorker } = await import('./CommentWorker');
  const state = newCommentState('412141275');
  const worker = new CommentWorker({ botUid: '412141275', unlimitedUids: [], credentialConfigPath: 'x', providerConfigPath: 'x',
    dailyTokenBudget: 4096, maxQueue: 10, maxUserQueue: 2, pollIntervalMs: 30000, images: config }, state,
    { save: async () => {}, answer: async () => '不应调用', send: async () => '1', now: () => Date.UTC(2026, 9, 31) });
  const event = privateMessageEvent({ sender_uid: '1954091502', msg_key: '2', timestamp: 1792627200, content: JSON.stringify({ content: '你好' }) }, '412141275', config.trustedUids)!;
  await expect(worker.admit(event)).resolves.toBe('ignored');
});

test('other-user image quota is per-user plus shared daily, while trusted users are separate', () => {
  const state = newCommentState('412141275'), now = Date.UTC(2026, 9, 31);
  let sequence = 0;
  const job = (uid: string) => ({ event: { key: `${uid}:${++sequence}`, uid, oid: uid, type: 0, channel: 'private' as const, trigger: 'private' as const,
    root: '0', parent: '0', text: '生成一张图', createdAt: now }, status: 'queued' as const, admittedAt: now });
  expect(reserveCommentImage(config, state, job('1'), now).allowed).toBe(true);
  expect(reserveCommentImage(config, state, job('1'), now)).toEqual({ allowed: false, reason: 'user_daily' });
  expect(reserveCommentImage(config, state, job('2'), now).allowed).toBe(true);
  expect(reserveCommentImage(config, state, job('3'), now)).toEqual({ allowed: false, reason: 'other_global_daily' });
  expect(reserveCommentImage(config, state, job('1954091502'), now).allowed).toBe(true);
  expect(state.days[shanghaiDay(now)].images).toEqual({ total: 2, users: { '1': 1, '2': 1, '1954091502': 1 } });
  expect(commentImageLimitMessage('other_global_daily')).toContain('其他人的生图额度');
});

test('trusted image quota has an independent rolling hourly limit and daily limit', () => {
  const state = newCommentState('412141275'), now = Date.UTC(2026, 9, 31);
  const job = (id: number) => ({ event: { key: `trusted:${id}`, uid: '1954091502', oid: '1954091502', type: 0,
    channel: 'private' as const, trigger: 'private' as const, root: '0', parent: '0', text: '生成一张图', createdAt: now },
    status: 'queued' as const, admittedAt: now });
  expect(reserveCommentImage(config, state, job(1), now)).toEqual({ allowed: true });
  expect(reserveCommentImage(config, state, job(2), now + 1)).toEqual({ allowed: true });
  expect(reserveCommentImage(config, state, job(3), now + 2)).toEqual({ allowed: false, reason: 'trusted_hourly' });
  expect(commentImageLimitMessage('trusted_hourly')).toContain('这小时');
  expect(reserveCommentImage(config, state, job(4), now + 3600001)).toEqual({ allowed: true });
  expect(reserveCommentImage(config, state, job(5), now + 3600002)).toEqual({ allowed: false, reason: 'trusted_daily' });
});
