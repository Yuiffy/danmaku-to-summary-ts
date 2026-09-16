import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileMerger } from './FileMerger';
import { LiveSegment } from './LiveSessionManager';
import { ProcessingAlertService } from '../monitoring/ProcessingAlertService';

function makeSegment(videoPath: string, index: number): LiveSegment {
  const openedAt = new Date(2026, 0, 1, 12, index, 0);
  return {
    videoPath,
    xmlPath: videoPath.replace(/\.flv$/, '.xml'),
    fileOpenTime: openedAt,
    fileCloseTime: new Date(openedAt.getTime() + 60_000),
    eventTimestamp: openedAt
  };
}

describe('FileMerger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-merger-'));
    jest.spyOn(ProcessingAlertService, 'notifyHighCpuAtMergeStart').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyIfSlowStage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses stream copy by default when concatenating segments', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    const outputPath = path.join(tempDir, 'merged.flv');

    await merger.mergeVideos([
      makeSegment(path.join(tempDir, 'part1.flv'), 0),
      makeSegment(path.join(tempDir, 'part2.flv'), 1)
    ], outputPath);

    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('aac');
    expect(fs.existsSync(path.join(tempDir, 'filelist.txt'))).toBe(false);
  });

  test('fills gaps while still preferring stream-copy merge', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    const createBlankVideo = jest
      .spyOn(merger, 'createBlankVideo')
      .mockResolvedValue(path.join(tempDir, 'blank_60000.flv'));
    const outputPath = path.join(tempDir, 'merged.flv');
    const first = makeSegment(path.join(tempDir, 'part1.flv'), 0);
    const second = makeSegment(path.join(tempDir, 'part2.flv'), 2);

    await merger.mergeVideos([first, second], outputPath);

    expect(createBlankVideo).toHaveBeenCalledWith(tempDir, 60000, first.videoPath);
    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('-c:a');
  });

  test('creates blank video with reference media parameters', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    jest.spyOn(merger as any, 'getMediaProfile').mockResolvedValue({
      width: 1280,
      height: 720,
      frameRate: '30000/1001',
      audioSampleRate: '44100',
      audioChannelLayout: 'mono'
    });

    await merger.createBlankVideo(tempDir, 2000, path.join(tempDir, 'part1.flv'));

    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('color=c=black:s=1280x720:r=30000/1001:d=2');
    expect(args).toContain('anullsrc=r=44100:cl=mono');
    expect(args).toContain('-threads');
    expect(args[args.indexOf('-threads') + 1]).toBe('1');
  });
});
