import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readUploadTelemetry } from './AdminUploadTelemetry';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-telemetry-')); roots.push(root);
  return path.join(root, 'ledger.sqlite3');
}

it('does not create missing ledgers and degrades safely for incompatible ledgers', () => {
  const file = fixture();
  expect(readUploadTelemetry(file, Date.now())).toEqual({ available: false, truncated: false, events: [] });
  expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file, 'not sqlite');
  expect(readUploadTelemetry(file, Date.now()).available).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe('not sqlite');
});

it('reads the Python ledger schema with 96h lookback, retains accounts, and leaves files unchanged', () => {
  const file = fixture(), { DatabaseSync } = require('node:sqlite');
  const now = Date.parse('2026-10-27T12:00:00Z'), seconds = now / 1000;
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE upload_events(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,at REAL NOT NULL,
    event TEXT NOT NULL,stage TEXT NOT NULL,part_index INTEGER,http_status INTEGER);`);
  const insert = db.prepare('INSERT INTO upload_events VALUES(?,?,?,?,?,?,?)');
  insert.run(1, 'one', seconds - 97 * 3600, 'preupload_start', 'preupload', 1, null);
  insert.run(2, 'one', seconds - 95 * 3600, 'preupload_start', 'preupload', 2, null);
  insert.run(3, 'two', seconds - 60, 'preupload_failed', 'preupload', 1, 406);
  insert.run(4, 'two', seconds - 50, 'preupload_ready', 'preupload', 1, 200);
  insert.run(5, 'two', seconds + 1, 'preupload_failed', 'preupload', 1, 406);
  db.close();
  const before = fs.readFileSync(file);
  expect(readUploadTelemetry(file, now)).toMatchObject({ available: true, truncated: false,
    since: new Date(now - 97 * 3600000).toISOString(), events: [
      { id: 3, accountId: 'two', httpStatus: 406 }, { id: 2, accountId: 'one', event: 'preupload_start' } ] });
  expect(fs.readFileSync(file)).toEqual(before);
});
