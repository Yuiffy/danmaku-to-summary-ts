import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminSourceMedia } from './AdminSourceMedia';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-playback-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
it('matches the real keyframe time, shares concurrent requests and invalidates cached source changes', async () => {
  const file = path.join(directory, 'source.flv'); fs.writeFileSync(file, 'source');
  const run = jest.fn(async (_executable: string, args: string[]) => {
    if (args.includes('-movflags')) { fs.writeFileSync(args[args.length - 1], 'browser-mp4'); return ''; }
    return JSON.stringify({ packets: [{ flags: 'K_', data_hash: 'MD5:keyframe', pts_time: args[args.length - 1] === file ? '90.5' : '.08' }] });
  });
  const media = new AdminSourceMedia(path.join(directory, 'cache'), () => 'ffmpeg', run);
  const [first, concurrent] = await Promise.all([media.prepare(file, { start: 100, end: 120 }), media.prepare(file, { start: 100, end: 120 })]);
  expect(first.origin).toBeCloseTo(90.42); expect(concurrent).toEqual(first); expect(run).toHaveBeenCalledTimes(3);
  expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['-c', 'copy', '-ss', '92']));
  expect(await media.prepare(file, { start: 100, end: 120 })).toEqual(first); expect(run).toHaveBeenCalledTimes(3);
  fs.appendFileSync(file, 'changed');
  expect((await media.prepare(file, { start: 100, end: 120 })).file).not.toBe(first.file);
  expect(fs.readFileSync(file, 'utf8')).toBe('sourcechanged');
});
it('passes browser formats through and refuses an unproven time mapping without saving a ready receipt', async () => {
  const file = path.join(directory, 'source.mp4'); fs.writeFileSync(file, 'source');
  const run = jest.fn(async (_executable: string, args: string[]) => {
    if (args.includes('-movflags')) { fs.writeFileSync(args[args.length - 1], 'mp4'); return ''; }
    return JSON.stringify({ packets: [{ flags: 'K_', data_hash: args[args.length - 1].endsWith('.flv') ? 'different' : 'first', pts_time: '0' }] });
  });
  const cache = path.join(directory, 'cache'), media = new AdminSourceMedia(cache, () => 'ffmpeg', run);
  expect(await media.prepare(file, { start: 10, end: 12 })).toMatchObject({ file, origin: 0, direct: true });
  expect(run).not.toHaveBeenCalled();
  const flv = path.join(directory, 'source.flv'); fs.writeFileSync(flv, 'flv');
  await expect(media.prepare(flv, { start: 10, end: 12 })).rejects.toThrow('原片时间');
  expect(fs.readdirSync(cache)).toEqual([]);
});
