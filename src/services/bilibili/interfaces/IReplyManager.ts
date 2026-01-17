/**
 * 回复管理器接口
 */
import { ReplyTask, BilibiliDynamic } from './types';

export interface IReplyManager {
  /**
   * 添加回复任务
   * @param task 回复任务
   */
  addTask(task: ReplyTask): Promise<void>;

  /**
   * 处理回复任务
   * @param taskId 任务ID
   */
  processTask(taskId: string): Promise<void>;

  /**
   * 获取待处理任务列表
   * @returns 任务列表
   */
  getPendingTasks(): ReplyTask[];

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态
   */
  getTaskStatus(taskId: string): 'pending' | 'processing' | 'completed' | 'failed';

  /**
   * 清理已完成的任务
   */
  cleanupCompletedTasks(): Promise<void>;

  /**
   * 启动任务处理器
   */
  start(): Promise<void>;

  /**
   * 停止任务处理器
   */
  stop(): Promise<void>;

  /**
   * 是否正在运行
   */
  isRunning(): boolean;
}
