import { EventEmitter } from 'events';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));
jest.mock('../ffmpeg_resource', () => ({ ...jest.requireActual('../ffmpeg_resource'),
  waitForAsrAvailability: jest.fn().mockResolvedValue({ waitedMs: 0, asrActive: false }),
  waitForCpuAvailability: jest.fn().mockResolvedValue({ waitedMs: 0, lastCpuPercent: 95,
    resourceOverrides: { threads: 2, priority: 'idle', cpuBusy: true } }),
  applyFfmpegProcessPriority: jest.fn(), startResourcePeakMonitor: jest.fn(() => ({ stop: jest.fn() }))
}));

const { spawn } = require('child_process');
const resources = require('../ffmpeg_resource');
const { runFfmpeg } = require('./media_runtime');

test('starts a busy CPU stage with capped decoder/filter/encoder threads and idle priority', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234, stderr: new EventEmitter() });
  spawn.mockImplementation(() => { setImmediate(() => child.emit('close', 0)); return child; });
  const resourceConfig = { threads: 12, priority: 'normal' };
  await runFfmpeg(['-i', 'source.mp4', '-threads', '0', '-c:v', 'h264_nvenc', 'out.mp4'], { resourceConfig });
  const [, args, options] = spawn.mock.calls[0];
  expect(args.slice(0, args.indexOf('-i'))).toEqual(expect.arrayContaining(['-threads', '2']));
  expect(args.slice(args.indexOf('source.mp4') + 1)).toEqual(expect.arrayContaining(['-threads', '2']));
  for (const flag of ['-threads', '-filter_threads', '-filter_complex_threads']) {
    expect(args[args.indexOf(flag) + 1]).toBe('2');
  }
  expect(resources.applyFfmpegProcessPriority).toHaveBeenCalledWith(1234, 'idle');
  expect(options).toMatchObject({ shell: false, windowsHide: true });
  expect(resourceConfig).toEqual({ threads: 12, priority: 'normal' });
});
