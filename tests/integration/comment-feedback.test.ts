import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import request from 'supertest';
import { CommentFeedbackStore } from '../../src/services/bilibili/comment-replies/CommentFeedbackStore';
import { CommentStateStore } from '../../src/services/bilibili/comment-replies/CommentState';
import { CommentWorker } from '../../src/services/bilibili/comment-replies/CommentWorker';
import { CommentEvent, CommentReplyConfig, LIMITS } from '../../src/services/bilibili/comment-replies/CommentPolicy';
import { AdminCommentFeedback } from '../../src/services/admin/AdminCommentFeedback';
import { createAdminServer } from '../../src/services/admin/AdminServer';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-feedback-'));
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config/comment-replies.example.json'), JSON.stringify({ botUid: '99' }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const config: CommentReplyConfig = { botUid: '99', feedbackOwnerUids: ['99'], unlimitedUids: [], credentialConfigPath: 'config/production.json',
  providerConfigPath: 'config/production.json', dailyTokenBudget: 204800, maxQueue: 200, maxUserQueue: 10, pollIntervalMs: 30000 };
const event: CommentEvent = { key: '1:10:5', uid: '1', oid: '10', type: 1, trigger: 'mention', root: '5', parent: '5', text: '字幕太小，手机看不清', createdAt: 1000000 };
const note = { category: 'subtitles' as const, quote: '字幕太小', videoOwnerUid: '99', videoTitle: '我们的切片' };

test('durable feedback survives a restart and seven-day history pruning without another model call or reply', async () => {
  const directory = path.join(root, 'data/runtime/comment-feedback/99');
  const archive = new CommentFeedbackStore(directory, () => 1234567);
  const file = path.join(root, 'state.json');
  const store = new CommentStateStore(file, '99');
  const state = await store.open();
  const answer = jest.fn(async () => ({ reply: '字幕大小确实影响手机阅读。', feedback: note })), send = jest.fn(async () => '7');
  const worker = new CommentWorker(config, state, { save: value => store.save(value), answer, send, now: () => event.createdAt,
    collectFeedback: async () => { throw Error('disk unavailable'); } });
  await worker.admit(event); await worker.tick(); await store.close();
  const restarted = new CommentStateStore(file, '99'), restored = await restarted.open();
  expect(restored.jobs[0]).toMatchObject({ status: 'sent', feedback: note });
  const resumed = new CommentWorker(config, restored, { save: value => restarted.save(value), answer, send,
    now: () => event.createdAt + LIMITS.retentionMs + 1, collectFeedback: (e, n) => archive.collect(e, n) });
  await resumed.tick(); await resumed.tick(); await restarted.close();
  expect(restored.jobs).toHaveLength(0); expect(answer).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  await archive.collect(event, { ...note, videoTitle: '重试不能覆盖首次记录' });
  expect(await fs.readdir(directory)).toHaveLength(1);
  const view = new AdminCommentFeedback(root).view();
  expect(view.rows[0]).toMatchObject({ videoTitle: note.videoTitle, collectedAt: 1234567, comment: event.text });
  expect(view.rows[0].url).toContain('comment_root_id=5&comment_secondary_id=5');
});

test('archive listing is authenticated, paginated and filtered without modifying records; corruption is visible', async () => {
  const directory = path.join(root, 'data/runtime/comment-feedback/99'), store = new CommentFeedbackStore(directory);
  const admin = new AdminCommentFeedback(root);
  expect(admin.view().total).toBe(0);
  for (let i = 1; i <= 55; i++) await store.collect({ ...event, key: `1:10:${i}`, parent: String(i), root: String(i) }, note);
  const files = await fs.readdir(directory), before = await fs.readFile(path.join(directory, files[0]), 'utf8');
  expect(admin.view()).toMatchObject({ total: 55, pages: 2, counts: { subtitles: 55 } });
  expect(admin.view({ page: 2 }).rows).toHaveLength(5);
  expect(admin.view({ category: 'audio' }).total).toBe(0);
  expect(admin.view({ search: '手机' }).total).toBe(55);
  expect(() => admin.view({ category: '../' })).toThrow();
  const app = createAdminServer({ commentFeedback: admin } as any, 'a'.repeat(64));
  await request(app).get('/comment-feedback').expect(403);
  await request(app).get('/comment-feedback').query({ search: '手机' }).set('Authorization', `Bearer ${'a'.repeat(64)}`).expect(200);
  await request(app).post('/comment-feedback').set('Authorization', `Bearer ${'a'.repeat(64)}`).expect(404);
  expect(await fs.readFile(path.join(directory, files[0]), 'utf8')).toBe(before);
  await fs.writeFile(path.join(directory, files[0]), '{}');
  expect(() => admin.view()).toThrow('存档');
});
