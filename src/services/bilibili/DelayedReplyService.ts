/**
 * 延迟回复服务实现
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { AppError } from '../../core/errors/AppError';
import { IDelayedReplyService } from './interfaces/IDelayedReplyService';
import { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import {
  DelayedReplyTask,
  BilibiliDynamic,
  RoomLiveStatus,
  LiveContentSummaryDeliveryMode,
} from './interfaces/types';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { DelayedReplyArtifactResolver } from './delayed-reply/DelayedReplyArtifactResolver';
import { DelayedReplyDiagnostics } from './delayed-reply/DelayedReplyDiagnostics';
import { LiveContentSummaryComposer } from './delayed-reply/LiveContentSummaryComposer';
import { DelayedReplyScheduler } from './delayed-reply/DelayedReplyScheduler';
import { DelayedReplyPolicy } from './delayed-reply/DelayedReplyPolicy';
import { ReplyContentReader } from './delayed-reply/ReplyContentReader';
import { SupplementaryReplyWorkflow } from './delayed-reply/SupplementaryReplyWorkflow';

/**
 * 延迟回复服务实现
 */
export class DelayedReplyService implements IDelayedReplyService {
  private readonly policy = new DelayedReplyPolicy();
  private readonly replyContent = new ReplyContentReader();
  private logger = getLogger('DelayedReplyService');
  private readonly artifactResolver = new DelayedReplyArtifactResolver();
  private readonly diagnostics = new DelayedReplyDiagnostics();
  private readonly liveContentSummaryComposer = new LiveContentSummaryComposer();
  private static readonly COMIC_WAIT_INTERVAL_MS = 2 * 60 * 1000;
  private static readonly COMBINED_REPLY_COMIC_WAIT_INTERVAL_MS = 60 * 1000;
  private static readonly MAX_COMIC_WAIT_COUNT = 5;
  private static readonly LIVE_CONTENT_WAIT_INTERVAL_MS = 60 * 1000;
  private static readonly LIVE_RECHECK_INTERVAL_MS = 2 * 60 * 1000;
  private static readonly LIVE_CONTINUATION_REPLACEMENT_MAX_WAIT_COUNT = 180;
  /** Initial active-live defer window before waiting for a final recording replacement. */
  private static readonly MAX_ACTIVE_LIVE_DEFER_COUNT = 60;
  private tasks: Map<string, DelayedReplyTask> = new Map();
  private readonly scheduler: DelayedReplyScheduler;
  private readonly supplementary: SupplementaryReplyWorkflow;
  private isRunningFlag = false;
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
    this.supplementary = new SupplementaryReplyWorkflow({
      bilibiliAPI, store, notifier,
      policy: this.policy,
      replyContent: this.replyContent,
      artifactResolver: this.artifactResolver,
      diagnostics: this.diagnostics,
      liveContentSummaryComposer: this.liveContentSummaryComposer,
      scheduleTask: task => this.scheduleTask(task),
      checkFileExists: filePath => this.checkFileExists(filePath),
      notifyComicGenerationFailure: task => this.notifyComicGenerationFailure(task)
    });
    this.scheduler = new DelayedReplyScheduler({
      checkDueTasks: () => this.checkDueTasks(),
      logCountdown: () => this.logCountdown(),
      executeTask: task => this.executeDelayedReply(task)
    });
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

    this.scheduler.stop();

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
    const resolvedPaths = this.artifactResolver.resolve(roomId, goodnightTextPath, comicImagePath);
    goodnightTextPath = resolvedPaths.goodnightTextPath;
    comicImagePath = resolvedPaths.comicImagePath;

    const dedupeKey = this.policy.getTaskDedupeKey(roomId, goodnightTextPath, comicImagePath);
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
      liveContentSummaryDeliveryMode = this.liveContentSummaryComposer.resolveDeliveryMode(
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
        task => this.policy.isSameDelayedReplyTask(task, roomId, goodnightTextPath, comicImagePath) &&
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
            this.policy.isSameDelayedReplyTextTask(task, roomId, goodnightTextPath) &&
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
        task => this.policy.isSameDelayedReplyTask(task, roomId, goodnightTextPath, comicImagePath) &&
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
          !this.policy.isSameDelayedReplyTask(existingTask, roomId, goodnightTextPath, comicImagePath)
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
        taskId: crypto.randomUUID(),
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
        if (!this.policy.isUidLookupRetriableError(error)) {
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
    if (this.executingTaskIds.has(taskId)) {
      throw new AppError('Task is currently executing', 'TASK_BUSY', 409);
    }
    try {
      this.scheduler.cancel(taskId);

      // A queued setImmediate callback can still hold this object after removal.
      const task = this.tasks.get(taskId);
      if (task) task.status = 'completed';
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
    const resolvedMode = this.liveContentSummaryComposer.resolveDeliveryMode(roomId, deliveryMode);
    let task = Array.from(this.tasks.values())
      .filter(candidate => this.policy.isSameDelayedReplyTextTask(candidate, roomId, normalizedTextPath))
      .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];

    if (!task) {
      const storedTasks = await this.store.getAllTasks();
      task = storedTasks
        .filter(candidate => this.policy.isSameDelayedReplyTextTask(candidate, roomId, normalizedTextPath))
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

    if (!this.liveContentSummaryComposer.isDelivered(task) && task.liveContentSummaryState !== 'publishing') {
      const summary = this.liveContentSummaryComposer.read(task);
      task.liveContentSummaryState = summary.kind === 'success'
        ? 'ready'
        : summary.kind === 'failed'
          ? 'failed'
          : 'waiting';
      task.liveContentSummaryError = summary.kind === 'failed' ? summary.error : undefined;
    }

    let shouldSchedule = false;
    if (task.replyId && !this.liveContentSummaryComposer.isDelivered(task)) {
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

        if (this.policy.isDelayedReplyTaskExpired(task)) {
          await this.suppressStaleTask(task, 'stale delayed reply suppressed on service startup');
          continue;
        }

        const resolvedPaths = this.artifactResolver.resolve(task.roomId, task.goodnightTextPath, task.comicImagePath);
        if (resolvedPaths.goodnightTextPath !== task.goodnightTextPath || resolvedPaths.comicImagePath !== task.comicImagePath) {
          task.goodnightTextPath = resolvedPaths.goodnightTextPath;
          task.comicImagePath = resolvedPaths.comicImagePath;
          await this.store.updateTask(task.taskId, {
            goodnightTextPath: task.goodnightTextPath,
            comicImagePath: task.comicImagePath
          });
        }

        const dedupeKey = this.policy.getTaskDedupeKey(task.roomId, task.goodnightTextPath, task.comicImagePath);
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
    this.scheduler.start();
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
    this.scheduler.schedule(task);
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
      if (this.policy.isCredentialError(error)) {
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



  private async tryPublishLiveContentSummarySeparately(
    task: DelayedReplyTask
  ): Promise<'done' | 'waiting' | 'retry' | 'failed'> {
    return this.supplementary.tryPublishLiveContentSummarySeparately(task);
  }

  private async executeLiveContentSummaryReply(task: DelayedReplyTask): Promise<void> {
    return this.supplementary.executeLiveContentSummaryReply(task);
  }

  private async completeOrWaitForLiveContentSummary(task: DelayedReplyTask): Promise<void> {
    return this.supplementary.completeOrWaitForLiveContentSummary(task);
  }


  private async executeSummaryDynamicReply(
    task: DelayedReplyTask,
    replyText?: string,
    imagePath?: string
  ): Promise<void> {
    return this.supplementary.executeSummaryDynamicReply(task, replyText, imagePath);
  }

  private async executeSupplementalComicReply(task: DelayedReplyTask): Promise<void> {
    return this.supplementary.executeSupplementalComicReply(task);
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

      this.scheduler.cancel(task.taskId);

      if (task.status === 'waiting_comic') {
        if (this.policy.isDelayedReplyTaskExpired(task)) {
          await this.suppressStaleTask(task, 'stale delayed reply suppressed before execution');
          return;
        }

        await this.executeSupplementalComicReply(task);
        return;
      }

      if (task.status === 'waiting_summary') {
        if (this.policy.isDelayedReplyTaskExpired(task)) {
          await this.suppressStaleTask(task, 'stale summary dynamic reply suppressed before execution');
          return;
        }

        await this.executeSummaryDynamicReply(task);
        return;
      }

      if (task.status === 'waiting_live_content') {
        if (this.policy.isDelayedReplyTaskExpired(task)) {
          await this.suppressStaleTask(task, 'stale live content summary reply suppressed before execution');
          return;
        }

        await this.executeLiveContentSummaryReply(task);
        return;
      }

      // 更新任务状态
      const liveStatus = await this.getRoomLiveStatusSafely(task.roomId);
      if (this.policy.isSameActiveLiveForTask(task, liveStatus)) {
        await this.deferTaskForActiveLive(task, liveStatus!);
        return;
      }

      if (await this.deferTaskWaitingForReplacement(task)) {
        return;
      }

      if (this.policy.isDelayedReplyTaskExpired(task)) {
        await this.suppressStaleTask(task, 'stale delayed reply suppressed before execution');
        return;
      }

      task.status = 'processing';
      await this.store.updateTask(task.taskId, { status: 'processing' });

      this.logger.info(`执行延迟回复: ${task.taskId}`, {
        roomId: task.roomId,
        uid: task.uid
      });

      const resolvedPaths = this.artifactResolver.resolve(task.roomId, task.goodnightTextPath, task.comicImagePath);
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
      const baseReplyText = await this.replyContent.readReplyText(task.goodnightTextPath);
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
          !this.policy.isWithinFirstReplyWave(finalDynamic) &&
          this.artifactResolver.shouldWaitForComicImage(task, DelayedReplyService.MAX_COMIC_WAIT_COUNT)
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
            withinFirstReplyWave: this.policy.isWithinFirstReplyWave(finalDynamic),
            comicImagePath: task.comicImagePath,
            comicWaitCount: task.comicWaitCount || 0
          });
          const comicGenerationFailed = this.artifactResolver.isComicGenerationTerminalFailure(task.comicImagePath);
          if (comicGenerationFailed) {
            await this.notifyComicGenerationFailure(task);
          }
          shouldWaitForSupplementalComic = !comicGenerationFailed;
        }
      }

      const composition = this.liveContentSummaryComposer.compose(task, baseReplyText, 'main');
      const replyText = composition.text;

      const dynamicReplyDedupeKey = this.policy.getDynamicReplyDedupeKey(task.roomId, String(finalDynamic.id));
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
            task.liveContentSummaryDeliveryMode || this.liveContentSummaryComposer.resolveDeliveryMode(task.roomId)
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
        this.liveContentSummaryComposer.markAttached(task, 'main', task.replyId);
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
          ...this.liveContentSummaryComposer.getTaskUpdates(task)
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
          !this.liveContentSummaryComposer.isDelivered(task) &&
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
          ...this.liveContentSummaryComposer.getTaskUpdates(task)
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
          const imageGenerationInfo = this.diagnostics.getComicGenerationInfo(task.comicImagePath);
          const textGenerationInfo = this.diagnostics.getTextGenerationInfo(task.goodnightTextPath, task.comicImagePath);
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
        replyText = await this.replyContent.readReplyText(task.goodnightTextPath);
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
      const isCredentialError = this.policy.isCredentialError(error);
      if (isBlacklistError) {
        this.logger.warn(`检测到黑名单或禁言错误，不进行重试: ${task.taskId}`, { error: task.error });
      }
      if (isCredentialError) {
        this.logger.warn(`检测到B站Cookie或凭证失效，不进行重试: ${task.taskId}`, { error: task.error });
      }

      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;

      if (!isBlacklistError && !isCredentialError && !this.policy.isPermanentReplyError(error) && task.retryCount < maxRetries) {
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
          const retryInfo = isBlacklistError || isCredentialError || this.policy.isPermanentReplyError(error)
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
            this.diagnostics.getComicGenerationInfo(task.comicImagePath),
            this.diagnostics.getTextGenerationInfo(task.goodnightTextPath, task.comicImagePath)
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
              imageGenerationInfo: this.diagnostics.getComicGenerationInfo(task.comicImagePath),
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
        (!effectiveCurrentTask || !this.policy.isNewerRecordingTask(effectiveCurrentTask, task))
      )
      .sort((a, b) => this.policy.getTaskCompletionTime(b).getTime() - this.policy.getTaskCompletionTime(a).getTime());

    const sameDynamicTask = repliedTasks.find(task =>
      task.repliedDynamicId === dynamicId &&
      now - this.policy.getTaskCompletionTime(task).getTime() < recentReplyWindowMs
    );
    if (sameDynamicTask) {
      return sameDynamicTask;
    }

    return repliedTasks.find(task =>
      now - this.policy.getTaskCompletionTime(task).getTime() < recentReplyWindowMs
    ) || null;
  }


  private async notifyComicGenerationFailure(task: DelayedReplyTask): Promise<void> {
    if (!this.notifier || task.comicGenerationFailureNotifiedAt) {
      return;
    }

    const anchorName = BilibiliConfigHelper.getAnchorConfig(task.roomId)?.name || '未知主播';
    const imageGenerationInfo = this.diagnostics.getComicGenerationInfo(task.comicImagePath)
      || '图片未生成，未找到生图失败元数据';
    const comicScriptGenerationInfo = this.diagnostics.getComicScriptGenerationInfo(task.comicImagePath)
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
      if (this.policy.isCredentialError(error)) {
        throw error;
      }
      this.logger.error('获取最新动态失败', { error, uid });
      return null;
    }
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
}
