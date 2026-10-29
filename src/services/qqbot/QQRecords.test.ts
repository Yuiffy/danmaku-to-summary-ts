import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QQRecords } from './QQRecords';
import { qqRequest, QQInbound, QQ_LIMITS } from './QQPolicy';
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

test('expanded agent rounds persist and remain readable through the admin contract, including a blocked next round', async () => {
  const request = qqRequest(inbound, at)!, writer = new QQRecords(root, '900000001', () => at + 1000);
  const agent = { modelCalls: QQ_LIMITS.agentTurns, inputTokens: 30000, outputTokens: 2000,
    tools: Array.from({ length: QQ_LIMITS.agentTurns - 1 }, () => ({ name: 'search_recordings', status: 'ok' as const, elapsedMs: 1 })),
    calls: Array.from({ length: QQ_LIMITS.agentTurns + 1 }, (_, index) => ({ turn: index + 1, at, elapsedMs: 1,
      status: index < QQ_LIMITS.agentTurns ? 'ok' as const : 'blocked' as const, requestBytes: 1000,
      budgetBefore: 1000 * index, charge: 1000, budgetLimit: QQ_LIMITS.reservation })) };
  await writer.write(request, { status: 'generating', agent });
  await writer.write(request, { status: 'sent', answer: '查询完成', model: 'gpt-6-luna' });
  expect(new AdminQQRecords(root).view().rows[0].agent).toEqual(agent);
  await expect(writer.write(request, { status: 'generating', agent: { ...agent, modelCalls: QQ_LIMITS.agentTurns + 1 } })).rejects.toThrow();
});
test('detailed failure survives fallback sending and strips unknown diagnostic fields at every level', async () => {
  const request = qqRequest(inbound, at)!, writer = new QQRecords(root, '900000001', () => at + 1000);
  const failure = { stage: 'model_budget' as const, code: 'budget_exceeded' as const, at, turn: 4, budgetBefore: 60000, charge: 10000, budgetLimit: 65536 };
  const call = { turn: 4, at, elapsedMs: 0, status: 'blocked' as const, requestBytes: 8976, budgetBefore: 60000, charge: 10000, budgetLimit: 65536, failure };
  await writer.write(request, { status: 'generating', queuedMs: 45000, error: 'model_failed', failure,
    agent: { modelCalls: 3, inputTokens: 9000, outputTokens: 180, calls: [call], failures: [failure],
      tools: [{ name: 'read_context', status: 'failed', elapsedMs: 40, failure: { stage: 'tool', code: 'tool_failed', at } }] } });
  await writer.write(request, { status: 'sending', answer: '这次没答好' }); await writer.write(request, { status: 'sent' });
  const file = path.join(root, 'data/runtime/qqbot/records/900000001/2026-10-28', `${request.key}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const node of [raw.failure, raw.agent.calls[0], raw.agent.calls[0].failure, raw.agent.failures[0], raw.agent.tools[0].failure]) node.apiKey = 'must-not-leak';
  fs.writeFileSync(file, JSON.stringify(raw));
  const row = new AdminQQRecords(root).view().rows[0];
  expect(row).toMatchObject({ status: 'sent', error: 'model_failed', failure, queuedMs: 45000 });
  expect(row.agent!.calls).toEqual([call]); expect(JSON.stringify(row)).not.toContain('must-not-leak');
  await expect(writer.write(request, { status: 'sent', failure: { ...failure, code: 'made_up' as any } })).rejects.toThrow('Invalid QQ transcript');
});

test('platform nicknames persist through send checkpoints and support admin search alongside legacy records', async () => {
  const writer = new QQRecords(root, '900000001', () => at + 1000);
  const named = qqRequest({ ...inbound, senderName: '小饼干' }, at)!;
  await writer.write(named, { status: 'accepted' });
  await writer.write(named, { status: 'sent', answer: '你好呀' });
  await writer.write(qqRequest({ ...inbound, messageId: 'legacy' }, at)!, { status: 'skipped' });
  const view = new AdminQQRecords(root).view({ search: '小饼干' });
  expect(view.total).toBe(1); expect(view.rows[0].senderName).toBe('小饼干');
  expect(new AdminQQRecords(root).view().total).toBe(2);
  const file = path.join(root, 'data/runtime/qqbot/records/900000001/2026-10-28', `${named.key}.json`);
  for (const senderName of ['', 'bad\nname', '鱼'.repeat(81), 42]) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.senderName = senderName;
    fs.writeFileSync(file, JSON.stringify(record));
    expect(() => new AdminQQRecords(root).view()).toThrow('QQ 问答存档无法读取');
  }
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
