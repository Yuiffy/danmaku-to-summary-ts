import * as fs from 'fs';
import * as path from 'path';
import { AdminCommentRepliesView } from '../../core/admin/commentReplies';
import { CommentState } from '../bilibili/comment-replies/CommentState';
import { LIMITS, positiveId, shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { AdminError } from './AdminFiles';

/** Read-only snapshots; the comment worker remains the only state writer. */
export class AdminCommentReplies {
  constructor(private readonly root: string, private readonly now = Date.now,
    private readonly alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } }) {}

  view(query: { page?: unknown; status?: unknown } = {}): AdminCommentRepliesView {
    const page = Number(query.page || 1), filter = String(query.status || 'all');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !['all', 'active', 'history'].includes(filter)) throw new AdminError('评论筛选条件无效');
    const config = JSON.parse(fs.readFileSync(path.join(this.root, 'config/comment-replies.example.json'), 'utf8').replace(/^\uFEFF/u, ''));
    if (!positiveId(config.botUid)) throw new AdminError('评论账号配置无效', 503);
    const file = path.join(this.root, 'data/runtime/comment-replies', `${config.botUid}.json`);
    const empty: AdminCommentRepliesView = { service: 'missing', counts: {}, today: { reservedTokens: 0, modelCalls: 0,
      limit: Math.floor(config.dailyTokenBudget / LIMITS.tokenReservation) }, total: 0, page, pages: 1, rows: [] };
    if (!fs.existsSync(file)) return empty;
    const stat = fs.statSync(file);
    if (stat.size > 40 * 1024 * 1024) throw new AdminError('评论状态过大，请检查消费者', 503);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as CommentState;
    if (state.botUid !== config.botUid || state.version !== 1 || !Array.isArray(state.jobs)) throw new AdminError('评论状态无效', 503);
    const isActive = (status: string) => ['queued', 'generating', 'ready', 'sending'].includes(status);
    const jobs = state.jobs.filter(job => filter === 'all' || isActive(job.status) === (filter === 'active')).reverse();
    const usage = state.days[shanghaiDay(this.now())]?.tokens || 0;
    let running = false;
    try {
      const lock = JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8'));
      running = lock.botUid === state.botUid && Number.isSafeInteger(lock.pid) && lock.pid > 0 && this.alive(lock.pid);
    } catch { /* Missing/stale lock means stopped, never acquire or clear it here. */ }
    return { ...empty, service: state.paused ? 'paused' : running ? 'running' : 'stopped', updatedAt: stat.mtimeMs,
      counts: state.jobs.reduce<Record<string, number>>((result, job) => { result[job.status] = (result[job.status] || 0) + 1; return result; }, {}),
      today: { reservedTokens: usage, modelCalls: Math.floor(usage / LIMITS.tokenReservation), limit: empty.today.limit },
      total: jobs.length, pages: Math.max(1, Math.ceil(jobs.length / 50)),
      rows: jobs.slice((page - 1) * 50, page * 50).map(job => ({ key: job.event.key, uid: job.event.uid, type: job.event.type,
        trigger: job.event.trigger || 'legacy', text: job.event.text, answer: job.answer, status: job.status,
        admittedAt: job.admittedAt, processingAt: job.processingAt, completedAt: job.completedAt, replyId: job.replyId,
        likeStatus: job.likeStatus, url: job.event.type === 1 && positiveId(job.event.oid) && positiveId(job.event.root)
          ? `https://www.bilibili.com/video/av${job.event.oid}?comment_on=1&comment_root_id=${job.event.root}${job.replyId && positiveId(job.replyId) ? `&comment_secondary_id=${job.replyId}#reply${job.replyId}` : ''}` : undefined })) };
  }
}
