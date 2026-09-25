import { MultiRoomVoteBot } from './MultiRoomVoteBot';

const now = 1790259000000;
const rooms = [
  { roomId: '100', ownerUid: '10', connected: true },
  { roomId: '200', ownerUid: '20', connected: true }
];
const message = (roomId: string, uid: string, text: string, at = now) => ({ roomId, uid, text, sentAt: at });

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
  expect(sent).toContainEqual(['100', '结束 1:1票 2:0票 1胜']);
  expect(sent).toContainEqual(['200', '结束 1:0票 2:1票 2胜']);
  expect(sent.map(([id]) => id)).toEqual(['100', '100', '200', '200', '100', '200']);
});

it('allows a configured global administrator in every known room and waits for trustworthy owner metadata', async () => {
  const sent = jest.fn(async () => {});
  const bot = new MultiRoomVoteBot({ globalAdminUids: ['42'] }, sent, jest.fn());
  bot.updateRooms([...rooms, { roomId: '300', ownerUid: '0', connected: true }]);
  for (const id of ['100', '200', '300', '400']) bot.ingest(message(id, '42', '#投票 1甲 2乙'), now);
  await bot.flush();
  expect(sent.mock.calls.map(call => (call as unknown[])[0])).toEqual(['100', '100', '200', '200']);
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
  expect(sent.mock.calls.map(call => (call as unknown[])[0])).toEqual(['200', '200']);
  bot.updateRooms([{ ...rooms[1], ownerUid: '21' }]);
  bot.ingest(message('200', '20', '#投票 1甲 2乙'), now);
  bot.ingest(message('200', '21', '#投票 1甲 2乙'), now);
  bot.updateRooms([]);
  await bot.flush();
  bot.tick(now + 33000);
  await bot.flush();
  expect(sent).toHaveBeenCalledTimes(2);
  bot.updateRooms(rooms);
  bot.ingest(message('100', '10', '#投票 1甲 2乙'), now);
  bot.disconnect();
  await bot.flush();
  expect(sent).toHaveBeenCalledTimes(2);
});
