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
   * @param roomId 房间ID
   * @param goodnightTextPath 晚安文本路径
   * @param comicImagePath 漫画图片路径（可选）
   * @param delaySeconds 延迟秒数（可选，不传则使用配置的延迟时间）
   */
  addTask(roomId: string, goodnightTextPath: string, comicImagePath?: string, delaySeconds?: number): Promise<string>;

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
