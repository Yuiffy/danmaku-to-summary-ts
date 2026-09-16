import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSessionManager } from './LiveSessionManager';

const RECORD_PREFIX = '\u5f55\u5236';

function writeRecording(dir: string, fileName: string, mtime: Date): string {
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, fileName);
  const xmlPath = videoPath.replace(/\.flv$/, '.xml');
  fs.writeFileSync(videoPath, 'video');
  fs.writeFileSync(xmlPath, '<i></i>');
  fs.utimesSync(videoPath, mtime, mtime);
  fs.utimesSync(xmlPath, mtime, mtime);
  return videoPath;
}

function addCurrentSegment(manager: LiveSessionManager, roomId: string, videoPath: string, start: Date, end: Date): void {
  const xmlPath = videoPath.replace(/\.flv$/, '.xml');
  manager.addSegment(roomId, videoPath, xmlPath, start, end, end);
}

describe('LiveSessionManager nearby segment recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
  });

  test('uses an explicit recording start when rebuilding a session', () => {
    const manager = new LiveSessionManager();
    const recordingStart = new Date('2026-08-12T04:14:22.532+08:00');

    const session = manager.createOrGetSession('21452505', '七海Nana7mi', '种田！第一年冬', recordingStart);

    expect(session.startTime).toEqual(recordingStart);
  });

  test('parses recording filename timestamps as Asia/Shanghai time', () => {
    const manager = new LiveSessionManager() as any;

    const parsed = manager.parseRecordingFileName('录制-21452505-20260812-041422-531-种田！第一年冬.flv');

    expect(parsed.startTime).toEqual(new Date('2026-08-12T04:14:22+08:00'));
  });

  test('resumes a recently processing session as the same live after a short reconnect', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 3, 1, 12, 55));

    const manager = new LiveSessionManager();
    const roomId = '25788785';
    const first = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260703-011248-481-live.flv`,
      new Date(2026, 6, 3, 1, 12, 52)
    );

    manager.createOrGetSession(roomId, 'SUI', 'live');
    addCurrentSegment(
      manager,
      roomId,
      first,
      new Date(2026, 6, 3, 1, 12, 48),
      new Date(2026, 6, 3, 1, 12, 52)
    );
    manager.markAsProcessing(roomId);

    const session = manager.createOrGetSession(roomId, 'SUI', 'live continued');

    expect(session.status).toBe('collecting');
    expect(session.title).toBe('live continued');
    expect(session.segments.map(segment => path.basename(segment.videoPath))).toEqual([
      path.basename(first)
    ]);
  });

  test('accepts a continuation segment while previous session is already processing', () => {
    const manager = new LiveSessionManager();
    const roomId = '25788785';
    const first = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260703-011240-591-live.flv`,
      new Date(2026, 6, 3, 1, 12, 47)
    );
    const continuation = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260703-011248-481-live.flv`,
      new Date(2026, 6, 3, 1, 52, 52)
    );

    manager.createOrGetSession(roomId, 'SUI', 'live');
    addCurrentSegment(
      manager,
      roomId,
      first,
      new Date(2026, 6, 3, 1, 12, 40),
      new Date(2026, 6, 3, 1, 12, 47)
    );
    manager.markAsProcessing(roomId);

    const added = manager.addSegment(
      roomId,
      continuation,
      continuation.replace(/\.flv$/, '.xml'),
      new Date(2026, 6, 3, 1, 12, 48),
      new Date(2026, 6, 3, 1, 52, 52),
      new Date(2026, 6, 3, 1, 52, 52)
    );

    expect(added).toBe(true);
    expect(manager.getSession(roomId)?.status).toBe('collecting');
    expect(manager.getSession(roomId)?.segments.map(segment => path.basename(segment.videoPath))).toEqual([
      path.basename(first),
      path.basename(continuation)
    ]);
  });

  test('ignores a duplicate FileClosed path without reviving a completed session', () => {
    const manager = new LiveSessionManager();
    const roomId = '25788785';
    const recording = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260703-011248-481-live.flv`,
      new Date(2026, 6, 3, 1, 15, 0)
    );
    const openTime = new Date(2026, 6, 3, 1, 12, 48);
    const closeTime = new Date(2026, 6, 3, 1, 15, 0);

    manager.createOrGetSession(roomId, 'SUI', 'live');
    expect(manager.addSegment(
      roomId,
      recording,
      recording.replace(/\.flv$/, '.xml'),
      openTime,
      closeTime,
      closeTime
    )).toBe(true);
    manager.markAsCompleted(roomId);

    const duplicateAdded = manager.addSegment(
      roomId,
      path.join(tempDir, '.', path.basename(recording)),
      recording.replace(/\.flv$/, '.xml'),
      openTime,
      closeTime,
      closeTime
    );

    expect(duplicateAdded).toBe(false);
    expect(manager.getSession(roomId)?.status).toBe('completed');
    expect(manager.getSession(roomId)?.segments).toHaveLength(1);
  });

  test('recovers same-room adjacent recordings despite title changes and bak location', () => {
    const manager = new LiveSessionManager();
    const roomId = '25788785';
    const bakDir = path.join(tempDir, 'bak');

    writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-002240-499-other-stream.flv`,
      new Date(2026, 5, 25, 0, 23, 0)
    );
    const first = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-200256-086-night.flv`,
      new Date(2026, 5, 25, 21, 55, 46)
    );
    const middle = writeRecording(
      bakDir,
      `${RECORD_PREFIX}-25788785-20260625-215843-042-five-centimeters.flv`,
      new Date(2026, 5, 25, 23, 12, 0)
    );
    const current = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-231349-652-five-centimeters-renamed.flv`,
      new Date(2026, 5, 25, 23, 38, 16)
    );
    writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-215843-042-five-centimeters_merged.flv`,
      new Date(2026, 5, 25, 23, 15, 58)
    );

    manager.createOrGetSession(roomId, 'SUI', 'changed title');
    addCurrentSegment(
      manager,
      roomId,
      current,
      new Date(2026, 5, 25, 23, 13, 49),
      new Date(2026, 5, 25, 23, 38, 16)
    );

    const recovered = manager.augmentSessionWithNearbySegments(roomId, {
      maxGapSeconds: 1800,
      minSizeBytes: 0,
      maxSegments: 20
    });

    expect(recovered).toBe(2);
    expect(manager.getSession(roomId)?.segments.map(segment => path.basename(segment.videoPath))).toEqual([
      path.basename(first),
      path.basename(middle),
      path.basename(current)
    ]);
  });

  test('recovers adjacent recordings from the previous date directory across midnight', () => {
    const manager = new LiveSessionManager();
    const roomId = '1967216004';
    const previousDateDir = path.join(tempDir, '2026_08_03');
    const currentDateDir = path.join(tempDir, '2026_08_04');

    const first = writeRecording(
      previousDateDir,
      `${RECORD_PREFIX}-${roomId}-20260803-222453-001-night.flv`,
      new Date(2026, 7, 4, 0, 48, 57)
    );
    const middle = writeRecording(
      currentDateDir,
      `${RECORD_PREFIX}-${roomId}-20260804-005248-002-night.flv`,
      new Date(2026, 7, 4, 0, 59, 5)
    );
    const current = writeRecording(
      currentDateDir,
      `${RECORD_PREFIX}-${roomId}-20260804-010729-003-night.flv`,
      new Date(2026, 7, 4, 1, 56, 12)
    );

    manager.createOrGetSession(roomId, '三理', 'night');
    addCurrentSegment(
      manager,
      roomId,
      current,
      new Date(2026, 7, 4, 1, 7, 29),
      new Date(2026, 7, 4, 1, 56, 12)
    );

    const recovered = manager.augmentSessionWithNearbySegments(roomId, {
      maxGapSeconds: 1800,
      minSizeBytes: 0,
      maxSegments: 20
    });

    expect(recovered).toBe(2);
    expect(manager.getSession(roomId)?.segments.map(segment => path.basename(segment.videoPath))).toEqual([
      path.basename(first),
      path.basename(middle),
      path.basename(current)
    ]);
  });

  test('does not recover recordings outside the configured gap window', () => {
    const manager = new LiveSessionManager();
    const roomId = '25788785';
    const previous = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-200256-086-night.flv`,
      new Date(2026, 5, 25, 21, 55, 46)
    );
    const current = writeRecording(
      tempDir,
      `${RECORD_PREFIX}-25788785-20260625-231349-652-late.flv`,
      new Date(2026, 5, 25, 23, 38, 16)
    );

    manager.createOrGetSession(roomId, 'SUI', 'late');
    addCurrentSegment(
      manager,
      roomId,
      current,
      new Date(2026, 5, 25, 23, 13, 49),
      new Date(2026, 5, 25, 23, 38, 16)
    );

    const recovered = manager.augmentSessionWithNearbySegments(roomId, {
      maxGapSeconds: 300,
      minSizeBytes: 0
    });

    expect(recovered).toBe(0);
    expect(manager.getSession(roomId)?.segments.map(segment => path.basename(segment.videoPath))).toEqual([
      path.basename(current)
    ]);
    expect(path.basename(previous)).toContain('200256');
  });
});
