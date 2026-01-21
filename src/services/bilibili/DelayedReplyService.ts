/**
 * 延迟回复服务实现
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
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
  async addTask(roomId: string, goodnightTextPath: string, comicImagePath?: string, delaySeconds?: number): Promise<string> {
    try {
      this.logger.info(`[延迟回复] 尝试添加任务: roomId=${roomId}, goodnightTextPath=${goodnightTextPath}, comicImagePath=${comicImagePath}`);
      
      // 获取延迟回复配置
      const delayedReplySettings = BilibiliConfigHelper.getDelayedReplySettings(roomId);
      if (!delayedReplySettings) {
        this.logger.warn('⚠️  延迟回复未启用，跳过添加任务', { roomId });
        return '';
      }
      this.logger.info(`✅ 延迟回复配置已加载: enabled=${delayedReplySettings.enabled}, anchorEnabled=${delayedReplySettings.anchorEnabled}, delayMinutes=${delayedReplySettings.delayMinutes}`);

      // 获取主播UID
      let uid = BilibiliConfigHelper.getAnchorUid(roomId);
      this.logger.info(`🔍 配置中的UID: ${uid || '未配置'}`);
      
      if (!uid) {
        // 如果配置中没有 UID，尝试通过 API 获取
        this.logger.info(`📡 通过API获取UID: roomId=${roomId}`);
        uid = await this.bilibiliAPI.getUidByRoomId(roomId);
        if (!uid) {
          this.logger.warn('⚠️  无法获取主播UID，跳过添加任务', { roomId });
          return '';
        }
        this.logger.info(`✅ API获取UID成功: ${uid}`);
      }

      // 检查是否已有待处理或处理中的任务（去重逻辑）
      const now = new Date();
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
          dynamicId: latestDynamic.id,
          content: replyText,
          images: imagePath
        });
      } catch (publishError) {
        // 不在这里发送通知，由外部 catch 统一处理
        throw publishError;
      }

      this.logger.info(`延迟回复评论发布成功: ${task.taskId}`, {
        dynamicId: String(latestDynamic.id),
        replyId: String(result.replyId)
      });
      // 输出回复链接
      const replyUrl = `https://www.bilibili.com/opus/${String(latestDynamic.id)}#reply${String(result.replyId)}`;
      this.logger.info(`回复链接: ${replyUrl}`);

      // 发送企业微信通知
      if (this.notifier) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name;
        await this.notifier.notifyReplySuccess(
          String(latestDynamic.id),
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
        dynamicId: String(latestDynamic.id)
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

      // 发送企业微信通知
      if (this.notifier) {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name || '未知主播';
        
        // 使用新的通用错误通知方法
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

      // 重试逻辑
      const isBlacklistError = task.error?.includes('黑名单') || task.error?.includes('12035');
      if (isBlacklistError) {
        this.logger.warn(`检测到黑名单或禁言错误，不进行重试: ${task.taskId}`, { error: task.error });
        return;
      }

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
      
      // 提取正文部分（跳过元数据）
      const lines = content.split('\n');
      const startIndex = lines.findIndex(line => line.startsWith('---'));
      
      if (startIndex >= 0) {
        const result = lines.slice(startIndex + 1).join('\n').trim();
        this.logger.debug('提取正文成功（跳过元数据）', { textPath, resultLength: result.length });
        return result;
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
}
