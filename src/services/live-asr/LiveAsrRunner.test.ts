import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findLiveAsrSources, LiveAsrConfig, LiveAsrRunner, validateLiveAsrConfig } from './LiveAsrRunner';
import { atomicLiveJson, liveCachePath, mediaIdentity, writeMergedLiveAsrCache } from './LiveAsrStorage';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'live-asr-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const config = (root: string): LiveAsrConfig => ({ enabled: true, room_ids: ['25788785'], room_roots: { '25788785': [root] } });

it('requires a single explicit room and ignores archive, foreign-room and merged files', async () => {
  for (const value of [ { ...config(directory), room_ids: [] }, { ...config(directory), room_ids: ['25788785', '123'] },
    { ...config(directory), room_roots: { '123': [directory] } } ]) expect(() => validateLiveAsrConfig(value)).toThrow();
  const day = path.join(directory, '2026_10_17');
  await fs.mkdir(path.join(day, 'bak'), { recursive: true });
  const good = path.join(day, '录制-25788785-20261017-test.flv');
  for (const file of [good, path.join(day, '录制-123-20261017-test.flv'), path.join(day, '录制-25788785-test_merged.flv'),
    path.join(day, 'bak', '录制-25788785-test.flv')]) await fs.writeFile(file, Buffer.alloc(140000));
  expect(await findLiveAsrSources(config(directory))).toEqual([{ source: good, room_id: '25788785' }]);
  expect(await findLiveAsrSources({ ...config(directory), enabled: false })).toEqual([]);
});

it('shares one serial model, extends unfinished speech, and releases it while idle', async () => {
  const request = jest.fn().mockResolvedValueOnce({ ok: true, waiting: true, extend: true })
    .mockResolvedValue({ ok: true, cursor: 57, duration: 180 });
  const close = jest.fn(), make = jest.fn(() => ({ request, close }));
  const discover = jest.fn().mockResolvedValue([{ source: 'owned.flv', room_id: '25788785' }]);
  const runner = new LiveAsrRunner(config(directory), {}, make, discover);
  await runner.tick(1000); await runner.tick(2000);
  expect(make).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].window_s).toBe(60);
  expect(request.mock.calls[1][0].window_s).toBe(120);
  discover.mockResolvedValue([]);
  await runner.tick(123000);
  expect(close).toHaveBeenCalledTimes(1);
});

it('maps cached chunks onto the actual merge timeline, keeping holes and inserted silence', async () => {
  const sources = [path.join(directory, 'one.flv'), path.join(directory, 'two.flv')], output = path.join(directory, 'merged.flv');
  for (const file of [...sources, output]) await fs.writeFile(file, Buffer.alloc(140000, 5));
  for (const file of sources) await atomicLiveJson(liveCachePath(file), { version: 1, room_id: '25788785', spec: { model: 'paraformer-zh' },
    source: await mediaIdentity(file), chunks: [{ start: 0, end: 57, result: { text: '你好', timestamp: [[0, 500]] } }] });
  const duration = async (file: string) => file === output ? 125 : 60;
  expect(await writeMergedLiveAsrCache(sources, output, duration, () => 5)).toBe(true);
  const merged = JSON.parse(await fs.readFile(liveCachePath(output), 'utf8'));
  expect(merged.chunks.map(({ start, end }: { start: number; end: number }) => [start, end])).toEqual([[0, 57], [60, 65], [65, 122]]);
  expect(merged.chunks[2].result.timestamp).toEqual([[0, 500]]);
  await expect(writeMergedLiveAsrCache(sources, output, async file => file === output ? 130 : 60, () => 5)).rejects.toThrow('timeline');
  await fs.writeFile(sources[0], Buffer.alloc(140000, 6));
  await expect(writeMergedLiveAsrCache(sources, output, duration, () => 5)).rejects.toThrow('mismatch');
});
