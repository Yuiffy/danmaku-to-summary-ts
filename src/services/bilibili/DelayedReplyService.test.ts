import { DelayedReplyService } from './DelayedReplyService';
import { DelayedReplyTask } from './interfaces/types';

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
});
