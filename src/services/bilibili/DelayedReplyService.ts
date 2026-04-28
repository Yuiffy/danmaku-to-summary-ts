/**
 * 延迟回复服务实现
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { IDelayedReplyService } from './interfaces/IDelayedReplyService';
import { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import { DelayedReplyTask, BilibiliDynamic } from './interfaces/types';
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
  private tasks: Map<string, DelayedReplyTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private isRunningFlag = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;
  private notifier?: WeChatWorkNotifier;
  private addTaskLocks: Map<string, Promise<string>> = new Map();

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
    liveEndTime?: Date
  ): Promise<string> {
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
      liveEndTime
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
    liveEndTime?: Date
  ): Promise<string> {
    try {
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
                (task.status === 'pending' || task.status === 'processing')
      );

      if (exactExistingTask) {
        this.logger.info('跳过添加任务：相同延迟回复任务已存在', {
          roomId,
          existingTaskId: exactExistingTask.taskId,
          existingStatus: exactExistingTask.status,
          scheduledTime: exactExistingTask.scheduledTime.toISOString()
        });
        return exactExistingTask.taskId;
      }

      const recentCompletedExactTask = Array.from(this.tasks.values()).find(
        task => this.isSameDelayedReplyTask(task, roomId, goodnightTextPath, comicImagePath) &&
                task.status === 'completed' &&
                now.getTime() - task.createTime.getTime() < 30 * 60 * 1000
      );

      if (recentCompletedExactTask) {
        this.logger.info('跳过添加任务：相同延迟回复任务已在30分钟内完成', {
          roomId,
          existingTaskId: recentCompletedExactTask.taskId,
          completedTaskCreatedAt: recentCompletedExactTask.createTime.toISOString()
        });
        return recentCompletedExactTask.taskId;
      }

      const existingTask = Array.from(this.tasks.values()).find(
        task => task.roomId === roomId &&
                (task.status === 'pending' || task.status === 'processing')
      );

      if (existingTask) {
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
        checkCount: 0
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
      await this.store.removeTask(taskId);

      this.logger.info(`移除延迟回复任务: ${taskId}`);
    } catch (error) {
      this.logger.error('移除延迟回复任务失败', { error, taskId });
      throw error;
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

  private getTaskDedupeKey(roomId: string, goodnightTextPath: string, comicImagePath?: string): string {
    return [
      String(roomId),
      path.normalize(goodnightTextPath),
      comicImagePath ? path.normalize(comicImagePath) : ''
    ].join('|');
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

  /**
   * 加载已保存的任务
   */
  private async loadTasks(): Promise<void> {
    try {
      const pendingTasks = await this.store.getPendingTasks();
      const uniqueTasks: DelayedReplyTask[] = [];
      const seenTaskKeys = new Set<string>();

      for (const task of pendingTasks) {
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
        this.tasks.set(task.taskId, task);
        this.scheduleTask(task);
      }

      this.logger.info(`加载了 ${uniqueTasks.length} 个待处理任务，压制重复任务 ${pendingTasks.length - uniqueTasks.length} 个`);
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
      task => task.status === 'pending'
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
        
        const checkCount = task.checkCount || 0;
        const remainingChecks = MAX_CHECK_COUNT - checkCount;
        const maxRemainingMinutes = remainingChecks * CHECK_INTERVAL_MINUTES;
        
        this.logger.info(
          `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 还剩 ${remainingMinutes} 分钟 (已检查 ${checkCount}/${MAX_CHECK_COUNT} 次，最多还等 ${maxRemainingMinutes} 分钟)`
        );
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
        if (task.status === 'pending' && task.scheduledTime <= now) {
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
      this.logger.error(`查找目标动态失败: ${error}`, { taskId: task.taskId });
      return null;
    }
  }

  /**
   * 执行延迟回复
   */
  private async executeDelayedReply(task: DelayedReplyTask): Promise<void> {
    try {
      // 清除定时器
      const timer = this.timers.get(task.taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(task.taskId);
      }

      // 更新任务状态
      task.status = 'processing';
      await this.store.updateTask(task.taskId, { status: 'processing' });

      this.logger.info(`执行延迟回复: ${task.taskId}`, {
        roomId: task.roomId,
        uid: task.uid
      });

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
      const replyText = await this.readReplyText(task.goodnightTextPath);
      if (!replyText) {
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

      const imagePath = task.comicImagePath && await this.checkFileExists(task.comicImagePath)
        ? [task.comicImagePath]
        : undefined;

      // 发布评论
      let result;
      try {
        result = await this.bilibiliAPI.publishComment({
          dynamicId: finalDynamic.id,
          content: replyText,
          images: imagePath
        });
      } catch (publishError) {
        // 不在这里发送通知，由外部 catch 统一处理
        throw publishError;
      }

      this.logger.info(`延迟回复评论发布成功: ${task.taskId}`, {
        dynamicId: String(finalDynamic.id),
        replyId: String(result.replyId)
      });
      // 输出回复链接
      const replyUrl = `https://www.bilibili.com/opus/${String(finalDynamic.id)}#reply${String(result.replyId)}`;
      this.logger.info(`回复链接: ${replyUrl}`);

      // 发送企业微信通知
      if (this.notifier) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name;
        await this.notifier.notifyReplySuccess(
          String(finalDynamic.id),
          String(result.replyId),
          anchorName,
          replyText,
          result.imageUrl,
          imagePath ? imagePath[0] : undefined
        );
      }

      // 更新任务状态
      task.status = 'completed';
      await this.store.updateTask(task.taskId, { status: 'completed' });

      this.logger.info(`延迟回复完成: ${task.taskId}`, {
        dynamicId: String(finalDynamic.id)
      });
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
      if (isBlacklistError) {
        this.logger.warn(`检测到黑名单或禁言错误，不进行重试: ${task.taskId}`, { error: task.error });
      }

      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;

      if (!isBlacklistError && task.retryCount < maxRetries) {
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
            replyText,
            error: error instanceof Error ? error.stack : String(error)
          }
        );
      }
    }
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
          const result = lines.slice(endIndex + 1).join('\n').trim();
          this.logger.debug('提取正文成功（跳过 front matter 元数据）', { textPath, resultLength: result.length });
          return result;
        }
      }

      const result = content.trim();
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

  /**
   * 检查文件是否存在
   */
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
        message.includes('网络')
      );
    }

    return false;
  }
}
