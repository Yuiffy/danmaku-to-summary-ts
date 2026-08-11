const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectPrunableArchiveVideos,
  collectTemporaryAudioOutputs,
  extractRoomIdFromMediaName,
  getDayDirectoryAgeDays,
  isBakEntryName,
  isMergedRecordingVideo,
  isStaleTemporaryAudioOutput,
  isUsableMediaDuration
} = require('./audio_processor');

describe('recording archive pruning', () => {
  let dayDir: string;

  beforeEach(() => {
    dayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-retention-'));
  });

  afterEach(() => {
    fs.rmSync(dayDir, { recursive: true, force: true });
  });

  function write(relativePath: string): string {
    const fullPath = path.join(dayDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, relativePath);
    return fullPath;
  }

  test('prunes root source videos only when a merged recording exists', async () => {
    const source = write('recording.flv');
    const merged = write('recording_merged.flv');
    const mergedFull = write('recording_merged_full.flv');
    const clip = write('own_stream_fun_clips/recording_merged_fun_01.mp4');
    write('recording.srt');

    const candidates = await collectPrunableArchiveVideos(dayDir);

    expect(new Set(candidates)).toEqual(new Set([source, clip]));
    expect(candidates).not.toContain(merged);
    expect(candidates).not.toContain(mergedFull);
  });

  test('keeps root source videos when no merged recording exists', async () => {
    const source = write('recording.flv');
    const clip = write('manual_clips/highlight.mp4');

    const candidates = await collectPrunableArchiveVideos(dayDir);

    expect(candidates).toEqual([clip]);
    expect(candidates).not.toContain(source);
  });

  test('recognizes legacy backup names without mistaking normal files', () => {
    expect(isBakEntryName('bak')).toBe(true);
    expect(isBakEntryName('bak_20260704_031712')).toBe(true);
    expect(isBakEntryName('recording.flv.bak_20260704_031712')).toBe(true);
    expect(isBakEntryName('recording.flv.bak')).toBe(true);
    expect(isBakEntryName('backup-notes.txt')).toBe(false);
  });

  test('only treats recording videos with a merged token as merged output', () => {
    expect(isMergedRecordingVideo('recording_merged.flv')).toBe(true);
    expect(isMergedRecordingVideo('recording_merged_full.flv')).toBe(true);
    expect(isMergedRecordingVideo('recording.flv')).toBe(false);
    expect(isMergedRecordingVideo('recording_merged.srt')).toBe(false);
  });

  test('falls back to the room directory when a derived file has no room id', () => {
    const mediaPath = path.join(
      'D:\\files\\videos\\DDTV录播',
      '1713548468_莉蔻Liko',
      '2026_05_01',
      'topic_clips',
      'blank_17655.flv'
    );

    expect(extractRoomIdFromMediaName(mediaPath)).toBe(1713548468);
  });

  test('rejects recording shells too short to produce usable audio', () => {
    expect(isUsableMediaDuration(0.029)).toBe(false);
    expect(isUsableMediaDuration(0.1)).toBe(true);
    expect(isUsableMediaDuration(Number.NaN)).toBe(false);
  });

  test('ages archive directories from the recorded day instead of file mtimes', () => {
    const now = new Date(2026, 7, 11, 12).getTime();

    expect(getDayDirectoryAgeDays('2026_07_07', now)).toBeCloseTo(34.5);
    expect(getDayDirectoryAgeDays('2026_07_09', now)).toBeCloseTo(32.5);
    expect(getDayDirectoryAgeDays('2026_02_31', now)).toBeNull();
  });

  test('collects all abandoned process-scoped audio outputs before archive', async () => {
    const temporary = write('recording.tmp-1234-1786452900609.opus');
    write('recording.opus');

    expect(await collectTemporaryAudioOutputs(dayDir)).toEqual([temporary]);
  });

  test('only prunes temporary audio outputs after writes have stopped for ten minutes', () => {
    const now = Date.now();

    expect(isStaleTemporaryAudioOutput({ mtimeMs: now - 11 * 60 * 1000 }, now)).toBe(true);
    expect(isStaleTemporaryAudioOutput({ mtimeMs: now - 9 * 60 * 1000 }, now)).toBe(false);
  });
});
