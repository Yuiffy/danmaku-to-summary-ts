import * as fs from 'fs';
import * as path from 'path';
import { AdminQQRecordsView, QQ_RECORD_STATUSES, QQRecord, validQQRecord } from '../../core/admin/qqRecords';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { AdminError } from './AdminFiles';
import { createHash } from 'crypto';
import { qqConversations, qqIdentity, qqUsers, summarizeQQRecords } from './AdminQQRecordStats';
import { qqAccountUsage, readQQUsage } from './AdminQQUsage';

/** Bounded, read-only local transcript listing. Never opens credentials or calls QQ. */
export class AdminQQRecords {
  constructor(private readonly root: string, private readonly now = Date.now) {}
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
  view(query: { page?: unknown; date?: unknown; scope?: unknown; status?: unknown; search?: unknown; user?: unknown; conversation?: unknown } = {}): AdminQQRecordsView {
    const page = Number(query.page || 1), scope = String(query.scope || 'all'), status = String(query.status || 'all');
    const search = String(query.search || '').trim().toLocaleLowerCase(), selected = String(query.date || '');
    const user = String(query.user || ''), conversation = String(query.conversation || '');
    const identity = (value: string) => !value || /^[1-9]\d{0,24}:[a-f0-9]{64}$/u.test(value);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 120 ||
      !['all', 'group', 'c2c'].includes(scope) || (status !== 'all' && !Object.hasOwn(QQ_RECORD_STATUSES, status)) ||
      !identity(user) || !identity(conversation) || (selected && !/^\d{4}-\d{2}-\d{2}$/u.test(selected))) throw new AdminError('QQ 记录筛选条件无效');
    try {
      const directory = path.join(this.root, 'data/runtime/qqbot/records');
      const now = this.now();
      const result: AdminQQRecordsView = { date: selected || shanghaiDay(now), dates: [], total: 0, page, pages: 1, rows: [],
        asOf: now, summary: summarizeQQRecords([]), users: [], conversations: [], accounts: [] };
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
          if (scope === 'all' || scope === value.scope) {
            const { version, id, appId, scope: recordScope, user, conversation, senderName, question, answer, status: recordStatus, requestedAt, updatedAt, model, error, image, agent } = value;
            records.push({ version, id, appId, scope: recordScope, user, conversation, question, answer, status: recordStatus, requestedAt, updatedAt, model,
              ...(senderName ? { senderName } : {}), ...(error ? { error } : {}), ...(image ? { image: { sha256: image.sha256, prompt: image.prompt } } : {}),
              ...(agent ? { agent: { modelCalls: agent.modelCalls, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tools: agent.tools.map(({ name, status, elapsedMs }) => ({ name, status, elapsedMs })) } } : {}) });
          }
        }
      }
      records.sort((a, b) => b.requestedAt - a.requestedAt || a.id.localeCompare(b.id));
      const usageBudget = { remaining: 32 * 1024 * 1024 };
      const snapshots = new Map(accounts.map(appId => [appId, readQQUsage(this.root, appId, usageBudget)]));
      result.accounts = accounts.map(appId => qqAccountUsage(appId, snapshots.get(appId)!, now));
      result.users = qqUsers(records, snapshots, now);
      const userRecords = records.filter(row => !user || qqIdentity(row.appId, row.user) === user);
      result.conversations = qqConversations(userRecords);
      const filtered = userRecords.filter(row => (!conversation || qqIdentity(row.appId, row.conversation) === conversation) &&
        (status === 'all' || status === row.status) && (!search ||
          [row.question, row.answer, row.user, row.conversation, row.senderName || ''].some(text => text.toLocaleLowerCase().includes(search))));
      result.summary = summarizeQQRecords(filtered);
      result.total = filtered.length; result.pages = Math.max(1, Math.ceil(filtered.length / 50));
      result.rows = filtered.slice((page - 1) * 50, page * 50); return result;
    } catch { throw new AdminError('QQ 问答存档无法读取，请检查存档完整性或容量', 503); }
  }
}
