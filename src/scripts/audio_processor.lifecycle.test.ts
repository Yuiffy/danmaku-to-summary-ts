import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('./config-loader', () => ({ getConfig: jest.fn() }));
jest.mock('./ffmpeg_resource', () => ({
  applyFfmpegProcessPriority: jest.fn(),
  getFfmpegResourceConfig: jest.fn(() => ({})),
  startResourcePeakMonitor: jest.fn(() => ({ stop: jest.fn() })),
  waitForAsrAvailability: jest.fn(async () => ({ asrActive: false })),
  withFfmpegResourceLimits: jest.fn((args: string[]) => args)
}));

const { spawn } = require('child_process');
const configLoader = require('./config-loader');
const resources = require('./ffmpeg_resource');
const {
  applyOnlyAudioRetention, collectConvertedBackupCandidates,
  getAudioConversionTimeoutMs, runFfmpegCommand
} = require('./audio_processor');

describe('audio conversion lifecycle', () => {
  let root: string;
  let dayDir: string;
  let config: any;
  const old = new Date(Date.now() - 5 * 86400000);

  function write(relativePath: string): string {
    const fullPath = path.join(dayDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'fixture');
    fs.utimesSync(fullPath, old, old);
    return fullPath;
  }

  function childProcess(): any {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn(() => true);
    return child;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-lifecycle-'));
    dayDir = path.join(root, '123_test', '2020_01_01');
    fs.mkdirSync(dayDir, { recursive: true });
    config = {
      audio: { enabled: true, audioOnlyRooms: [123], defaultProfile: 'opus48k',
        defaultFormat: '.opus', ffmpeg: { path: 'ffmpeg', timeout: 30000 },
        storage: { retentionEnabled: true, includeBak: false, convertAfterDays: 3,
          deleteBakAfterConversion: true, archiveEnabled: false } },
      storage: { basePath: root }
    };
    configLoader.getConfig.mockReturnValue(config);
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('gives long recordings a duration-based budget and honors a larger configured floor', () => {
    expect(getAudioConversionTimeoutMs(41522.661, config)).toBe(2196134);
    expect(getAudioConversionTimeoutMs(60, config)).toBe(300000);
    config.audio.ffmpeg.timeout = 3600000;
    expect(getAudioConversionTimeoutMs(41522.661, config)).toBe(3600000);
    config.audio.ffmpeg.timeout = 'invalid';
    expect(getAudioConversionTimeoutMs(Number.NaN, config)).toBe(300000);
  });

  test('waits for ffmpeg to close before rejecting a timeout', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    spawn.mockReturnValue(child);
    let settled = false;
    const promise = runFfmpegCommand(['-i', 'fixture.flv'], 1000);
    const result = promise.catch((error: Error) => { settled = true; return error; });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    child.emit('close', 1);
    expect((await result).message).toContain('1000ms');
    expect(resources.startResourcePeakMonitor.mock.results.at(-1).value.stop).toHaveBeenCalledTimes(1);
  });

  test('selects only old backups with verified merged target audio', async () => {
    write('recording_merged.opus');
    write('bak/recording.flv');
    const verifyMedia = jest.fn(async () => 100);
    const candidates = await collectConvertedBackupCandidates(dayDir, { convertAfterDays: 3 },
      { format: '.opus' }, { verifyMedia });
    expect(candidates).toEqual([{ path: path.join(dayDir, 'bak'), bytes: 7, fileCount: 1 }]);
    expect(verifyMedia).toHaveBeenCalledWith(path.join(dayDir, 'recording_merged.opus'));
  });

  test.each(['recording_merged.flv', 'unreadable.flv', 'recording.m4a'])(
    'keeps backups while source %s remains', async (name) => {
      write('recording_merged.opus');
      write(name);
      write('bak/recording.flv');
      const verifyMedia = jest.fn();
      expect(await collectConvertedBackupCandidates(dayDir, { convertAfterDays: 3 },
        { format: '.opus' }, { verifyMedia })).toEqual([]);
      expect(verifyMedia).not.toHaveBeenCalled();
    });

  test('keeps new backup entries and keeps backups when verification fails', async () => {
    write('recording_merged.opus');
    const backup = write('bak/recording.flv');
    fs.utimesSync(backup, new Date(), new Date());
    expect(await collectConvertedBackupCandidates(dayDir, { convertAfterDays: 3 },
      { format: '.opus' }, { verifyMedia: async () => 100 })).toEqual([]);
    fs.utimesSync(backup, old, old);
    await expect(collectConvertedBackupCandidates(dayDir, { convertAfterDays: 3 },
      { format: '.opus' }, { verifyMedia: async () => { throw new Error('invalid audio'); } }))
      .rejects.toThrow('invalid audio');
    expect(fs.existsSync(backup)).toBe(true);
  });

  test('requires a merged target and an enabled conversion age', async () => {
    write('recording.opus');
    write('bak/recording.flv');
    expect(await collectConvertedBackupCandidates(dayDir, { convertAfterDays: 3 },
      { format: '.opus' })).toEqual([]);
    expect(await collectConvertedBackupCandidates(dayDir, { convertAfterDays: null },
      { format: '.opus' })).toEqual([]);
  });

  function mockProbe() {
    spawn.mockImplementation(() => {
      const child = childProcess();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('100\n'));
        child.emit('close', 0);
      });
      return child;
    });
  }

  test('dry-run does not delete backups; a real pass clears already converted backlog', async () => {
    write('recording_merged.opus');
    const backup = write('bak/recording.flv');
    mockProbe();
    const dry = await applyOnlyAudioRetention({ dryRun: true });
    expect(dry.prunedBackupDirectories).toBe(1);
    expect(fs.existsSync(backup)).toBe(true);
    const actual = await applyOnlyAudioRetention();
    expect(actual.prunedBackupBytes).toBe(7);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(path.join(dayDir, 'recording_merged.opus'))).toBe(true);
  });

  test('preserves backup lifetime for video-retaining rooms and honors action limits', async () => {
    write('recording_merged.opus');
    const backup = write('bak/recording.flv');
    mockProbe();
    const limited = await applyOnlyAudioRetention({ limit: 0 });
    expect(limited.prunedBackupDirectories).toBe(0);
    config.audio.audioOnlyRooms = [];
    config.audio.storage.archiveAllRoomDirectories = true;
    const result = await applyOnlyAudioRetention();
    expect(result.prunedBackupDirectories).toBe(0);
    expect(fs.existsSync(backup)).toBe(true);
  });

  test('backup-only maintenance never starts conversion or archive operations', async () => {
    const source = write('recording_merged.flv');
    const backup = write('bak/recording.flv');
    mockProbe();
    const result = await applyOnlyAudioRetention({ backupsOnly: true });
    expect(result.scanned).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.converted).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(backup)).toBe(true);
  });

  test.each([0, 1])('only deletes source and backup after successful conversion (ffmpeg exit %s)', async (exitCode) => {
    const source = write('recording_merged.flv');
    const backup = write('bak/recording.flv');
    spawn.mockImplementation((command: string, args: string[]) => {
      const child = childProcess();
      setImmediate(() => {
        if (command === 'ffprobe') {
          child.stdout.emit('data', Buffer.from('100\n'));
          child.emit('close', 0);
        } else {
          fs.writeFileSync(args.at(-1)!, 'converted');
          child.emit('close', exitCode);
        }
      });
      return child;
    });
    const result = await applyOnlyAudioRetention();
    expect(fs.existsSync(source)).toBe(exitCode !== 0);
    expect(fs.existsSync(backup)).toBe(exitCode !== 0);
    expect(result.prunedBackupDirectories).toBe(exitCode === 0 ? 1 : 0);
    expect(fs.readdirSync(dayDir).some((name: string) => name.includes('.tmp-'))).toBe(false);
  });
});
