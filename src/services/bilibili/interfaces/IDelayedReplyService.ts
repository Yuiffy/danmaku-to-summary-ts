/**
 * 延迟回复服务接口
 */
import { DelayedReplyTask, LiveContentSummaryDeliveryMode } from './types';

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
   * @param liveStartTime 直播开始时间（可选）
   * @param liveEndTime 直播结束时间（可选）
   */
  addTask(
    roomId: string, 
    goodnightTextPath: string, 
    comicImagePath?: string, 
    delaySeconds?: number,
    liveStartTime?: Date,
    liveEndTime?: Date,
    liveContentSummaryPath?: string,
    liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode
  ): Promise<string>;

  /**
   * 注册已计划或已生成的本场直播梗概，并唤醒对应延迟回复任务。
   */
  registerLiveContentSummary(
    roomId: string,
    goodnightTextPath: string,
    liveContentSummaryPath: string,
    deliveryMode?: LiveContentSummaryDeliveryMode
  ): Promise<DelayedReplyTask | null>;

  /**
   * 移除任务
   */
  removeTask(taskId: string): Promise<void>;

  /**
   * 为已成功发布的历史晚安回复补发汇总动态评论。
   */
  publishSummaryForTask(taskId: string): Promise<DelayedReplyTask>;

  /**
   * 为已成功发布文字回复的历史任务补发漫画图片。
   */
  recoverComicForTask(taskId: string, comicImagePath: string): Promise<DelayedReplyTask>;

  /**
   * 获取所有任务
   */
  getTasks(): DelayedReplyTask[];

  /**
   * 是否正在运行
   */
  isRunning(): boolean;
}
