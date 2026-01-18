/**
 * 延迟回复存储实现
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';
import { DelayedReplyTask } from './interfaces/types';

/**
 * 延迟回复存储实现
 */
export class DelayedReplyStore implements IDelayedReplyStore {
  private logger = getLogger('DelayedReplyStore');
  private storagePath: string;
  private tasks: Map<string, DelayedReplyTask> = new Map();
  private initialized = false;

  constructor() {
    this.storagePath = path.join(process.cwd(), 'data', 'delayed_reply_tasks.json');
  }

  /**
   * 初始化存储
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // 确保数据目录存在
      const dataDir = path.dirname(this.storagePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // 加载已保存的任务
      if (fs.existsSync(this.storagePath)) {
        const content = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(content);

        for (const task of data.tasks || []) {
          // 转换日期字符串为Date对象
          task.createTime = new Date(task.createTime);
          task.scheduledTime = new Date(task.scheduledTime);
          this.tasks.set(task.taskId, task);
        }

        this.logger.info(`加载了 ${this.tasks.size} 个延迟任务`);
      }

      this.initialized = true;
    } catch (error) {
      this.logger.error('初始化延迟回复存储失败', { error });
      throw error;
    }
  }

  /**
   * 添加任务
   */
  async addTask(task: DelayedReplyTask): Promise<void> {
    try {
      this.tasks.set(task.taskId, task);
      await this.save();
      this.logger.info(`添加延迟任务: ${task.taskId}`, { roomId: task.roomId });
    } catch (error) {
      this.logger.error('添加延迟任务失败', { error, taskId: task.taskId });
      throw error;
    }
  }

  /**
   * 获取任务
   */
  async getTask(taskId: string): Promise<DelayedReplyTask | null> {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 获取待处理任务
   */
  async getPendingTasks(): Promise<DelayedReplyTask[]> {
    const now = new Date();
    return Array.from(this.tasks.values()).filter(
      task => task.status === 'pending' && task.scheduledTime <= now
    );
  }

  /**
   * 更新任务
   */
  async updateTask(taskId: string, updates: Partial<DelayedReplyTask>): Promise<void> {
    try {
      const task = this.tasks.get(taskId);
      if (!task) {
        this.logger.warn(`任务不存在: ${taskId}`);
        return;
      }

      // 更新任务
      Object.assign(task, updates);
      await this.save();
    } catch (error) {
      this.logger.error('更新延迟任务失败', { error, taskId });
      throw error;
    }
  }

  /**
   * 删除任务
   */
  async removeTask(taskId: string): Promise<void> {
    try {
      this.tasks.delete(taskId);
      await this.save();
      this.logger.info(`删除延迟任务: ${taskId}`);
    } catch (error) {
      this.logger.error('删除延迟任务失败', { error, taskId });
      throw error;
    }
  }

  /**
   * 清理旧任务
   */
  async cleanupOldTasks(): Promise<void> {
    try {
      const now = new Date();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7天

      const tasksToRemove: string[] = [];

      for (const [taskId, task] of this.tasks.entries()) {
        const age = now.getTime() - task.createTime.getTime();
        if (age > maxAge && (task.status === 'completed' || task.status === 'failed')) {
          tasksToRemove.push(taskId);
        }
      }

      for (const taskId of tasksToRemove) {
        this.tasks.delete(taskId);
      }

      if (tasksToRemove.length > 0) {
        await this.save();
        this.logger.info(`清理了 ${tasksToRemove.length} 个旧任务`);
      }
    } catch (error) {
      this.logger.error('清理旧任务失败', { error });
    }
  }

  /**
   * 保存到文件
   */
  private async save(): Promise<void> {
    try {
      const data = {
        tasks: Array.from(this.tasks.values()),
        lastUpdated: new Date().toISOString()
      };

      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      this.logger.error('保存延迟任务失败', { error });
      throw error;
    }
  }
}
