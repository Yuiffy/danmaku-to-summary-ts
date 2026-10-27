import * as fs from 'fs';
import * as path from 'path';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQConfig, QQInbound, QQ_LIMITS, QQ_PRIVATE_REPLY, QQ_QUOTA_REPLY, qqRequest } from './QQPolicy';
import { newQQState, validateQQState } from './QQState';
import { QQWorker } from './QQWorker';

function fixture() {
  let now = Date.parse('2026-10-28T02:00:00Z');
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../..', 'config/qqbot.example.json'), 'utf8')) as QQConfig;
  const state = newQQState('900000001'); state.day = shanghaiDay(now);
  const answer = jest.fn(async () => '收到你的问题啦。');
  const send = jest.fn(async () => {});
  const worker = new QQWorker({ ...config, privateReply: QQ_PRIVATE_REPLY }, state, {
    now: () => now, save: async value => validateQQState(value, state.appId), record: async () => {},
    answer, send, sleep: async ms => { now += ms; }, report: () => {},
  });
  const message = (id: string, senderId = 'member-a'): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId, groupOpenid: 'group-a', messageId: id, timestamp: new Date(now).toISOString(), content: '你好' });
  const user = qqRequest(message('seed'), now)!.user;
  const request = async (id: string, senderId?: string) => { expect(worker.receive(message(id, senderId))).toBe(true); await worker.idle(); };
  return { state, answer, send, user, request, now, advance: (ms: number) => { now += ms; } };
}

test('all QQ users can continue past the old cap; hundredth succeeds and next waits for the rolling five-hour expiry', async () => {
  const f = fixture();
  f.state.users[f.user] = { count: 6, starts: Array(6).fill(f.now - 60000), noticeUntil: f.now + 3600000 };
  await f.request('past-old-cap');
  expect(f.answer).toHaveBeenCalledTimes(1);
  f.state.users[f.user].count = 99; f.state.users[f.user].starts = Array(99).fill(f.now - 60000);
  delete f.state.users[f.user].noticeUntil;
  await f.request('hundredth'); await f.request('hundred-and-first');
  expect(f.answer).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls.at(-1)).toEqual(expect.arrayContaining([QQ_QUOTA_REPLY]));
  f.advance(3600001); await f.request('only-one-hour');
  expect(f.answer).toHaveBeenCalledTimes(2);
  f.advance(4 * 3600000); await f.request('five-hours-later');
  expect(f.answer).toHaveBeenCalledTimes(3);
});

test('daily counts no longer limit a user once the rolling five-hour window has capacity', async () => {
  const f = fixture();
  f.state.users[f.user] = { count: 100, starts: [] };
  await f.request('hundred-and-first');
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.state.users[f.user].count).toBe(101);
  await f.request('another-user', 'member-b');
  expect(f.answer).toHaveBeenCalledTimes(2);
});

test('entries expire exactly five hours after their recorded start', async () => {
  const f = fixture();
  f.state.users[f.user] = { count: 200, starts: [f.now - QQ_LIMITS.userWindowMs, ...Array(99).fill(f.now - 60000)] };
  await f.request('boundary');
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.state.users[f.user].starts).toHaveLength(100);
});

test('raised deployment budget admits existing usage while retaining the independent global ceiling', async () => {
  const f = fixture(); f.state.tokens = 348160;
  await f.request('previously-budget-limited');
  expect(f.answer).toHaveBeenCalledTimes(1);
  f.state.tokens = 40960000 - QQ_LIMITS.reservation + 1;
  await f.request('global-limit');
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls.at(-1)).toEqual(expect.arrayContaining([QQ_QUOTA_REPLY]));
});
