/**
 * 动态轮询服务接口
 */
import { BilibiliDynamic } from './types';

export interface IDynamicPollingService {
  /**
   * 启动轮询服务
   */
  start(): Promise<void>;

  /**
   * 停止轮询服务
   */
  stop(): Promise<void>;

  /**
   * 添加主播到轮询列表
   * @param uid 主播UID
   * @param config 主播配置
   */
  addAnchor(uid: string, config: any): Promise<void>;

  /**
   * 从轮询列表中移除主播
   * @param uid 主播UID
   */
  removeAnchor(uid: string): Promise<void>;

  /**
   * 设置主播直播开始时间
   * @param uid 主播UID
   * @param startTime 直播开始时间
   */
  setLiveStartTime(uid: string, startTime: Date): Promise<void>;

  /**
   * 获取主播列表
   * @returns 主播UID列表
   */
  getAnchors(): string[];

  /**
   * 是否正在运行
   */
  isRunning(): boolean;
}

/**
 * 新动态回调函数类型
 */
export type NewDynamicCallback = (dynamic: BilibiliDynamic) => void;
