/**
 * 动态轮询服务实现
 */
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { IDynamicPollingService, NewDynamicCallback } from './interfaces/IDynamicPollingService';
import { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
import { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
import { BilibiliDynamic, AnchorConfig } from './interfaces/types';

/**
 * 动态轮询服务实现
 */
export class DynamicPollingService implements IDynamicPollingService {
  private logger = getLogger('DynamicPollingService');
  private anchors: Map<string, AnchorConfig> = new Map();
  private currentIndex = 0;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunningFlag = false;
  private newDynamicCallbacks: NewDynamicCallback[] = [];

  constructor(
    private bilibiliAPI: IBilibiliAPIService,
    private replyHistoryStore: IReplyHistoryStore
  ) {
    this.loadAnchorsFromConfig();
  }

  /**
   * 从配置加载主播列表
   */
  private loadAnchorsFromConfig(): void {
    try {
      const config = ConfigProvider.getConfig();
      const bilibiliConfig = config.bilibili as any;

      if (!bilibiliConfig || !bilibiliConfig.anchors) {
        this.logger.warn('B站配置中没有主播列表');
        return;
      }

      for (const [uid, anchorConfig] of Object.entries(bilibiliConfig.anchors)) {
        const config = anchorConfig as any;
        if (config.enabled) {
          this.anchors.set(uid, {
            uid,
            name: config.name,
            roomId: config.roomId,
            enabled: config.enabled
          });
          this.logger.info(`加载主播: ${config.name} (${uid})`);
        }
      }

      this.logger.info(`加载了 ${this.anchors.size} 个主播`);
    } catch (error) {
      this.logger.error('加载主播配置失败', { error });
    }
  }

  /**
   * 启动轮询服务
   */
  async start(): Promise<void> {
    if (this.isRunningFlag) {
      this.logger.warn('轮询服务已在运行');
      return;
    }

    this.logger.info('启动动态轮询服务');

    // 初始化回复历史存储
    await this.replyHistoryStore.initialize();

    // 启动轮询
    this.isRunningFlag = true;
    this.startPolling();

    this.logger.info('动态轮询服务已启动');
  }

  /**
   * 停止轮询服务
   */
  async stop(): Promise<void> {
    if (!this.isRunningFlag) {
      this.logger.warn('轮询服务未运行');
      return;
    }

    this.logger.info('停止动态轮询服务');

    // 停止轮询
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunningFlag = false;
    this.logger.info('动态轮询服务已停止');
  }

  /**
   * 添加主播到轮询列表
   */
  async addAnchor(uid: string, config: any): Promise<void> {
    try {
      const anchorConfig: AnchorConfig = {
        uid,
        name: config.name,
        roomId: config.roomId,
        enabled: config.enabled
      };

      this.anchors.set(uid, anchorConfig);
      this.logger.info(`添加主播: ${anchorConfig.name} (${uid})`);
    } catch (error) {
      this.logger.error('添加主播失败', { error, uid });
      throw error;
    }
  }

  /**
   * 从轮询列表中移除主播
   */
  async removeAnchor(uid: string): Promise<void> {
    try {
      this.anchors.delete(uid);
      this.logger.info(`移除主播: ${uid}`);
    } catch (error) {
      this.logger.error('移除主播失败', { error, uid });
      throw error;
    }
  }

  /**
   * 设置主播直播开始时间
   */
  async setLiveStartTime(uid: string, startTime: Date): Promise<void> {
    try {
      const anchor = this.anchors.get(uid);
      if (anchor) {
        anchor.liveStartTime = startTime;
        this.logger.info(`设置主播直播开始时间: ${anchor.name} (${uid})`, { startTime });
      } else {
        this.logger.warn(`主播不存在: ${uid}`);
      }
    } catch (error) {
      this.logger.error('设置直播开始时间失败', { error, uid });
      throw error;
    }
  }

  /**
   * 获取主播列表
   */
  getAnchors(): string[] {
    return Array.from(this.anchors.keys());
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.isRunningFlag;
  }

  /**
   * 注册新动态回调
   */
  onNewDynamic(callback: NewDynamicCallback): void {
    this.newDynamicCallbacks.push(callback);
  }

  /**
   * 启动轮询
   */
  private startPolling(): void {
    const config = ConfigProvider.getConfig();
    const bilibiliConfig = config.bilibili as any;
    const interval = bilibiliConfig?.polling?.interval || 60000; // 默认60秒

    this.logger.info(`启动轮询，间隔: ${interval}ms`);

    // 立即执行一次
    this.pollNextAnchor();

    // 设置定时器
    this.pollingInterval = setInterval(() => {
      this.pollNextAnchor();
    }, interval);
  }

  /**
   * 轮询下一个主播
   */
  private async pollNextAnchor(): Promise<void> {
    if (this.anchors.size === 0) {
      this.logger.debug('没有主播需要轮询');
      return;
    }

    const anchorUids = Array.from(this.anchors.keys());
    const uid = anchorUids[this.currentIndex];
    const anchor = this.anchors.get(uid);

    if (!anchor || !anchor.enabled) {
      this.logger.debug(`跳过主播: ${uid} (未启用)`);
      this.currentIndex = (this.currentIndex + 1) % anchorUids.length;
      return;
    }

    try {
      this.logger.debug(`轮询主播: ${anchor.name} (${uid})`);

      // 获取动态列表
      const dynamics = await this.bilibiliAPI.getDynamics(uid);

      // 过滤新动态
      const newDynamics = await this.filterNewDynamics(dynamics, uid);

      // 触发回调
      for (const dynamic of newDynamics) {
        this.logger.info(`发现新动态: ${dynamic.id}`, { uid, content: dynamic.content.substring(0, 50) });
        
        for (const callback of this.newDynamicCallbacks) {
          try {
            callback(dynamic);
          } catch (error) {
            this.logger.error('新动态回调执行失败', { error, dynamicId: dynamic.id });
          }
        }
      }

      // 更新最后检测时间
      anchor.lastCheckTime = new Date();

    } catch (error) {
      this.logger.error(`轮询主播失败: ${anchor.name} (${uid})`, { error });
    }

    // 移动到下一个主播
    this.currentIndex = (this.currentIndex + 1) % anchorUids.length;
  }

  /**
   * 过滤新动态
   */
  private async filterNewDynamics(dynamics: BilibiliDynamic[], uid: string): Promise<BilibiliDynamic[]> {
    const anchor = this.anchors.get(uid);
    if (!anchor) {
      return [];
    }

    const newDynamics: BilibiliDynamic[] = [];

    for (const dynamic of dynamics) {
      // 检查是否已回复
      const hasReplied = await this.replyHistoryStore.hasReplied(dynamic.id);
      if (hasReplied) {
        this.logger.debug(`动态已回复，跳过: ${dynamic.id}`);
        continue;
      }

      // 检查是否在直播开始后发布
      if (anchor.liveStartTime) {
        if (dynamic.publishTime < anchor.liveStartTime) {
          this.logger.debug(`动态在直播开始前发布，跳过: ${dynamic.id}`, {
            publishTime: dynamic.publishTime,
            liveStartTime: anchor.liveStartTime
          });
          continue;
        }
      }

      newDynamics.push(dynamic);
    }

    return newDynamics;
  }
}
