/**
 * 延迟回复服务接口
 */
import { DelayedReplyTask } from './types';

/**
 * 延迟回复服务接口
 */
export interface IDelayedReplyService {
  /**
   * 启动服务
   */
  start(): Promise<void>;

  /**
   * 停止服务
   */
  stop(): Promise<void>;

  /**
   * 添加延迟回复任务
   */
  addTask(roomId: string, goodnightTextPath: string, comicImagePath?: string): Promise<string>;

  /**
   * 移除任务
   */
  removeTask(taskId: string): Promise<void>;

  /**
   * 获取所有任务
   */
  getTasks(): DelayedReplyTask[];

  /**
   * 是否正在运行
   */
  isRunning(): boolean;
}
