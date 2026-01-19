/**
 * 回复管理器实现
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { IReplyManager } from './interfaces/IReplyManager';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
import { ReplyTask, ReplyHistory, BilibiliDynamic } from './interfaces/types';

/**
 * 生成UUID
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * 回复管理器实现
 */
export class ReplyManager implements IReplyManager {
  private logger = getLogger('ReplyManager');
  private tasks: Map<string, ReplyTask> = new Map();
  private taskStatus: Map<string, 'pending' | 'processing' | 'completed' | 'failed'> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;
  private isRunningFlag = false;

  constructor(
    private bilibiliAPI: IBilibiliAPIService,
    private replyHistoryStore: IReplyHistoryStore
  ) {}

  /**
   * 添加回复任务
   */
  async addTask(task: ReplyTask): Promise<void> {
    try {
      this.tasks.set(task.taskId, task);
      this.taskStatus.set(task.taskId, 'pending');
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.info(`添加回复任务: ${task.taskId}`, { dynamicId: String(task.dynamic.id) });
    } catch (error) {
      // 避免 JSON.stringify 导致大数精度丢失，只记录关键字段
      this.logger.error('添加回复任务失败', {
        taskId: task.taskId,
        dynamicId: String(task.dynamic.id),
        error
      });
      throw error;
    }
  }

  /**
   * 处理回复任务
   */
  async processTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger.warn(`任务不存在: ${taskId}`);
      return;
    }

    this.taskStatus.set(taskId, 'processing');
    // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
    this.logger.info(`处理回复任务: ${taskId}`, { dynamicId: String(task.dynamic.id) });

    try {
      // 读取晚安回复文本
      const replyText = await this.readReplyText(task.textPath);
      if (!replyText) {
        throw new Error('晚安回复文本为空');
      }

      // 发布评论（Python脚本会处理图片上传）
      const result = await this.bilibiliAPI.publishComment({
        dynamicId: task.dynamic.id,
        content: replyText,
        images: task.imagePath && fs.existsSync(task.imagePath) ? [task.imagePath] : undefined
      });

      // 记录回复历史
      await this.replyHistoryStore.recordReply({
        dynamicId: task.dynamic.id,
        uid: task.dynamic.uid,
        replyTime: new Date(result.replyTime),
        contentSummary: replyText.substring(0, 100),
        success: true
      });

      // 标记任务完成
      this.taskStatus.set(taskId, 'completed');
      // 确保 dynamicId 和 replyId 以字符串形式记录日志，避免大数精度丢失
      this.logger.info(`回复任务完成: ${taskId}`, {
        dynamicId: String(task.dynamic.id),
        replyId: String(result.replyId)
      });
      // 输出回复链接
      const replyUrl = `https://www.bilibili.com/opus/${String(task.dynamic.id)}#reply${String(result.replyId)}`;
      this.logger.info(`回复链接: ${replyUrl}`);

    } catch (error) {
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.error(`处理回复任务失败: ${taskId}`, {
        dynamicId: String(task.dynamic.id),
        error
      });

      // 记录失败历史
      await this.replyHistoryStore.recordReply({
        dynamicId: task.dynamic.id,
        uid: task.dynamic.uid,
        replyTime: new Date(),
        contentSummary: '回复失败',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });

      // 标记任务失败
      this.taskStatus.set(taskId, 'failed');

      // 重试逻辑
      if (task.retryCount < 3) {
        this.logger.info(`准备重试任务: ${taskId} (${task.retryCount + 1}/3)`);
        task.retryCount++;
        // 延迟后重试
        setTimeout(() => {
          this.processTask(taskId);
        }, 5000 * (task.retryCount + 1));
      }
    }
  }

  /**
   * 获取待处理任务列表
   */
  getPendingTasks(): ReplyTask[] {
    return Array.from(this.tasks.values()).filter(
      task => this.taskStatus.get(task.taskId) === 'pending'
    );
  }

  /**
   * 获取任务状态
   */
  getTaskStatus(taskId: string): 'pending' | 'processing' | 'completed' | 'failed' {
    return this.taskStatus.get(taskId) || 'pending';
  }

  /**
   * 清理已完成的任务
   */
  async cleanupCompletedTasks(): Promise<void> {
    const completedTasks: string[] = [];

    for (const [taskId, status] of this.taskStatus.entries()) {
      if (status === 'completed' || status === 'failed') {
        completedTasks.push(taskId);
      }
    }

    for (const taskId of completedTasks) {
      this.tasks.delete(taskId);
      this.taskStatus.delete(taskId);
    }

    if (completedTasks.length > 0) {
      this.logger.info(`清理已完成任务: ${completedTasks.length} 个`);
    }
  }

  /**
   * 启动任务处理器
   */
  async start(): Promise<void> {
    if (this.isRunningFlag) {
      this.logger.warn('任务处理器已在运行');
      return;
    }

    this.logger.info('启动任务处理器');
    this.isRunningFlag = true;

    // 启动处理循环
    this.processingInterval = setInterval(() => {
      this.processPendingTasks();
    }, 5000); // 每5秒检查一次

    this.logger.info('任务处理器已启动');
  }

  /**
   * 停止任务处理器
   */
  async stop(): Promise<void> {
    if (!this.isRunningFlag) {
      this.logger.warn('任务处理器未运行');
      return;
    }

    this.logger.info('停止任务处理器');

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.isRunningFlag = false;
    this.logger.info('任务处理器已停止');
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.isRunningFlag;
  }

  /**
   * 处理待处理任务
   */
  private async processPendingTasks(): Promise<void> {
    const pendingTasks = this.getPendingTasks();

    if (pendingTasks.length === 0) {
      return;
    }

    this.logger.debug(`处理待处理任务: ${pendingTasks.length} 个`);

    // 只处理一个任务，避免并发
    const task = pendingTasks[0];
    await this.processTask(task.taskId);
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
   * 构建评论内容
   */
  private buildCommentContent(text: string, imageUrl?: string): string {
    let content = text;

    // 如果有图片，添加图片链接
    if (imageUrl) {
      content = `${text}\n\n[图片](${imageUrl})`;
    }

    return content;
  }

  /**
   * 创建回复任务
   */
  static createTask(dynamic: BilibiliDynamic, textPath: string, imagePath: string): ReplyTask {
    return {
      taskId: generateUUID(),
      dynamic,
      textPath,
      imagePath,
      retryCount: 0,
      createTime: new Date()
    };
  }
}
