/**
 * 延迟回复服务实现
 */
import * as crypto from 'crypto';
import { getLogger } from '../../core/logging/LogManager';
import { IDelayedReplyService } from './interfaces/IDelayedReplyService';
import { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import { IReplyManager } from './interfaces/IReplyManager';
import { DelayedReplyTask, BilibiliDynamic } from './interfaces/types';
import { BilibiliConfigHelper } from './BilibiliConfigHelper';

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

  constructor(
    private bilibiliAPI: IBilibiliAPIService,
    private replyManager: IReplyManager,
    private store: IDelayedReplyStore
  ) {}

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
  async addTask(roomId: string, goodnightTextPath: string, comicImagePath?: string, delaySeconds?: number): Promise<string> {
    try {
      // 获取延迟回复配置
      const delayedReplySettings = BilibiliConfigHelper.getDelayedReplySettings(roomId);
      if (!delayedReplySettings) {
        this.logger.info('延迟回复未启用，跳过添加任务', { roomId });
        return '';
      }

      // 获取主播UID
      let uid = BilibiliConfigHelper.getAnchorUid(roomId);
      if (!uid) {
        // 如果配置中没有 UID，尝试通过 API 获取
        uid = await this.bilibiliAPI.getUidByRoomId(roomId);
        if (!uid) {
          this.logger.warn('无法获取主播UID，跳过添加任务', { roomId });
          return '';
        }
      }

      // 计算延迟时间（优先使用传入的 delaySeconds，否则使用配置的 delayMinutes）
      const delayMs = delaySeconds !== undefined
        ? delaySeconds * 1000
        : delayedReplySettings.delayMinutes * 60 * 1000;
      const scheduledTime = new Date(Date.now() + delayMs);

      // 创建任务
      const task: DelayedReplyTask = {
        taskId: generateUUID(),
        roomId,
        uid,
        goodnightTextPath,
        comicImagePath,
        createTime: new Date(),
        scheduledTime,
        status: 'pending',
        retryCount: 0
      };

      // 保存任务
      this.tasks.set(task.taskId, task);
      await this.store.addTask(task);

      // 设置定时器
      this.scheduleTask(task);

      this.logger.info(`添加延迟回复任务: ${task.taskId}`, {
        roomId,
        uid,
        scheduledTime: scheduledTime.toISOString()
      });

      return task.taskId;
    } catch (error) {
      this.logger.error('添加延迟回复任务失败', { error, roomId });
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

  /**
   * 加载已保存的任务
   */
  private async loadTasks(): Promise<void> {
    try {
      const pendingTasks = await this.store.getPendingTasks();

      for (const task of pendingTasks) {
        this.tasks.set(task.taskId, task);
        this.scheduleTask(task);
      }

      this.logger.info(`加载了 ${pendingTasks.length} 个待处理任务`);
    } catch (error) {
      this.logger.error('加载延迟任务失败', { error });
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

    for (const task of pendingTasks) {
      const remainingMs = task.scheduledTime.getTime() - now.getTime();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      if (remainingMinutes > 0) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name || task.roomId;
        this.logger.info(
          `   ⏰ [${task.taskId.slice(0, 8)}] ${anchorName} - 还剩 ${remainingMinutes} 分钟`
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
      this.logger.error('检查到期任务失败', { error });
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

      // 获取最新动态
      const latestDynamic = await this.getLatestDynamic(task.uid!);
      if (!latestDynamic) {
        throw new Error('未找到最新动态');
      }

      // 创建回复任务
      const replyTask = {
        taskId: generateUUID(),
        dynamic: latestDynamic,
        textPath: task.goodnightTextPath,
        imagePath: task.comicImagePath || '',
        retryCount: 0,
        createTime: new Date()
      };

      // 执行回复
      await this.replyManager.addTask(replyTask);
      
      // 立即处理回复任务
      await this.replyManager.processTask(replyTask.taskId);

      // 更新任务状态
      task.status = 'completed';
      await this.store.updateTask(task.taskId, { status: 'completed' });

      this.logger.info(`延迟回复完成: ${task.taskId}`, {
        dynamicId: String(latestDynamic.id)
      });
    } catch (error) {
      this.logger.error(`执行延迟回复失败: ${task.taskId}`, { error });

      // 更新任务状态
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      await this.store.updateTask(task.taskId, {
        status: 'failed',
        error: task.error
      });

      // 重试逻辑
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;

      if (task.retryCount < maxRetries) {
        task.retryCount++;
        task.status = 'pending';

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
      }
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
      
      this.logger.info(`找到有效动态: ${validDynamics.length} 个`, {
        uid,
        dynamicId: String(validDynamics[0].id),
        dynamicType: validDynamics[0].type
      });
      
      return validDynamics[0];
    } catch (error) {
      this.logger.error('获取最新动态失败', { error, uid });
      return null;
    }
  }
}
