import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QQRecords } from './QQRecords';
import { qqRequest, QQInbound } from './QQPolicy';
import { AdminQQRecords } from '../admin/AdminQQRecords';
import requestHttp from 'supertest';
import { createAdminServer } from '../admin/AdminServer';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-records-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const at = Date.parse('2026-10-28T02:00:00Z');
const inbound: QQInbound = { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'private-user', groupOpenid: 'private-group',
  messageId: 'message-a', content: '鹿饼你好', timestamp: new Date(at).toISOString() };

test('durable question and answer survive new reader, with filters and no raw identifiers', async () => {
  const request = qqRequest(inbound, at)!, writer = new QQRecords(root, '900000001', () => at + 1000);
  await writer.write(request, { status: 'accepted' });
  await writer.write(request, { status: 'sending', answer: '你好呀', model: 'gpt-6-luna' });
  expect(new AdminQQRecords(root).view().rows[0].status).toBe('sending');
  await writer.write(request, { status: 'sent' });
  const view = new AdminQQRecords(root).view({ date: '2026-10-28', scope: 'group', status: 'sent', search: '你好' });
  expect(view.total).toBe(1); expect(view.rows[0]).toMatchObject({ question: '鹿饼你好', answer: '你好呀', status: 'sent' });
  expect(JSON.stringify(view)).not.toContain('private-user'); expect(JSON.stringify(view)).not.toContain('private-group');
  expect(new AdminQQRecords(root).view({ scope: 'c2c' }).total).toBe(0);
  expect(new AdminQQRecords(root).view({ date: '2026-10-27' }).total).toBe(0);
});
test('agent trace survives later send checkpoints and the admin projection strips nested unknown fields', async () => {
  const request = qqRequest(inbound, at)!, writer = new QQRecords(root, '900000001', () => at + 1000);
  const agent = { modelCalls: 2, inputTokens: 3000, outputTokens: 120,
    tools: [{ name: 'read_live_overview', status: 'ok' as const, elapsedMs: 40 }] };
  await writer.write(request, { status: 'generating', agent });
  await writer.write(request, { status: 'sent', answer: '10月27日唱歌看电影', model: 'gpt-6-luna' });
  const file = path.join(root, 'data/runtime/qqbot/records/900000001/2026-10-28', `${request.key}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.agent.tools[0].apiKey = 'must-not-leak';
  fs.writeFileSync(file, JSON.stringify(raw));
  const view = new AdminQQRecords(root).view();
  expect(view.rows[0].agent).toEqual(agent); expect(JSON.stringify(view)).not.toContain('must-not-leak');
  await expect(writer.write(request, { status: 'sent', agent: { ...agent, modelCalls: 1000 } })).rejects.toThrow('Invalid QQ transcript');
});
test('bounded paging and invalid filter rejection', async () => {
  const writer = new QQRecords(root, '900000001', () => at);
  for (let i = 0; i < 51; i++) await writer.write(qqRequest({ ...inbound, messageId: `message-${i}` }, at)!, { status: 'skipped' });
  expect(new AdminQQRecords(root).view().rows).toHaveLength(50);
  expect(new AdminQQRecords(root).view({ page: 2 }).rows).toHaveLength(1);
  for (const query of [{ date: '../../secret' }, { status: 'constructor' }, { scope: 'guild' }, { page: -1 }]) {
    expect(() => new AdminQQRecords(root).view(query)).toThrow();
  }
});
test('empty and corrupt archives differ and unknown stored fields are never exposed', async () => {
  expect(new AdminQQRecords(root).view().total).toBe(0);
  const request = qqRequest(inbound, at)!;
  await new QQRecords(root, '900000001', () => at).write(request, { status: 'accepted' });
  const file = path.join(root, 'data/runtime/qqbot/records/900000001/2026-10-28', `${request.key}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.apiKey = 'must-not-leak';
  fs.writeFileSync(file, JSON.stringify(record));
  expect(JSON.stringify(new AdminQQRecords(root).view())).not.toContain('must-not-leak');
  fs.writeFileSync(file, '{broken'); expect(() => new AdminQQRecords(root).view()).toThrow('QQ 问答存档无法读取');
});
test('admin route requires authentication and never accepts transcript writes', async () => {
  const token = 'test-token'.repeat(8);
  const app = createAdminServer({ qqRecords: new AdminQQRecords(root) } as any, token);
  await requestHttp(app).get('/qq-records').expect(403);
  const response = await requestHttp(app).get('/qq-records').set('Authorization', `Bearer ${token}`).expect(200);
  expect(response.body.rows).toEqual([]);
  await requestHttp(app).post('/qq-records').set('Authorization', `Bearer ${token}`).send({}).expect(404);
});
