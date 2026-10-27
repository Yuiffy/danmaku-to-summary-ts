import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminQQRecords } from './AdminQQRecords';
import { QQRecords } from '../qqbot/QQRecords';
import { QQInbound, QQ_QUOTA_REPLY, qqRequest } from '../qqbot/QQPolicy';
import { newQQState } from '../qqbot/QQState';

let root: string;
const now = Date.parse('2026-10-28T10:00:00+08:00'), appId = '900000001';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-statistics-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const inbound = (id: string, extra: Partial<QQInbound> = {}): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member-a', groupOpenid: 'group-a', messageId: id, content: `问题${id}`, timestamp: new Date(now).toISOString(), ...extra });

test('user and conversation filters compose before paging; facets and summaries cover the complete selected day', async () => {
  const writer = new QQRecords(root, appId, () => now);
  for (let i = 0; i < 51; i++) await writer.write(qqRequest(inbound(`a-${i}`, { senderName: '小饼干', groupOpenid: i ? 'group-a' : 'group-b' }), now)!,
    { status: 'sent', answer: i ? '你好呀' : QQ_QUOTA_REPLY });
  await writer.write(qqRequest(inbound('b', { senderId: 'member-b', senderName: '小鱼' }), now)!, { status: 'skipped' });
  const reader = new AdminQQRecords(root, () => now), all = reader.view();
  expect(all.summary).toMatchObject({ records: 52, users: 2, conversations: 2, replied: 51, skipped: 1, quotaNotices: 1 });
  const user = all.users.find(item => item.senderName === '小饼干')!;
  expect(user.stats).toMatchObject({ records: 51, conversations: 2, quotaNotices: 1 });
  const second = reader.view({ user: user.key, page: 2 });
  expect(second.rows).toHaveLength(1); expect(second.summary.records).toBe(51); expect(second.users).toHaveLength(2);
  const group = all.conversations.find(item => item.records === 51)!;
  const scoped = reader.view({ user: user.key, conversation: group.key });
  expect(scoped.total).toBe(50); expect(scoped.rows.every(row => row.user === user.user)).toBe(true);
  const searched = reader.view({ user: user.key, status: 'sent', search: QQ_QUOTA_REPLY });
  expect(searched.total).toBe(1); expect(searched.summary.quotaNotices).toBe(1); expect(searched.users).toHaveLength(2);
});

test('same hashes in different bot accounts remain separate user selections and private scope does not leak group records', async () => {
  const request = qqRequest(inbound('one'), now)!;
  for (const account of [appId, '900000002']) await new QQRecords(root, account, () => now).write(request, { status: 'sent', answer: '你好' });
  const privateRequest = qqRequest(inbound('private', { kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE' }), now)!;
  await new QQRecords(root, appId, () => now).write(privateRequest, { status: 'sent', answer: '请进群' });
  const reader = new AdminQQRecords(root, () => now);
  expect(reader.view({ user: `${appId}:${request.user}` }).rows.map(row => row.appId)).toEqual([appId]);
  const privateView = reader.view({ scope: 'c2c' });
  expect(privateView.total).toBe(1); expect(privateView.users).toHaveLength(1); expect(privateView.conversations[0].scope).toBe('c2c');
  for (const query of [{ user: '../secret' }, { conversation: request.user }, { user: `0001:${request.user}` }]) expect(() => reader.view(query)).toThrow('QQ 记录筛选条件无效');
});

test('historical record filters still show current quota counters; reads never rewrite a stale runtime ledger', async () => {
  const request = qqRequest(inbound('old', { timestamp: '2026-10-27T10:00:00+08:00' }), now - 86400000)!;
  await new QQRecords(root, appId, () => now).write(request, { status: 'sent', answer: QQ_QUOTA_REPLY });
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/qqbot.example.json'), JSON.stringify({ dailyTokenBudget: 40960000, apiKey: 'do-not-expose' }));
  const state = newQQState(appId); state.day = '2026-10-27'; state.tokens = 40960000;
  state.users[request.user] = { count: 123, starts: Array(100).fill(now - 2 * 3600000), noticeUntil: now + 3600000 };
  const file = path.join(root, `data/runtime/qqbot/${appId}.json`); fs.writeFileSync(file, JSON.stringify(state));
  const before = fs.readFileSync(file, 'utf8'), reader = new AdminQQRecords(root, () => now);
  const view = reader.view({ date: '2026-10-27' });
  expect(view.users[0].text).toMatchObject({ status: 'limited', used: 100, reasons: [{ code: 'user_window' }] });
  expect(view.accounts[0].tokensUsed).toBe(0); expect(JSON.stringify(view)).not.toContain('do-not-expose');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  fs.writeFileSync(file, 'broken'); expect(reader.view().users[0].text.status).toBe('unavailable');
});
