import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AdminSourceMedia } from './AdminSourceMedia';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-playback-')); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
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
it('passes fast-start browser formats through and refuses an unproven FLV mapping without saving a ready receipt', async () => {
  const file = path.join(directory, 'source.mp4'); fs.writeFileSync(file, 'source');
  const run = jest.fn(async (_executable: string, args: string[]) => {
    if (args.includes('-movflags')) { fs.writeFileSync(args[args.length - 1], 'mp4'); return ''; }
    return JSON.stringify({ packets: [{ flags: 'K_', data_hash: args[args.length - 1].endsWith('.flv') ? 'different' : 'first', pts_time: '0' }] });
  });
  const cache = path.join(directory, 'cache'), media = new AdminSourceMedia(cache, () => 'ffmpeg', run);
  expect(await media.prepare(file, { start: 10, end: 12 })).toMatchObject({ file, origin: 0, direct: true, format: '.mp4' });
  expect(run).not.toHaveBeenCalled();
  const flv = path.join(directory, 'source.flv'); fs.writeFileSync(flv, 'flv');
  await expect(media.prepare(flv, { start: 10, end: 12 })).rejects.toThrow('原片时间');
  expect(fs.readdirSync(cache)).toEqual([]);
});

it('prepares a short window when an MP4 index is at the tail', async () => {
  const file = path.join(directory, 'tail-index.mp4');
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 32, 0);
  bytes.write('ftypisom', 4);
  bytes.write('mdat', 16);
  bytes.write('moov', 4 * 1024 * 1024 + 4);
  fs.writeFileSync(file, bytes);
  const run = jest.fn(async (_executable: string, args: string[]) => {
    if (args.includes('-movflags')) { fs.writeFileSync(args[args.length - 1], 'fast-start-window'); return ''; }
    return JSON.stringify({ packets: [{ flags: 'K_', data_hash: 'same', pts_time: args[args.length - 1] === file ? '12.5' : '.08' }] });
  });
  const media = new AdminSourceMedia(path.join(directory, 'cache'), () => 'ffmpeg', run);
  await expect(media.prepare(file, { start: 20, end: 22 })).resolves.toMatchObject({ direct: false, format: '.mp4' });
  expect(run).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-movflags', '+faststart']), expect.any(Number));
});

function slowProcesses(source: string, remuxMs: number, probeMs: number) {
  (execFile as unknown as jest.Mock).mockImplementation((_executable, args: string[], options, callback) => {
    const remux = args.includes('-movflags'), file = args[args.length - 1];
    const duration = remux ? remuxMs : file === source ? probeMs : 100;
    setTimeout(() => {
      if (duration > options.timeout) { callback({ killed: true, signal: 'SIGTERM' }, '', ''); return; }
      if (remux) { fs.writeFileSync(file, 'browser-mp4'); callback(null, '', ''); return; }
      callback(null, JSON.stringify({ packets: [{ flags: 'K_', data_hash: 'same-keyframe', pts_time: file === source ? '90.5' : '.08' }] }), '');
    }, Math.min(duration, options.timeout));
  });
}

it('prepares slow recordings whose remux and source seek each take longer than 25 seconds', async () => {
  jest.useFakeTimers();
  const file = path.join(directory, 'large.flv'); fs.writeFileSync(file, 'source');
  slowProcesses(file, 26_000, 26_000);
  const media = new AdminSourceMedia(path.join(directory, 'cache'), () => 'ffmpeg');
  const ready = expect(media.prepare(file, { start: 100, end: 120 }, { forceRemux: true })).resolves.toMatchObject({ origin: 90.42, direct: false });
  await jest.advanceTimersByTimeAsync(53_000); await ready;
  const calls = (execFile as unknown as jest.Mock).mock.calls;
  expect(calls.slice(-3).map(call => call[2].timeout)).toEqual([90_000, 64_000, 63_900]);
  expect(fs.readFileSync(file, 'utf8')).toBe('source');
});

it('bounds all stages to one deadline, cleans partial output and permits a fresh retry', async () => {
  jest.useFakeTimers();
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const file = path.join(directory, 'large.flv'); fs.writeFileSync(file, 'source');
  slowProcesses(file, 60_000, 40_000);
  const cache = path.join(directory, 'cache'), media = new AdminSourceMedia(cache, () => 'ffmpeg');
  const failed = expect(media.prepare(file, { start: 100, end: 120 }, { forceRemux: true })).rejects.toThrow('准备超时');
  await jest.advanceTimersByTimeAsync(90_000); await failed;
  expect(fs.readdirSync(cache)).toEqual([]);
  expect(warning).toHaveBeenCalledWith('[admin/source-preview] process failed', expect.objectContaining({ stage: '时间校验', killed: true, timeoutMs: 29_900 }));
  slowProcesses(file, 10, 10);
  const ready = expect(media.prepare(file, { start: 100, end: 120 }, { forceRemux: true })).resolves.toMatchObject({ origin: 90.42 });
  await jest.advanceTimersByTimeAsync(200); await ready;
});

it.each([
  [{ code: 'ENOENT' }, '工具不可用'],
  [{ code: 1 }, '转封装失败']
])('reports actionable process errors and retains stderr in the local log', async (error, message) => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const file = path.join(directory, 'source.flv'); fs.writeFileSync(file, 'source');
  (execFile as unknown as jest.Mock).mockImplementation((_executable, _args, _options, callback) => callback(error, '', 'specific diagnostic'));
  const cache = path.join(directory, 'cache'), media = new AdminSourceMedia(cache, () => 'ffmpeg');
  await expect(media.prepare(file, { start: 100, end: 120 }, { forceRemux: true })).rejects.toThrow(message);
  expect(warning).toHaveBeenCalledWith('[admin/source-preview] process failed', expect.objectContaining({ stderr: 'specific diagnostic' }));
  expect(fs.readdirSync(cache)).toEqual([]);
});
