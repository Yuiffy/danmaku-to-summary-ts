import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AdminAIVideoQueue } from './AdminAIVideoQueue';
import { createAdminServer } from './AdminServer';
import { digest } from './AdminFiles';

let root: string, queueFile: string;
const token = 'a'.repeat(64), headers = { Authorization: `Bearer ${token}` };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-video-')); queueFile = path.join(root, 'queue.json'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (tasks: unknown[]) => fs.writeFileSync(queueFile, JSON.stringify({ tasks }));
const task = (id: string, status: string) => ({ id, name: `视频${id}`, status, prompt: '岁己散步', model_version: 'seedance2.0mini', completed: status === 'completed' ? 1 : 0, repeat: 1,
  reference_images: ['D:/private/reference.png'], audio_references: [], qq: { user: 'private-user' }, canvas: { submitId: `private-submit-${id}`, creditConfirmationToken: 'private-token' } });
const server = () => createAdminServer({ configs: {} as any, clips: {} as any, jobs: {} as any, aiVideoQueue: new AdminAIVideoQueue(queueFile) }, token);

test('projects current and historical tasks without exposing private paths, identities or tokens and never mutates queue', () => {
  write([task('draft', 'draft'), task('waiting', 'pending'), { ...task('running', 'submitted'), inflight: [{ submitted_at: 100, next_query_at: 200 }] }, task('old', 'completed'),
    { ...task('ambiguous', 'pending'), submission_reservations: [{ state: 'needs_review' }] }, { ...task('credit', 'paused'), failure_code: 'confirmation_required', required_credits: 90 }]);
  const before = fs.readFileSync(queueFile, 'utf8'), adapter = new AdminAIVideoQueue(queueFile);
  const current = adapter.view();
  expect(current.total).toBe(5); expect(current.counts).toMatchObject({ draft: 1, pending: 1, submitted: 1, completed: 1, needs_review: 1 });
  expect(current.rows.find(row => row.id === 'running')).toMatchObject({ active: 1, lastSubmittedAt: 100000, nextQueryAt: 200000 });
  expect(adapter.view({ view: 'history' }).rows.map(row => row.id)).toEqual(['old']);
  expect(adapter.view({ view: 'all', search: 'credit' }).rows[0]).toMatchObject({ requiredCredits: 90 });
  expect(JSON.stringify(current)).not.toMatch(/private-|D:\//u);
  expect(fs.readFileSync(queueFile, 'utf8')).toBe(before);
});
test('paginates and bounds invalid or corrupt inputs', () => {
  const adapter = new AdminAIVideoQueue(queueFile);
  expect(() => adapter.view()).toThrow('不可读');
  write(Array.from({ length: 35 }, (_, index) => task(String(index), 'completed')));
  expect(adapter.view({ view: 'history', page: 2 })).toMatchObject({ page: 2, pages: 2, total: 35, rows: expect.any(Array) });
  expect(adapter.view({ view: 'history', page: 2 }).rows).toHaveLength(5);
  for (const query of [{ page: -1 }, { page: 1.5 }, { view: 'delete' }, { search: 'x'.repeat(201) }]) expect(() => adapter.view(query)).toThrow('筛选无效');
  fs.writeFileSync(queueFile, '{'); expect(() => adapter.view()).toThrow('已损坏');
});
test('lists reference-video counts without exposing source paths', () => {
  write([{ ...task('video', 'pending'), video_references: ['D:/private/source.mp4'] }]);
  const view = new AdminAIVideoQueue(queueFile).view();
  expect(view.rows[0].videoCount).toBe(1);
  expect(JSON.stringify(view)).not.toContain('private/source.mp4');
});
test('aggregates users across groups and filters without counting rejected or replayed submissions twice', () => {
  const owner = { app: '900000001', user: 'a'.repeat(64) };
  const priced = (id: string, amount: number, state = 'accepted') => ({ ...task(id, 'submitted'), qq: owner,
    qq_sender_name: '小鱼', canvas: { submitId: id }, credit_usage: { submit_id: id, quoted_credits: amount, run_state: state } });
  write([priced('one', 90), { ...priced('one', 90), qq: { ...owner, conversation: 'other-group' } },
    priced('uncertain', 30, 'intent'), priced('rejected', 100, 'rejected'), priced('quote-only', 200, 'quoted'),
    { ...priced('completed', 10, 'intent'), status: 'completed' }, { ...task('old', 'completed'), qq: owner },
    { ...task('draft', 'draft'), qq: owner },
    { ...priced('invalid', 900), credit_usage: { submit_id: 'invalid', quoted_credits: '900', run_state: 'accepted' } },
    { ...priced('other', 20), qq: { ...owner, app: '900000002' }, qq_sender_name: '另一用户' }]);
  const view = new AdminAIVideoQueue(queueFile).view({ search: 'nothing', view: 'history' });
  expect(view.rows).toEqual([]);
  expect(view.creditUsage).toHaveLength(2);
  expect(view.creditUsage[0]).toMatchObject({ senderName: '小鱼', tasks: 8, completed: 2,
    submittedCredits: 100, uncertainCredits: 30, unpricedTasks: 2 });
  expect(view.creditUsage[1]).toMatchObject({ submittedCredits: 20, tasks: 1 });
  expect(JSON.stringify(view.creditUsage)).not.toContain(owner.user);
});

test('authenticates readonly listing and streams registered output with Range/HEAD support', async () => {
  const id = `qq_900000001_${'b'.repeat(64)}`, directory = path.join(root, 'qq-results', id), file = path.join(directory, 'video.mp4');
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, '0000ftypisom0000');
  write([{ ...task(id, 'completed'), qq_output: file }]);
  const app = server(), endpoint = `/queues/ai-video/${digest(id)}/media`;
  await request(app).get('/queues/ai-video').expect(403);
  const list = await request(app).get('/queues/ai-video?view=history').set(headers).expect(200);
  expect(list.body.rows[0].playable).toBe(true);
  const result = await request(app).get(endpoint).set(headers).set('Range', 'bytes=4-7').expect(206);
  expect(result.headers['content-range']).toBe('bytes 4-7/16'); expect(result.body.toString()).toBe('ftyp');
  await request(app).head(endpoint).set(headers).expect(200);
  await request(app).get(endpoint).expect(403);
  for (const method of ['post', 'put', 'delete'] as const) await request(app)[method]('/queues/ai-video').set(headers).send({}).expect(404);
  write([{ ...task(id, 'completed'), qq_output: path.join(root, 'private.mp4') }]); fs.writeFileSync(path.join(root, 'private.mp4'), '0000ftypisom0000');
  await request(app).get(endpoint).set(headers).expect(404);
});
