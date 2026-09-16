import { DelayedReplyScheduler } from './DelayedReplyScheduler';
import { DelayedReplyTask } from '../interfaces/types';

function createTask(overrides: Partial<DelayedReplyTask> = {}): DelayedReplyTask {
  const now = new Date();
  return {
    taskId: 'task-1',
    roomId: 'room-1',
    goodnightTextPath: 'reply.md',
    createTime: now,
    scheduledTime: new Date(now.getTime() + 1000),
    status: 'pending',
    retryCount: 0,
    ...overrides
  };
}

describe('DelayedReplyScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('replaces a task timer and executes the latest schedule once', async () => {
    jest.useFakeTimers();
    const executeTask = jest.fn().mockResolvedValue(undefined);
    const scheduler = new DelayedReplyScheduler({
      checkDueTasks: jest.fn().mockResolvedValue(undefined),
      logCountdown: jest.fn(),
      executeTask
    });
    const task = createTask();

    scheduler.schedule(task);
    scheduler.schedule({
      ...task,
      scheduledTime: new Date(Date.now() + 2000)
    });

    await jest.advanceTimersByTimeAsync(1000);
    expect(executeTask).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(scheduler.hasScheduledTask(task.taskId)).toBe(false);
  });

  it('runs the immediate check and intervals, then clears all handles on stop', async () => {
    jest.useFakeTimers();
    const checkDueTasks = jest.fn().mockResolvedValue(undefined);
    const logCountdown = jest.fn();
    const scheduler = new DelayedReplyScheduler(
      { checkDueTasks, logCountdown, executeTask: jest.fn().mockResolvedValue(undefined) },
      { checkIntervalMs: 100, countdownIntervalMs: 200 }
    );

    scheduler.start();
    await Promise.resolve();
    expect(checkDueTasks).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(checkDueTasks).toHaveBeenCalledTimes(3);
    expect(logCountdown).toHaveBeenCalledTimes(1);

    scheduler.schedule(createTask({ scheduledTime: new Date(Date.now() + 1000) }));
    scheduler.stop();
    await jest.advanceTimersByTimeAsync(2000);
    expect(checkDueTasks).toHaveBeenCalledTimes(3);
    expect(logCountdown).toHaveBeenCalledTimes(1);
  });

  it('contains callback failures instead of creating unhandled timer rejections', async () => {
    jest.useFakeTimers();
    const executeTask = jest.fn().mockRejectedValue(new Error('boom'));
    const scheduler = new DelayedReplyScheduler({
      checkDueTasks: jest.fn().mockRejectedValue(new Error('check failed')),
      logCountdown: jest.fn(() => {
        throw new Error('countdown failed');
      }),
      executeTask
    }, { checkIntervalMs: 100, countdownIntervalMs: 100 });

    scheduler.start();
    scheduler.schedule(createTask({ scheduledTime: new Date(Date.now()) }));
    await jest.advanceTimersByTimeAsync(100);
    expect(executeTask).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
