import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AdminCommentFeedbackView, CommentFeedbackRecord } from '../../core/admin/commentFeedback';
import { positiveId, LIMITS } from '../bilibili/comment-replies/CommentPolicy';
import { validCommentFeedback } from '../bilibili/comment-replies/CommentFeedback';
import { AdminError } from './AdminFiles';

/** Local archive only: never fetches comments or calls a model during page reads. */
export class AdminCommentFeedback {
  constructor(private readonly root: string) {}
  view(query: { page?: unknown; category?: unknown; search?: unknown } = {}): AdminCommentFeedbackView {
    const page = Number(query.page || 1), category = String(query.category || 'all'), search = String(query.search || '').trim().toLocaleLowerCase();
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 120 ||
      !['all', 'selection', 'editing', 'subtitles', 'audio', 'visual', 'packaging', 'other'].includes(category)) throw new AdminError('反馈筛选条件无效');
    try {
      const config = JSON.parse(fs.readFileSync(path.join(this.root, 'config/comment-replies.example.json'), 'utf8').replace(/^\uFEFF/u, ''));
      if (!positiveId(config.botUid)) throw new Error('account');
      const directory = path.join(this.root, 'data/runtime/comment-feedback', config.botUid);
      const result: AdminCommentFeedbackView = { total: 0, page, pages: 1, counts: {}, rows: [] };
      if (!fs.existsSync(directory)) return result;
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('archive link');
      const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
      if (files.length > 20000) throw new Error('archive size');
      const records: CommentFeedbackRecord[] = [];
      for (const name of files) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('record size');
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as CommentFeedbackRecord;
        if (value.version !== 1 || value.source !== 'bilibili-mention' || typeof value.eventKey !== 'string' || value.eventKey.length > 120 ||
          value.id !== name.slice(0, -5) || createHash('sha256').update(value.eventKey).digest('hex') !== value.id ||
          ![value.videoAid, value.commentId, value.rootId, value.authorUid].every(positiveId) ||
          typeof value.comment !== 'string' || Array.from(value.comment).length > LIMITS.inputChars ||
          typeof value.authorName !== 'string' || value.authorName.length > 80 ||
          ![value.collectedAt, value.commentCreatedAt].every(at => Number.isSafeInteger(at) && at >= 0) ||
          !validCommentFeedback(value, { type: 1, trigger: 'mention', text: value.comment } as any)) throw new Error('record schema');
        result.counts[value.category] = (result.counts[value.category] || 0) + 1;
        if ((category === 'all' || value.category === category) && (!search ||
          [value.comment, value.videoTitle, value.authorName, value.videoAid].some(text => text.toLocaleLowerCase().includes(search)))) records.push(value);
      }
      records.sort((a, b) => b.collectedAt - a.collectedAt || a.id.localeCompare(b.id));
      result.total = records.length; result.pages = Math.max(1, Math.ceil(records.length / 50));
      result.rows = records.slice((page - 1) * 50, page * 50).map(value => ({ ...value,
        url: `https://www.bilibili.com/video/av${value.videoAid}?comment_on=1&comment_root_id=${value.rootId}&comment_secondary_id=${value.commentId}#reply${value.commentId}` }));
      return result;
    } catch { throw new AdminError('视频反馈存档无法读取，请检查存档完整性或容量', 503); }
  }
}
