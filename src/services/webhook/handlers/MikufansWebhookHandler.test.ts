import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MikufansWebhookHandler } from './MikufansWebhookHandler';

function writeSegment(dir: string, roomId: string): { videoPath: string; xmlPath: string } {
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, `record-${roomId}-${Date.now()}.flv`);
  const xmlPath = videoPath.replace(/\.flv$/, '.xml');
  fs.writeFileSync(videoPath, 'video');
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

  test('recovers nearby disk segments before merging when session state was lost', async () => {
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
});
