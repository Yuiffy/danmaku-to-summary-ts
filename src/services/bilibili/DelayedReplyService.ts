/**
 * 延迟回复服务实现
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { IDelayedReplyService } from './interfaces/IDelayedReplyService';
import { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import {
  DelayedReplyTask,
  BilibiliDynamic,
  RoomLiveStatus,
  PublishCommentResponse,
  LiveContentSummaryDeliveryMode,
} from './interfaces/types';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';

/**
 * 生成UUID
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * 延迟回复服务实现
 */
export class DelayedReplyService implements IDelayedReplyService {
  private logger = getLogger('DelayedReplyService');
  private static readonly COMIC_WAIT_INTERVAL_MS = 2 * 60 * 1000;
  private static readonly COMBINED_REPLY_COMIC_WAIT_INTERVAL_MS = 60 * 1000;
  private static readonly FIRST_REPLY_WAVE_WINDOW_MS = 5 * 60 * 1000;
  private static readonly MAX_COMIC_WAIT_COUNT = 5;
  private static readonly MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT = 30;
  private static readonly LIVE_CONTENT_WAIT_INTERVAL_MS = 60 * 1000;
  private static readonly MAX_COMMENT_CHARACTERS = 1000;
  private static readonly SUI_ROOM_ID = '25788785';
  private static readonly SHIORI_ROOM_ID = '26966466';
  private static readonly DEFAULT_MAX_TASK_AGE_HOURS = 24;
  private static readonly SUPPLEMENTAL_COMIC_REPLY_PREFIX = '（补图）';
  private static readonly LIVE_RECHECK_INTERVAL_MS = 2 * 60 * 1000;
  private static readonly LIVE_CONTINUATION_REPLACEMENT_MAX_WAIT_COUNT = 180;
  /** Initial active-live defer window before waiting for a final recording replacement. */
  private static readonly MAX_ACTIVE_LIVE_DEFER_COUNT = 60;
  private tasks: Map<string, DelayedReplyTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private isRunningFlag = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;
  private notifier?: WeChatWorkNotifier;
  private addTaskLocks: Map<string, Promise<string>> = new Map();
  private executingTaskIds: Set<string> = new Set();
  private publishingDynamicReplyKeys: Set<string> = new Set();
  private restoredTaskIds: Set<string> = new Set();

  constructor(
    private bilibiliAPI: IBilibiliAPIService,
    private store: IDelayedReplyStore,
    notifier?: WeChatWorkNotifier
  ) {
    this.notifier = notifier;
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    if (this.isRunningFlag) {
      this.logger.warn('延迟回复服务已在运行');
      return;
    }

    this.logger.info('启动延迟回复服务');

    // 初始化存储
    await this.store.initialize();

    // 加载已保存的任务
    await this.loadTasks();

    // 启动定时检查
    this.startCheckInterval();

    this.isRunningFlag = true;
    this.logger.info('延迟回复服务已启动');
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (!this.isRunningFlag) {
      this.logger.warn('延迟回复服务未运行');
      return;
    }

    this.logger.info('停止延迟回复服务');

    // 停止定时检查
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // 停止倒计时预告
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    // 清除所有定时器
    for (const [taskId, timer] of this.timers.entries()) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }

    this.isRunningFlag = false;
    this.logger.info('延迟回复服务已停止');
  }

  /**
   * 添加延迟回复任务
   */
  async addTask(
    roomId: string, 
    goodnightTextPath: string, 
    comicImagePath?: string, 
    delaySeconds?: number,
    liveStartTime?: Date,
    liveEndTime?: Date,
    liveContentSummaryPath?: string,
    liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode
  ): Promise<string> {
    const resolvedPaths = this.resolveDelayedReplyPaths(roomId, goodnightTextPath, comicImagePath);
    goodnightTextPath = resolvedPaths.goodnightTextPath;
    comicImagePath = resolvedPaths.comicImagePath;

    const dedupeKey = this.getTaskDedupeKey(roomId, goodnightTextPath, comicImagePath);
    const inFlightTask = this.addTaskLocks.get(dedupeKey);
    if (inFlightTask) {
      this.logger.info('跳过添加任务：相同延迟回复任务正在创建中', {
        roomId,
        goodnightTextPath,
        comicImagePath
      });
      return inFlightTask;
    }

    const createTaskPromise = this.addTaskInternal(
      roomId,
      goodnightTextPath,
      comicImagePath,
      delaySeconds,
      liveStartTime,
      liveEndTime,
      liveContentSummaryPath,
      liveContentSummaryDeliveryMode
    );
    this.addTaskLocks.set(dedupeKey, createTaskPromise);

    try {
      return await createTaskPromise;
    } finally {
      if (this.addTaskLocks.get(dedupeKey) === createTaskPromise) {
        this.addTaskLocks.delete(dedupeKey);
      }
    }
  }

  private async addTaskInternal(
    roomId: string,
    goodnightTextPath: string,
    comicImagePath?: string,
    delaySeconds?: number,
    liveStartTime?: Date,
    liveEndTime?: Date,
    liveContentSummaryPath?: string,
    liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode
  ): Promise<string> {
    try {
      liveContentSummaryPath = liveContentSummaryPath
        ? path.normalize(liveContentSummaryPath)
        : undefined;
      liveContentSummaryDeliveryMode = this.resolveLiveContentSummaryDeliveryMode(
        roomId,
        liveContentSummaryDeliveryMode
      );
      this.logger.info(`[延迟回复] 尝试添加任务: roomId=${roomId}, goodnightTextPath=${goodnightTextPath}, comicImagePath=${comicImagePath}`);
      
      // 获取延迟回复配置
      const delayedReplySettings = BilibiliConfigHelper.getDelayedReplySettings(roomId);
      if (!delayedReplySettings) {
        this.logger.warn('⚠️  延迟回复未启用，跳过添加任务', { roomId });
        return '';
      }
      this.logger.info(`✅ 延迟回复配置已加载: enabled=${delayedReplySettings.enabled}, anchorEnabled=${delayedReplySettings.anchorEnabled}, delayMinutes=${delayedReplySettings.delayMinutes}`);

      // 检查是否已有待处理或处理中的任务（去重逻辑）
      const now = new Date();
      const exactExistingTask = Array.from(this.tasks.values()).find(
        task => this.isSameDelayedReplyTask(task, roomId, goodnightTextPath, comicImagePath) &&
                (
                  task.status === 'pending' ||
                  task.status === 'processing' ||
                  task.status === 'waiting_comic' ||
                  task.status === 'waiting_summary' ||
                  task.status === 'waiting_live_content'
                )
      );

      if (exactExistingTask) {
        if (liveContentSummaryPath) {
          await this.registerLiveContentSummaryForTask(
            exactExistingTask,
            liveContentSummaryPath,
            liveContentSummaryDeliveryMode
          );
        }
        if (exactExistingTask.status === 'waiting_comic' && comicImagePath && fs.existsSync(comicImagePath)) {
          exactExistingTask.scheduledTime = new Date();
          exactExistingTask.error = undefined;
          await this.store.updateTask(exactExistingTask.taskId, {
            scheduledTime: exactExistingTask.scheduledTime,
            error: undefined
          });
          this.scheduleTask(exactExistingTask);
        }

        this.logger.info('跳过添加任务：相同延迟回复任务已存在', {
          roomId,
          existingTaskId: exactExistingTask.taskId,
          existingStatus: exactExistingTask.status,
          scheduledTime: exactExistingTask.scheduledTime.toISOString()
        });
        return exactExistingTask.taskId;
      }

      const completedTextTaskAwaitingRecoveredComic = comicImagePath
        ? Array.from(this.tasks.values()).find(task =>
            task.status === 'completed' &&
            this.isSameDelayedReplyTextTask(task, roomId, goodnightTextPath) &&
            !!task.replyId &&
            !!task.repliedDynamicId &&
            !task.supplementalReplyId &&
            !task.supplementalCompletedAt
          )
        : undefined;

      if (completedTextTaskAwaitingRecoveredComic) {
        if (liveContentSummaryPath) {
          await this.registerLiveContentSummaryForTask(
            completedTextTaskAwaitingRecoveredComic,
            liveContentSummaryPath,
            liveContentSummaryDeliveryMode
          );
        }
        completedTextTaskAwaitingRecoveredComic.comicImagePath = comicImagePath;
        completedTextTaskAwaitingRecoveredComic.comicWaitCount = 0;
        completedTextTaskAwaitingRecoveredComic.status = 'waiting_comic';
        completedTextTaskAwaitingRecoveredComic.scheduledTime = now;
        completedTextTaskAwaitingRecoveredComic.error = undefined;
        await this.store.updateTask(completedTextTaskAwaitingRecoveredComic.taskId, {
          comicImagePath,
          comicWaitCount: 0,
          status: 'waiting_comic',
          scheduledTime: now,
          error: undefined
        });
        this.scheduleTask(completedTextTaskAwaitingRecoveredComic);
        this.logger.info('复用已完成的文本回复任务并立即补图', {
          roomId,
          existingTaskId: completedTextTaskAwaitingRecoveredComic.taskId,
          repliedDynamicId: completedTextTaskAwaitingRecoveredComic.repliedDynamicId,
          replyId: completedTextTaskAwaitingRecoveredComic.replyId,
          comicImagePath
        });
        return completedTextTaskAwaitingRecoveredComic.taskId;
      }

      const recentCompletedExactTask = Array.from(this.tasks.values()).find(
        task => this.isSameDelayedReplyTask(task, roomId, goodnightTextPath, comicImagePath) &&
                task.status === 'completed'
      );

      if (recentCompletedExactTask) {
        if (liveContentSummaryPath) {
          await this.registerLiveContentSummaryForTask(
            recentCompletedExactTask,
            liveContentSummaryPath,
            liveContentSummaryDeliveryMode
          );
        }
        this.logger.info('跳过添加任务：相同延迟回复任务已完成', {
          roomId,
          existingTaskId: recentCompletedExactTask.taskId,
          completedTaskCreatedAt: recentCompletedExactTask.createTime.toISOString()
        });
        return recentCompletedExactTask.taskId;
      }

      const existingTask = Array.from(this.tasks.values()).find(
        task => task.roomId === roomId &&
                (
                  task.status === 'pending' ||
                  task.status === 'processing' ||
                  (
                    (
                      task.status === 'waiting_comic' ||
                      task.status === 'waiting_summary' ||
                      task.status === 'waiting_live_content'
                    ) &&
                    path.normalize(task.goodnightTextPath) === path.normalize(goodnightTextPath)
                  )
                )
      );

      if (existingTask) {
        if (existingTask.replyId) {
          this.logger.info('跳过添加任务：房间已有任务发布过主回复，避免重复评论', {
            roomId,
            existingTaskId: existingTask.taskId,
            existingStatus: existingTask.status,
            existingDynamicId: existingTask.repliedDynamicId,
            existingReplyId: existingTask.replyId
          });
          return existingTask.taskId;
        }

        if (
          existingTask.deferredForActiveLive &&
          !this.isSameDelayedReplyTask(existingTask, roomId, goodnightTextPath, comicImagePath)
        ) {
          this.logger.info('Replacing stale delayed reply task that was waiting for the continued live recording', {
            roomId,
            existingTaskId: existingTask.taskId,
            newGoodnightTextPath: goodnightTextPath,
            existingGoodnightTextPath: existingTask.goodnightTextPath
          });
          await this.removeTask(existingTask.taskId);
        } else {
        // 检查是否在30分钟CD内
        const timeSinceCreation = now.getTime() - existingTask.createTime.getTime();
        const cooldownMs = 30 * 60 * 1000; // 30分钟CD

        if (timeSinceCreation < cooldownMs) {
          const remainingMinutes = Math.ceil((cooldownMs - timeSinceCreation) / 60000);
          this.logger.info(`跳过添加任务：房间 ${roomId} 已有待处理任务，CD剩余 ${remainingMinutes} 分钟`, {
            roomId,
            existingTaskId: existingTask.taskId,
            existingStatus: existingTask.status,
            scheduledTime: existingTask.scheduledTime.toISOString()
          });
          return existingTask.taskId;
        }

        // 如果CD已过，删除旧任务
        this.logger.info(`CD已过，删除旧任务: ${existingTask.taskId}`, { roomId });
        await this.removeTask(existingTask.taskId);
        }
      }

      // 计算延迟时间（优先使用传入的 delaySeconds，否则使用配置的 delayMinutes）
      const delayMs = delaySeconds !== undefined
        ? delaySeconds * 1000
        : delayedReplySettings.delayMinutes * 60 * 1000;
      const scheduledTime = new Date(Date.now() + delayMs);

      const task: DelayedReplyTask = {
        taskId: generateUUID(),
        roomId,
        goodnightTextPath,
        comicImagePath,
        createTime: new Date(),
        scheduledTime,
        status: 'pending',
        retryCount: 0,
        liveStartTime,
        liveEndTime,
        checkCount: 0,
        liveContentSummaryPath,
        liveContentSummaryDeliveryMode,
        liveContentSummaryState: liveContentSummaryPath ? 'waiting' : undefined,
        liveContentSummaryRetryCount: 0
      };

      try {
        task.uid = await this.resolveUidForRoom(roomId, task.taskId);
      } catch (error) {
        if (!this.isUidLookupRetriableError(error)) {
          throw error;
        }

        task.error = error instanceof Error ? error.message : String(error);
        this.logger.warn(`UID解析失败，任务将进入队列等待重试: ${task.taskId}`, {
          roomId,
          scheduledTime: scheduledTime.toISOString(),
          error: task.error
        });
      }

      // 保存任务
      this.tasks.set(task.taskId, task);
      await this.store.addTask(task);

      this.logger.info(`添加延迟回复任务: ${task.taskId}`, {
        roomId,
        uid: task.uid,
        scheduledTime: scheduledTime.toISOString(),
        liveStartTime: liveStartTime?.toISOString(),
        liveEndTime: liveEndTime?.toISOString()
      });

      if (!task.uid) {
        this.scheduleTask(task);
        return task.taskId;
      }

      // 🚀 立即检查是否已有符合条件的动态
      this.logger.info(`🔍 [立即检查] 检查是否已有符合条件的晚安动态`, { taskId: task.taskId });
      const immediateTargetDynamic = await this.findTargetDynamic(task);
      
      if (immediateTargetDynamic) {
        this.logger.info(`✅ [立即回复] 发现符合条件的动态，立即执行回复！`, {
          taskId: task.taskId,
          dynamicId: String(immediateTargetDynamic.id),
          publishTime: immediateTargetDynamic.publishTime.toISOString()
        });
        
        // 立即执行回复（不等待延迟时间）
        // 使用 setImmediate 确保异步执行，避免阻塞当前流程
        setImmediate(async () => {
          await this.executeDelayedReply(task);
        });
      } else {
        this.logger.info(`⏰ [延迟回复] 未发现符合条件的动态，将在 ${delayMs / 60000} 分钟后检查`, {
          taskId: task.taskId
        });
        
        // 设置定时器（延迟执行）
        this.scheduleTask(task);
      }

      return task.taskId;
    } catch (error) {
      this.logger.error('添加延迟回复任务失败', { error, roomId });
      
      // 发送企微错误通知
      if (this.notifier) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(roomId);
        const anchorName = anchorConfig?.name || '未知主播';
        await this.notifier.notifyProcessError(
          anchorName,
          '添加延迟回复任务',
          error instanceof Error ? error.message : String(error),
          roomId,
          { goodnightTextPath, comicImagePath, error: error instanceof Error ? error.stack : String(error) }
        );
      }
      
      throw error;
    }
  }

  /**
   * 移除任务
   */
  async removeTask(taskId: string): Promise<void> {
    try {
      // 清除定时器
      const timer = this.timers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(taskId);
      }

      // 删除任务
      this.tasks.delete(taskId);
      this.restoredTaskIds.delete(taskId);
      await this.store.removeTask(taskId);

      this.logger.info(`移除延迟回复任务: ${taskId}`);
    } catch (error) {
      this.logger.error('移除延迟回复任务失败', { error, taskId });
      throw error;
    }
  }

  async publishSummaryForTask(taskId: string): Promise<DelayedReplyTask> {
    if (this.executingTaskIds.has(taskId)) {
      throw new Error(`任务正在执行中，不能重复补发汇总: ${taskId}`);
    }

    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`延迟回复任务不存在: ${taskId}`);
    }
    if (!task.replyId || !task.repliedDynamicId) {
      throw new Error(`延迟回复任务尚未成功发布主回复: ${taskId}`);
    }
    if (task.summaryReplyId || task.summaryCompletedAt) {
      return task;
    }

    this.executingTaskIds.add(taskId);
    this.tasks.set(taskId, task);
    try {
      task.status = 'waiting_summary';
      task.scheduledTime = new Date();
      task.error = undefined;
      await this.store.updateTask(taskId, {
        status: task.status,
        scheduledTime: task.scheduledTime,
        error: undefined
      });
      await this.executeSummaryDynamicReply(task);
      return task;
    } finally {
      this.executingTaskIds.delete(taskId);
    }
  }

  async recoverComicForTask(taskId: string, comicImagePath: string): Promise<DelayedReplyTask> {
    if (this.executingTaskIds.has(taskId)) {
      throw new Error(`任务正在执行中，不能重复补图: ${taskId}`);
    }

    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`延迟回复任务不存在: ${taskId}`);
    }
    if (!task.replyId || !task.repliedDynamicId) {
      throw new Error(`延迟回复任务尚未成功发布主回复: ${taskId}`);
    }
    if (task.supplementalReplyId || task.supplementalCompletedAt) {
      return task;
    }

    const normalizedComicImagePath = path.normalize(comicImagePath);
    if (!fs.existsSync(normalizedComicImagePath)) {
      throw new Error(`补图文件不存在: ${normalizedComicImagePath}`);
    }

    this.executingTaskIds.add(taskId);
    this.tasks.set(taskId, task);
    try {
      task.comicImagePath = normalizedComicImagePath;
      task.comicWaitCount = 0;
      task.retryCount = 0;
      task.status = 'waiting_comic';
      task.scheduledTime = new Date();
      task.error = undefined;
      await this.store.updateTask(taskId, {
        comicImagePath: task.comicImagePath,
        comicWaitCount: task.comicWaitCount,
        retryCount: task.retryCount,
        status: task.status,
        scheduledTime: task.scheduledTime,
        error: undefined
      });
      await this.executeSupplementalComicReply(task);
      return task;
    } finally {
      this.executingTaskIds.delete(taskId);
    }
  }

  async registerLiveContentSummary(
    roomId: string,
    goodnightTextPath: string,
    liveContentSummaryPath: string,
    deliveryMode?: LiveContentSummaryDeliveryMode
  ): Promise<DelayedReplyTask | null> {
    const normalizedTextPath = path.normalize(goodnightTextPath);
    const normalizedSummaryPath = path.normalize(liveContentSummaryPath);
    const resolvedMode = this.resolveLiveContentSummaryDeliveryMode(roomId, deliveryMode);
    let task = Array.from(this.tasks.values())
      .filter(candidate => this.isSameDelayedReplyTextTask(candidate, roomId, normalizedTextPath))
      .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];

    if (!task) {
      const storedTasks = await this.store.getAllTasks();
      task = storedTasks
        .filter(candidate => this.isSameDelayedReplyTextTask(candidate, roomId, normalizedTextPath))
        .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];
      if (task) {
        this.tasks.set(task.taskId, task);
      }
    }

    if (!task) {
      this.logger.warn('未找到可注册直播梗概的延迟回复任务', {
        roomId,
        goodnightTextPath: normalizedTextPath,
        liveContentSummaryPath: normalizedSummaryPath
      });
      return null;
    }

    await this.registerLiveContentSummaryForTask(task, normalizedSummaryPath, resolvedMode);
    return task;
  }

  private async registerLiveContentSummaryForTask(
    task: DelayedReplyTask,
    liveContentSummaryPath: string,
    deliveryMode: LiveContentSummaryDeliveryMode
  ): Promise<void> {
    task.liveContentSummaryPath = path.normalize(liveContentSummaryPath);
    task.liveContentSummaryDeliveryMode = deliveryMode;

    if (!this.isLiveContentSummaryDelivered(task) && task.liveContentSummaryState !== 'publishing') {
      const summary = this.readLiveContentSummary(task);
      task.liveContentSummaryState = summary.kind === 'success'
        ? 'ready'
        : summary.kind === 'failed'
          ? 'failed'
          : 'waiting';
      task.liveContentSummaryError = summary.kind === 'failed' ? summary.error : undefined;
    }

    let shouldSchedule = false;
    if (task.replyId && !this.isLiveContentSummaryDelivered(task)) {
      if (
        task.liveContentSummaryState !== 'failed' &&
        (task.status === 'completed' || task.status === 'failed')
      ) {
        task.status = 'waiting_live_content';
        task.scheduledTime = task.liveContentSummaryState === 'ready'
          ? new Date()
          : new Date(Date.now() + DelayedReplyService.LIVE_CONTENT_WAIT_INTERVAL_MS);
        shouldSchedule = true;
      } else if (
        task.status === 'waiting_comic' &&
        task.liveContentSummaryState === 'ready' &&
        deliveryMode === 'separate'
      ) {
        task.scheduledTime = new Date();
        shouldSchedule = true;
      } else if (
        task.status === 'waiting_live_content' &&
        task.liveContentSummaryState === 'ready'
      ) {
        task.scheduledTime = new Date();
        shouldSchedule = true;
      }
    }

    await this.store.updateTask(task.taskId, {
      liveContentSummaryPath: task.liveContentSummaryPath,
      liveContentSummaryDeliveryMode: task.liveContentSummaryDeliveryMode,
      liveContentSummaryState: task.liveContentSummaryState,
      liveContentSummaryError: task.liveContentSummaryError,
      status: task.status,
      scheduledTime: task.scheduledTime
    });

    if (shouldSchedule) {
      this.scheduleTask(task);
    }
  }

  /**
   * 获取所有任务
   */
  getTasks(): DelayedReplyTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.isRunningFlag;
  }

  private resolveDelayedReplyPaths(
    roomId: string,
    goodnightTextPath: string,
    comicImagePath?: string
  ): { goodnightTextPath: string; comicImagePath?: string } {
    const normalizedTextPath = path.normalize(goodnightTextPath);
    const normalizedComicPath = comicImagePath ? path.normalize(comicImagePath) : comicImagePath;

    if (fs.existsSync(normalizedTextPath)) {
      return {
        goodnightTextPath: normalizedTextPath,
        comicImagePath: normalizedComicPath
      };
    }

    const repairedTextPath = this.findExistingGoodnightPath(roomId, normalizedTextPath);
    if (!repairedTextPath) {
      return {
        goodnightTextPath: normalizedTextPath,
        comicImagePath: normalizedComicPath
      };
    }

    const repairedComicPath = this.deriveComicPathFromGoodnightPath(repairedTextPath);
    const finalComicPath = repairedComicPath || normalizedComicPath;
    this.logger.warn('修复延迟回复路径：传入路径不存在，已按房间/录制时间匹配真实文件', {
      roomId,
      originalGoodnightTextPath: goodnightTextPath,
      repairedGoodnightTextPath: repairedTextPath,
      originalComicImagePath: comicImagePath,
      repairedComicImagePath: finalComicPath
    });

    return {
      goodnightTextPath: repairedTextPath,
      comicImagePath: finalComicPath
    };
  }

  private findExistingGoodnightPath(roomId: string, badTextPath: string): string | undefined {
    const recordingMatch = badTextPath.match(new RegExp(`${this.escapeRegExp(String(roomId))}-(\\d{8})-(\\d{6})-(\\d{3})`));
    if (!recordingMatch) {
      return undefined;
    }

    const [, yyyymmdd, hhmmss, sequence] = recordingMatch;
    const fingerprint = `${roomId}-${yyyymmdd}-${hhmmss}-${sequence}`;
    const dateDirName = `${yyyymmdd.slice(0, 4)}_${yyyymmdd.slice(4, 6)}_${yyyymmdd.slice(6, 8)}`;
    const searchDirs = this.getDelayedReplySearchDirs(roomId, dateDirName, badTextPath);
    const candidates: string[] = [];

    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) {
          continue;
        }

        for (const fileName of fs.readdirSync(dir)) {
          if (fileName.includes(fingerprint) && fileName.endsWith('_晚安回复.md')) {
            candidates.push(path.join(dir, fileName));
          }
        }
      } catch (error) {
        this.logger.warn('扫描晚安回复候选目录失败', {
          roomId,
          dir,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return candidates
      .filter(candidate => fs.existsSync(candidate))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }

  private getDelayedReplySearchDirs(roomId: string, dateDirName: string, badTextPath: string): string[] {
    const dirs = new Set<string>();
    const parsedBadPath = path.parse(badTextPath);
    if (parsedBadPath.dir && fs.existsSync(parsedBadPath.dir)) {
      dirs.add(parsedBadPath.dir);
    }

    for (const basePath of this.getRecordingBasePathCandidates()) {
      try {
        if (!fs.existsSync(basePath)) {
          continue;
        }

        for (const roomDirName of fs.readdirSync(basePath)) {
          if (roomDirName.startsWith(`${roomId}_`)) {
            dirs.add(path.join(basePath, roomDirName, dateDirName));
          }
        }
      } catch (error) {
        this.logger.warn('扫描录播根目录失败', {
          roomId,
          basePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return Array.from(dirs);
  }

  private getRecordingBasePathCandidates(): string[] {
    const candidates = new Set<string>();
    try {
      const configBasePath = ConfigProvider.getConfig().webhook?.endpoints?.mikufans?.basePath;
      if (configBasePath) {
        candidates.add(path.normalize(configBasePath));
      }
    } catch {
      // 配置不可用时继续使用兜底路径
    }

    candidates.add(path.normalize('D:/files/videos/DDTV录播'));
    return Array.from(candidates);
  }

  private deriveComicPathFromGoodnightPath(goodnightTextPath: string): string | undefined {
    const comicPath = goodnightTextPath.replace(/_晚安回复\.md$/u, '_COMIC_FACTORY.png');
    return comicPath !== goodnightTextPath ? comicPath : undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private getTaskDedupeKey(roomId: string, goodnightTextPath: string, comicImagePath?: string): string {
    return [
      String(roomId),
      path.normalize(goodnightTextPath),
      comicImagePath ? path.normalize(comicImagePath) : ''
    ].join('|');
  }

  private getDynamicReplyDedupeKey(roomId: string, dynamicId: string): string {
    return [String(roomId), String(dynamicId)].join('|');
  }

  private isSameDelayedReplyTask(
    task: DelayedReplyTask,
    roomId: string,
    goodnightTextPath: string,
    comicImagePath?: string
  ): boolean {
    return this.getTaskDedupeKey(task.roomId, task.goodnightTextPath, task.comicImagePath) ===
      this.getTaskDedupeKey(roomId, goodnightTextPath, comicImagePath);
  }

  private isSameDelayedReplyTextTask(
    task: DelayedReplyTask,
    roomId: string,
    goodnightTextPath: string
  ): boolean {
    return task.roomId === roomId &&
      path.normalize(task.goodnightTextPath) === path.normalize(goodnightTextPath);
  }

  private getDelayedReplyLimitConfig() {
    const config = BilibiliConfigHelper.getDelayedReplyConfig() as any;
    return {
      maxTaskAgeHours: Number(config.maxTaskAgeHours ?? DelayedReplyService.DEFAULT_MAX_TASK_AGE_HOURS)
    };
  }

  private getTaskAgeMs(task: DelayedReplyTask, now = Date.now()): number {
    const anchorTime = task.liveEndTime || task.createTime;
    return now - anchorTime.getTime();
  }

  private isDelayedReplyTaskExpired(task: DelayedReplyTask, now = Date.now()): boolean {
    const { maxTaskAgeHours } = this.getDelayedReplyLimitConfig();
    return maxTaskAgeHours >= 0 && this.getTaskAgeMs(task, now) > maxTaskAgeHours * 60 * 60 * 1000;
  }

  private isTaskExpiredForCurrentStatus(task: DelayedReplyTask, now = Date.now()): boolean {
    return this.isDelayedReplyTaskExpired(task, now);
  }

  private async suppressStaleTask(task: DelayedReplyTask, reason: string): Promise<void> {
    task.status = 'completed';
    task.error = reason;
    task.completedAt = new Date();
    await this.store.updateTask(task.taskId, {
      status: task.status,
      error: task.error,
      completedAt: task.completedAt
    });
    this.logger.warn(reason, {
      taskId: task.taskId,
      roomId: task.roomId,
      goodnightTextPath: task.goodnightTextPath,
      createTime: task.createTime.toISOString(),
      liveEndTime: task.liveEndTime?.toISOString(),
      comicWaitCount: task.comicWaitCount || 0
    });
  }

  /**
   * 加载已保存的任务
   */
  private async loadTasks(): Promise<void> {
    try {
      const storedTasks = await this.store.getAllTasks();
      const uniqueTasks: DelayedReplyTask[] = [];
      const seenTaskKeys = new Set<string>();

      for (const task of storedTasks) {
        this.tasks.set(task.taskId, task);
        const isPending =
          task.status === 'pending' ||
          task.status === 'waiting_comic' ||
          task.status === 'waiting_summary' ||
          task.status === 'waiting_live_content';
        if (!isPending) {
          continue;
        }

        if (this.isTaskExpiredForCurrentStatus(task)) {
          await this.suppressStaleTask(task, 'stale delayed reply suppressed on service startup');
          continue;
        }

        const resolvedPaths = this.resolveDelayedReplyPaths(task.roomId, task.goodnightTextPath, task.comicImagePath);
        if (resolvedPaths.goodnightTextPath !== task.goodnightTextPath || resolvedPaths.comicImagePath !== task.comicImagePath) {
          task.goodnightTextPath = resolvedPaths.goodnightTextPath;
          task.comicImagePath = resolvedPaths.comicImagePath;
          await this.store.updateTask(task.taskId, {
            goodnightTextPath: task.goodnightTextPath,
            comicImagePath: task.comicImagePath
          });
        }

        const dedupeKey = this.getTaskDedupeKey(task.roomId, task.goodnightTextPath, task.comicImagePath);
        if (seenTaskKeys.has(dedupeKey)) {
          await this.store.updateTask(task.taskId, {
            status: 'failed',
            error: 'duplicate delayed reply task suppressed on service startup'
          });
          this.logger.warn('启动时跳过重复延迟回复任务', {
            taskId: task.taskId,
            roomId: task.roomId,
            goodnightTextPath: task.goodnightTextPath
          });
          continue;
        }

        seenTaskKeys.add(dedupeKey);
        uniqueTasks.push(task);
        this.restoredTaskIds.add(task.taskId);
        this.scheduleTask(task);
      }

      this.logger.info(`加载了 ${uniqueTasks.length} 个待处理任务，并恢复 ${storedTasks.length} 条幂等历史`);
    } catch (error) {
      this.logger.error('加载延迟任务失败', undefined, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 启动定时检查
   */
  private startCheckInterval(): void {
    // 每30秒检查一次
    this.checkInterval = setInterval(() => {
      this.checkDueTasks();
    }, 30000);

    // 每分钟倒计时预告
    this.countdownInterval = setInterval(() => {
      this.logCountdown();
    }, 60000);

    // 立即检查一次
    this.checkDueTasks();
  }

  /**
   * 倒计时预告
   */
  private logCountdown(): void {
    const now = new Date();
    const pendingTasks = Array.from(this.tasks.values()).filter(
      task =>
        task.status === 'pending' ||
        task.status === 'waiting_comic' ||
        task.status === 'waiting_summary' ||
        task.status === 'waiting_live_content'
    );

    if (pendingTasks.length === 0) {
      return;
    }

    this.logger.info(`📊 延迟任务倒计时预告 (${pendingTasks.length} 个待处理任务):`);

    const MAX_CHECK_COUNT = 10; // 最多检查10次
    const CHECK_INTERVAL_MINUTES = 2; // 每2分钟检查一次
    const MAX_WAIT_MINUTES = MAX_CHECK_COUNT * CHECK_INTERVAL_MINUTES; // 最多等待20分钟

    for (const task of pendingTasks) {
      const remainingMs = task.scheduledTime.getTime() - now.getTime();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      if (remainingMinutes > 0) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name || task.roomId;
        
        if (task.status === 'waiting_comic') {
          this.logger.info(
            `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 等待补图，还剩 ${remainingMinutes} 分钟 (已检查 ${task.comicWaitCount || 0} 次)`
          );
        } else if (task.status === 'waiting_summary') {
          this.logger.info(
            `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 等待重试汇总动态回复，还剩 ${remainingMinutes} 分钟`
          );
        } else if (task.status === 'waiting_live_content') {
          this.logger.info(
            `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 等待本场直播梗概，还剩 ${remainingMinutes} 分钟`
          );
        } else {
          const checkCount = task.checkCount || 0;
          const remainingChecks = MAX_CHECK_COUNT - checkCount;
          const maxRemainingMinutes = remainingChecks * CHECK_INTERVAL_MINUTES;

          this.logger.info(
            `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 等待动态，还剩 ${remainingMinutes} 分钟 (已检查 ${checkCount}/${MAX_CHECK_COUNT} 次，最多还等 ${maxRemainingMinutes} 分钟)`
          );
        }
      }
    }
  }

  /**
   * 检查到期的任务
   */
  private async checkDueTasks(): Promise<void> {
    try {
      const now = new Date();
      const dueTasks: DelayedReplyTask[] = [];

      for (const task of this.tasks.values()) {
        if (
          (
            task.status === 'pending' ||
            task.status === 'waiting_comic' ||
            task.status === 'waiting_summary' ||
            task.status === 'waiting_live_content'
          ) &&
          task.scheduledTime <= now
        ) {
          dueTasks.push(task);
        }
      }

      if (dueTasks.length === 0) {
        return;
      }

      this.logger.info(`发现 ${dueTasks.length} 个到期任务`);

      for (const task of dueTasks) {
        await this.executeDelayedReply(task);
      }
    } catch (error) {
      this.logger.error('检查到期任务失败', undefined, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 安排任务
   */
  private scheduleTask(task: DelayedReplyTask): void {
    const existingTimer = this.timers.get(task.taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(task.taskId);
    }

    const now = Date.now();
    const delay = Math.max(0, task.scheduledTime.getTime() - now);

    const timer = setTimeout(async () => {
      await this.executeDelayedReply(task);
    }, delay);

    this.timers.set(task.taskId, timer);
  }

  /**
   * 查找目标动态（智能等待晚安动态）
   * 返回直播结束前30分钟以后发表的新动态
   * 注意：只需要 liveEndTime，不需要 liveStartTime
   */
  private async findTargetDynamic(task: DelayedReplyTask): Promise<BilibiliDynamic | null> {
    try {
      // 如果没有直播结束时间信息，直接返回最新动态（立即回复）
      if (!task.liveEndTime) {
        this.logger.info(`任务 ${task.taskId} 没有直播结束时间信息，直接获取最新动态立即回复。liveEndTime: ${task.liveEndTime}`);
        return await this.getLatestDynamic(task.uid!);
      }

      // 计算目标时间范围：直播结束前30分钟到现在
      let targetStartTime = new Date(task.liveEndTime.getTime() - 30 * 60 * 1000);
      let targetEndTime = new Date();

      // 保护性修正：上游兜底时间可能解析异常，避免未来时间或倒挂时间窗口导致一直查不到。
      if (task.liveEndTime.getTime() > targetEndTime.getTime()) {
        this.logger.warn(
          `直播结束时间晚于当前时间，忽略异常的 liveEndTime: ${task.liveEndTime.toISOString()}`
        );
        targetStartTime = new Date(targetEndTime.getTime() - 30 * 60 * 1000);
      }

      // 如果有liveStartTime，则需要在liveStartTime之后
      if (task.liveStartTime && task.liveStartTime.getTime() <= targetEndTime.getTime()) {
        targetStartTime = new Date(Math.max(targetStartTime.getTime(), task.liveStartTime.getTime()));
      }

      if (targetStartTime.getTime() > targetEndTime.getTime()) {
        this.logger.warn(
          `动态查找时间范围异常，回退到“当前时间前30分钟”窗口: start=${targetStartTime.toISOString()}, end=${targetEndTime.toISOString()}`,
          { taskId: task.taskId }
        );
        targetStartTime = new Date(targetEndTime.getTime() - 30 * 60 * 1000);
      }

      this.logger.info(`查找目标动态: 时间范围 ${targetStartTime.toISOString()} 到 ${targetEndTime.toISOString()}`);

      // 获取所有动态
      const dynamics = await this.bilibiliAPI.getDynamics(task.uid!);
      
      // 筛选符合时间范围的动态
      const targetDynamics = dynamics.filter(d => {
        if (!d) return false;
        const publishTime = d.publishTime;
        return publishTime >= targetStartTime && publishTime <= targetEndTime;
      });

      if (targetDynamics.length > 0) {
        // 返回最新的符合条件的动态
        const targetDynamic = targetDynamics[0];
        this.logger.info(`找到目标动态: ${String(targetDynamic.id)}, 发布时间: ${targetDynamic.publishTime.toISOString()}`);
        return targetDynamic;
      }

      this.logger.info(`未找到符合条件的目标动态`);
      return null;
    } catch (error) {
      if (this.isCredentialError(error)) {
        throw error;
      }
      this.logger.error(`查找目标动态失败: ${error}`, { taskId: task.taskId });
      return null;
    }
  }

  /**
   * 执行延迟回复
   */
  private async getRoomLiveStatusSafely(roomId: string): Promise<RoomLiveStatus | null> {
    if (!this.bilibiliAPI.getRoomLiveStatus) {
      return null;
    }

    try {
      return await this.bilibiliAPI.getRoomLiveStatus(roomId);
    } catch (error) {
      this.logger.warn('Failed to check room live status; continuing delayed reply flow', {
        roomId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private isSameActiveLiveForTask(task: DelayedReplyTask, liveStatus: RoomLiveStatus | null): boolean {
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

  private async deferTaskForActiveLive(task: DelayedReplyTask, liveStatus: RoomLiveStatus): Promise<void> {
    const deferCount = (task.activeLiveDeferCount || 0) + 1;

    if (deferCount > DelayedReplyService.MAX_ACTIVE_LIVE_DEFER_COUNT) {
      // A live status that remains active is not enough evidence to publish a
      // partial recording. Keep the task replaceable until the final merged
      // recording creates its own delayed-reply task.
      const waitCount = task.liveContinuationWaitCount || 0;
      if (waitCount >= DelayedReplyService.LIVE_CONTINUATION_REPLACEMENT_MAX_WAIT_COUNT) {
        task.status = 'failed';
        task.error = 'stale delayed reply suppressed after live continuation; waiting replacement task timed out';
        task.activeLiveDeferCount = deferCount;
        await this.store.updateTask(task.taskId, {
          status: 'failed',
          error: task.error,
          activeLiveDeferCount: deferCount,
          liveContinuationWaitCount: waitCount
        });
        this.logger.warn('Suppressed stale delayed reply after the final recording replacement timed out', {
          taskId: task.taskId,
          roomId: task.roomId,
          activeLiveDeferCount: deferCount,
          liveContinuationWaitCount: waitCount,
          liveStatus: liveStatus.liveStatus,
          liveStartTime: liveStatus.liveStartTime?.toISOString()
        });
        return;
      }

      task.status = 'pending';
      task.scheduledTime = new Date(Date.now() + DelayedReplyService.LIVE_RECHECK_INTERVAL_MS);
      task.deferredForActiveLive = true;
      task.activeLiveDeferCount = deferCount;
      task.liveContinuationWaitCount = waitCount + 1;
      task.lastCheckTime = new Date();
      await this.store.updateTask(task.taskId, {
        status: 'pending',
        scheduledTime: task.scheduledTime,
        deferredForActiveLive: true,
        activeLiveDeferCount: deferCount,
        liveContinuationWaitCount: task.liveContinuationWaitCount,
        lastCheckTime: task.lastCheckTime
      });

      this.logger.warn('Active live defer limit reached; waiting for the final recording task to replace the partial task', {
        taskId: task.taskId,
        roomId: task.roomId,
        activeLiveDeferCount: deferCount,
        liveContinuationWaitCount: task.liveContinuationWaitCount,
        liveStatus: liveStatus.liveStatus,
        liveStartTime: liveStatus.liveStartTime?.toISOString(),
        nextCheckTime: task.scheduledTime.toISOString()
      });
      this.scheduleTask(task);
      return;
    }

    task.status = 'pending';
    task.scheduledTime = new Date(Date.now() + DelayedReplyService.LIVE_RECHECK_INTERVAL_MS);
    task.deferredForActiveLive = true;
    task.activeLiveDeferCount = deferCount;
    task.liveContinuationWaitCount = 0;
    task.lastCheckTime = new Date();

    await this.store.updateTask(task.taskId, {
      status: 'pending',
      scheduledTime: task.scheduledTime,
      deferredForActiveLive: true,
      activeLiveDeferCount: deferCount,
      liveContinuationWaitCount: 0,
      lastCheckTime: task.lastCheckTime
    });

    this.logger.info('Delayed reply task deferred because the same live is still active', {
      taskId: task.taskId,
      roomId: task.roomId,
      liveStatus: liveStatus.liveStatus,
      liveStartTime: liveStatus.liveStartTime?.toISOString(),
      nextCheckTime: task.scheduledTime.toISOString()
    });

    this.scheduleTask(task);
  }

  private async deferTaskWaitingForReplacement(task: DelayedReplyTask): Promise<boolean> {
    if (!task.deferredForActiveLive) {
      return false;
    }

    const waitCount = task.liveContinuationWaitCount || 0;
    if (waitCount >= DelayedReplyService.LIVE_CONTINUATION_REPLACEMENT_MAX_WAIT_COUNT) {
      task.status = 'failed';
      task.error = 'stale delayed reply suppressed after live continuation; waiting replacement task timed out';
      await this.store.updateTask(task.taskId, {
        status: 'failed',
        error: task.error,
        liveContinuationWaitCount: waitCount
      });
      this.logger.warn('Suppressed stale delayed reply task after waiting for final recording replacement', {
        taskId: task.taskId,
        roomId: task.roomId,
        waitCount
      });
      return true;
    }

    task.status = 'pending';
    task.scheduledTime = new Date(Date.now() + DelayedReplyService.LIVE_RECHECK_INTERVAL_MS);
    task.liveContinuationWaitCount = waitCount + 1;
    task.lastCheckTime = new Date();

    await this.store.updateTask(task.taskId, {
      status: 'pending',
      scheduledTime: task.scheduledTime,
      liveContinuationWaitCount: task.liveContinuationWaitCount,
      lastCheckTime: task.lastCheckTime
    });

    this.logger.info('Delayed reply task is waiting for the final recording task to replace it', {
      taskId: task.taskId,
      roomId: task.roomId,
      waitCount: task.liveContinuationWaitCount,
      nextCheckTime: task.scheduledTime.toISOString()
    });

    this.scheduleTask(task);
    return true;
  }

  private async executeDelayedReply(task: DelayedReplyTask): Promise<void> {
    if (this.executingTaskIds.has(task.taskId)) {
      this.logger.warn('Skip duplicate delayed reply execution because task is already running', {
        taskId: task.taskId,
        roomId: task.roomId,
        status: task.status
      });
      return;
    }

    this.executingTaskIds.add(task.taskId);
    try {
      await this.executeDelayedReplyLocked(task);
    } finally {
      this.executingTaskIds.delete(task.taskId);
    }
  }

  private async notifySupplementalComicReplySuccess(
    task: DelayedReplyTask,
    comicImagePath: string,
    result: PublishCommentResponse,
    replyText: string
  ): Promise<void> {
    if (!this.notifier || !task.repliedDynamicId || !task.supplementalReplyId) {
      return;
    }

    const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
    const replyUrl = `https://www.bilibili.com/opus/${task.repliedDynamicId}#reply${task.supplementalReplyId}`;
    const imageGenerationInfo = this.getComicGenerationNotificationInfo(comicImagePath);
    const textGenerationInfo = this.getTextGenerationNotificationInfo(task.goodnightTextPath, comicImagePath);
    const lines = [
      '✅ 补直播图片总结已发送',
      '',
      anchorConfig?.name ? `主播: ${anchorConfig.name}` : undefined,
      `动态ID: ${task.repliedDynamicId}`,
      task.replyId ? `主回复ID: ${task.replyId}` : undefined,
      `补图回复ID: ${task.supplementalReplyId}`,
      `回复内容: ${replyText}`,
      '',
      result.imageUrl ? `[B站附图](${result.imageUrl})` : undefined,
      `[查看补图回复](${replyUrl})`,
      textGenerationInfo ? `\n文本生成:\n${textGenerationInfo}` : undefined,
      imageGenerationInfo ? `\n生图状态:\n${imageGenerationInfo}` : undefined
    ].filter((line): line is string => Boolean(line));

    try {
      const imageSent = await this.notifier.sendImage(comicImagePath);
      if (!imageSent) {
        this.logger.warn('补图回复已发布，但企微图片消息发送失败，将继续发送文字通知', {
          taskId: task.taskId,
          dynamicId: task.repliedDynamicId,
          supplementalReplyId: task.supplementalReplyId,
          comicImagePath
        });
      }
    } catch (notifyImageError) {
      this.logger.warn('补图回复已发布，但企微图片消息发送异常，将继续发送文字通知', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId,
        error: notifyImageError instanceof Error ? notifyImageError.message : String(notifyImageError)
      });
    }

    try {
      const markdownSent = await this.notifier.sendMarkdown(lines.join('\n'));
      if (!markdownSent) {
        this.logger.warn('补图回复已发布，但企微文字通知发送失败；不会重试补图避免重复评论', {
          taskId: task.taskId,
          dynamicId: task.repliedDynamicId,
          supplementalReplyId: task.supplementalReplyId
        });
      }
    } catch (notifyMarkdownError) {
      this.logger.warn('补图回复已发布，但企微文字通知发送异常；不会重试补图避免重复评论', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId,
        error: notifyMarkdownError instanceof Error ? notifyMarkdownError.message : String(notifyMarkdownError)
      });
    }
  }

  private getSummaryLiveTimes(task: DelayedReplyTask): { startTime: Date; endTime: Date } {
    let startTime = task.liveStartTime;
    if (!startTime) {
      const match = path.basename(task.goodnightTextPath).match(/(?:录制-)?\d+-(\d{8})-(\d{6})-\d{3}/u);
      if (match) {
        const date = match[1];
        const time = match[2];
        const parsed = new Date(
          Number(date.slice(0, 4)),
          Number(date.slice(4, 6)) - 1,
          Number(date.slice(6, 8)),
          Number(time.slice(0, 2)),
          Number(time.slice(2, 4)),
          Number(time.slice(4, 6))
        );
        if (!Number.isNaN(parsed.getTime())) {
          startTime = parsed;
        }
      }
    }

    let endTime = task.liveEndTime;
    if (!endTime) {
      try {
        endTime = fs.statSync(task.goodnightTextPath).mtime;
      } catch {
        endTime = undefined;
      }
    }

    startTime = startTime || task.createTime;
    endTime = endTime && endTime.getTime() >= startTime.getTime() ? endTime : startTime;
    return { startTime, endTime };
  }

  private getShanghaiDateParts(value: Date): { month: number; day: number; hour: number } {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(value);
    const getPart = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(part => part.type === type)?.value || 0);

    return {
      month: getPart('month'),
      day: getPart('day'),
      hour: getPart('hour')
    };
  }

  private buildSummaryReplyText(task: DelayedReplyTask, replyText: string): string {
    const anchorName = BilibiliConfigHelper.getAnchorConfig(task.roomId)?.name || task.roomId;
    const { startTime, endTime } = this.getSummaryLiveTimes(task);
    const start = this.getShanghaiDateParts(startTime);
    const end = this.getShanghaiDateParts(endTime);
    const endLabel = start.month === end.month && start.day === end.day
      ? `${end.hour}点`
      : `${end.month}月${end.day}日${end.hour}点`;
    const prefix = `to ${anchorName} ${start.month}月${start.day}日${start.hour}点~${endLabel}的直播。`;
    return `${prefix}\n${replyText}`;
  }

  private resolveLiveContentSummaryDeliveryMode(
    roomId: string,
    requestedMode?: LiveContentSummaryDeliveryMode
  ): LiveContentSummaryDeliveryMode {
    if (requestedMode === 'separate' || requestedMode === 'attach_if_ready') {
      return requestedMode;
    }

    if (String(roomId) === DelayedReplyService.SHIORI_ROOM_ID) {
      return 'attach_if_ready';
    }
    if (String(roomId) === DelayedReplyService.SUI_ROOM_ID) {
      return 'separate';
    }
    return 'separate';
  }

  private isLiveContentSummaryDelivered(task: DelayedReplyTask): boolean {
    return task.liveContentSummaryState === 'attached_main' ||
      task.liveContentSummaryState === 'attached_supplemental' ||
      task.liveContentSummaryState === 'published_separate' ||
      !!task.liveContentSummaryCompletedAt;
  }

  private getLiveContentSummaryTaskUpdates(task: DelayedReplyTask): Partial<DelayedReplyTask> {
    return {
      liveContentSummaryPath: task.liveContentSummaryPath,
      liveContentSummaryDeliveryMode: task.liveContentSummaryDeliveryMode,
      liveContentSummaryState: task.liveContentSummaryState,
      liveContentSummaryReplyId: task.liveContentSummaryReplyId,
      liveContentSummaryAttachedTo: task.liveContentSummaryAttachedTo,
      liveContentSummaryCompletedAt: task.liveContentSummaryCompletedAt,
      liveContentSummaryRetryCount: task.liveContentSummaryRetryCount,
      liveContentSummaryError: task.liveContentSummaryError,
      liveContentSummaryForceSeparate: task.liveContentSummaryForceSeparate,
      liveContentSummaryPublishingAt: task.liveContentSummaryPublishingAt
    };
  }

  private normalizeLiveContentStringList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    return values
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  private buildBoundedLiveContentSummaryText(
    overview: string,
    groups: Array<{ label: string; items: string[] }>
  ): string {
    const prefix = '本场直播内容：';
    const limit = DelayedReplyService.MAX_COMMENT_CHARACTERS;
    let result = prefix;

    if (overview) {
      const remaining = limit - result.length;
      if (overview.length <= remaining) {
        result += overview;
      } else if (remaining > 3) {
        return `${result}${overview.slice(0, remaining - 3)}...`;
      } else {
        return `${result}${overview.slice(0, Math.max(0, remaining))}`;
      }
    }

    for (const group of groups) {
      if (group.items.length === 0 || result.length >= limit) {
        continue;
      }

      const separator = result === prefix ? '' : '；';
      let selectedSegment = '';
      for (let count = 1; count <= group.items.length; count++) {
        const omittedCount = group.items.length - count;
        const omittedSuffix = omittedCount > 0 ? `、等${omittedCount}项` : '';
        const segment = `${group.label}${group.items.slice(0, count).join('、')}${omittedSuffix}`;
        if (`${result}${separator}${segment}`.length > limit) {
          break;
        }
        selectedSegment = segment;
      }

      if (!selectedSegment) {
        const countOnlySegment = `${group.label}共${group.items.length}项`;
        if (`${result}${separator}${countOnlySegment}`.length <= limit) {
          selectedSegment = countOnlySegment;
        }
      }

      if (selectedSegment) {
        result = `${result}${separator}${selectedSegment}`;
      }
    }

    return result;
  }

  private readLiveContentSummary(task: DelayedReplyTask):
    | { kind: 'missing'; error?: string }
    | { kind: 'failed'; error: string }
    | { kind: 'success'; text: string } {
    const summaryPath = task.liveContentSummaryPath;
    if (!summaryPath || !fs.existsSync(summaryPath)) {
      return { kind: 'missing' };
    }

    try {
      const payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
        status?: string;
        error?: unknown;
        content?: {
          overview?: unknown;
          activityTypes?: unknown;
          songs?: unknown;
          games?: unknown;
          topics?: unknown;
        };
      };
      if (payload.status === 'failed') {
        return {
          kind: 'failed',
          error: String(payload.error || '直播梗概生成失败')
        };
      }
      if (payload.status !== 'success') {
        return { kind: 'missing', error: `直播梗概状态尚未完成: ${payload.status || 'unknown'}` };
      }

      const content = payload.content || {};
      const overview = String(content.overview || '').trim();
      const activityTypes = this.normalizeLiveContentStringList(content.activityTypes);
      const songs = this.normalizeLiveContentStringList(content.songs);
      const games = this.normalizeLiveContentStringList(content.games);
      const topics = this.normalizeLiveContentStringList(content.topics);
      const primaryOverview = overview || (activityTypes.length > 0 ? `内容：${activityTypes.join('、')}` : '');
      if (!primaryOverview && songs.length === 0 && games.length === 0 && topics.length === 0) {
        return { kind: 'failed', error: '直播梗概内容为空' };
      }
      return {
        kind: 'success',
        text: this.buildBoundedLiveContentSummaryText(primaryOverview, [
          { label: '歌曲：', items: songs },
          { label: '游戏：', items: games },
          { label: '话题：', items: topics }
        ])
      };
    } catch (error) {
      return {
        kind: 'missing',
        error: `直播梗概 JSON 暂不可读: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private composeReplyWithLiveContentSummary(
    task: DelayedReplyTask,
    replyText: string,
    target: 'main' | 'supplemental'
  ): { text: string; attached: boolean } {
    if (
      !task.liveContentSummaryPath ||
      task.liveContentSummaryDeliveryMode !== 'attach_if_ready' ||
      task.liveContentSummaryForceSeparate ||
      this.isLiveContentSummaryDelivered(task)
    ) {
      return { text: replyText, attached: false };
    }

    const summary = this.readLiveContentSummary(task);
    if (summary.kind === 'failed') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = summary.error;
      return { text: replyText, attached: false };
    }
    if (summary.kind !== 'success') {
      task.liveContentSummaryState = 'waiting';
      task.liveContentSummaryError = summary.error;
      return { text: replyText, attached: false };
    }

    task.liveContentSummaryState = 'ready';
    task.liveContentSummaryError = undefined;
    const combined = `${replyText}\n\n${summary.text}`;
    if (combined.length > DelayedReplyService.MAX_COMMENT_CHARACTERS) {
      task.liveContentSummaryForceSeparate = true;
      this.logger.info('晚安回复拼接直播梗概后超过 B 站评论上限，改为独立发布', {
        taskId: task.taskId,
        roomId: task.roomId,
        target,
        combinedLength: combined.length,
        maxLength: DelayedReplyService.MAX_COMMENT_CHARACTERS
      });
      return { text: replyText, attached: false };
    }

    return { text: combined, attached: true };
  }

  private markLiveContentSummaryAttached(
    task: DelayedReplyTask,
    target: 'main' | 'supplemental',
    replyId: string
  ): void {
    task.liveContentSummaryState = target === 'main' ? 'attached_main' : 'attached_supplemental';
    task.liveContentSummaryAttachedTo = target;
    task.liveContentSummaryReplyId = replyId;
    task.liveContentSummaryCompletedAt = new Date();
    task.liveContentSummaryError = undefined;
    task.liveContentSummaryPublishingAt = undefined;
  }

  private async tryPublishLiveContentSummarySeparately(
    task: DelayedReplyTask
  ): Promise<'done' | 'waiting' | 'retry' | 'failed'> {
    if (!task.liveContentSummaryPath || this.isLiveContentSummaryDelivered(task)) {
      return 'done';
    }
    if (!task.repliedDynamicId || !task.replyId) {
      return 'waiting';
    }
    if (task.liveContentSummaryState === 'publishing') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = '直播梗概发布结果不确定，为避免重启后重复评论，已停止自动重发';
      await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));
      this.logger.warn(task.liveContentSummaryError, {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId
      });
      return 'failed';
    }

    const summary = this.readLiveContentSummary(task);
    if (summary.kind === 'missing') {
      task.liveContentSummaryState = 'waiting';
      task.liveContentSummaryError = summary.error;
      await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));
      return 'waiting';
    }
    if (summary.kind === 'failed') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = summary.error;
      await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));
      this.logger.warn('直播梗概生成失败，不影响晚安回复流程', {
        taskId: task.taskId,
        roomId: task.roomId,
        error: summary.error
      });
      return 'failed';
    }

    task.liveContentSummaryState = 'publishing';
    task.liveContentSummaryPublishingAt = new Date();
    task.liveContentSummaryError = undefined;
    await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));

    try {
      const result = await this.bilibiliAPI.publishComment({
        dynamicId: task.repliedDynamicId,
        content: summary.text
      });
      task.liveContentSummaryState = 'published_separate';
      task.liveContentSummaryAttachedTo = 'separate';
      task.liveContentSummaryReplyId = String(result.replyId);
      task.liveContentSummaryCompletedAt = new Date();
      task.liveContentSummaryPublishingAt = undefined;
      task.liveContentSummaryError = undefined;
      await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));
      this.logger.info('本场直播梗概已单独发布', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId,
        replyId: task.liveContentSummaryReplyId,
        contentLength: summary.text.length
      });
      return 'done';
    } catch (error) {
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isBlacklistError = errorMessage.includes('黑名单') || errorMessage.includes('12035');
      const canRetry =
        !isBlacklistError &&
        !this.isCredentialError(error) &&
        !this.isPermanentReplyError(error) &&
        (task.liveContentSummaryRetryCount || 0) < delayedReplyConfig.maxRetries;

      task.liveContentSummaryPublishingAt = undefined;
      task.liveContentSummaryRetryCount = (task.liveContentSummaryRetryCount || 0) + (canRetry ? 1 : 0);
      task.liveContentSummaryState = canRetry ? 'ready' : 'failed';
      task.liveContentSummaryError = `直播梗概评论发布失败: ${errorMessage}`;
      await this.store.updateTask(task.taskId, this.getLiveContentSummaryTaskUpdates(task));
      this.logger[canRetry ? 'warn' : 'error'](
        canRetry ? '直播梗概评论发布失败，将独立重试' : '直播梗概评论发布最终失败，晚安回复不受影响',
        {
          taskId: task.taskId,
          roomId: task.roomId,
          retryCount: task.liveContentSummaryRetryCount,
          error: errorMessage
        }
      );
      return canRetry ? 'retry' : 'failed';
    }
  }

  private async executeLiveContentSummaryReply(task: DelayedReplyTask): Promise<void> {
    const outcome = await this.tryPublishLiveContentSummarySeparately(task);
    if (outcome === 'waiting' || outcome === 'retry') {
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const waitMs = outcome === 'retry'
        ? delayedReplyConfig.retryDelayMinutes * 60 * 1000
        : DelayedReplyService.LIVE_CONTENT_WAIT_INTERVAL_MS;
      task.status = 'waiting_live_content';
      task.scheduledTime = new Date(Date.now() + waitMs);
      await this.store.updateTask(task.taskId, {
        status: task.status,
        scheduledTime: task.scheduledTime,
        ...this.getLiveContentSummaryTaskUpdates(task)
      });
      this.scheduleTask(task);
      return;
    }

    task.status = 'completed';
    await this.store.updateTask(task.taskId, {
      status: task.status,
      ...this.getLiveContentSummaryTaskUpdates(task)
    });
  }

  private async completeOrWaitForLiveContentSummary(task: DelayedReplyTask): Promise<void> {
    if (!task.liveContentSummaryPath || this.isLiveContentSummaryDelivered(task)) {
      task.status = 'completed';
      await this.store.updateTask(task.taskId, {
        status: task.status,
        summaryReplyId: task.summaryReplyId,
        summaryCompletedAt: task.summaryCompletedAt,
        summaryRetryCount: task.summaryRetryCount,
        error: task.error,
        ...this.getLiveContentSummaryTaskUpdates(task)
      });
      return;
    }

    if (task.liveContentSummaryState === 'publishing') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = '直播梗概发布结果不确定，为避免重复评论，已停止自动重发';
    } else {
      const summary = this.readLiveContentSummary(task);
      task.liveContentSummaryState = summary.kind === 'success'
        ? 'ready'
        : summary.kind === 'failed'
          ? 'failed'
          : 'waiting';
      task.liveContentSummaryError = summary.kind === 'failed' || summary.kind === 'missing'
        ? summary.error
        : undefined;
    }

    if (task.liveContentSummaryState === 'failed') {
      task.status = 'completed';
      await this.store.updateTask(task.taskId, {
        status: task.status,
        summaryReplyId: task.summaryReplyId,
        summaryCompletedAt: task.summaryCompletedAt,
        summaryRetryCount: task.summaryRetryCount,
        error: task.error,
        ...this.getLiveContentSummaryTaskUpdates(task)
      });
      return;
    }

    task.status = 'waiting_live_content';
    task.scheduledTime = task.liveContentSummaryState === 'ready'
      ? new Date()
      : new Date(Date.now() + DelayedReplyService.LIVE_CONTENT_WAIT_INTERVAL_MS);
    await this.store.updateTask(task.taskId, {
      status: task.status,
      scheduledTime: task.scheduledTime,
      summaryReplyId: task.summaryReplyId,
      summaryCompletedAt: task.summaryCompletedAt,
      summaryRetryCount: task.summaryRetryCount,
      error: task.error,
      ...this.getLiveContentSummaryTaskUpdates(task)
    });
    this.scheduleTask(task);
  }

  private async completeWithoutSummaryDynamic(task: DelayedReplyTask): Promise<void> {
    await this.completeOrWaitForLiveContentSummary(task);
  }

  private async executeSummaryDynamicReply(
    task: DelayedReplyTask,
    replyText?: string,
    imagePath?: string
  ): Promise<void> {
    const summarySettings = BilibiliConfigHelper.getSummaryDynamicSettings();
    if (!summarySettings) {
      await this.completeWithoutSummaryDynamic(task);
      return;
    }

    if (task.summaryReplyId || task.summaryCompletedAt) {
      await this.completeWithoutSummaryDynamic(task);
      return;
    }

    const content = this.buildSummaryReplyText(
      task,
      replyText || await this.readReplyText(task.goodnightTextPath)
    );
    const resolvedImagePath = imagePath ||
      (task.comicImagePath && await this.checkFileExists(task.comicImagePath)
        ? task.comicImagePath
        : undefined);

    try {
      const result = await this.bilibiliAPI.publishComment({
        dynamicId: summarySettings.dynamicId,
        content,
        images: resolvedImagePath ? [resolvedImagePath] : undefined
      });

      task.summaryReplyId = String(result.replyId);
      task.summaryCompletedAt = new Date();
      task.error = undefined;
      await this.completeOrWaitForLiveContentSummary(task);
      this.logger.info('晚安回复已发布到汇总动态', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: summarySettings.dynamicId,
        replyId: task.summaryReplyId,
        hasImage: !!resolvedImagePath
      });
    } catch (error) {
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isBlacklistError = errorMessage.includes('黑名单') || errorMessage.includes('12035');
      const isCredentialError = this.isCredentialError(error);
      const canRetry =
        !isBlacklistError &&
        !isCredentialError &&
        !this.isPermanentReplyError(error) &&
        (task.summaryRetryCount || 0) < delayedReplyConfig.maxRetries;

      if (canRetry) {
        task.summaryRetryCount = (task.summaryRetryCount || 0) + 1;
        task.status = 'waiting_summary';
        task.scheduledTime = new Date(
          Date.now() + delayedReplyConfig.retryDelayMinutes * 60 * 1000
        );
        task.error = `汇总动态回复发布失败，等待重试: ${errorMessage}`;
        await this.store.updateTask(task.taskId, {
          status: task.status,
          summaryRetryCount: task.summaryRetryCount,
          scheduledTime: task.scheduledTime,
          error: task.error
        });
        this.scheduleTask(task);
        this.logger.warn('汇总动态回复发布失败，将独立重试', {
          taskId: task.taskId,
          roomId: task.roomId,
          retryCount: task.summaryRetryCount,
          nextRetryTime: task.scheduledTime.toISOString(),
          error: errorMessage
        });
        return;
      }

      task.error = `汇总动态回复发布失败，已停止重试: ${errorMessage}`;
      await this.store.updateTask(task.taskId, {
        summaryRetryCount: task.summaryRetryCount || 0,
        error: task.error
      });
      this.logger.error('汇总动态回复发布最终失败，主人动态下的晚安回复已保留', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: summarySettings.dynamicId
      }, error instanceof Error ? error : new Error(errorMessage));
      await this.completeOrWaitForLiveContentSummary(task);
    }
  }

  private async executeSupplementalComicReply(task: DelayedReplyTask): Promise<void> {
    if (task.supplementalReplyId || task.supplementalCompletedAt) {
      this.logger.info('补图回复已完成，继续确认汇总动态回复', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    if (!task.repliedDynamicId) {
      task.status = 'failed';
      task.error = '补图任务缺少已回复的动态ID';
      await this.store.updateTask(task.taskId, {
        status: task.status,
        error: task.error
      });
      return;
    }

    if (
      task.liveContentSummaryDeliveryMode === 'separate' ||
      task.liveContentSummaryForceSeparate
    ) {
      await this.tryPublishLiveContentSummarySeparately(task);
    }

    if (!task.comicImagePath) {
      task.error = '补图任务没有漫画图片路径';
      await this.store.updateTask(task.taskId, {
        error: task.error
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    const resolvedPaths = this.resolveDelayedReplyPaths(task.roomId, task.goodnightTextPath, task.comicImagePath);
    if (resolvedPaths.goodnightTextPath !== task.goodnightTextPath || resolvedPaths.comicImagePath !== task.comicImagePath) {
      task.goodnightTextPath = resolvedPaths.goodnightTextPath;
      task.comicImagePath = resolvedPaths.comicImagePath;
      await this.store.updateTask(task.taskId, {
        goodnightTextPath: task.goodnightTextPath,
        comicImagePath: task.comicImagePath
      });
    }

    const comicImagePath = task.comicImagePath;
    if (!comicImagePath) {
      task.error = '补图任务路径修复后没有漫画图片路径';
      await this.store.updateTask(task.taskId, {
        error: task.error
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    const hasComicImage = await this.checkFileExists(comicImagePath);
    if (!hasComicImage) {
      task.comicWaitCount = (task.comicWaitCount || 0) + 1;

      if (this.isComicGenerationTerminalFailure(comicImagePath)) {
        await this.notifyComicGenerationFailure(task);
        task.error = '漫画图片生成已失败，补图停止';
        await this.store.updateTask(task.taskId, {
          error: task.error,
          comicWaitCount: task.comicWaitCount
        });
        this.logger.warn('漫画图片生成已失败，停止补图等待', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: task.repliedDynamicId,
          comicImagePath
        });
        await this.executeSummaryDynamicReply(task);
        return;
      }

      if (task.comicWaitCount >= DelayedReplyService.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT) {
        task.error = `补图等待达到上限 (${task.comicWaitCount}/${DelayedReplyService.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT})，停止等待`;
        this.writeComicGenerationFailureMeta(
          comicImagePath,
          task.error,
          task.taskId,
          task.roomId,
          task.repliedDynamicId
        );
        await this.store.updateTask(task.taskId, {
          error: task.error,
          comicWaitCount: task.comicWaitCount
        });
        this.logger.warn('补图等待达到上限，停止等待漫画图片生成', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: task.repliedDynamicId,
          comicImagePath,
          comicWaitCount: task.comicWaitCount,
          maxComicWaitCount: DelayedReplyService.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT
        });
        await this.executeSummaryDynamicReply(task);
        return;
      }

      task.status = 'waiting_comic';
      task.scheduledTime = new Date(Date.now() + DelayedReplyService.COMIC_WAIT_INTERVAL_MS);
      task.error = `等待漫画图片生成后补图 (${task.comicWaitCount})`;
      await this.store.updateTask(task.taskId, {
        status: task.status,
        scheduledTime: task.scheduledTime,
        comicWaitCount: task.comicWaitCount,
        error: task.error
      });
      this.logger.info('补图任务继续等待漫画图片生成', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId,
        comicImagePath,
        nextCheckTime: task.scheduledTime.toISOString()
      });
      this.scheduleTask(task);
      return;
    }

    try {
      const baseReplyText = this.buildSupplementalComicReplyText(await this.readReplyText(task.goodnightTextPath));
      const composition = this.composeReplyWithLiveContentSummary(task, baseReplyText, 'supplemental');
      const replyText = composition.text;
      const result = await this.bilibiliAPI.publishComment({
        dynamicId: task.repliedDynamicId,
        content: replyText,
        images: [comicImagePath]
      });

      task.status = BilibiliConfigHelper.getSummaryDynamicSettings()
        ? 'waiting_summary'
        : 'completed';
      task.supplementalReplyId = String(result.replyId);
      task.supplementalCompletedAt = new Date();
      task.error = undefined;
      if (composition.attached) {
        this.markLiveContentSummaryAttached(task, 'supplemental', task.supplementalReplyId);
      }
      await this.store.updateTask(task.taskId, {
        status: task.status,
        supplementalReplyId: task.supplementalReplyId,
        supplementalCompletedAt: task.supplementalCompletedAt,
        error: undefined,
        ...this.getLiveContentSummaryTaskUpdates(task)
      });

      this.logger.info('补图回复发布成功', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        replyId: task.supplementalReplyId,
        comicImagePath
      });

      if (this.notifier) {
        await this.notifySupplementalComicReplySuccess(task, comicImagePath, result, replyText);
      }

      if (
        !composition.attached &&
        (task.liveContentSummaryDeliveryMode === 'separate' || task.liveContentSummaryForceSeparate)
      ) {
        await this.tryPublishLiveContentSummarySeparately(task);
      }

      await this.executeSummaryDynamicReply(
        task,
        await this.readReplyText(task.goodnightTextPath),
        comicImagePath
      );
    } catch (error) {
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;
      const isBlacklistError = String(error instanceof Error ? error.message : error).includes('黑名单') ||
        String(error instanceof Error ? error.message : error).includes('12035');
      const isCredentialError = this.isCredentialError(error);

      if (!isBlacklistError && !isCredentialError && !this.isPermanentReplyError(error) && task.retryCount < maxRetries) {
        task.retryCount++;
        task.status = 'waiting_comic';
        task.scheduledTime = new Date(Date.now() + delayedReplyConfig.retryDelayMinutes * 60 * 1000);
        task.error = `补图回复发布失败，等待重试: ${error instanceof Error ? error.message : String(error)}`;
        await this.store.updateTask(task.taskId, {
          status: task.status,
          retryCount: task.retryCount,
          scheduledTime: task.scheduledTime,
          error: task.error
        });
        this.scheduleTask(task);
        this.logger.warn('补图回复发布失败，将重试补图', {
          taskId: task.taskId,
          retryCount: task.retryCount,
          maxRetries,
          nextRetryTime: task.scheduledTime.toISOString(),
          error: task.error
        });
        return;
      }

      task.error = `补图回复发布失败，已停止重试: ${error instanceof Error ? error.message : String(error)}`;
      await this.store.updateTask(task.taskId, {
        error: task.error
      });
      this.logger.error('补图回复发布最终失败，主文字回复已保留', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        comicImagePath
      }, error instanceof Error ? error : new Error(String(error)));
      await this.executeSummaryDynamicReply(task, undefined, comicImagePath);
    }
  }

  private async executeDelayedReplyLocked(task: DelayedReplyTask): Promise<void> {
    let publishFailureContext: {
      dynamicId: string;
      replyText?: string;
      imagePath?: string;
    } | null = null;

    try {
      // 清除定时器
      if (
        task.status !== 'pending' &&
        task.status !== 'waiting_comic' &&
        task.status !== 'waiting_summary' &&
        task.status !== 'waiting_live_content'
      ) {
        this.logger.info('Skip delayed reply execution because task is no longer pending', {
          taskId: task.taskId,
          roomId: task.roomId,
          status: task.status
        });
        return;
      }

      const timer = this.timers.get(task.taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(task.taskId);
      }

      if (task.status === 'waiting_comic') {
        if (this.isTaskExpiredForCurrentStatus(task)) {
          await this.suppressStaleTask(task, 'stale delayed reply suppressed before execution');
          return;
        }

        await this.executeSupplementalComicReply(task);
        return;
      }

      if (task.status === 'waiting_summary') {
        if (this.isTaskExpiredForCurrentStatus(task)) {
          await this.suppressStaleTask(task, 'stale summary dynamic reply suppressed before execution');
          return;
        }

        await this.executeSummaryDynamicReply(task);
        return;
      }

      if (task.status === 'waiting_live_content') {
        if (this.isTaskExpiredForCurrentStatus(task)) {
          await this.suppressStaleTask(task, 'stale live content summary reply suppressed before execution');
          return;
        }

        await this.executeLiveContentSummaryReply(task);
        return;
      }

      // 更新任务状态
      const liveStatus = await this.getRoomLiveStatusSafely(task.roomId);
      if (this.isSameActiveLiveForTask(task, liveStatus)) {
        await this.deferTaskForActiveLive(task, liveStatus!);
        return;
      }

      if (await this.deferTaskWaitingForReplacement(task)) {
        return;
      }

      if (this.isTaskExpiredForCurrentStatus(task)) {
        await this.suppressStaleTask(task, 'stale delayed reply suppressed before execution');
        return;
      }

      task.status = 'processing';
      await this.store.updateTask(task.taskId, { status: 'processing' });

      this.logger.info(`执行延迟回复: ${task.taskId}`, {
        roomId: task.roomId,
        uid: task.uid
      });

      const resolvedPaths = this.resolveDelayedReplyPaths(task.roomId, task.goodnightTextPath, task.comicImagePath);
      if (resolvedPaths.goodnightTextPath !== task.goodnightTextPath || resolvedPaths.comicImagePath !== task.comicImagePath) {
        task.goodnightTextPath = resolvedPaths.goodnightTextPath;
        task.comicImagePath = resolvedPaths.comicImagePath;
        await this.store.updateTask(task.taskId, {
          goodnightTextPath: task.goodnightTextPath,
          comicImagePath: task.comicImagePath
        });
      }

      const uid = await this.ensureTaskUid(task);

      // 智能等待晚安动态逻辑
      const MAX_CHECK_COUNT = 10; // 最多检查10次（20分钟）
      const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2分钟检查一次
      
      task.checkCount = task.checkCount || 0;
      
      // 尝试查找目标动态（晚安动态）
      let targetDynamic = await this.findTargetDynamic(task);
      
      // 如果没有找到目标动态且未超过最大检查次数，则继续轮询
      if (!targetDynamic && task.checkCount < MAX_CHECK_COUNT) {
        task.checkCount++;
        task.lastCheckTime = new Date();
        
        this.logger.info(`未找到目标动态，将在2分钟后重新检查 (${task.checkCount}/${MAX_CHECK_COUNT})`, {
          taskId: task.taskId,
          roomId: task.roomId
        });
        
        // 更新任务状态为pending并重新调度
        task.status = 'pending';
        task.scheduledTime = new Date(Date.now() + CHECK_INTERVAL_MS);
        
        await this.store.updateTask(task.taskId, {
          status: 'pending',
          scheduledTime: task.scheduledTime,
          checkCount: task.checkCount,
          lastCheckTime: task.lastCheckTime
        });
        
        // 重新安排任务
        this.scheduleTask(task);
        return;
      }
      
      // 如果找到了目标动态，使用它；否则降级到最新动态
      let finalDynamic: BilibiliDynamic | null = null;
      
      if (targetDynamic) {
        this.logger.info(`✅ 找到目标动态，将回复到晚安动态`, {
          taskId: task.taskId,
          dynamicId: String(targetDynamic.id)
        });
        finalDynamic = targetDynamic;
      } else {
        // 超时或没有直播时间信息，降级到最新动态
        if (task.checkCount >= MAX_CHECK_COUNT) {
          this.logger.warn(`⏰ 已达到最大检查次数，降级到最新动态`, {
            taskId: task.taskId,
            checkCount: task.checkCount
          });
        }
        
        finalDynamic = await this.getLatestDynamic(uid);
        
        if (!finalDynamic) {
          const errorMsg = '未找到最新动态';
          
          // 发送企微错误通知
          if (this.notifier) {
            const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
            const anchorName = anchorConfig?.name || '未知主播';
            await this.notifier.notifyProcessError(
              anchorName,
              '获取最新动态',
              errorMsg,
              task.roomId,
              { uid: task.uid, taskId: task.taskId }
            );
          }
          
          throw new Error(errorMsg);
        }
      }

      // 直接发布评论，而不是通过ReplyManager
      // 读取晚安回复文本
      const baseReplyText = await this.readReplyText(task.goodnightTextPath);
      if (!baseReplyText) {
        const errorMsg = '晚安回复文本为空';
        
        // 发送企微错误通知
        if (this.notifier) {
          const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
          const anchorName = anchorConfig?.name || '未知主播';
          await this.notifier.notifyProcessError(
            anchorName,
            '读取晚安回复文本',
            errorMsg,
            task.roomId,
            { goodnightTextPath: task.goodnightTextPath, taskId: task.taskId }
          );
        }
        
        throw new Error(errorMsg);
      }

      let imagePath: string[] | undefined;
      let shouldWaitForSupplementalComic = false;
      if (task.comicImagePath) {
        const hasComicImage = await this.checkFileExists(task.comicImagePath);
        if (hasComicImage) {
          imagePath = [task.comicImagePath];
        } else if (
          !this.isWithinFirstReplyWave(finalDynamic) &&
          this.shouldWaitForComicImage(task)
        ) {
          task.comicWaitCount = (task.comicWaitCount || 0) + 1;
          task.status = 'pending';
          task.scheduledTime = new Date(
            Date.now() + DelayedReplyService.COMBINED_REPLY_COMIC_WAIT_INTERVAL_MS
          );
          task.error = `等待漫画图片生成 (${task.comicWaitCount}/${DelayedReplyService.MAX_COMIC_WAIT_COUNT})`;

          await this.store.updateTask(task.taskId, {
            status: task.status,
            scheduledTime: task.scheduledTime,
            comicWaitCount: task.comicWaitCount,
            error: task.error
          });

          this.logger.info(`晚安动态已错过第一梯队，等待漫画图片后合并发布`, {
            taskId: task.taskId,
            roomId: task.roomId,
            dynamicId: String(finalDynamic.id),
            dynamicAgeMinutes: Math.max(
              0,
              (Date.now() - finalDynamic.publishTime.getTime()) / 60_000
            ).toFixed(1),
            comicImagePath: task.comicImagePath,
            comicWaitCount: task.comicWaitCount,
            scheduledTime: task.scheduledTime.toISOString()
          });

          this.scheduleTask(task);
          return;
        } else {
          this.logger.warn(`漫画图片仍未生成，将发送纯文字晚安回复`, {
            taskId: task.taskId,
            roomId: task.roomId,
            dynamicId: String(finalDynamic.id),
            withinFirstReplyWave: this.isWithinFirstReplyWave(finalDynamic),
            comicImagePath: task.comicImagePath,
            comicWaitCount: task.comicWaitCount || 0
          });
          const comicGenerationFailed = this.isComicGenerationTerminalFailure(task.comicImagePath);
          if (comicGenerationFailed) {
            await this.notifyComicGenerationFailure(task);
          }
          shouldWaitForSupplementalComic = !comicGenerationFailed;
        }
      }

      const composition = this.composeReplyWithLiveContentSummary(task, baseReplyText, 'main');
      const replyText = composition.text;

      const dynamicReplyDedupeKey = this.getDynamicReplyDedupeKey(task.roomId, String(finalDynamic.id));
      if (this.publishingDynamicReplyKeys.has(dynamicReplyDedupeKey)) {
        task.status = 'pending';
        task.scheduledTime = new Date(Date.now() + 15 * 1000);
        task.error = `同房间动态 ${String(finalDynamic.id)} 正在发布回复，稍后复查避免重复评论`;
        await this.store.updateTask(task.taskId, {
          status: task.status,
          scheduledTime: task.scheduledTime,
          error: task.error
        });
        this.scheduleTask(task);
        this.logger.warn('Skip concurrent delayed reply publish for the same dynamic', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: String(finalDynamic.id),
          nextCheckTime: task.scheduledTime.toISOString()
        });
        return;
      }

      const duplicateReply = this.findRecentCompletedReply(task.roomId, String(finalDynamic.id), task.taskId, task);
      if (duplicateReply) {
        const skippedMessage = `跳过重复延迟回复：房间 ${task.roomId} 最近已回复动态 ${String(finalDynamic.id)}`;
        this.logger.warn(skippedMessage, {
          taskId: task.taskId,
          existingTaskId: duplicateReply.taskId,
          dynamicId: String(finalDynamic.id),
          existingReplyId: duplicateReply.replyId,
          existingCompletedAt: duplicateReply.completedAt?.toISOString()
        });

        if (task.liveContentSummaryPath) {
          await this.registerLiveContentSummaryForTask(
            duplicateReply,
            task.liveContentSummaryPath,
            task.liveContentSummaryDeliveryMode || this.resolveLiveContentSummaryDeliveryMode(task.roomId)
          );
        }
        task.status = 'completed';
        task.error = skippedMessage;
        task.repliedDynamicId = String(finalDynamic.id);
        task.completedAt = new Date();
        await this.store.updateTask(task.taskId, {
          status: 'completed',
          error: skippedMessage,
          repliedDynamicId: task.repliedDynamicId,
          completedAt: task.completedAt
        });
        return;
      }

      // 发布评论
      let result;
      this.publishingDynamicReplyKeys.add(dynamicReplyDedupeKey);
      try {
        result = await this.bilibiliAPI.publishComment({
          dynamicId: finalDynamic.id,
          content: replyText,
          images: imagePath
        });
      } catch (publishError) {
        publishFailureContext = {
          dynamicId: String(finalDynamic.id),
          replyText,
          imagePath: imagePath ? imagePath[0] : undefined
        };
        // 不在这里发送通知，由外部 catch 统一处理
        throw publishError;
      } finally {
        this.publishingDynamicReplyKeys.delete(dynamicReplyDedupeKey);
      }

      this.logger.info(`延迟回复评论发布成功: ${task.taskId}`, {
        dynamicId: String(finalDynamic.id),
        replyId: String(result.replyId)
      });
      // 输出回复链接
      const replyUrl = `https://www.bilibili.com/opus/${String(finalDynamic.id)}#reply${String(result.replyId)}`;
      this.logger.info(`回复链接: ${replyUrl}`);

      task.repliedDynamicId = String(finalDynamic.id);
      task.replyId = String(result.replyId);
      task.completedAt = new Date();
      task.error = undefined;
      if (composition.attached) {
        this.markLiveContentSummaryAttached(task, 'main', task.replyId);
      }

      if (shouldWaitForSupplementalComic) {
        task.comicWaitCount = 0;
        task.status = 'waiting_comic';
        task.scheduledTime = new Date(Date.now() + DelayedReplyService.COMIC_WAIT_INTERVAL_MS);
        task.error = '已发送纯文字晚安回复，等待漫画图片生成后补图';

        await this.store.updateTask(task.taskId, {
          status: task.status,
          repliedDynamicId: task.repliedDynamicId,
          replyId: task.replyId,
          completedAt: task.completedAt,
          scheduledTime: task.scheduledTime,
          comicWaitCount: task.comicWaitCount,
          error: task.error,
          ...this.getLiveContentSummaryTaskUpdates(task)
        });

        this.logger.info('已发送纯文字晚安回复，继续等待漫画图片生成后补图', {
          taskId: task.taskId,
          dynamicId: task.repliedDynamicId,
          replyId: task.replyId,
          comicImagePath: task.comicImagePath,
          nextCheckTime: task.scheduledTime.toISOString()
        });

        this.scheduleTask(task);
      } else {
        const hasPendingLiveContent = !!task.liveContentSummaryPath &&
          !this.isLiveContentSummaryDelivered(task) &&
          task.liveContentSummaryState !== 'failed';
        task.status = BilibiliConfigHelper.getSummaryDynamicSettings()
          ? 'waiting_summary'
          : hasPendingLiveContent
            ? 'waiting_live_content'
            : 'completed';
        await this.store.updateTask(task.taskId, {
          status: task.status,
          repliedDynamicId: task.repliedDynamicId,
          replyId: task.replyId,
          completedAt: task.completedAt,
          error: undefined,
          ...this.getLiveContentSummaryTaskUpdates(task)
        });

        this.logger.info(`延迟回复完成: ${task.taskId}`, {
          dynamicId: String(finalDynamic.id)
        });
      }

      if (
        !composition.attached &&
        (task.liveContentSummaryDeliveryMode === 'separate' || task.liveContentSummaryForceSeparate)
      ) {
        await this.tryPublishLiveContentSummarySeparately(task);
      }

      // B站评论已经成功发布并持久化，通知失败不能触发重试，否则会重复评论。
      if (this.notifier) {
        try {
          const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
          const anchorName = anchorConfig?.name;
          const imageGenerationInfo = this.getComicGenerationNotificationInfo(task.comicImagePath);
          const textGenerationInfo = this.getTextGenerationNotificationInfo(task.goodnightTextPath, task.comicImagePath);
          await this.notifier.notifyReplySuccess(
            String(finalDynamic.id),
            String(result.replyId),
            anchorName,
            replyText,
            result.imageUrl,
            imagePath ? imagePath[0] : undefined,
            imageGenerationInfo,
            textGenerationInfo
          );
        } catch (notifyError) {
          this.logger.warn('动态回复已发布，但成功通知发送异常；不会重试评论避免重复回复', {
            taskId: task.taskId,
            dynamicId: String(finalDynamic.id),
            replyId: String(result.replyId),
            error: notifyError instanceof Error ? notifyError.message : String(notifyError)
          });
        }
      }

      if (shouldWaitForSupplementalComic) {
        return;
      }

      await this.executeSummaryDynamicReply(
        task,
        replyText,
        imagePath ? imagePath[0] : undefined
      );
    } catch (error) {
      this.logger.error(`执行延迟回复失败: ${task.taskId}`, undefined, error instanceof Error ? error : new Error(String(error)));

      // 尝试读取回复文本用于通知
      let replyText: string | undefined;
      try {
        replyText = await this.readReplyText(task.goodnightTextPath);
      } catch {
        // 读取失败时忽略，不影响主流程
      }

      // 更新任务状态
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      await this.store.updateTask(task.taskId, {
        status: 'failed',
        error: task.error
      });

      // 重试逻辑
      const isBlacklistError = task.error?.includes('黑名单') || task.error?.includes('12035');
      const isCredentialError = this.isCredentialError(error);
      if (isBlacklistError) {
        this.logger.warn(`检测到黑名单或禁言错误，不进行重试: ${task.taskId}`, { error: task.error });
      }
      if (isCredentialError) {
        this.logger.warn(`检测到B站Cookie或凭证失效，不进行重试: ${task.taskId}`, { error: task.error });
      }

      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;

      if (!isBlacklistError && !isCredentialError && !this.isPermanentReplyError(error) && task.retryCount < maxRetries) {
        task.retryCount++;
        task.status = 'pending';
        task.error = undefined;

        // 计算重试延迟
        const retryDelayMinutes = delayedReplyConfig.retryDelayMinutes;
        task.scheduledTime = new Date(Date.now() + retryDelayMinutes * 60 * 1000);

        await this.store.updateTask(task.taskId, {
          status: 'pending',
          retryCount: task.retryCount,
          scheduledTime: task.scheduledTime
        });

        // 重新安排任务
        this.scheduleTask(task);

        this.logger.info(`准备重试延迟回复: ${task.taskId} (${task.retryCount}/${maxRetries})`);
        return;
      }

      // 只在最终失败时发送企业微信通知，避免重试过程制造通知风暴。
      if (this.notifier) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name || '未知主播';

        const failureContext = publishFailureContext as {
          dynamicId: string;
          replyText?: string;
          imagePath?: string;
        } | null;

        if (failureContext) {
          const retryInfo = isBlacklistError || isCredentialError || this.isPermanentReplyError(error)
            ? '不会自动重试'
            : `已达到最大重试次数 ${task.retryCount}/${maxRetries}`;
          const errorMessage = `${task.error || '未知错误'}\n\n房间ID: ${task.roomId}\n任务ID: ${task.taskId}\nUID: ${task.uid || '未知'}\n重试状态: ${retryInfo}`;

          await this.notifier.notifyReplyFailure(
            failureContext.dynamicId,
            errorMessage,
            anchorName,
            failureContext.replyText || replyText,
            undefined,
            failureContext.imagePath,
            this.getComicGenerationNotificationInfo(task.comicImagePath),
            this.getTextGenerationNotificationInfo(task.goodnightTextPath, task.comicImagePath)
          );
        } else {
          await this.notifier.notifyProcessError(
            anchorName,
            '延迟回复执行',
            task.error || '未知错误',
            task.roomId,
            {
              taskId: task.taskId,
              uid: task.uid,
              goodnightTextPath: task.goodnightTextPath,
              comicImagePath: task.comicImagePath,
              imageGenerationInfo: this.getComicGenerationNotificationInfo(task.comicImagePath),
              replyText,
              error: error instanceof Error ? error.stack : String(error)
            }
          );
        }
      }
    }
  }

  /**
   * 查找近期已发布主回复的同房间任务，避免多段/续播任务重复回复同一条动态。
   */
  private findRecentCompletedReply(
    roomId: string,
    dynamicId: string,
    currentTaskId: string,
    currentTask?: DelayedReplyTask
  ): DelayedReplyTask | null {
    const now = Date.now();
    const recentReplyWindowMs = 2 * 60 * 60 * 1000;
    const effectiveCurrentTask = currentTask || this.tasks.get(currentTaskId);

    const repliedTasks = Array.from(this.tasks.values())
      .filter(task =>
        task.taskId !== currentTaskId &&
        task.roomId === roomId &&
        !!task.replyId &&
        (!effectiveCurrentTask || !this.isNewerRecordingTask(effectiveCurrentTask, task))
      )
      .sort((a, b) => this.getTaskCompletionTime(b).getTime() - this.getTaskCompletionTime(a).getTime());

    const sameDynamicTask = repliedTasks.find(task =>
      task.repliedDynamicId === dynamicId &&
      now - this.getTaskCompletionTime(task).getTime() < recentReplyWindowMs
    );
    if (sameDynamicTask) {
      return sameDynamicTask;
    }

    return repliedTasks.find(task =>
      now - this.getTaskCompletionTime(task).getTime() < recentReplyWindowMs
    ) || null;
  }

  /**
   * A later final recording can legitimately target the same dynamic as an
   * earlier partial recording. The later live end time identifies that case.
   */
  private isNewerRecordingTask(currentTask: DelayedReplyTask, previousTask: DelayedReplyTask): boolean {
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

  private getTaskCompletionTime(task: DelayedReplyTask): Date {
    return task.completedAt || task.scheduledTime || task.createTime;
  }

  /**
   * 读取晚安回复文本
   */
  private async readReplyText(textPath: string): Promise<string> {
    try {
      this.logger.debug('开始读取晚安回复文本', { textPath });
      
      if (!fs.existsSync(textPath)) {
        const errorMsg = `晚安回复文件不存在: ${textPath}`;
        this.logger.error(errorMsg, { textPath, exists: false });
        throw new Error(errorMsg);
      }

      this.logger.debug('文件存在，开始读取内容', { textPath });
      
      const content = fs.readFileSync(textPath, 'utf8');
      this.logger.debug('文件读取成功', { textPath, contentLength: content.length });
      
      // 仅在文件开头存在 front matter 时才跳过元数据，避免正文中的 `---` 被误判。
      const lines = content.split('\n');
      const firstNonEmptyIndex = lines.findIndex(line => line.trim().length > 0);
      
      if (firstNonEmptyIndex >= 0 && lines[firstNonEmptyIndex].trim() === '---') {
        const endIndex = lines.findIndex(
          (line, index) => index > firstNonEmptyIndex && line.trim() === '---'
        );

        if (endIndex > firstNonEmptyIndex) {
          const result = this.sanitizeReplyText(lines.slice(endIndex + 1).join('\n'));
          this.assertReplyTextIsPublishable(result, textPath);
          this.logger.debug('提取正文成功（跳过 front matter 元数据）', { textPath, resultLength: result.length });
          return result;
        }
      }

      const result = this.sanitizeReplyText(content);
      this.assertReplyTextIsPublishable(result, textPath);
      this.logger.debug('提取正文成功（无元数据）', { textPath, resultLength: result.length });
      return result;
    } catch (error) {
      const errorInfo = {
        textPath,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : String(error)
      };
      this.logger.error('读取晚安回复文本失败', errorInfo);
      throw error;
    }
  }

  private sanitizeReplyText(text: string): string {
    return text
      .trim()
      .replace(/^\s*>+\s*(?:🔍\s*)?$/gmu, '')
      .replace(/^\s*>+\s*/gmu, '')
      .replace(/^\s*🔍\s*\*\*[^*\r\n]{2,30}\*\*/gmu, '')
      .replace(/^\s*🔍\s*/gmu, '')
      .replace(/\*\*([^*\r\n]+)\*\*/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
      .replace(/^\s*[（(]\s*共\s*\d+\s*字\s*[）)]\s*$/gmu, '')
      .replace(/[（(]\s*共\s*\d+\s*字\s*[）)]\s*$/u, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private buildSupplementalComicReplyText(replyText: string): string {
    return `${DelayedReplyService.SUPPLEMENTAL_COMIC_REPLY_PREFIX}${replyText}`;
  }

  private assertReplyTextIsPublishable(text: string, textPath: string): void {
    const suspiciousPatterns = [
      /word\s*count\s*check/i,
      /(?:[\p{Script=Han}A-Za-z0-9！!？?。，、：；:;,.~～🌙☀️]\(\d+\)\s*){2,}/u,
      /字数\s*(?:检查|统计|校验)/u
    ];

    if (suspiciousPatterns.some(pattern => pattern.test(text))) {
      throw new Error(`晚安回复疑似模型调试/字数校验输出，拒绝发布: ${textPath}`);
    }
  }

  private getTextGenerationNotificationInfo(goodnightTextPath: string, comicImagePath?: string): string | undefined {
    const goodnightInfo = this.getGoodnightTextGenerationInfo(goodnightTextPath);
    const comicScriptInfo = this.getComicScriptGenerationInfo(comicImagePath);

    return [
      this.getAsrNotificationInfo(goodnightTextPath),
      goodnightInfo ? `晚安文本: ${goodnightInfo}` : undefined,
      comicScriptInfo ? `漫画脚本文本: ${comicScriptInfo}` : undefined
    ].filter(Boolean).join('\n') || undefined;
  }

  private getAsrNotificationInfo(goodnightTextPath: string): string | undefined {
    try {
      const asrMetaPath = goodnightTextPath.replace(/_晚安回复\.md$/u, '.asr_meta.json');
      if (!fs.existsSync(asrMetaPath)) {
        return undefined;
      }
      const meta = JSON.parse(fs.readFileSync(asrMetaPath, 'utf8'));
      const backend = meta.backend || 'unknown';
      const profile = meta.modelProfile || 'default';
      const elapsed = Number(meta.elapsedSeconds || 0);
      const duration = Number(meta.mediaDurationSeconds || 0);
      const speed = elapsed > 0 && duration > 0 ? (duration / elapsed) : null;
      const modelLabel = profile === 'finetuned'
        ? `微调(${path.basename(String(meta.finetunedModel || meta.model || 'unknown'))})`
        : `原版(${meta.model || 'paraformer-zh'})`;
      return [
        `ASR: ${backend} / ${modelLabel}`,
        elapsed > 0 ? `耗时: ${elapsed.toFixed(1)}s` : undefined,
        speed ? `速度: ${speed.toFixed(2)}x` : undefined,
        meta.realtimeFactor !== null && meta.realtimeFactor !== undefined ? `RTF: ${Number(meta.realtimeFactor).toFixed(3)}` : undefined,
        this.getSpeakerProcessingNotificationInfo(meta.speakerProcessing)
      ].filter(Boolean).join('，');
    } catch (error) {
      this.logger.warn('读取 ASR 元数据失败', {
        goodnightTextPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return 'ASR: 元数据读取失败';
    }
  }

  private getSpeakerProcessingNotificationInfo(speakerProcessing: any): string | undefined {
    if (!speakerProcessing || typeof speakerProcessing !== 'object') {
      return undefined;
    }

    const rawStatus = speakerProcessing.status !== null && speakerProcessing.status !== undefined
      ? String(speakerProcessing.status)
      : '';
    const status = rawStatus.trim().toLowerCase();
    const decision = speakerProcessing.decision !== null && speakerProcessing.decision !== undefined
      ? String(speakerProcessing.decision)
      : '';
    const normalizedDecision = decision.trim().toLowerCase();
    const mode = speakerProcessing.mode !== null && speakerProcessing.mode !== undefined
      ? String(speakerProcessing.mode)
      : '';
    const reason = speakerProcessing.reason !== null && speakerProcessing.reason !== undefined
      ? String(speakerProcessing.reason)
      : '';
    const rawStrategy = speakerProcessing.fullClusteringStrategy
      ?? speakerProcessing.full_clustering_strategy;
    const strategy = rawStrategy === 'probe_centroid_assignment'
      ? '探测簇中心分配'
      : rawStrategy === 'full_clustering_fallback'
        ? '全量聚类回退'
        : rawStrategy === 'full_clustering'
          ? '全量聚类'
          : undefined;
    const fullRunValue = speakerProcessing.fullRun ?? speakerProcessing.full_run;

    if (status === 'disabled' || normalizedDecision === 'disabled' || mode === 'disabled') {
      return undefined;
    }

    let statusLabel: string;
    if (status.includes('fail') || status.includes('error')) {
      statusLabel = '处理失败（ASR 已保留）';
    } else if (fullRunValue === true) {
      statusLabel = '已完整处理';
    } else if (
      fullRunValue === false ||
      status.includes('skip') ||
      normalizedDecision.includes('single')
    ) {
      statusLabel = '抽样判定单人，已跳过全量';
    } else if (
      status === 'completed' ||
      status === 'complete' ||
      status === 'success' ||
      normalizedDecision.includes('multi') ||
      normalizedDecision.includes('multiple')
    ) {
      statusLabel = '已完整处理';
    } else {
      statusLabel = rawStatus ? `状态: ${rawStatus}` : '状态未知';
    }

    const context = [
      mode ? `模式: ${mode}` : undefined,
      decision ? `判定: ${decision}` : undefined,
      reason ? `原因: ${reason}` : undefined,
      strategy ? `策略: ${strategy}` : undefined
    ].filter(Boolean).join('，');

    const sampleParts = [
      this.formatSpeakerCount(
        speakerProcessing.sampledChunks ?? speakerProcessing.sampled_chunks,
        '段'
      ),
      this.formatSpeakerCount(
        speakerProcessing.validChunks ?? speakerProcessing.valid_chunks,
        '段有效'
      ),
      this.formatSpeakerCount(
        speakerProcessing.detectedClusters ?? speakerProcessing.detected_clusters,
        '个检测簇'
      ),
      this.formatSpeakerCount(
        speakerProcessing.supportedClusters ?? speakerProcessing.supported_clusters,
        '个支持簇'
      ),
      this.formatSpeakerSeconds(
        speakerProcessing.sampledSpeechSeconds ??
          speakerProcessing.sampled_speech_seconds ??
          speakerProcessing.sampled_speech_s,
        '语音'
      )
    ].filter(Boolean);

    const timingInfo = this.getSpeakerTimingNotificationInfo(speakerProcessing.timings);
    return [
      `说话人: ${statusLabel}${context ? `（${context}）` : ''}`,
      sampleParts.length > 0 ? `抽样: ${sampleParts.join('/')}` : undefined,
      timingInfo
    ].filter(Boolean).join('；');
  }

  private getSpeakerTimingNotificationInfo(timings: any): string | undefined {
    if (!timings || typeof timings !== 'object') {
      return undefined;
    }

    const probeEmbedding = this.getFirstFiniteNumber(timings.probeEmbedding, timings.probe_embedding_s);
    const probeClustering = this.getFirstFiniteNumber(timings.probeClustering, timings.probe_clustering_s);
    const probeParts = [probeEmbedding, probeClustering].filter((value): value is number => value !== undefined);
    const probe = probeParts.length > 0
      ? probeParts.reduce((sum, value) => sum + value, 0)
      : undefined;
    const full = this.getFirstFiniteNumber(timings.fullEmbedding, timings.full_embedding_s);
    const clustering = this.getFirstFiniteNumber(timings.fullClustering, timings.full_clustering_s);
    const reference = this.getFirstFiniteNumber(timings.reference, timings.referenceEmbedding, timings.reference_embedding_s);
    const matching = this.getFirstFiniteNumber(timings.matching, timings.speakerMatching, timings.reference_matching_s);
    const total = this.getFirstFiniteNumber(timings.total, timings.total_s);

    const parts = [
      this.formatSpeakerTiming(probe, '探测'),
      this.formatSpeakerTiming(full, '全量'),
      this.formatSpeakerTiming(clustering, '聚类'),
      this.formatSpeakerTiming(reference, '参考'),
      this.formatSpeakerTiming(matching, '匹配'),
      this.formatSpeakerTiming(total, '总计')
    ].filter(Boolean);

    return parts.length > 0 ? `说话人耗时: ${parts.join(' / ')}` : undefined;
  }

  private getFirstFiniteNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      const number = this.getFiniteNumber(value);
      if (number !== undefined) {
        return number;
      }
    }
    return undefined;
  }

  private getFiniteNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') {
      return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private formatSpeakerCount(value: unknown, suffix: string): string | undefined {
    const number = Array.isArray(value) ? value.length : this.getFiniteNumber(value);
    return number !== undefined ? `${number}${suffix}` : undefined;
  }

  private formatSpeakerSeconds(value: unknown, label: string): string | undefined {
    const seconds = this.getFiniteNumber(value);
    return seconds !== undefined ? `${seconds.toFixed(1)}s${label}` : undefined;
  }

  private formatSpeakerTiming(value: number | undefined, label: string): string | undefined {
    return value !== undefined ? `${label} ${value.toFixed(1)}s` : undefined;
  }

  private getGoodnightTextGenerationInfo(textPath: string): string | undefined {
    try {
      if (!fs.existsSync(textPath)) {
        return undefined;
      }

      const content = fs.readFileSync(textPath, 'utf8');
      const frontMatter = this.parseFrontMatter(content);
      if (!frontMatter) {
        return '模型: 未知（无元数据）';
      }

      const provider = frontMatter.provider || '未知服务';
      const model = frontMatter.model || '未知模型';
      const fallback = frontMatter.fallback === 'true' ? '，fallback: 是' : '';
      const promptTokens = this.getFiniteNumber(frontMatter.promptTokens);
      const cachedTokens = this.getFiniteNumber(frontMatter.cachedTokens);
      const cacheWriteTokens = this.getFiniteNumber(frontMatter.cacheWriteTokens);
      const cacheInfo = promptTokens !== undefined
        ? cachedTokens !== undefined
          ? `，输入缓存: ${cachedTokens}/${promptTokens} tokens${cacheWriteTokens !== undefined ? `，缓存写入: ${cacheWriteTokens} tokens` : ''}`
          : `，输入: ${promptTokens} tokens（缓存命中量未报告）`
        : '';
      return `模型: ${model}，服务: ${provider}${fallback}${cacheInfo}`;
    } catch (error) {
      this.logger.warn('读取晚安文本生成元数据失败', {
        textPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return '模型: 未知（元数据读取失败）';
    }
  }

  private getComicScriptGenerationInfo(comicImagePath?: string): string | undefined {
    if (!comicImagePath) {
      return undefined;
    }

    const parsedPath = path.parse(comicImagePath);
    const scriptBaseName = parsedPath.name.replace(/_COMIC_FACTORY$/i, '_COMIC_SCRIPT');
    const scriptPath = path.join(parsedPath.dir, `${scriptBaseName}.txt`);
    const metaPath = path.join(parsedPath.dir, `${scriptBaseName}_META.json`);

    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const provider = meta.provider || '未知服务';
        const model = meta.model || '未知模型';
        const fallback = meta.fallback ? '，fallback: 是' : '';
        const reason = meta.reason ? `，原因: ${String(meta.reason).slice(0, 200)}` : '';
        const status = meta.status === 'success' ? '成功' : meta.status === 'failure' ? '失败' : String(meta.status || '未知');
        const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
        const successfulAttempt = attempts.find((attempt: any) => attempt?.status === 'success');
        const promptTokens = this.getFiniteNumber(successfulAttempt?.promptTokens);
        const cachedTokens = this.getFiniteNumber(successfulAttempt?.cachedTokens);
        const cacheWriteTokens = this.getFiniteNumber(successfulAttempt?.cacheWriteTokens);
        const cacheInfo = promptTokens !== undefined
          ? cachedTokens !== undefined
            ? `，输入缓存: ${cachedTokens}/${promptTokens} tokens${cacheWriteTokens !== undefined ? `，缓存写入: ${cacheWriteTokens} tokens` : ''}`
            : `，输入: ${promptTokens} tokens（缓存命中量未报告）`
          : '';
        return `模型: ${model}，服务: ${provider}，状态: ${status}${fallback}${cacheInfo}${reason}`;
      }

      if (fs.existsSync(scriptPath)) {
        return '模型: 未知（旧脚本未记录元数据）';
      }

      return '模型: 未知（未找到漫画脚本）';
    } catch (error) {
      this.logger.warn('读取漫画脚本文本生成元数据失败', {
        comicImagePath,
        metaPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return '模型: 未知（元数据读取失败）';
    }
  }

  private parseFrontMatter(content: string): Record<string, string> | null {
    const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      return null;
    }

    const result: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (!item) {
        continue;
      }
      result[item[1]] = item[2].replace(/^"|"$/g, '');
    }

    return result;
  }

  private getComicGenerationNotificationInfo(comicImagePath?: string): string | undefined {
    if (!comicImagePath) {
      return undefined;
    }

    const parsedPath = path.parse(comicImagePath);
    const metaCandidates = [
      path.join(parsedPath.dir, `${parsedPath.name}_META.json`),
      path.join(parsedPath.dir, `${parsedPath.name.replace(/_COMIC_FACTORY$/i, '')}_COMIC_FACTORY_META.json`)
    ];

    const metaPath = metaCandidates.find(candidate => fs.existsSync(candidate));
    if (!metaPath) {
      const modeInfo = '漫画模式: 未记录（无法判定新版/旧版）';
      const imageInfo = fs.existsSync(comicImagePath)
        ? '图片已生成，未找到生图元数据'
        : '图片未生成，未找到生图失败元数据';
      return `${modeInfo}\n${imageInfo}`;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const modeInfo = this.formatComicStorytellingMode(meta);
      const status = meta.status === 'success' ? '成功' : meta.status === 'failure' ? '失败' : String(meta.status || '未知');
      const routeAttempts = Array.isArray(meta.routeAttempts) ? meta.routeAttempts : [];
      const successfulRoute = routeAttempts.find((attempt: any) => attempt?.status === 'success');
      const provider = meta.provider || successfulRoute?.provider || '未知服务';
      const model = meta.model || successfulRoute?.model || '未知模型';
      const endpoint = meta.endpoint || '未知接口';
      const reason = meta.reason ? String(meta.reason) : '';
      const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
      const successfulAttempt = attempts.find((attempt: any) => attempt?.status === 'success');
      const usage = meta.usage || successfulAttempt?.usage || {};
      const usageDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
      const inputTokens = this.getFirstFiniteNumber(usage.input_tokens, usage.prompt_tokens);
      const outputTokens = this.getFirstFiniteNumber(usage.output_tokens, usage.completion_tokens);
      const imageInputTokens = this.getFiniteNumber(usageDetails.image_tokens);
      const textInputTokens = this.getFiniteNumber(usageDetails.text_tokens);
      const usageInfo = inputTokens !== undefined || outputTokens !== undefined
        ? [
            inputTokens !== undefined ? `输入 ${inputTokens}` : undefined,
            imageInputTokens !== undefined ? `图片 ${imageInputTokens}` : undefined,
            textInputTokens !== undefined ? `文字 ${textInputTokens}` : undefined,
            outputTokens !== undefined ? `输出 ${outputTokens}` : undefined
          ].filter(Boolean).join('，') + ' tokens'
        : undefined;
      const combinedAttempts = routeAttempts.length > 0 ? routeAttempts : attempts;
      const formatRoute = (routeProvider: string, routeModel: string, routeEndpoint: string) =>
        `${routeProvider}/${routeModel}${routeEndpoint !== '未知接口' && routeEndpoint !== 'unknown' ? ` (${routeEndpoint})` : ''}`;
      const lastAttempts = combinedAttempts.slice(-3).map((attempt: any) => {
        const attemptProvider = attempt?.provider || provider || '未知服务';
        const attemptModel = attempt?.model || '未知模型';
        const attemptEndpoint = attempt?.endpoint || '未知接口';
        const attemptStatus = attempt?.status || 'unknown';
        const attemptReason = attempt?.reason ? `: ${String(attempt.reason).slice(0, 120)}` : '';
        return `- ${formatRoute(attemptProvider, attemptModel, attemptEndpoint)} / ${attemptStatus}${attemptReason}`;
      });
      const summary = `${formatRoute(provider, model, endpoint)}: ${status}`;

      return [
        modeInfo,
        `模型: ${summary}`,
        usageInfo ? `用量: ${usageInfo}` : undefined,
        reason ? `原因: ${reason}` : undefined,
        lastAttempts.length > 1 || status !== '成功' ? `尝试:\n${lastAttempts.join('\n')}` : undefined
      ].filter(Boolean).join('\n');
    } catch (error) {
      this.logger.warn('读取生图元数据失败', {
        comicImagePath,
        metaPath,
        error: error instanceof Error ? error.message : String(error)
      });
      const modeInfo = '漫画模式: 未知（生图元数据读取失败）';
      const imageInfo = fs.existsSync(comicImagePath)
        ? '图片已生成，但生图元数据读取失败'
        : '图片未生成，且生图元数据读取失败';
      return `${modeInfo}\n${imageInfo}`;
    }
  }

  private formatComicStorytellingMode(meta: any): string {
    const variant = String(meta?.storytellingVariant || '').trim();
    const mode = variant === 'immersive_v1'
      ? '新版沉浸式（灰度组 immersive_v1）'
      : variant === 'control'
        ? '旧版对照组（control）'
        : variant
          ? `未知变体（${variant}）`
          : '未记录（无法判定新版/旧版）';
    const reasonLabels: Record<string, string> = {
      forced: '强制指定',
      'stable-rollout': '稳定灰度',
      'experiment-disabled': '实验关闭'
    };
    const assignmentReason = String(meta?.storytellingAssignmentReason || '').trim();
    const assignment = reasonLabels[assignmentReason] || assignmentReason;
    const rollout = this.getFiniteNumber(meta?.storytellingImmersivePercent);
    const bucket = this.getFiniteNumber(meta?.storytellingBucket);
    const details = [
      assignment ? `分配: ${assignment}` : undefined,
      rollout !== undefined ? `新版比例: ${rollout}%` : undefined,
      bucket !== undefined ? `桶: ${(bucket / 100).toFixed(2)}` : undefined
    ].filter(Boolean);

    return `漫画模式: ${mode}${details.length > 0 ? `；${details.join('；')}` : ''}`;
  }

  /**
   * 生图已经明确失败时单独告警。成功回复通知里的“生图状态”只是附带信息，
   * 容易被“回复成功”掩盖；这里确保原因会以失败告警的形式送达企微。
   */
  private async notifyComicGenerationFailure(task: DelayedReplyTask): Promise<void> {
    if (!this.notifier || task.comicGenerationFailureNotifiedAt) {
      return;
    }

    const anchorName = BilibiliConfigHelper.getAnchorConfig(task.roomId)?.name || '未知主播';
    const imageGenerationInfo = this.getComicGenerationNotificationInfo(task.comicImagePath)
      || '图片未生成，未找到生图失败元数据';
    const comicScriptGenerationInfo = this.getComicScriptGenerationInfo(task.comicImagePath)
      || '模型: 未知（未找到漫画脚本元数据）';

    try {
      const notified = await this.notifier.notifyProcessError(
        anchorName,
        '异步漫画生图',
        '图片生成失败，本次晚安将仅发送文字回复',
        task.roomId,
        {
          taskId: task.taskId,
          comicImagePath: task.comicImagePath,
          comicScriptGenerationInfo,
          imageGenerationInfo
        }
      );

      if (!notified) {
        this.logger.warn('漫画生图失败企微通知发送失败，将保留未通知状态', {
          taskId: task.taskId,
          roomId: task.roomId
        });
        return;
      }

      task.comicGenerationFailureNotifiedAt = new Date();
      await this.store.updateTask(task.taskId, {
        comicGenerationFailureNotifiedAt: task.comicGenerationFailureNotifiedAt
      });
    } catch (error) {
      // 通知异常不能阻断正常的纯文字晚安回复。
      this.logger.warn('发送漫画生图失败企微通知异常', {
        taskId: task.taskId,
        roomId: task.roomId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private shouldWaitForComicImage(task: DelayedReplyTask): boolean {
    if (!task.comicImagePath) {
      return false;
    }

    const waitCount = task.comicWaitCount || 0;
    if (waitCount >= DelayedReplyService.MAX_COMIC_WAIT_COUNT) {
      return false;
    }

    const parsedPath = path.parse(task.comicImagePath);
    const metaCandidates = [
      path.join(parsedPath.dir, `${parsedPath.name}_META.json`),
      path.join(parsedPath.dir, `${parsedPath.name.replace(/_COMIC_FACTORY$/i, '')}_COMIC_FACTORY_META.json`)
    ];
    const metaPath = metaCandidates.find(candidate => fs.existsSync(candidate));
    if (!metaPath) {
      return true;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return meta?.status !== 'success' && meta?.status !== 'failure';
    } catch {
      return true;
    }
  }

  private isWithinFirstReplyWave(dynamic: BilibiliDynamic, now = Date.now()): boolean {
    const dynamicAgeMs = Math.max(0, now - dynamic.publishTime.getTime());
    return dynamicAgeMs <= DelayedReplyService.FIRST_REPLY_WAVE_WINDOW_MS;
  }

  private isComicGenerationTerminalFailure(comicImagePath?: string): boolean {
    if (!comicImagePath || fs.existsSync(comicImagePath)) {
      return false;
    }

    const parsedPath = path.parse(comicImagePath);
    const metaCandidates = [
      path.join(parsedPath.dir, `${parsedPath.name}_META.json`),
      path.join(parsedPath.dir, `${parsedPath.name.replace(/_COMIC_FACTORY$/i, '')}_COMIC_FACTORY_META.json`)
    ];
    const metaPath = metaCandidates.find(candidate => fs.existsSync(candidate));
    if (!metaPath) {
      return false;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return meta?.status === 'failure';
    } catch {
      return false;
    }
  }

  /**
   * 检查文件是否存在
   */
  private writeComicGenerationFailureMeta(
    comicImagePath: string,
    reason: string,
    taskId: string,
    roomId: string,
    dynamicId?: string
  ): void {
    try {
      const parsedPath = path.parse(comicImagePath);
      const metaPath = path.join(parsedPath.dir, `${parsedPath.name}_META.json`);
      const payload = {
        status: 'failure',
        provider: null,
        model: null,
        endpoint: 'delayed-reply-supplemental-wait',
        reason,
        taskId,
        roomId,
        dynamicId,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn('保存补图失败元数据失败', {
        taskId,
        roomId,
        comicImagePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async checkFileExists(filePath: string): Promise<boolean> {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      this.logger.error('检查文件存在性失败', { filePath, error });
      return false;
    }
  }

  /**
   * 获取最新动态
   */
  private async getLatestDynamic(uid: string): Promise<BilibiliDynamic | null> {
    try {
      const dynamics = await this.bilibiliAPI.getDynamics(uid);
      
      // 过滤掉无法解析的动态（如直播推荐等）
      const validDynamics = dynamics.filter(d => d !== null);
      
      if (validDynamics.length === 0) {
        this.logger.warn('未找到有效的动态', { uid, totalDynamics: dynamics.length });
        return null;
      }
      
      // 输出前5个动态的详细信息，帮助调试
      this.logger.info(`找到有效动态: ${validDynamics.length} 个`, {
        uid,
        top5Dynamics: validDynamics.slice(0, 5).map(d => ({
          id: String(d.id),
          type: d.type,
          content: d.content.substring(0, 50),
          publishTime: d.publishTime.toISOString()
        }))
      });
      
      this.logger.info(`选择最新动态: ${String(validDynamics[0].id)}`, {
        uid,
        dynamicId: String(validDynamics[0].id),
        dynamicType: validDynamics[0].type,
        content: validDynamics[0].content.substring(0, 100)
      });
      
      return validDynamics[0];
    } catch (error) {
      if (this.isCredentialError(error)) {
        throw error;
      }
      this.logger.error('获取最新动态失败', { error, uid });
      return null;
    }
  }

  private isCredentialError(error: unknown): boolean {
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

  private isTransientNetworkError(message?: string): boolean {
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

  private isPermanentReplyError(error: unknown): boolean {
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
   * 确保任务拥有可用的UID
   */
  private async ensureTaskUid(task: DelayedReplyTask): Promise<string> {
    if (task.uid) {
      return task.uid;
    }

    const uid = await this.resolveUidForRoom(task.roomId, task.taskId);
    if (!uid) {
      throw new Error(`无法解析主播UID: roomId=${task.roomId}`);
    }

    task.uid = uid;
    task.error = undefined;
    await this.store.updateTask(task.taskId, {
      uid,
      error: undefined
    });

    return uid;
  }

  /**
   * 解析主播UID
   */
  private async resolveUidForRoom(roomId: string, currentTaskId?: string): Promise<string | undefined> {
    const configuredUid = BilibiliConfigHelper.getAnchorUid(roomId);
    this.logger.info(`🔍 配置中的UID: ${configuredUid || '未配置'}`, { roomId });
    if (configuredUid) {
      return configuredUid;
    }

    const historicalUid = this.findHistoricalUid(roomId, currentTaskId);
    if (historicalUid) {
      this.logger.info(`🗂️  使用历史任务中的UID: ${historicalUid}`, { roomId });
      return historicalUid;
    }

    this.logger.info(`📡 通过API获取UID: roomId=${roomId}`);
    const apiUid = await this.bilibiliAPI.getUidByRoomId(roomId);
    if (apiUid) {
      this.logger.info(`✅ API获取UID成功: ${apiUid}`, { roomId });
    }
    return apiUid;
  }

  /**
   * 从历史任务中查找已知UID
   */
  private findHistoricalUid(roomId: string, currentTaskId?: string): string | undefined {
    const historicalTasks = Array.from(this.tasks.values())
      .filter(task =>
        task.roomId === roomId &&
        task.taskId !== currentTaskId &&
        !!task.uid
      )
      .sort((a, b) => b.createTime.getTime() - a.createTime.getTime());

    return historicalTasks[0]?.uid || undefined;
  }

  /**
   * 判断UID解析失败是否适合进入队列重试
   */
  private isUidLookupRetriableError(error: unknown): boolean {
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
