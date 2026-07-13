import { DelayedReplyService } from './DelayedReplyService';
import { DelayedReplyTask } from './interfaces/types';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('DelayedReplyService duplicate reply detection', () => {
  function createService(): DelayedReplyService {
    return new DelayedReplyService(
      {} as any,
      {} as any
    );
  }

  function createTask(overrides: Partial<DelayedReplyTask>): DelayedReplyTask {
    return {
      taskId: 'task-1',
      roomId: '27628030',
      goodnightTextPath: 'goodnight.md',
      comicImagePath: 'comic.png',
      createTime: new Date(Date.now() - 60 * 1000),
      scheduledTime: new Date(),
      status: 'waiting_comic',
      retryCount: 0,
      repliedDynamicId: '1222379810217525253',
      replyId: '305238656897',
      completedAt: new Date(Date.now() - 30 * 1000),
      ...overrides
    };
  }

  it('treats waiting_comic tasks with a main reply as already replied', () => {
    const service = createService() as any;
    const repliedTask = createTask({});

    service.tasks.set(repliedTask.taskId, repliedTask);

    const duplicate = service.findRecentCompletedReply(
      '27628030',
      '1222379810217525253',
      'task-2'
    );

    expect(duplicate).toBe(repliedTask);
  });

  it('notifies WeChat Work with persisted async image failure details once', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-reply-comic-failure-'));
    const comicImagePath = path.join(outputDir, 'stream_COMIC_FACTORY.png');
    const metaPath = path.join(outputDir, 'stream_COMIC_FACTORY_META.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      status: 'failure',
      provider: 'tuzi',
      model: 'gemini-async',
      endpoint: 'gemini_async',
      reason: '异步任务返回 safety_block',
      attempts: [{ provider: 'tuzi', model: 'gemini-async', endpoint: 'gemini_async', status: 'failure', reason: 'safety_block' }]
    }), 'utf8');

    const notifier = { notifyProcessError: jest.fn().mockResolvedValue(true) };
    const store = { updateTask: jest.fn().mockResolvedValue(undefined) };
    const service = new DelayedReplyService({} as any, store as any, notifier as any) as any;
    const task = createTask({ comicImagePath, comicGenerationFailureNotifiedAt: undefined });
    const anchorConfigSpy = jest.spyOn(BilibiliConfigHelper, 'getAnchorConfig').mockReturnValue(undefined);

    try {
      await service.executeSupplementalComicReply(task);
      await service.executeSupplementalComicReply(task);

      expect(notifier.notifyProcessError).toHaveBeenCalledTimes(1);
      expect(notifier.notifyProcessError.mock.calls[0][1]).toBe('异步漫画生图');
      expect(notifier.notifyProcessError.mock.calls[0][4].imageGenerationInfo).toContain('异步任务返回 safety_block');
      expect(task.status).toBe('completed');
      expect(task.error).toBe('漫画图片生成已失败，补图停止');
      expect(store.updateTask).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
        comicGenerationFailureNotifiedAt: expect.any(Date)
      }));
    } finally {
      anchorConfigSpy.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
