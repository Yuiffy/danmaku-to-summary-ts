import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AdminCommentReplies } from './AdminCommentReplies';
import { createAdminServer } from './AdminServer';
import { newCommentState } from '../bilibili/comment-replies/CommentState';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-admin-')); fs.mkdirSync(path.join(root, 'config')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('bounded read-only history exposes progress without owner/checkpoint/config secrets', async () => {
  fs.writeFileSync(path.join(root, 'config/comment-replies.example.json'), JSON.stringify({ botUid: '99', dailyTokenBudget: 4096000, cookie: 'private-cookie' }));
  const admin = new AdminCommentReplies(root, () => Date.UTC(2026, 9, 22), () => true);
  expect(admin.view().service).toBe('missing');
  const file = path.join(root, 'data/runtime/comment-replies/99.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = newCommentState('99'); state.feeds.at.head = 'secret-checkpoint';
  for (let i = 0; i < 55; i++) state.jobs.push({ event: { key: String(i), uid: '1', oid: '10', type: 1, root: '100', parent: '200', text: '<script>untrusted</script>', createdAt: 1, trigger: 'mention' },
    status: i === 54 ? 'generating' : 'sent', admittedAt: i + 1, processingAt: i + 2, likeStatus: 'liked', replyId: String(300 + i) });
  fs.writeFileSync(file, JSON.stringify(state)); fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 123, botUid: '99' }));
  const before = fs.readFileSync(file, 'utf8'), view = admin.view();
  expect(view).toMatchObject({ service: 'running', total: 55, pages: 2 }); expect(view.rows).toHaveLength(50);
  expect(view.rows[0]).toMatchObject({ status: 'generating', likeStatus: 'liked', trigger: 'mention' });
  expect(admin.view({ status: 'active' }).rows).toHaveLength(1); expect(admin.view({ page: 2 }).rows).toHaveLength(5);
  expect(JSON.stringify(view)).not.toMatch(/private-cookie|secret-checkpoint/);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(() => admin.view({ page: '../99' })).toThrow();
  const app = createAdminServer({ commentReplies: admin } as any, 'a'.repeat(64));
  await request(app).get('/comment-replies').expect(403);
  const response = await request(app).get('/comment-replies?status=active').set('Authorization', `Bearer ${'a'.repeat(64)}`).expect(200);
  expect(response.body.rows).toHaveLength(1);
});
