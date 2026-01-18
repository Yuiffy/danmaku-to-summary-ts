/**
 * 延迟回复存储接口
 */
import { DelayedReplyTask } from './types';

/**
 * 延迟回复存储接口
 */
export interface IDelayedReplyStore {
  /**
   * 初始化存储
   */
  initialize(): Promise<void>;

  /**
   * 添加任务
   */
  addTask(task: DelayedReplyTask): Promise<void>;

  /**
   * 获取任务
   */
  getTask(taskId: string): Promise<DelayedReplyTask | null>;

  /**
   * 获取待处理任务
   */
  getPendingTasks(): Promise<DelayedReplyTask[]>;

  /**
   * 更新任务
   */
  updateTask(taskId: string, updates: Partial<DelayedReplyTask>): Promise<void>;

  /**
   * 删除任务
   */
  removeTask(taskId: string): Promise<void>;

  /**
   * 清理旧任务
   */
  cleanupOldTasks(): Promise<void>;
}
