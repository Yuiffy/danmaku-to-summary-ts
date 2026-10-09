import fs from 'fs';
import os from 'os';
import path from 'path';

const childProcess = require('child_process');
const { getVideoResolution } = require('./video_probe');

describe('clip-local video resolution', () => {
  let directory: string;
  let media: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-resolution-'));
    media = path.join(directory, 'changing-resolution.flv');
    fs.writeFileSync(media, 'source');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('uses decoded frames at the clip start, not the portrait header or an earlier keyframe', async () => {
    const probe = jest.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => {
      args.at(-1)(null, args[1].includes('-read_intervals') ? JSON.stringify({ frames: [
        { best_effort_timestamp_time: '99', width: 720, height: 1280 },
        { best_effort_timestamp_time: '100', width: 1280, height: 720 }
      ] }) : '720,1280\n');
      return {} as any;
    });
    await expect(getVideoResolution(media)).resolves.toEqual({ width: 720, height: 1280 });
    await expect(getVideoResolution(media, 'ffprobe', 100)).resolves.toEqual({ width: 1280, height: 720 });
    await getVideoResolution(media, 'ffprobe', 100);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1][1]).toContain('100%115');
    await getVideoResolution(media, 'ffprobe', 99);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test.each(['{}', '{"frames":[{"width":720,"height":1280,"best_effort_timestamp_time":"99"}]}'])
  ('rejects missing clip-local frames and retries instead of guessing a subtitle layout: %s', async stdout => {
    const probe = jest.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => {
      args.at(-1)(null, stdout);
      return {} as any;
    });
    await expect(getVideoResolution(media, 'ffprobe', 100)).rejects.toThrow('resolution');
    await expect(getVideoResolution(media, 'ffprobe', 100)).rejects.toThrow('resolution');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
