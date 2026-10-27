import * as fs from 'fs';
import * as path from 'path';
import { AdminQQRecordsView, QQ_RECORD_STATUSES, QQRecord, validQQRecord } from '../../core/admin/qqRecords';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { AdminError } from './AdminFiles';
import { createHash } from 'crypto';

/** Bounded, read-only local transcript listing. Never opens credentials or calls QQ. */
export class AdminQQRecords {
  constructor(private readonly root: string) {}
  image(appId: string, date: string, id: string): Buffer {
    if (!/^[1-9]\d{0,24}$/u.test(appId) || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^[a-f0-9]{64}$/u.test(id)) throw new AdminError('QQ 图片标识无效');
    try {
      const directory = path.join(this.root, 'data/runtime/qqbot/records', appId, date);
      const archive = path.join(this.root, 'data/runtime/qqbot/records');
      for (const entry of [archive, path.join(archive, appId), directory]) {
        const stat = fs.lstatSync(entry); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('image directory');
      }
      const recordFile = path.join(directory, `${id}.json`), imageFile = path.join(directory, `${id}.png`);
      for (const file of [recordFile, imageFile]) {
        const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (file === recordFile ? 65536 : 10 * 1024 * 1024)) throw new Error('image file');
      }
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as QQRecord;
      if (!validQQRecord(record) || record.id !== id || record.appId !== appId || shanghaiDay(record.requestedAt) !== date || !record.image) throw new Error('image schema');
      const image = fs.readFileSync(imageFile);
      if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || createHash('sha256').update(image).digest('hex') !== record.image.sha256) throw new Error('image hash');
      return image;
    } catch { throw new AdminError('QQ 图片存档无法读取或校验失败', 503); }
  }
  view(query: { page?: unknown; date?: unknown; scope?: unknown; status?: unknown; search?: unknown } = {}): AdminQQRecordsView {
    const page = Number(query.page || 1), scope = String(query.scope || 'all'), status = String(query.status || 'all');
    const search = String(query.search || '').trim().toLocaleLowerCase(), selected = String(query.date || '');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 120 ||
      !['all', 'group', 'c2c'].includes(scope) || (status !== 'all' && !Object.hasOwn(QQ_RECORD_STATUSES, status)) ||
      (selected && !/^\d{4}-\d{2}-\d{2}$/u.test(selected))) throw new AdminError('QQ 记录筛选条件无效');
    try {
      const directory = path.join(this.root, 'data/runtime/qqbot/records');
      const result: AdminQQRecordsView = { date: selected || shanghaiDay(Date.now()), dates: [], total: 0, page, pages: 1, rows: [] };
      const safeDirectory = (file: string) => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('archive directory'); };
      if (!fs.existsSync(directory)) return result;
      safeDirectory(directory);
      const accounts = fs.readdirSync(directory).filter(name => /^[1-9]\d{0,24}$/u.test(name));
      if (accounts.length > 100) throw new Error('archive accounts');
      const dates = new Set<string>();
      for (const account of accounts) {
        const base = path.join(directory, account); safeDirectory(base);
        const names = fs.readdirSync(base); if (names.length > 10000) throw new Error('archive dates');
        for (const name of names) if (/^\d{4}-\d{2}-\d{2}$/u.test(name)) dates.add(name);
      }
      result.dates = [...dates].sort().reverse(); result.date = selected || result.dates[0] || result.date;
      const records: QQRecord[] = []; let count = 0;
      for (const account of accounts) {
        const base = path.join(directory, account, result.date); if (!fs.existsSync(base)) continue;
        safeDirectory(base);
        const files = fs.readdirSync(base).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
        count += files.length; if (count > 10000) throw new Error('archive records');
        for (const name of files) {
          const file = path.join(base, name), stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('archive record');
          const value = JSON.parse(fs.readFileSync(file, 'utf8')) as QQRecord;
          if (!validQQRecord(value) || value.id !== name.slice(0, -5) || value.appId !== account || shanghaiDay(value.requestedAt) !== result.date) throw new Error('archive schema');
          if ((scope === 'all' || scope === value.scope) && (status === 'all' || status === value.status) &&
            (!search || [value.question, value.answer, value.user, value.conversation].some(text => text.toLocaleLowerCase().includes(search)))) {
            const { version, id, appId, scope: recordScope, user, conversation, question, answer, status: recordStatus, requestedAt, updatedAt, model, error, image, agent } = value;
            records.push({ version, id, appId, scope: recordScope, user, conversation, question, answer, status: recordStatus, requestedAt, updatedAt, model,
              ...(error ? { error } : {}), ...(image ? { image: { sha256: image.sha256, prompt: image.prompt } } : {}),
              ...(agent ? { agent: { modelCalls: agent.modelCalls, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tools: agent.tools.map(({ name, status, elapsedMs }) => ({ name, status, elapsedMs })) } } : {}) });
          }
        }
      }
      records.sort((a, b) => b.requestedAt - a.requestedAt || a.id.localeCompare(b.id));
      result.total = records.length; result.pages = Math.max(1, Math.ceil(records.length / 50));
      result.rows = records.slice((page - 1) * 50, page * 50); return result;
    } catch { throw new AdminError('QQ 问答存档无法读取，请检查存档完整性或容量', 503); }
  }
}
