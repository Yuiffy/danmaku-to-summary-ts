import * as path from 'path';
import { existsSync } from 'fs';
import { SubtitleSource, digest, recordingSessionKey } from './SubtitleCorpus';
import { SemanticFocus, SemanticMatch } from './SubtitleIndex';

export interface RecordingFtsConfig { enabled: boolean; directory: string; pollIntervalMs?: number }
export type RecordingKind = 'subtitle' | 'danmaku';
export interface FtsSource extends SubtitleSource {
  roomId: string; configuredRoot: string; kind: RecordingKind; hash: string; size: number; mtime: number; parserKey: string;
}
export interface FtsChunk { cue: number; endCue: number; seconds: number; clock: string; body: string }
export interface FtsMatch extends SemanticMatch { kind: RecordingKind; endCue: number }
export interface FtsResult { available: boolean; complete: boolean; limited?: boolean; indexedFiles: number; matches: FtsMatch[] }
export type FtsSearch = (date: string | null, terms: string[], focus: SemanticFocus & {
  kind: 'all' | RecordingKind; earliest: boolean;
}) => Promise<FtsResult>;

type Value = string | number | null;
interface Statement { run(...values: Value[]): unknown; all(...values: Value[]): unknown[]; get(...values: Value[]): unknown }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
// Node >=22.18 ships SQLite/FTS5. Keep compatibility with the project's Node 20 type package.
const sqlite = (): { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => Database } => require('node:sqlite');
const VERSION = 'recording-fts-v1-cjk-1400-90-200';
export const ftsRootsKey = (roots: string[], botUid?: string): string => digest(JSON.stringify([roots, botUid || '']));
export const ftsFile = (config: RecordingFtsConfig): string => path.join(config.directory, 'recordings.sqlite');
export function ftsText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    value => ' ' + Array.from(value).join(' ') + ' ');
}
const phrase = (text: string): string => '"' + ftsText(text).replace(/"/gu, '""') + '"';

/** Single-writer adapter. Source replacement and its FTS rows commit together. */
export class RecordingFtsWriter {
  private readonly db: Database;
  constructor(config: RecordingFtsConfig) {
    this.db = new (sqlite().DatabaseSync)(ftsFile(config));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms(room TEXT PRIMARY KEY,roots_key TEXT,complete INTEGER,updated_at INTEGER,files INTEGER);
      CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY,room TEXT,configured_root TEXT,root TEXT,file TEXT,kind TEXT,
        date TEXT,session TEXT,hash TEXT,size INTEGER,mtime REAL,parser_key TEXT,UNIQUE(room,file));
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,source_id INTEGER,cue INTEGER,end_cue INTEGER,seconds REAL,clock TEXT);
      CREATE INDEX IF NOT EXISTS sources_scope ON sources(room,kind,date);
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS recording_fts USING fts5(body,tokenize='unicode61');`);
    const version = this.db.prepare('SELECT version FROM metadata').get() as { version: string } | undefined;
    if (version && version.version !== VERSION) { this.db.close(); throw new Error('Unsupported recording FTS index version'); }
    if (!version) this.db.prepare('INSERT INTO metadata VALUES(?)').run(VERSION);
  }
  status(room: string, roots: string[], complete: boolean, botUid?: string): void {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE room=?').get(room) as { count: number };
    this.db.prepare(`INSERT INTO rooms VALUES(?,?,?,?,?) ON CONFLICT(room) DO UPDATE SET
      roots_key=excluded.roots_key,complete=excluded.complete,updated_at=excluded.updated_at,files=excluded.files`)
      .run(room, ftsRootsKey(roots, botUid), Number(complete), Date.now(), count.count);
  }
  sources(room: string): Array<FtsSource & { id: number }> {
    return this.db.prepare(`SELECT id,room AS roomId,configured_root AS configuredRoot,root,file,kind,date,hash,size,mtime,parser_key AS parserKey
      FROM sources WHERE room=?`).all(room) as Array<FtsSource & { id: number }>;
  }
  private remove(id: number): void {
    this.db.prepare('DELETE FROM recording_fts WHERE rowid IN (SELECT id FROM chunks WHERE source_id=?)').run(id);
    this.db.prepare('DELETE FROM chunks WHERE source_id=?').run(id);
    this.db.prepare('DELETE FROM sources WHERE id=?').run(id);
  }
  deleteSource(id: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.remove(id); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  replace(source: FtsSource, chunks: FtsChunk[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT id FROM sources WHERE room=? AND file=?').get(source.roomId, source.file) as { id: number } | undefined;
      if (previous) this.remove(previous.id);
      this.db.prepare('INSERT INTO sources(room,configured_root,root,file,kind,date,session,hash,size,mtime,parser_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(source.roomId, source.configuredRoot, source.root, source.file, source.kind, source.date,
          recordingSessionKey(source), source.hash, source.size, source.mtime, source.parserKey);
      const { id } = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
      const insert = this.db.prepare('INSERT INTO chunks(source_id,cue,end_cue,seconds,clock) VALUES(?,?,?,?,?)');
      const text = this.db.prepare('INSERT INTO recording_fts(rowid,body) VALUES(last_insert_rowid(),?)');
      for (const chunk of chunks) { insert.run(id, chunk.cue, chunk.endCue, chunk.seconds, chunk.clock); text.run(ftsText(chunk.body)); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

/** Read-only recall: metadata is never accepted as a citation without source/hash verification. */
export function createFtsSearch(config: RecordingFtsConfig, room: string, roots: string[], signal: AbortSignal, botUid?: string): FtsSearch {
  return async (date, terms, focus) => {
    signal.throwIfAborted();
    const unavailable: FtsResult = { available: false, complete: false, indexedFiles: 0, matches: [] };
    if (!config.enabled || !existsSync(ftsFile(config))) return unavailable;
    let db: Database | undefined;
    try {
      db = new (sqlite().DatabaseSync)(ftsFile(config), { readOnly: true });
      db.exec('PRAGMA busy_timeout=1000; BEGIN');
      const version = db.prepare('SELECT version FROM metadata').get() as { version: string } | undefined;
      const state = db.prepare('SELECT roots_key,complete,updated_at,files FROM rooms WHERE room=?').get(room) as
        { roots_key: string; complete: number; updated_at: number; files: number } | undefined;
      if (version?.version !== VERSION || state?.roots_key !== ftsRootsKey(roots, botUid)) return unavailable;
      const constraints = ['s.room=?'], values: Value[] = [room];
      if (date) { constraints.push('s.date LIKE ?'); values.push(date + '%'); }
      if (focus.kind !== 'all') { constraints.push('s.kind=?'); values.push(focus.kind); }
      if (focus.session) { constraints.push('s.session=?'); values.push(recordingSessionKey(focus.session)); }
      const normalized = [...new Set(terms.map(term => term.normalize('NFKC').trim()).filter(Boolean))];
      if (!normalized.length) return { ...unavailable, available: true, indexedFiles: state.files };
      // Terms include alternative phrasings and ASR variants, not mandatory simultaneous facts.
      // A conjunctive hit must not hide passages containing just one useful variant.
      const rows = db.prepare(`SELECT s.file,s.root,s.date,s.hash,s.kind,c.cue,c.end_cue AS endCue,
        bm25(recording_fts) AS rank FROM recording_fts JOIN chunks c ON c.id=recording_fts.rowid
        JOIN sources s ON s.id=c.source_id WHERE recording_fts MATCH ? AND ${constraints.join(' AND ')}
        ORDER BY ${focus.earliest ? 'c.clock,c.seconds,c.id' : 'rank'} LIMIT 129`)
        .all(normalized.map(phrase).join(' OR '), ...values) as Array<FtsMatch & { rank: number }>;
      const perFile = new Map<string, number>();
      const matches: FtsMatch[] = [];
      for (const row of rows.slice(0, 128)) {
        const count = perFile.get(row.file) || 0;
        if (count >= 4) continue;
        matches.push({ ...row, score: -row.rank }); perFile.set(row.file, count + 1);
        if (matches.length >= 32) break;
      }
      signal.throwIfAborted();
      return { available: true, indexedFiles: state.files, matches, limited: rows.length > 128 || matches.length !== rows.length,
        complete: !!state.complete &&
          Date.now() - state.updated_at <= Math.max(600000, (config.pollIntervalMs || 120000) * 3) };
    } catch { signal.throwIfAborted(); return unavailable; }
    finally { db?.close(); }
  };
}
