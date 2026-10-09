import { MultiRoomVoteBot } from './MultiRoomVoteBot';
import * as path from 'path';
import * as os from 'os';
import { LiveQuestionConfig, QuestionAnswer } from './questions/QuestionPolicy';

const now = 1790259000000;
const rooms = [
  { roomId: '100', ownerUid: '10', connected: true },
  { roomId: '200', ownerUid: '20', connected: true }
];
const message = (roomId: string, uid: string, text: string, at = now) => ({ roomId, uid, text, sentAt: at });

it('finishes only the commanded room and discards its queued progress while preserving other rooms', async () => {
  const sent: Array<[string, string]> = [];
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'] }, async (id, text) => { sent.push([id, text]); }, jest.fn());
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.ingest(message('200', '20', '#投票 1丙 2丁'), now);
  await bot.flush();
  bot.ingest(message('100', '30', '1', now + 100), now + 100);
  bot.tick(now + 10000);
  bot.ingest(message('100', '20', '#结束投票', now + 10000), now + 10000);
  bot.ingest(message('100', '10', '#结束投票', now + 10000), now + 10000);
  await bot.flush();
  expect(sent).toEqual([
    ['100', '投票30秒，发序号：1.甲 2.乙'],
    ['200', '投票30秒，发序号：1.丙 2.丁'],
    ['200', '剩余20秒~1.丙:0票 2.丁:0票'],
    ['100', '结束：1.甲:1票 2.乙:0票 【甲】胜~']
  ]);
  bot.ingest(message('200', '42', '#结束投票', now + 11000), now + 11000);
  await bot.flush();
  expect(sent[4]).toEqual(['200', '结束：1.丙:0票 2.丁:0票 无人投票']);
  bot.tick(now + 33000);
  await bot.flush();
  expect(sent).toHaveLength(5);
});

it('authorizes each owner only in their room and counts viewers independently across simultaneous votes', async () => {
  const sent: Array<[string, string]> = [];
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'], botUid: '99' }, async (id, text) => { sent.push([id, text]); }, jest.fn());
  bot.updateRooms(rooms);
  bot.ingest(message('200', '10', '#投票 1甲 2乙'), now);
  await bot.flush();
  expect(sent).toEqual([]);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.ingest(message('200', '20', '#投票 1丙 2丁'), now);
  await bot.flush();
  bot.ingest(message('100', '30', '111'), now);
  bot.ingest(message('100', '30', '2'), now);
  bot.ingest(message('200', '30', '222'), now);
  bot.ingest(message('200', '99', '1'), now);
  bot.ingest(message('200', '10', '#取消投票'), now);
  bot.tick(now + 33000);
  await bot.flush();
  expect(sent).toContainEqual(['100', '结束：1.甲:1票 2.乙:0票 【甲】胜~']);
  expect(sent).toContainEqual(['200', '结束：1.丙:0票 2.丁:1票 【丁】胜~']);
  expect(sent.map(([id]) => id)).toEqual(['100', '200', '100', '200']);
});

it('isolates letter subsets and numeric keys across rooms', async () => {
  const sent: Array<[string, string]> = [];
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'] }, async (id, text) => { sent.push([id, text]); }, jest.fn());
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 B甲 C乙'), now);
  bot.ingest(message('200', '20', '#投票 2丙 3丁'), now);
  await bot.flush();
  for (const roomId of ['100', '200']) {
    bot.ingest(message(roomId, '30', 'bbb'), now);
    bot.ingest(message(roomId, '30', '333'), now);
  }
  bot.tick(now + 33000);
  await bot.flush();
  expect(sent).toContainEqual(['100', '结束：B.甲:1票 C.乙:0票 【甲】胜~']);
  expect(sent).toContainEqual(['200', '结束：2.丙:0票 3.丁:1票 【丁】胜~']);
});

it('allows a configured global administrator in every known room and waits for trustworthy owner metadata', async () => {
  const sent = jest.fn(async () => {});
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'] }, sent, jest.fn());
  bot.updateRooms([...rooms, { roomId: '300', ownerUid: '0', connected: true }]);
  for (const id of ['100', '200', '300', '400']) bot.ingest(message(id, '42', '#投票 1甲 2乙'), now);
  await bot.flush();
  expect(sent.mock.calls.map(call => (call as unknown[])[0])).toEqual(['100', '200']);
  bot.ingest(message('200', '42', '#取消投票'), now);
  await bot.flush();
  expect(sent).toHaveBeenLastCalledWith('200', '投票已取消', expect.any(Function));
});

it('cancels removed, disconnected and owner-changed rooms, invalidating queued messages without affecting other rooms', async () => {
  const sent = jest.fn(async () => {});
  const bot = new MultiRoomVoteBot({ globalAdminUids: [] }, sent, jest.fn());
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.ingest(message('200', '20', '#投票 1甲 2乙'), now);
  bot.updateRooms([{ ...rooms[0], connected: false }, rooms[1]]);
  await bot.flush();
  expect(sent.mock.calls.map(call => (call as unknown[])[0])).toEqual(['200']);
  bot.updateRooms([{ ...rooms[1], ownerUid: '21' }]);
  bot.ingest(message('200', '20', '#投票 1甲 2乙'), now);
  bot.ingest(message('200', '21', '#投票 1甲 2乙'), now);
  bot.updateRooms([]);
  await bot.flush();
  bot.tick(now + 33000);
  await bot.flush();
  expect(sent).toHaveBeenCalledTimes(1);
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.disconnect();
  await bot.flush();
  expect(sent).toHaveBeenCalledTimes(1);
});

const questionConfig: LiveQuestionConfig = {
  enabled: true, providerConfigPath: path.join(os.tmpdir(), 'provider.json'),
  recordingRoots: { '100': [path.join(os.tmpdir(), 'room100')], '200': [path.join(os.tmpdir(), 'room200')] }
};

it('shares one question worker across rooms and preserves its replies when only a vote is cancelled', async () => {
  const sent: Array<[string, string]> = [];
  let finish!: (result: QuestionAnswer) => void;
  const answerer = jest.fn(() => new Promise<QuestionAnswer>(resolve => { finish = resolve; }));
  const bot = new MultiRoomVoteBot({ globalAdminUids: [], questions: questionConfig }, async (id, text) => { sent.push([id, text]); }, jest.fn(), answerer);
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '@鹿饼 玩过法环吗？'), now);
  bot.ingest(message('200', '20', '@鹿饼 有唱过什么歌？'), now);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.ingest(message('100', '10', '#取消投票'), now);
  await Promise.resolve();
  finish({ answer: '玩过法环。' });
  await bot.flush();
  expect(answerer).toHaveBeenCalledTimes(1);
  expect(sent).toContainEqual(['200', '正忙着查「玩过法环吗?」问题，请稍后再问']);
  expect(sent).toContainEqual(['100', '投票已取消']);
  expect(sent).toContainEqual(['100', '鹿饼答：玩过法环。']);
  bot.stop();
});

it('aborts questions when a room owner changes and suppresses late answers', async () => {
  let finish!: (result: QuestionAnswer) => void;
  let signal!: AbortSignal;
  let unblock!: () => void;
  const blocker = new Promise<void>(resolve => { unblock = resolve; });
  const sent: Array<[string, string]> = [];
  const answerer = jest.fn((_request, requestSignal: AbortSignal) => {
    signal = requestSignal;
    return new Promise<QuestionAnswer>(resolve => { finish = resolve; });
  });
  const bot = new MultiRoomVoteBot({ globalAdminUids: [], questions: questionConfig }, async (id, text, current) => {
    await blocker;
    if (current()) sent.push([id, text]);
  }, jest.fn(), answerer);
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '@鹿饼 玩过法环吗？'), now);
  await Promise.resolve();
  bot.updateRooms([{ ...rooms[0], ownerUid: '11' }, rooms[1]]);
  expect(signal.aborted).toBe(true);
  finish({ answer: '旧主播答案' });
  unblock();
  await bot.flush();
  expect(sent).toEqual([]);
  bot.stop();
});

it('drops completed answers waiting behind a send when the source room is removed', async () => {
  let unblock!: () => void;
  const blocker = new Promise<void>(resolve => { unblock = resolve; });
  const sent: string[] = [];
  const bot = new MultiRoomVoteBot({ globalAdminUids: [], questions: questionConfig }, async (_id, text, current) => {
    await blocker;
    if (current()) sent.push(text);
  }, jest.fn(), async () => ({ answer: '不应发到已经移除的房间' }));
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.ingest(message('100', '10', '@鹿饼 玩过法环吗？'), now);
  await new Promise(resolve => setImmediate(resolve));
  bot.updateRooms([rooms[1]]);
  unblock();
  await bot.flush();
  expect(sent).toEqual([]);
  bot.stop();
});

it('accepts question requests only from the local owner or configured global administrator', async () => {
  const send = jest.fn(async () => {});
  const answer = jest.fn(async () => ({ answer: '没查到。' }));
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'], questions: questionConfig }, send, jest.fn(), answer);
  bot.updateRooms(rooms);
  for (const uid of ['30', '20']) bot.ingest(message('100', uid, '@鹿饼 玩过法环吗？'), now);
  await bot.flush();
  expect(answer).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  bot.ingest(message('100', '42', '@鹿饼 玩过法环吗？'), now);
  await bot.flush();
  expect(answer).toHaveBeenCalledTimes(1);
  bot.stop();
});
