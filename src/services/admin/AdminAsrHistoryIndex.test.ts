import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsrHistoryItem } from '../../core/admin/asrHistory';
import { AdminAsrHistoryIndex, queryAsrHistory } from './AdminAsrHistoryIndex';
import { backfillAsrHistory } from './AdminAsrHistoryBackfill';
import { atomicJson } from './AdminFiles';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const row = (id: string): AsrHistoryItem => ({ id, title: id, streamerName: '测试主播', status: 'completed',
  metadata: 'available', tiers: [], speakerState: 'unknown', elapsedSeconds: 10, generatedAt: '2026-10-24T20:00:00Z' });

it('persists history independently of queue retention, deduplicates sidecars and supports Shanghai date filtering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-sqlite-')); roots.push(root);
  const file = path.join(root, 'history.sqlite'), writer = new AdminAsrHistoryIndex(file);
  try {
    writer.upsert(path.join(root, 'a.asr_meta.json'), row('a'));
    writer.upsert(path.join(root, 'a.asr_meta.json'), row('a'));
    writer.upsert(path.join(root, 'b.asr_meta.json'), { ...row('b'), streamerName: '其他主播', generatedAt: '2026-10-23T20:00:00Z' });
    writer.upsert(path.join(root, 'a.asr_meta.json'), { ...row('a'), metadata: 'missing', elapsedSeconds: undefined });
  } finally { writer.close(); }
  expect(queryAsrHistory(file, 1, 1)).toMatchObject({ total: 2, items: [{ id: 'a', elapsedSeconds: 10 }] });
  expect(queryAsrHistory(file, 2, 1).items[0].id).toBe('b');
  expect(queryAsrHistory(file, 1, 20, { streamer: '测试', date: '2026-10-25' }).total).toBe(1);
  expect(queryAsrHistory(file, 1, 20, { streamer: "' OR 1=1 --" }).total).toBe(0);
  expect(() => queryAsrHistory(file, 0)).toThrow('历史分页参数无效');
  expect(() => queryAsrHistory(file, 1, 20, { date: 'yesterday' })).toThrow('历史筛选参数无效');
});

it('imports old sidecars without modifying them and stops discovery when closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-backfill-')); roots.push(root);
  const recordings = path.join(root, '100_主播'), sidecar = path.join(recordings, '录制-100-20261024-120000-100-标题_merged.asr_meta.json');
  atomicJson(sidecar, { elapsedSeconds: 10, mediaDurationSeconds: 1000, generatedAt: '2026-10-24T20:00:00Z' });
  fs.writeFileSync(path.join(recordings, 'broken.asr_meta.json'), '{');
  const before = fs.readFileSync(sidecar, 'utf8'), file = path.join(root, 'history.sqlite'), writer = new AdminAsrHistoryIndex(file);
  try {
    expect(await backfillAsrHistory([recordings], writer, () => false)).toBe(1);
    expect(await backfillAsrHistory([recordings], writer, () => true)).toBe(0);
    expect(queryAsrHistory(file).items[0]).toMatchObject({ streamerName: '主播', title: '标题', elapsedSeconds: 10, status: 'asr_completed', tiers: [] });
    expect(fs.readFileSync(sidecar, 'utf8')).toBe(before);
  } finally { writer.close(); }
});
