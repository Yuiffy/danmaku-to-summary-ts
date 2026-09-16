import { getLogger } from '../../../core/logging/LogManager';
import type { DelayedReplyTask } from '../interfaces/types';

export interface DelayedReplySchedulerCallbacks {
  checkDueTasks: () => Promise<void>;
  logCountdown: () => void;
  executeTask: (task: DelayedReplyTask) => Promise<void>;
}

export interface DelayedReplySchedulerOptions {
  checkIntervalMs?: number;
  countdownIntervalMs?: number;
}

/** Owns timer handles and interval lifecycle for delayed-reply tasks. */
export class DelayedReplyScheduler {
  private readonly logger = getLogger('DelayedReplyScheduler');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly checkIntervalMs: number;
  private readonly countdownIntervalMs: number;
  private checkInterval: NodeJS.Timeout | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly callbacks: DelayedReplySchedulerCallbacks,
    options: DelayedReplySchedulerOptions = {}
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? 30_000;
    this.countdownIntervalMs = options.countdownIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.checkInterval || this.countdownInterval) {
      return;
    }

    this.checkInterval = setInterval(() => {
      void this.runDueCheck();
    }, this.checkIntervalMs);
    this.countdownInterval = setInterval(() => {
      try {
        this.callbacks.logCountdown();
      } catch (error) {
        this.logger.error('延迟回复倒计时回调失败', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, this.countdownIntervalMs);

    // Do not make service startup wait for an API call or a task execution.
    void this.runDueCheck();
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.clearTaskTimers();
  }

  schedule(task: DelayedReplyTask): void {
    this.cancel(task.taskId);
    const delayMs = Math.max(0, task.scheduledTime.getTime() - Date.now());
    const timer = setTimeout(() => {
      // Remove the handle before executing so a reschedule from inside the
      // callback cannot accidentally clear a timer that belongs to a later run.
      this.timers.delete(task.taskId);
      void this.runTask(task);
    }, delayMs);
    this.timers.set(task.taskId, timer);
  }

  cancel(taskId: string): boolean {
    const timer = this.timers.get(taskId);
    if (!timer) {
      return false;
    }
    clearTimeout(timer);
    this.timers.delete(taskId);
    return true;
  }

  clearTaskTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  hasScheduledTask(taskId: string): boolean {
    return this.timers.has(taskId);
  }

  private async runDueCheck(): Promise<void> {
    try {
      await this.callbacks.checkDueTasks();
    } catch (error) {
      this.logger.error('检查延迟回复到期任务失败', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runTask(task: DelayedReplyTask): Promise<void> {
    try {
      await this.callbacks.executeTask(task);
    } catch (error) {
      this.logger.error('延迟回复定时任务执行失败', {
        taskId: task.taskId,
        roomId: task.roomId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
