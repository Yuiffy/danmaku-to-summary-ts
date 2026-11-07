import * as fs from 'fs';
import * as path from 'path';
import { AdminError } from './AdminFiles';
import { QQChatMessage } from '../qqbot/QQChatTypes';

export interface AdminQQChatView {
  date: string;
  dates: string[];
  total: number;
  page: number;
  pages: number;
  rows: QQChatMessage[];
  asOf: number;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

export class AdminQQChat {
  constructor(private readonly root: string, private readonly now = Date.now) {}

  private archiveRoot(): string { return path.join(this.root, 'data/runtime/qqbot/chat'); }

  private readFile(file: string): QQChatMessage[] {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('chat archive file');
    return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
      if (!line) return [];
      try {
        const value = JSON.parse(line) as QQChatMessage;
        if (value.version !== 1 || !/^[1-9]\d{0,24}$/u.test(value.appId) || !hashPattern.test(value.id) ||
          !hashPattern.test(value.conversation) || !hashPattern.test(value.user) || typeof value.text !== 'string' ||
          value.text.length > 2000 || !Number.isSafeInteger(value.createdAt)) throw new Error('chat schema');
        return [value];
      } catch { throw new Error('chat archive row'); }
    });
  }

  view(query: { page?: unknown; date?: unknown; search?: unknown; conversation?: unknown } = {}): AdminQQChatView {
    const page = Number(query.page || 1), requestedDate = String(query.date || ''), search = String(query.search || '').trim().toLocaleLowerCase();
    const conversation = String(query.conversation || '');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || (requestedDate && !datePattern.test(requestedDate)) ||
      search.length > 120 || (conversation && !hashPattern.test(conversation))) throw new AdminError('QQ 群聊筛选条件无效');
    const root = this.archiveRoot(), result: AdminQQChatView = { date: requestedDate, dates: [], total: 0, page, pages: 1, rows: [], asOf: this.now() };
    if (!fs.existsSync(root)) return result;
    const rootStat = fs.lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AdminError('QQ 群聊存档目录无效', 503);
    const dates = new Set<string>(), rows: QQChatMessage[] = [];
    for (const appId of fs.readdirSync(root)) {
      if (!/^[1-9]\d{0,24}$/u.test(appId)) continue;
      const base = path.join(root, appId), baseStat = fs.lstatSync(base);
      if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('chat account directory');
      for (const date of fs.readdirSync(base)) {
        if (!datePattern.test(date)) continue;
        dates.add(date);
        if (requestedDate && date !== requestedDate) continue;
        const file = path.join(base, date, 'messages.jsonl');
        if (!fs.existsSync(file)) continue;
        rows.push(...this.readFile(file));
      }
    }
    result.dates = [...dates].sort().reverse(); result.date = requestedDate || result.dates[0] || '';
    const filtered = [...new Map(rows.map(row => [row.id, row])).values()].filter(row => (!conversation || row.conversation === conversation) &&
      (!search || [row.text, row.senderName || '', row.conversation].some(value => value.toLocaleLowerCase().includes(search))));
    filtered.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    result.total = filtered.length; result.pages = Math.max(1, Math.ceil(result.total / 100)); result.rows = filtered.slice((page - 1) * 100, page * 100);
    return result;
  }

  deleteBefore(input: unknown): { before: string; deletedDates: string[]; deletedMessages: number } {
    const before = String(input || '');
    if (!datePattern.test(before)) throw new AdminError('删除日期无效');
    const root = this.archiveRoot(); if (!fs.existsSync(root)) return { before, deletedDates: [], deletedMessages: 0 };
    const deletedDates: string[] = []; let deletedMessages = 0;
    for (const appId of fs.readdirSync(root)) {
      if (!/^[1-9]\d{0,24}$/u.test(appId)) continue;
      const base = path.join(root, appId); const stat = fs.lstatSync(base);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AdminError('QQ 群聊存档目录无效', 503);
      for (const date of fs.readdirSync(base)) {
        if (!datePattern.test(date) || date >= before) continue;
        const directory = path.join(base, date), directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new AdminError('QQ 群聊日期目录无效', 503);
        const file = path.join(directory, 'messages.jsonl');
        if (fs.existsSync(file)) deletedMessages += this.readFile(file).length;
        fs.rmSync(directory, { recursive: true, force: false });
        deletedDates.push(date);
      }
    }
    return { before, deletedDates: [...new Set(deletedDates)].sort(), deletedMessages };
  }
}
