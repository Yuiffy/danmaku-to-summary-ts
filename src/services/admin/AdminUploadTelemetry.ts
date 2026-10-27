import * as fs from 'fs';

export interface UploadTelemetry {
  available: boolean;
  since?: string;
  truncated: boolean;
  events: { id: number; accountId: string; at: string; event: string; stage: string; partIndex?: number; httpStatus?: number }[];
}
interface Database {
  prepare(sql: string): { all(...values: number[]): any[]; get(): any };
  exec(sql: string): void;
  close(): void;
}
const ROW_LIMIT = 20000;

/** Fixed local ledger only: never creates a database or imports the upload worker. */
export function readUploadTelemetry(file: string, now: number): UploadTelemetry {
  const unavailable: UploadTelemetry = { available: false, truncated: false, events: [] };
  if (!fs.existsSync(file)) return unavailable;
  let db: Database | undefined;
  try {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => Database };
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=250; BEGIN');
    // 48h of history needs a further 48h of lookback at its left boundary.
    const rows = db.prepare(`SELECT id,account_id,at,event,stage,part_index,http_status FROM upload_events
      WHERE at>? AND at<=? AND (event='preupload_start' OR http_status=406)
      ORDER BY at DESC,id DESC LIMIT ?`).all((now - 96 * 3600000) / 1000, now / 1000, ROW_LIMIT + 1);
    const first = db.prepare('SELECT MIN(at) AS at FROM upload_events').get();
    return { available: true, truncated: rows.length > ROW_LIMIT,
      since: typeof first?.at === 'number' && Number.isFinite(first.at) ? new Date(first.at * 1000).toISOString() : undefined,
      events: rows.slice(0, ROW_LIMIT).map(row => ({ id: row.id, accountId: String(row.account_id),
        at: new Date(row.at * 1000).toISOString(), event: row.event, stage: row.stage,
        partIndex: row.part_index ?? undefined, httpStatus: row.http_status ?? undefined })) };
  } catch { return unavailable; }
  finally { db?.close(); }
}
