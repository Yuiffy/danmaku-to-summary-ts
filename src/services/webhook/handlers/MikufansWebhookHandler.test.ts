import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { ProcessingAlertService } from '../../monitoring/ProcessingAlertService';
import { MikufansWebhookHandler } from './MikufansWebhookHandler';

function writeSegment(dir: string, roomId: string): { videoPath: string; xmlPath: string } {
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, `record-${roomId}-${Date.now()}.flv`);
  const xmlPath = videoPath.replace(/\.flv$/, '.xml');
  fs.writeFileSync(videoPath, Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(xmlPath, '<i></i>');
  return { videoPath, xmlPath };
}

function writeRecording(dir: string, fileName: string, mtime: Date, sizeBytes = 2 * 1024 * 1024): string {
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, fileName);
  const xmlPath = videoPath.replace(/\.flv$/, '.xml');
  fs.writeFileSync(videoPath, Buffer.alloc(sizeBytes));
  fs.writeFileSync(xmlPath, '<i></i>');
  fs.utimesSync(videoPath, mtime, mtime);
  fs.utimesSync(xmlPath, mtime, mtime);
  return videoPath;
}

function formatRecordingStamp(date: Date): { datePart: string; timePart: string } {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return {
    datePart: `${y}${m}${d}`,
    timePart: `${hh}${mm}${ss}`
  };
}

function makeRecordingName(roomId: string, date: Date, suffix: string): string {
  const stamp = formatRecordingStamp(date);
  return `录制-${roomId}-${stamp.datePart}-${stamp.timePart}-${suffix}-陪陪你这个猪度过周2！.flv`;
}

describe('MikufansWebhookHandler segment collection finalization', () => {
  let tempDir: string;
  let handlers: any[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikufans-handler-'));
    handlers = [];
    jest.spyOn(ProcessingAlertService, 'notifyStreamStartedWithoutFileOpening').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyStreamEndedWithoutCurrentSegment').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyFinalizationStuck').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyMissingFileCloseAfterStreamEnd').mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const handler of handlers) {
      for (const roomActions of handler.delayedActions.values()) {
        for (const timer of roomActions.values()) {
          clearTimeout(timer);
        }
      }
      handler.delayedActions.clear();
      for (const timer of handler.pendingDelayedReplyFileTimers.values()) {
        clearTimeout(timer);
      }
      handler.pendingDelayedReplyFileTimers.clear();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('cancels numeric-keyed stream finalization when the live reconnects', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = 25788785;
    const staleFinalization = jest.fn().mockResolvedValue(undefined);

    handler.startDelayedAction(
      roomId,
      'stream_ended',
      staleFinalization,
      `StreamEnded: ${roomId}`
    );
    handler.startDelayedAction(
      roomId,
      'segment_collection',
      staleFinalization,
      `SegmentCollection: ${roomId}`
    );

    expect(Array.from(handler.delayedActions.keys())).toEqual([String(roomId)]);

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-05T23:03:21.129+08:00',
      EventData: {
        RoomId: roomId
      }
    });

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(staleFinalization).not.toHaveBeenCalled();
    expect(handler.delayedActions.get(String(roomId))?.has('stream_ended')).not.toBe(true);
    expect(handler.delayedActions.get(String(roomId))?.has('segment_collection')).not.toBe(true);
    expect(handler.delayedActions.get(String(roomId))?.has('recording_start_alert')).toBe(true);
    expect(handler.activeLiveRooms.has(String(roomId))).toBe(true);
  });

  test('removes a fired action from pending without deleting a replacement timer', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    let releaseAction!: () => void;
    const actionGate = new Promise<void>(resolve => {
      releaseAction = resolve;
    });

    handler.startDelayedAction(
      roomId,
      'stream_ended',
      async () => actionGate,
      'original',
      1000
    );
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(handler.delayedActions.get(roomId)?.has('stream_ended')).not.toBe(true);

    handler.startDelayedAction(
      roomId,
      'stream_ended',
      jest.fn().mockResolvedValue(undefined),
      'replacement',
      1000
    );
    releaseAction();
    await Promise.resolve();

    expect(handler.delayedActions.get(roomId)?.has('stream_ended')).toBe(true);
  });

  test('an already-fired stale end callback cannot finalize after reconnect', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788785';
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;
    const { videoPath, xmlPath } = writeSegment(tempDir, roomId);
    const now = new Date();
    handler.liveSessionManager.createOrGetSession(roomId, 'SUI', 'live');
    handler.liveSessionManager.addSegment(
      roomId,
      videoPath,
      xmlPath,
      new Date(now.getTime() - 60_000),
      now,
      now
    );
    handler.activeLiveRooms.add(roomId);

    await handler.processStreamEnded(roomId);

    expect(startProcessing).not.toHaveBeenCalled();
  });

  test('ignores an out-of-order StreamEnded older than the reconnect start', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = 25788785;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-05T23:03:21.129+08:00',
      EventData: { RoomId: roomId }
    });
    await handler.handleStreamEnded('old-session', {
      EventTimestamp: '2026-08-05T23:02:07.785+08:00',
      EventData: { RoomId: roomId }
    });

    expect(handler.activeLiveRooms.has(String(roomId))).toBe(true);
    expect(Array.from(handler.delayedActions.get(String(roomId)).keys())).toEqual([
      'recording_start_alert'
    ]);
    expect(handler.streamTimestamps.get(String(roomId)).endTime).toBeUndefined();
  });

  test('keeps finalization armed across the offline tail event sequence', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-11T17:05:25.855+08:00'));
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const openTime = new Date('2026-08-11T15:02:54.980+08:00');
    const closeTime = new Date('2026-08-11T17:05:22.358+08:00');
    const videoPath = writeRecording(
      tempDir,
      '录制-26966466-20260811-150254-979-米帕岁栞机械狂欢！.flv',
      closeTime
    );
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      webhook: {
        endpoints: {
          mikufans: {
            basePath: tempDir
          }
        }
      }
    } as any);
    handler.streamTimestamps.set(roomId, {
      startTime: new Date('2026-08-11T15:00:42.916+08:00')
    });

    await handler.collectSegment(roomId, videoPath, {
      EventData: {
        RoomId: roomId,
        Name: '栞栞Shiori',
        Title: '米帕岁栞机械狂欢！',
        FileOpenTime: openTime.toISOString(),
        FileCloseTime: closeTime.toISOString()
      }
    });
    handler.finalFileClosedRooms.set(roomId, closeTime);

    await handler.handleStreamEnded('main-session', {
      EventTimestamp: '2026-08-11T17:05:25.8556531+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'main-session',
        Name: '栞栞Shiori',
        Title: '米帕岁栞机械狂欢！',
        Streaming: false
      }
    });
    await handler.handleEvent({
      EventType: 'SessionStarted',
      EventTimestamp: '2026-08-11T17:05:25.8745089+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'offline-tail',
        Name: '栞栞Shiori',
        Title: '米帕岁栞机械狂欢！',
        Recording: true,
        Streaming: false
      }
    }, 'SessionStarted');
    await handler.handleEvent({
      EventType: 'FileOpening',
      EventTimestamp: '2026-08-11T17:05:25.9985419+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'offline-tail',
        Name: '栞栞Shiori',
        Title: '米帕岁栞机械狂欢！',
        Recording: true,
        Streaming: false
      }
    }, 'FileOpening');
    const tailCloseTimes = [
      new Date('2026-08-11T17:05:26.500+08:00'),
      new Date('2026-08-11T17:05:27.500+08:00')
    ];
    for (const [index, tailCloseTime] of tailCloseTimes.entries()) {
      const tailPath = writeRecording(
        tempDir,
        `录制-26966466-20260811-170525-00${index + 1}-offline-tail.flv`,
        tailCloseTime,
        600 * 1024
      );
      await handler.handleEvent({
        EventType: 'FileClosed',
        EventTimestamp: tailCloseTime.toISOString(),
        EventData: {
          RoomId: roomId,
          SessionId: 'offline-tail',
          Name: '栞栞Shiori',
          Title: '米帕岁栞机械狂欢！',
          RelativePath: path.basename(tailPath),
          FileOpenTime: '2026-08-11T17:05:25.9985419+08:00',
          FileCloseTime: tailCloseTime.toISOString(),
          Recording: false,
          Streaming: false
        }
      }, 'FileClosed');
    }
    await handler.handleSessionEnded('offline-tail', {
      EventTimestamp: '2026-08-11T17:05:27.980335+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'offline-tail',
        Name: '栞栞Shiori',
        Title: '米帕岁栞机械狂欢！',
        Recording: false,
        Streaming: false
      }
    });

    const actions = handler.delayedActions.get(roomId);
    expect(handler.activeLiveRooms.has(roomId)).toBe(false);
    expect(actions.has('stream_ended')).toBe(true);
    expect(actions.has('segment_collection')).toBe(true);
    expect(actions.has('session_ended')).toBe(false);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(startProcessing).toHaveBeenCalledTimes(1);
    expect(startProcessing.mock.calls[0][0]).toBe(videoPath);
  });

  test('ignores stale online recorder events without disarming finalization', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const finalization = jest.fn().mockResolvedValue(undefined);
    handler.streamTimestamps.set(roomId, {
      startTime: new Date('2026-08-11T15:00:42.916+08:00'),
      endTime: new Date('2026-08-11T17:05:25.855+08:00')
    });
    handler.startDelayedAction(roomId, 'stream_ended', finalization, 'existing-finalization');

    await handler.handleSessionStarted('stale-session', {
      EventTimestamp: '2026-08-11T17:05:20.000+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'stale-session',
        Recording: true,
        Streaming: true
      }
    });
    await handler.handleFileOpening({
      EventTimestamp: '2026-08-11T17:05:24.000+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'stale-session',
        FileOpenTime: '2026-08-11T17:05:19.000+08:00',
        Streaming: true
      }
    });

    expect(handler.activeLiveRooms.has(roomId)).toBe(false);
    expect(handler.delayedActions.get(roomId)?.has('stream_ended')).toBe(true);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(finalization).toHaveBeenCalledTimes(1);
  });

  test('accepts an online recorder event after StreamEnded as a real reconnect', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    handler.streamTimestamps.set(roomId, {
      startTime: new Date('2026-08-11T15:00:42.916+08:00'),
      endTime: new Date('2026-08-11T17:05:25.855+08:00')
    });
    handler.startDelayedAction(
      roomId,
      'stream_ended',
      jest.fn().mockResolvedValue(undefined),
      'existing-finalization'
    );

    await handler.handleSessionStarted('reconnect-session', {
      EventTimestamp: '2026-08-11T17:05:26.000+08:00',
      EventData: {
        RoomId: roomId,
        SessionId: 'reconnect-session',
        Recording: true,
        Streaming: true
      }
    });

    expect(handler.activeLiveRooms.has(roomId)).toBe(true);
    expect(handler.delayedActions.get(roomId)?.has('stream_ended')).not.toBe(true);
  });

  test('alerts when StreamStarted is not followed by an online recorder event', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: {
        RoomId: 25788785,
        Name: '岁己SUI',
        Title: '和米帕栞栞玩机械狂欢！',
        Streaming: true
      }
    });

    await jest.advanceTimersByTimeAsync(480 * 1000 - 1);
    expect(alert).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('does not arm the missing-recorder alert when StreamStarted says Recording=false', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T20:10:57.5243202+08:00',
      EventData: {
        RoomId: 21224291,
        Name: '安堂いなり_official',
        Title: '种田！',
        Recording: false,
        Streaming: true
      }
    });

    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(alert).not.toHaveBeenCalled();
    expect(handler.delayedActions.get('21224291')?.has('recording_start_alert')).not.toBe(true);
  });

  test('an online FileOpening cancels the missing-recorder-event alert', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    });
    await handler.handleFileOpening({
      EventTimestamp: '2026-08-11T15:00:43.0000000+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    });

    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(alert).not.toHaveBeenCalled();
  });

  test('uses historical recording times when the room has a newer active session', () => {
    jest.useFakeTimers();
    const currentLiveStart = new Date('2026-08-11T20:05:20.000+08:00');
    const recordingStart = new Date('2026-08-11T15:03:07.000+08:00');
    const recordingEnd = new Date('2026-08-11T17:09:31.610+08:00');
    jest.setSystemTime(currentLiveStart);
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788785';
    const videoPath = writeRecording(
      tempDir,
      makeRecordingName(roomId, recordingStart, '193'),
      recordingEnd
    );
    handler.streamTimestamps.set(roomId, { startTime: currentLiveStart });
    handler.liveSessionManager.createOrGetSession(roomId, '岁己SUI', 'current-live');

    const times = handler.resolveLiveTimesForDelayedReply(videoPath, roomId);

    expect(times.liveStartTime).toEqual(recordingStart);
    expect(times.liveEndTime).toEqual(recordingEnd);
  });

  test('does not arm the missing-recorder alert when SessionStarted arrived before StreamStarted', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;

    await handler.handleEvent({
      EventType: 'SessionStarted',
      EventTimestamp: '2026-08-11T15:00:43.0000000+08:00',
      EventData: {
        RoomId: 25788785,
        SessionId: 'online-session',
        Name: '岁己SUI',
        Recording: true,
        Streaming: true
      }
    }, 'SessionStarted');
    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    });

    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(alert).not.toHaveBeenCalled();
    expect(handler.delayedActions.get('25788785')?.has('recording_start_alert')).not.toBe(true);
  });

  test('does not arm the missing-recorder alert when FileOpening arrived before StreamStarted', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;

    await handler.handleFileOpening({
      EventTimestamp: '2026-08-11T15:00:43.0000000+08:00',
      EventData: {
        RoomId: 25788785,
        Name: '岁己SUI',
        FileOpenTime: '2026-08-11T15:00:43.0000000+08:00',
        Streaming: true
      }
    });
    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    });

    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(alert).not.toHaveBeenCalled();
    expect(handler.delayedActions.get('25788785')?.has('recording_start_alert')).not.toBe(true);
  });

  test('a duplicate StreamStarted cannot re-arm the alert after FileOpening', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamStartedWithoutFileOpening as jest.Mock;
    const streamStarted = {
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    };

    await handler.handleStreamStarted(streamStarted);
    await handler.handleFileOpening({
      EventTimestamp: '2026-08-11T15:00:43.0000000+08:00',
      EventData: { RoomId: 25788785, Name: '岁己SUI', Streaming: true }
    });
    await handler.handleStreamStarted(streamStarted);

    await jest.advanceTimersByTimeAsync(300 * 1000);
    expect(alert).not.toHaveBeenCalled();
    expect(handler.delayedActions.get('25788785')?.has('recording_start_alert')).not.toBe(true);
  });

  test('alerts after StreamEnded when no current processable segment arrives', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T15:00:42.9160512+08:00',
      EventData: { RoomId: 31368705, Name: '米汀Nagisa', Streaming: true }
    });
    await handler.handleStreamEnded('missing-session', {
      EventTimestamp: '2026-08-11T17:12:34.8668126+08:00',
      EventData: {
        RoomId: 31368705,
        SessionId: 'missing-session',
        Name: '米汀Nagisa',
        Streaming: false
      }
    });

    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('does not alert after StreamEnded when the room explicitly was not recording', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T17:59:19.0035086+08:00',
      EventData: {
        RoomId: 1967215387,
        Name: '命依Mei',
        Recording: false,
        Streaming: true
      }
    });
    await handler.handleStreamEnded('not-recorded', {
      EventTimestamp: '2026-08-11T19:06:07.0893543+08:00',
      EventData: {
        RoomId: 1967215387,
        SessionId: 'not-recorded',
        Name: '命依Mei',
        Recording: false,
        Streaming: false
      }
    });

    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(alert).not.toHaveBeenCalled();
    expect(handler.delayedActions.get('1967215387')?.has('stream_end_segment_alert')).not.toBe(true);
  });

  test('SessionEnded cannot bypass the StreamEnded segment grace period', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const alert = ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment as jest.Mock;

    await handler.handleStreamStarted({
      EventTimestamp: '2026-08-11T17:59:11.2520077+08:00',
      EventData: {
        RoomId: 1820703922,
        Name: '花礼Harei',
        Recording: true,
        Streaming: true
      }
    });
    await handler.handleStreamEnded('harei-session', {
      EventTimestamp: '2026-08-11T18:47:09.4630953+08:00',
      EventData: {
        RoomId: 1820703922,
        SessionId: 'harei-session',
        Name: '花礼Harei',
        Recording: true,
        Streaming: false
      }
    });
    await handler.handleSessionEnded('harei-session', {
      EventTimestamp: '2026-08-11T18:47:19.8331662+08:00',
      EventData: {
        RoomId: 1820703922,
        SessionId: 'harei-session',
        Name: '花礼Harei',
        Recording: false,
        Streaming: false
      }
    });

    expect(alert).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60 * 1000 - 1);
    expect(alert).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('SessionEnded repairs a missing finalization timer after StreamEnded', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const now = new Date();
    const videoPath = writeRecording(tempDir, makeRecordingName(roomId, now, '001'), now);
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;
    handler.streamTimestamps.set(roomId, {
      startTime: new Date(now.getTime() - 60_000),
      endTime: now
    });
    handler.liveSessionManager.createOrGetSession(roomId, '栞栞Shiori', 'live');
    handler.liveSessionManager.addSegment(
      roomId,
      videoPath,
      videoPath.replace(/\.flv$/, '.xml'),
      new Date(now.getTime() - 60_000),
      now,
      now
    );

    await handler.handleSessionEnded('tail-session', {
      EventTimestamp: now.toISOString(),
      EventData: {
        RoomId: roomId,
        SessionId: 'tail-session',
        Name: '栞栞Shiori',
        Streaming: false
      }
    });

    expect(ProcessingAlertService.notifyFinalizationStuck).toHaveBeenCalledTimes(1);
    expect(handler.delayedActions.get(roomId).has('stream_ended')).toBe(true);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(startProcessing).toHaveBeenCalledTimes(1);
  });

  test('a duplicate SessionEnded cannot reprocess an already completed stream', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const now = new Date();
    const videoPath = writeRecording(tempDir, makeRecordingName(roomId, now, '002'), now);
    handler.startProcessing = jest.fn().mockResolvedValue(true);
    handler.streamTimestamps.set(roomId, {
      startTime: new Date(now.getTime() - 60_000),
      endTime: now
    });
    handler.liveSessionManager.createOrGetSession(roomId, '栞栞Shiori', 'live');
    handler.liveSessionManager.addSegment(
      roomId,
      videoPath,
      videoPath.replace(/\.flv$/, '.xml'),
      new Date(now.getTime() - 60_000),
      now,
      now
    );
    handler.liveSessionManager.markAsCompleted(roomId);
    fs.rmSync(videoPath);
    fs.rmSync(videoPath.replace(/\.flv$/, '.xml'));

    await handler.handleSessionEnded('duplicate-tail', {
      EventTimestamp: now.toISOString(),
      EventData: { RoomId: roomId, SessionId: 'duplicate-tail', Name: '栞栞Shiori' }
    });

    expect(handler.startProcessing).not.toHaveBeenCalled();
    expect(ProcessingAlertService.notifyFinalizationStuck).not.toHaveBeenCalled();
    expect(handler.delayedActions.has(roomId)).toBe(false);
  });

  test('a duplicate StreamEnded cannot reprocess an already completed stream', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const endTime = new Date();
    const videoPath = writeRecording(
      tempDir,
      makeRecordingName(roomId, new Date(endTime.getTime() - 60_000), '004'),
      endTime
    );
    handler.startProcessing = jest.fn().mockResolvedValue(true);
    handler.streamTimestamps.set(roomId, {
      startTime: new Date(endTime.getTime() - 60_000),
      endTime
    });
    handler.liveSessionManager.createOrGetSession(roomId, '栞栞Shiori', 'live');
    handler.liveSessionManager.addSegment(
      roomId,
      videoPath,
      videoPath.replace(/\.flv$/, '.xml'),
      new Date(endTime.getTime() - 60_000),
      endTime,
      endTime
    );
    handler.liveSessionManager.markAsCompleted(roomId);

    await handler.handleStreamEnded('duplicate-end', {
      EventTimestamp: endTime.toISOString(),
      EventData: { RoomId: roomId, SessionId: 'duplicate-end', Streaming: false }
    });
    await handler.processStreamEnded(roomId);

    expect(handler.startProcessing).not.toHaveBeenCalled();
    expect(handler.delayedActions.has(roomId)).toBe(false);
    expect(handler.liveSessionManager.getSession(roomId).status).toBe('completed');
  });

  test('recovers a late FileClosed without Streaming after a no-session StreamEnded', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '31368705';
    const startTime = new Date('2026-08-11T15:03:42.180+08:00');
    const endTime = new Date('2026-08-11T17:12:34.866+08:00');
    const closeTime = new Date(endTime.getTime() + 1000);
    jest.setSystemTime(new Date(closeTime.getTime() + 2000));
    const videoPath = writeRecording(
      tempDir,
      makeRecordingName(roomId, new Date(startTime.getTime() + 1000), '005'),
      closeTime
    );
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      webhook: {
        endpoints: {
          mikufans: { basePath: tempDir }
        }
      }
    } as any);

    await handler.handleStreamStarted({
      EventTimestamp: startTime.toISOString(),
      EventData: { RoomId: roomId, Name: '米汀Nagisa', Streaming: true }
    });
    await handler.handleStreamEnded('missing-session', {
      EventTimestamp: endTime.toISOString(),
      EventData: { RoomId: roomId, SessionId: 'missing-session', Name: '米汀Nagisa', Streaming: false }
    });
    await handler.handleFileClosed({
      EventTimestamp: closeTime.toISOString(),
      EventData: {
        RoomId: roomId,
        SessionId: 'late-file',
        Name: '米汀Nagisa',
        RelativePath: path.basename(videoPath),
        FileOpenTime: new Date(startTime.getTime() + 1000).toISOString(),
        FileCloseTime: closeTime.toISOString()
      }
    });

    expect(handler.finalFileClosedRooms.has(roomId)).toBe(true);
    const rebuiltSession = handler.liveSessionManager.getSession(roomId);
    expect(rebuiltSession.segments).toHaveLength(1);
    expect(rebuiltSession.startTime).toEqual(new Date(startTime.getTime() + 1000));
    expect(handler.delayedActions.get(roomId)?.has('segment_collection')).toBe(true);
    expect(handler.delayedActions.get(roomId)?.has('finalization_watchdog')).toBe(true);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(startProcessing).toHaveBeenCalledTimes(1);
    expect(startProcessing.mock.calls[0][0]).toBe(videoPath);
  });

  test('normalizes RoomId across numeric SessionStarted and string FileClosed/StreamEnded events', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '26966466';
    const now = new Date();
    const openTime = new Date(now.getTime() - 60_000);
    const videoPath = writeRecording(tempDir, makeRecordingName(roomId, openTime, '003'), now);
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      webhook: {
        endpoints: {
          mikufans: {
            basePath: tempDir
          }
        }
      }
    } as any);

    await handler.handleEvent({
      EventType: 'SessionStarted',
      EventTimestamp: openTime.toISOString(),
      EventData: {
        RoomId: Number(roomId),
        SessionId: 'numeric-session',
        Name: 'Shiori',
        Title: 'live',
        Recording: true,
        Streaming: true
      }
    }, 'SessionStarted');
    await handler.handleEvent({
      EventType: 'FileClosed',
      EventTimestamp: now.toISOString(),
      EventData: {
        RoomId: roomId,
        SessionId: 'numeric-session',
        Name: 'Shiori',
        Title: 'live',
        RelativePath: path.basename(videoPath),
        FileOpenTime: openTime.toISOString(),
        FileCloseTime: now.toISOString(),
        Streaming: false
      }
    }, 'FileClosed');
    await handler.handleEvent({
      EventType: 'StreamEnded',
      EventTimestamp: new Date(now.getTime() + 1000).toISOString(),
      EventData: {
        RoomId: roomId,
        SessionId: 'numeric-session',
        Name: 'Shiori',
        Streaming: false
      }
    }, 'StreamEnded');

    expect(Array.from(handler.liveSessionManager.getAllSessions().keys())).toEqual([roomId]);
    expect(handler.liveSessionManager.getSession(roomId).segments).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(startProcessing).toHaveBeenCalledTimes(1);
    expect(startProcessing.mock.calls[0][0]).toBe(videoPath);
  });

  test('finalizes after segment collection timeout when FileClosed reported Streaming=false', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788785';
    const { videoPath } = writeSegment(tempDir, roomId);
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;

    await handler.collectSegment(roomId, videoPath, {
      EventData: {
        RoomId: Number(roomId),
        Name: 'SUI',
        Title: 'live',
        FileOpenTime: new Date(Date.now() - 60_000).toISOString(),
        FileCloseTime: new Date().toISOString()
      }
    });
    handler.finalFileClosedRooms.set(roomId, new Date());

    await handler.processSegmentCollectionTimeout(roomId);

    expect(startProcessing).toHaveBeenCalledTimes(1);
    expect(startProcessing.mock.calls[0][0]).toBe(videoPath);
  });

  test('keeps waiting for StreamEnded when the final FileClosed marker is absent', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788786';
    const { videoPath } = writeSegment(tempDir, roomId);
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;

    await handler.collectSegment(roomId, videoPath, {
      EventData: {
        RoomId: Number(roomId),
        Name: 'SUI',
        Title: 'live',
        FileOpenTime: new Date(Date.now() - 60_000).toISOString(),
        FileCloseTime: new Date().toISOString()
      }
    });

    await handler.processSegmentCollectionTimeout(roomId);

    expect(startProcessing).not.toHaveBeenCalled();
  });

  test('waits through the reconnect grace window before finalizing a final FileClosed segment', async () => {
    jest.useFakeTimers();
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788787';
    const { videoPath } = writeSegment(tempDir, roomId);
    const startProcessing = jest.fn().mockResolvedValue(true);
    handler.startProcessing = startProcessing;

    await handler.collectSegment(roomId, videoPath, {
      EventData: {
        RoomId: Number(roomId),
        Name: 'SUI',
        Title: 'live',
        FileOpenTime: new Date(Date.now() - 60_000).toISOString(),
        FileCloseTime: new Date().toISOString()
      }
    });
    handler.finalFileClosedRooms.set(roomId, new Date());

    expect(handler.MAX_DELAY_MS).toBe(5 * 60 * 1000);
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(startProcessing).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(startProcessing).toHaveBeenCalledTimes(1);
    expect(startProcessing.mock.calls[0][0]).toBe(videoPath);
  });

  test('immediately recovers nearby disk segments when FileClosed reconstructs lost session state', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788785';
    const bakDir = path.join(tempDir, 'bak');
    const now = Date.now();
    const open1 = new Date(now - 95 * 60 * 1000);
    const close1 = new Date(now - 85 * 60 * 1000);
    const open2 = new Date(now - 80 * 60 * 1000);
    const close2 = new Date(now - 70 * 60 * 1000);
    const open3 = new Date(now - 65 * 60 * 1000);
    const close3 = new Date(now - 55 * 60 * 1000);
    const open4 = new Date(now - 50 * 60 * 1000);
    const close4 = new Date(now - 10 * 60 * 1000);
    const name1 = makeRecordingName(roomId, open1, '757');
    const name2 = makeRecordingName(roomId, open2, '682');
    const name3 = makeRecordingName(roomId, open3, '539');
    const name4 = makeRecordingName(roomId, open4, '348');
    writeRecording(bakDir, name1, close1);
    writeRecording(tempDir, name2, close2);
    writeRecording(tempDir, name3, close3);
    const current = writeRecording(tempDir, name4, close4);
    const mergeVideos = jest.fn().mockResolvedValue(undefined);
    handler.fileMerger.mergeVideos = mergeVideos;
    handler.fileMerger.mergeXmlFiles = jest.fn().mockResolvedValue(undefined);
    handler.fileMerger.copyCover = jest.fn().mockResolvedValue(undefined);
    handler.fileMerger.backupSegments = jest.fn().mockResolvedValue(undefined);
    handler.startProcessing = jest.fn().mockResolvedValue(true);

    await handler.collectSegment(roomId, current, {
      EventData: {
        RoomId: Number(roomId),
        Name: 'SUI',
        Title: '陪陪你这个猪度过周2！',
        FileOpenTime: open4.toISOString(),
        FileCloseTime: close4.toISOString()
      }
    });

    expect(handler.liveSessionManager.getSession(roomId).segments.map((segment: { videoPath: string }) => path.basename(segment.videoPath))).toEqual([
      name1,
      name2,
      name3,
      name4
    ]);

    handler.finalFileClosedRooms.set(roomId, close4);

    await handler.processSegmentCollectionTimeout(roomId);

    expect(mergeVideos).toHaveBeenCalledTimes(1);
    expect(mergeVideos.mock.calls[0][0].map((segment: { videoPath: string }) => path.basename(segment.videoPath))).toEqual([
      name1,
      name2,
      name3,
      name4
    ]);
  });

  test('uses Python soft GPU protection instead of the legacy queue GPU gate', () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const adaptiveConfig = {
      asr: {
        default_backend: 'paraformer',
        paraformer: {
          resource_guard: {
            enabled: true,
            pause_when_game_running: false
          },
          gpu_throttle: {
            enabled: true,
            soft_gpu: { enabled: true }
          }
        }
      }
    };

    expect(handler.isAdaptiveParaformerGpuProtectionEnabled(adaptiveConfig)).toBe(true);
    expect(handler.isAdaptiveParaformerGpuProtectionEnabled({
      ...adaptiveConfig,
      asr: {
        ...adaptiveConfig.asr,
        paraformer: {
          ...adaptiveConfig.asr.paraformer,
          resource_guard: { enabled: true, pause_when_game_running: true }
        }
      }
    })).toBe(true);
    expect(handler.isAdaptiveParaformerGpuProtectionEnabled({
      ...adaptiveConfig,
      asr: {
        ...adaptiveConfig.asr,
        default_backend: 'whisper'
      }
    })).toBe(false);
  });
});
