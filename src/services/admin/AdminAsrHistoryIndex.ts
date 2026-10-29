import * as fs from 'fs';
import * as path from 'path';
import { AsrHistory, AsrHistoryItem } from '../../core/admin/asrHistory';
import { AdminError, digest } from './AdminFiles';

type Value = string | number;
interface Statement { run(...values: Value[]): unknown; get(...values: Value[]): any; all(...values: Value[]): any[] }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const sqlite = (): { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => Database } => require('node:sqlite');
export interface AsrHistoryFilter { streamer?: unknown; date?: unknown }
export function historyPage(pageInput: unknown = 1, sizeInput: unknown = 20): { page: number; pageSize: number } {
  const page = Number(pageInput), pageSize = Number(sizeInput);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new AdminError('历史分页参数无效');
  return { page, pageSize };
}

/** Rebuildable local index. Source sidecars remain authoritative and are never moved or deleted. */
export class AdminAsrHistoryIndex {
  private readonly db: Database;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new (sqlite().DatabaseSync)(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS asr_history_v1(recording_key TEXT PRIMARY KEY,sort_at TEXT NOT NULL,streamer TEXT NOT NULL,
        metadata TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS asr_history_date ON asr_history_v1(sort_at DESC);
      CREATE INDEX IF NOT EXISTS asr_history_streamer ON asr_history_v1(streamer,sort_at DESC);`);
  }
  upsert(source: string, row: AsrHistoryItem): void {
    // A later queue prune/missing archive must not erase previously captured performance.
    const key = digest(path.resolve(source).toLowerCase());
    const existing = this.db.prepare('SELECT payload,metadata FROM asr_history_v1 WHERE recording_key=?').get(key);
    if (existing?.metadata === 'available' && row.metadata !== 'available') return;
    const payload = JSON.stringify(row);
    if (existing?.payload === payload) return;
    this.db.prepare(`INSERT INTO asr_history_v1 VALUES(?,?,?,?,?) ON CONFLICT(recording_key) DO UPDATE SET
      sort_at=excluded.sort_at,streamer=excluded.streamer,metadata=excluded.metadata,payload=excluded.payload`)
      .run(key, row.generatedAt || '', row.streamerName, row.metadata, payload);
  }
  upsertMany(rows: Array<{ source: string; row: AsrHistoryItem }>): void {
    if (!rows.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of rows) this.upsert(item.source, item.row);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.db.close(); }
}

/** Page requests open SQLite read-only. Index maintenance belongs to the admin observer. */
export function queryAsrHistory(file: string, pageInput?: unknown, sizeInput?: unknown, filter: AsrHistoryFilter = {}): AsrHistory {
  const { page, pageSize } = historyPage(pageInput, sizeInput);
  if (filter.streamer !== undefined && (typeof filter.streamer !== 'string' || filter.streamer.length > 100)
    || filter.date !== undefined && (typeof filter.date !== 'string' || filter.date !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(filter.date))) throw new AdminError('历史筛选参数无效');
  let db: Database | undefined;
  try {
    db = new (sqlite().DatabaseSync)(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const conditions: string[] = [], values: Value[] = [];
    if (filter.streamer) { conditions.push('instr(streamer,?)>0'); values.push(String(filter.streamer)); }
    if (filter.date) { conditions.push("date(sort_at,'+8 hours')=?"); values.push(String(filter.date)); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM asr_history_v1${where}`).get(...values).count;
    const items = db.prepare(`SELECT payload FROM asr_history_v1${where} ORDER BY sort_at DESC,recording_key LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize).map(row => JSON.parse(row.payload) as AsrHistoryItem);
    return { observedAt: new Date().toISOString(), page, pageSize, total, items };
  } catch { throw new AdminError('字幕历史索引暂不可读', 503); }
  finally { db?.close(); }
}
