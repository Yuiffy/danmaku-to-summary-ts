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

  test('recovers nearby disk segments before merging when session state was lost', async () => {
    const handler = new MikufansWebhookHandler() as any;
    handlers.push(handler);
    const roomId = '25788785';
    const bakDir = path.join(tempDir, 'bak');
    writeRecording(
      bakDir,
      '录制-25788785-20260707-195340-757-陪陪你这个猪度过周2！.flv',
      new Date(2026, 6, 7, 20, 6, 28)
    );
    writeRecording(
      tempDir,
      '录制-25788785-20260707-200832-682-陪陪你这个猪度过周2！.flv',
      new Date(2026, 6, 7, 21, 17, 41)
    );
    writeRecording(
      tempDir,
      '录制-25788785-20260707-211743-539-陪陪你这个猪度过周2！.flv',
      new Date(2026, 6, 7, 21, 56, 6)
    );
    const current = writeRecording(
      tempDir,
      '录制-25788785-20260707-215707-348-陪陪你这个猪度过周2！.flv',
      new Date(2026, 6, 8, 0, 49, 17)
    );
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
        FileOpenTime: new Date(2026, 6, 7, 21, 57, 7).toISOString(),
        FileCloseTime: new Date(2026, 6, 8, 0, 49, 17).toISOString()
      }
    });
    handler.finalFileClosedRooms.set(roomId, new Date(2026, 6, 8, 0, 49, 17));

    await handler.processSegmentCollectionTimeout(roomId);

    expect(mergeVideos).toHaveBeenCalledTimes(1);
    expect(mergeVideos.mock.calls[0][0].map((segment: { videoPath: string }) => path.basename(segment.videoPath))).toEqual([
      '录制-25788785-20260707-195340-757-陪陪你这个猪度过周2！.flv',
      '录制-25788785-20260707-200832-682-陪陪你这个猪度过周2！.flv',
      '录制-25788785-20260707-211743-539-陪陪你这个猪度过周2！.flv',
      '录制-25788785-20260707-215707-348-陪陪你这个猪度过周2！.flv'
    ]);
  });
});
