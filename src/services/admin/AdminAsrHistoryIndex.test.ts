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

const tier = (name: AsrHistoryItem['tiers'][number]['tier'], audioSeconds: number) => ({ tier: name, audioSeconds });

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

it('summarizes all filtered history rows independently of the current page', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-summary-')); roots.push(root);
  const file = path.join(root, 'history.sqlite'), writer = new AdminAsrHistoryIndex(file);
  try {
    writer.upsert(path.join(root, 'cpu'), { ...row('cpu'), tiers: [tier('cpu_background', 100)] });
    writer.upsert(path.join(root, 'gpu'), { ...row('gpu'), tiers: [tier('gpu_ultra_low_impact', 50), tier('gpu_low_impact', 50)] });
    writer.upsert(path.join(root, 'legacy'), { ...row('legacy'), mediaSeconds: 100, tiers: [] });
  } finally { writer.close(); }
  const firstPage = queryAsrHistory(file, 1, 1);
  expect(firstPage.total).toBe(3);
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.summary.totalAudioSeconds).toBe(300);
  expect(firstPage.summary.recordedAudioSeconds).toBe(200);
  expect(firstPage.summary.tiers).toEqual(expect.arrayContaining([
    expect.objectContaining({ tier: 'cpu_background', audioSeconds: 100, percent: 33.33333333333333 }),
    expect.objectContaining({ tier: 'gpu_ultra_low_impact', audioSeconds: 50, percent: 16.666666666666664 }),
    expect.objectContaining({ tier: 'gpu_low_impact', audioSeconds: 50, percent: 16.666666666666664 }),
    expect.objectContaining({ tier: 'unrecorded', audioSeconds: 100, percent: 33.33333333333333 })
  ]));
  expect(queryAsrHistory(file, 1, 20, { streamer: '不存在' }).summary.totalAudioSeconds).toBe(0);
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


it('rolls back an entire batch when one row cannot be persisted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-rollback-')); roots.push(root);
  const file = path.join(root, 'history.sqlite'), writer = new AdminAsrHistoryIndex(file);
  try {
    writer.upsert(path.join(root, 'old'), row('old'));
    const invalid = { ...row('bad'), elapsedSeconds: BigInt(1) } as any;
    expect(() => writer.upsertMany([{ source: path.join(root, 'new'), row: row('new') },
      { source: path.join(root, 'bad'), row: invalid }])).toThrow();
    expect(queryAsrHistory(file).items.map(item => item.id)).toEqual(['old']);
    writer.upsertMany([{ source: path.join(root, 'new'), row: row('new') }]);
    expect(queryAsrHistory(file).total).toBe(2);
  } finally { writer.close(); }
});
