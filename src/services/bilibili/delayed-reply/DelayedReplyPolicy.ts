import * as path from 'path';
import { BilibiliConfigHelper } from '../BilibiliConfigHelper';
import { DelayedReplyTask, BilibiliDynamic, RoomLiveStatus } from '../interfaces/types';

/** Eligibility, identity, and failure classification; owns no task state or timers. */
export class DelayedReplyPolicy {

  private static readonly DEFAULT_MAX_TASK_AGE_HOURS = 24;

  private static readonly FIRST_REPLY_WAVE_WINDOW_MS = 5 * 60 * 1000;

  getTaskDedupeKey(roomId: string, goodnightTextPath: string, comicImagePath?: string): string {
    return [
      String(roomId),
      path.normalize(goodnightTextPath),
      comicImagePath ? path.normalize(comicImagePath) : ''
    ].join('|');
  }

  getDynamicReplyDedupeKey(roomId: string, dynamicId: string): string {
    return [String(roomId), String(dynamicId)].join('|');
  }

  isSameDelayedReplyTask(
    task: DelayedReplyTask,
    roomId: string,
    goodnightTextPath: string,
    comicImagePath?: string
  ): boolean {
    return this.getTaskDedupeKey(task.roomId, task.goodnightTextPath, task.comicImagePath) ===
      this.getTaskDedupeKey(roomId, goodnightTextPath, comicImagePath);
  }

  isSameDelayedReplyTextTask(
    task: DelayedReplyTask,
    roomId: string,
    goodnightTextPath: string
  ): boolean {
    return task.roomId === roomId &&
      path.normalize(task.goodnightTextPath) === path.normalize(goodnightTextPath);
  }

  getDelayedReplyLimitConfig() {
    const config = BilibiliConfigHelper.getDelayedReplyConfig() as any;
    return {
      maxTaskAgeHours: Number(config.maxTaskAgeHours ?? DelayedReplyPolicy.DEFAULT_MAX_TASK_AGE_HOURS)
    };
  }

  getTaskAgeMs(task: DelayedReplyTask, now = Date.now()): number {
    const anchorTime = task.liveEndTime || task.createTime;
    return now - anchorTime.getTime();
  }

  isDelayedReplyTaskExpired(task: DelayedReplyTask, now = Date.now()): boolean {
    const { maxTaskAgeHours } = this.getDelayedReplyLimitConfig();
    return maxTaskAgeHours >= 0 && this.getTaskAgeMs(task, now) > maxTaskAgeHours * 60 * 60 * 1000;
  }

  isSameActiveLiveForTask(task: DelayedReplyTask, liveStatus: RoomLiveStatus | null): boolean {
    if (!liveStatus?.isLive) {
      return false;
    }

    const liveStart = liveStatus.liveStartTime?.getTime();
    if (!liveStart || Number.isNaN(liveStart)) {
      return true;
    }

    const toleranceMs = 5 * 60 * 1000;
    const taskCreateTime = task.createTime.getTime();
    const taskLiveStart = task.liveStartTime?.getTime();
    const taskLiveEnd = task.liveEndTime?.getTime();

    if (taskLiveEnd) {
      const earliestSameLiveStart = taskLiveStart
        ? taskLiveStart - toleranceMs
        : Number.NEGATIVE_INFINITY;
      return liveStart >= earliestSameLiveStart && liveStart <= taskLiveEnd + toleranceMs;
    }

    if (taskLiveStart) {
      return liveStart >= taskLiveStart - toleranceMs && liveStart <= taskCreateTime + toleranceMs;
    }

    return liveStart <= taskCreateTime + toleranceMs;
  }

  /**
   * A later final recording can legitimately target the same dynamic as an
   * earlier partial recording. The later live end time identifies that case.
   */
  isNewerRecordingTask(currentTask: DelayedReplyTask, previousTask: DelayedReplyTask): boolean {
    const currentEnd = currentTask.liveEndTime?.getTime();
    const previousEnd = previousTask.liveEndTime?.getTime();

    if (!currentEnd || Number.isNaN(currentEnd)) {
      return false;
    }
    if (!previousEnd || Number.isNaN(previousEnd)) {
      return true;
    }

    return currentEnd > previousEnd;
  }

  getTaskCompletionTime(task: DelayedReplyTask): Date {
    return task.completedAt || task.scheduledTime || task.createTime;
  }

  isWithinFirstReplyWave(dynamic: BilibiliDynamic, now = Date.now()): boolean {
    const dynamicAgeMs = Math.max(0, now - dynamic.publishTime.getTime());
    return dynamicAgeMs <= DelayedReplyPolicy.FIRST_REPLY_WAVE_WINDOW_MS;
  }

  isCredentialError(error: unknown): boolean {
    const maybeError = error as any;
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (this.isTransientNetworkError(normalized)) {
      return false;
    }

    return (
      maybeError?.code === 'AUTHENTICATION_ERROR' ||
      maybeError?.statusCode === 401 ||
      normalized.includes('sessdata') ||
      normalized.includes('bili_jct') ||
      normalized.includes('csrf') ||
      normalized.includes('cookie') ||
      normalized.includes('凭证无效') ||
      normalized.includes('账号未登录') ||
      normalized.includes('未登录') ||
      normalized.includes('登录失效')
    );
  }

  isTransientNetworkError(message?: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('cannot connect') ||
      normalized.includes('connect to host') ||
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('etimedout') ||
      normalized.includes('econnreset') ||
      normalized.includes('enotfound') ||
      normalized.includes('network') ||
      normalized.includes('信号灯超时时间已到') ||
      normalized.includes('淇″彿鐏秴鏃舵椂闂村凡鍒?')
    );
  }

  isPermanentReplyError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes('晚安回复文件不存在') ||
      normalized.includes('晚安回复文本为空') ||
      normalized.includes('12051') ||
      normalized.includes('重复评论，请勿刷屏')
    );
  }

  /**
   * 判断UID解析失败是否适合进入队列重试
   */
  isUidLookupRetriableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('cannot connect') ||
        message.includes('connect to host') ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('信号灯超时时间已到') ||
        message.includes('网络') ||
        message.includes('python脚本退出码')
      );
    }

    return false;
  }
}
