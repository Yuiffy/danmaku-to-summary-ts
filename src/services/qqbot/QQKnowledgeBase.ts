import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

type SqlValue = string | number | null;
interface Statement { run(...values: SqlValue[]): unknown; all(...values: SqlValue[]): unknown[]; get(...values: SqlValue[]): unknown; }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void; }
const sqlite = (): { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => Database } => require('node:sqlite');

export interface QQKnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  contentHash: string;
}
export interface QQKnowledgeHit {
  evidenceId: string;
  title: string;
  text: string;
  source: string;
  updatedAt: number;
}
export interface QQKnowledgeInput { id: string; title: string; content: string; source?: string; tags?: string[]; enabled?: boolean; }

const ID = /^[a-z0-9][a-z0-9._-]{1,100}$/u;
const MAX_TITLE = 200, MAX_CONTENT = 20000, MAX_SOURCE = 300, MAX_TAGS = 20;
const DEFAULT_ID = 'qq.group-message-scope';
const DEFAULT_CONTENT = 'QQ群机器人的消息范围按群单独授权。群主或具备权限的群管理员可以在该群的机器人设置中选择消息范围，常见选项包括：获取群内全部消息、获取@机器人的最近10条消息、仅获取@机器人的消息。只有开启“获取群内全部消息”时，机器人才能收到普通群聊并进行归档；本地 groupMessageMode 配置不能绕过 QQ 平台侧授权。其他群需要等待该群群主或有权限的管理员设置。该规则来自用户提供的 QQ 设置截图与确认，截图本身不入库。';

export const qqKnowledgeFile = (root: string): string => path.join(root, 'data/runtime/qqbot/knowledge.sqlite');
const hash = (title: string, content: string, source: string, tags: string[], enabled: boolean): string =>
  createHash('sha256').update(JSON.stringify([title, content, source, tags, enabled])).digest('hex');
const cleanText = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string') throw new Error(`${label} 必须是文本`);
  const text = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text || Array.from(text).length > max) throw new Error(`${label} 无效或过长`);
  return text;
};
const cleanTags = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : []).map(tag => cleanText(tag, 40, '标签')))].slice(0, MAX_TAGS);
const rowToEntry = (row: any): QQKnowledgeEntry => ({ id: row.id, title: row.title, content: row.content, source: row.source,
  tags: JSON.parse(row.tags), enabled: !!row.enabled, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), contentHash: row.content_hash });

export class QQKnowledgeBase {
  private readonly db: Database;
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new (sqlite().DatabaseSync)(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,
        tags TEXT NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,content_hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED,title,content,tags);`);
  }
  upsert(input: QQKnowledgeInput): QQKnowledgeEntry {
    if (!ID.test(input.id)) throw new Error('知识条目标识无效');
    const title = cleanText(input.title, MAX_TITLE, '标题'), content = cleanText(input.content, MAX_CONTENT, '内容');
    const source = cleanText(input.source || '本地维护', MAX_SOURCE, '来源'), tags = cleanTags(input.tags);
    const enabled = input.enabled !== false, now = Date.now();
    const previous = this.get(input.id), createdAt = previous?.createdAt || now;
    const entry: QQKnowledgeEntry = { id: input.id, title, content, source, tags, enabled, createdAt, updatedAt: now,
      contentHash: hash(title, content, source, tags, enabled) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO entries(id,title,content,source,tags,enabled,created_at,updated_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,source=excluded.source,tags=excluded.tags,enabled=excluded.enabled,updated_at=excluded.updated_at,content_hash=excluded.content_hash')
        .run(entry.id, entry.title, entry.content, entry.source, JSON.stringify(entry.tags), Number(entry.enabled), entry.createdAt, entry.updatedAt, entry.contentHash);
      this.db.prepare('DELETE FROM entries_fts WHERE id=?').run(entry.id);
      this.db.prepare('INSERT INTO entries_fts(id,title,content,tags) VALUES(?,?,?,?)').run(entry.id, entry.title, entry.content, entry.tags.join(' '));
      this.db.exec('COMMIT'); return entry;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seedDefaults(): void {
    if (!this.get(DEFAULT_ID)) this.upsert({ id: DEFAULT_ID, title: 'QQ群机器人消息范围配置', content: DEFAULT_CONTENT,
      source: '用户提供的 QQ 设置截图与确认（脱敏）', tags: ['QQ', '机器人', '群权限', '消息范围'] });
  }
  get(id: string): QQKnowledgeEntry | undefined {
    if (!ID.test(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM entries WHERE id=?').get(id) as any; return row ? rowToEntry(row) : undefined;
  }
  list(includeDisabled = true): QQKnowledgeEntry[] {
    const rows = (includeDisabled ? this.db.prepare('SELECT * FROM entries ORDER BY updated_at DESC') : this.db.prepare('SELECT * FROM entries WHERE enabled=1 ORDER BY updated_at DESC')).all();
    return rows.map(rowToEntry);
  }
  search(query: string, limit = 8): QQKnowledgeHit[] {
    const cleaned = cleanText(query, 300, '搜索词');
    const safeLimit = Math.min(16, Math.max(1, Math.floor(limit)));
    const terms = cleaned.split(/\s+/u).filter(Boolean).map(term => term.replace(/["*:^(){}\[\]]/gu, ' ')).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' OR ');
    let rows = this.db.prepare('SELECT e.id,e.title,e.content,e.source,e.updated_at FROM entries_fts f JOIN entries e ON e.id=f.id WHERE e.enabled=1 AND entries_fts MATCH ? ORDER BY rank LIMIT ?').all(match, safeLimit) as any[];
    // unicode61 does not tokenize every CJK phrase consistently across Node/SQLite builds;
    // retain FTS for normal text and use parameterized substring recall for CJK terms.
    if (!rows.length) {
      const clauses = terms.map(() => '(title LIKE ? OR content LIKE ? OR tags LIKE ?)').join(' OR ');
      const values = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
      rows = this.db.prepare(`SELECT id,title,content,source,updated_at FROM entries WHERE enabled=1 AND (${clauses}) ORDER BY updated_at DESC LIMIT ?`).all(...values, safeLimit) as any[];
    }
    return rows.map(row => ({ evidenceId: row.id, title: row.title, text: row.content, source: row.source, updatedAt: Number(row.updated_at) }));
  }
  delete(id: string): void {
    if (!ID.test(id)) throw new Error('知识条目标识无效');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM entries_fts WHERE id=?').run(id); this.db.prepare('DELETE FROM entries WHERE id=?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

export { DEFAULT_ID as QQ_DEFAULT_KNOWLEDGE_ID };
