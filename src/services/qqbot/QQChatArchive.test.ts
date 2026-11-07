import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QQChatArchive } from './QQChatArchive';
import { QQInbound } from './QQPolicy';
import { AdminQQChat } from '../admin/AdminQQChat';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-chat-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const at = Date.parse('2026-10-28T02:00:00Z');
const message = (id: string, text: string, timestamp = at): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE',
  senderId: 'member-a', senderName: '小饼干', groupOpenid: 'group-a', messageId: id, content: text, timestamp: new Date(timestamp).toISOString() });

test('captures ordinary group messages and supplies bounded context by conversation', async () => {
  const archive = new QQChatArchive(root, '900000001', () => at + 1000);
  const first = await archive.capture(message('1', '第一句'));
  const second = await archive.capture(message('2', '第二句', at + 1000));
  expect(first?.conversation).toMatch(/^[a-f0-9]{64}$/u);
  expect((await archive.recent(first!.conversation, at + 2000)).map(row => row.text)).toEqual(['第一句', '第二句']);
  expect((await archive.recent('bad', at + 2000))).toEqual([]);
  expect(second?.user).toBe(first?.user);
});

test('admin can filter and delete older dates', async () => {
  const archive = new QQChatArchive(root, '900000001', () => at + 86400000 * 3);
  await archive.capture(message('old', '旧消息', Date.parse('2026-10-26T02:00:00Z')));
  await archive.capture(message('new', '新消息', Date.parse('2026-10-28T02:00:00Z')));
  const admin = new AdminQQChat(root, () => at);
  expect(admin.view({ date: '2026-10-28', search: '新消息' }).total).toBe(1);
  expect(admin.deleteBefore('2026-10-28').deletedMessages).toBe(1);
  expect(admin.view({ date: '2026-10-26' }).total).toBe(0);
  expect(admin.view({ date: '2026-10-28' }).total).toBe(1);
});
