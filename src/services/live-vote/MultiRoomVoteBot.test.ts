import { MultiRoomVoteBot } from './MultiRoomVoteBot';

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
    ['200', '票型：1.丙:0票 2.丁:0票'],
    ['100', '结束：1.甲:1票 2.乙:0票 甲胜']
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
  expect(sent).toContainEqual(['100', '结束：1.甲:1票 2.乙:0票 甲胜']);
  expect(sent).toContainEqual(['200', '结束：1.丙:0票 2.丁:1票 丁胜']);
  expect(sent.map(([id]) => id)).toEqual(['100', '200', '100', '200']);
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
