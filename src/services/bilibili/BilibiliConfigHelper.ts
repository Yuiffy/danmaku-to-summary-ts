/**
 * Bilibili 配置读取工具类
 * 提供统一的配置读取接口，处理 roomId 的字符串/数字转换
 */

import { ConfigProvider } from '../../core/config/ConfigProvider';
import { getLogger } from '../../core/logging/LogManager';
import type {
  AppConfig,
  BilibiliConfig,
  DelayedReplyConfig,
  RoomAIConfig,
} from '../../core/config/ConfigInterface';

/**
 * 主播配置信息
 */
export interface AnchorConfig {
  uid: string;
  name: string;
  roomId: string;
  enabled: boolean;
  delayedReplyEnabled: boolean;
}

/**
 * 延迟回复配置信息
 */
export interface DelayedReplySettings {
  /** 全局是否启用 */
  enabled: boolean;
  /** 主播是否启用 */
  anchorEnabled: boolean;
  /** 延迟时间（分钟） */
  delayMinutes: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟（分钟） */
  retryDelayMinutes: number;
}

/**
 * Bilibili 配置读取工具类
 */
export class BilibiliConfigHelper {
  private static logger = getLogger('BilibiliConfigHelper');

  /**
   * 获取完整配置
   */
  private static getConfig(): AppConfig {
    return ConfigProvider.getConfig();
  }

  /**
   * 获取 Bilibili 配置
   */
  private static getBilibiliConfig(): BilibiliConfig {
    const config = this.getConfig();
    return config.bilibili;
  }

  /**
   * 规范化 roomId（统一转为字符串）
   */
  private static normalizeRoomId(roomId: string | number): string {
    return String(roomId);
  }

  /**
   * 从 AI 配置中获取房间配置
   */
  private static getRoomAIConfig(roomId: string | number): RoomAIConfig | undefined {
    const config = this.getConfig();
    const normalizedRoomId = this.normalizeRoomId(roomId);
    const numericRoomId = parseInt(normalizedRoomId, 10);

    // 尝试字符串键
    let roomConfig = config.ai.roomSettings[normalizedRoomId];
    // 尝试数字键
    if (!roomConfig && !isNaN(numericRoomId)) {
      roomConfig = config.ai.roomSettings[numericRoomId];
    }

    return roomConfig;
  }

  /**
   * 从 Bilibili 配置中获取主播配置
   */
  private static getAnchorConfigFromBilibili(roomId: string | number): AnchorConfig | undefined {
    const bilibiliConfig = this.getBilibiliConfig();
    const normalizedRoomId = this.normalizeRoomId(roomId);
    const numericRoomId = parseInt(normalizedRoomId, 10);

    // 遍历所有主播配置
    for (const [key, anchor] of Object.entries(bilibiliConfig.anchors || {})) {
      // 检查 roomId 是否匹配（字符串或数字）
      if (
        anchor.roomId === normalizedRoomId ||
        anchor.roomId === String(numericRoomId) ||
        key === normalizedRoomId ||
        key === String(numericRoomId)
      ) {
        return {
          uid: anchor.uid,
          name: anchor.name,
          roomId: normalizedRoomId,
          enabled: anchor.enabled,
          delayedReplyEnabled: anchor.delayedReplyEnabled ?? false,
        };
      }
    }

    return undefined;
  }

  /**
   * 获取主播配置（合并 AI 和 Bilibili 配置）
   */
  static getAnchorConfig(roomId: string | number): AnchorConfig | null {
    const normalizedRoomId = this.normalizeRoomId(roomId);

    // 优先从 Bilibili 配置获取
    const bilibiliAnchor = this.getAnchorConfigFromBilibili(roomId);
    if (bilibiliAnchor) {
      return bilibiliAnchor;
    }

    // 从 AI 配置获取
    const roomAIConfig = this.getRoomAIConfig(roomId);
    if (roomAIConfig) {
      return {
        uid: '', // AI 配置中没有 UID，需要通过 API 获取
        name: roomAIConfig.anchorName || '未知主播',
        roomId: normalizedRoomId,
        enabled: true, // AI 配置默认启用
        delayedReplyEnabled: roomAIConfig.enableDelayedReply ?? false,
      };
    }

    this.logger.debug(`未找到主播配置: ${normalizedRoomId}`);
    return null;
  }

  /**
   * 获取主播 UID
   */
  static getAnchorUid(roomId: string | number): string | null {
    const anchorConfig = this.getAnchorConfig(roomId);
    return anchorConfig?.uid || null;
  }

  /**
   * 检查主播是否启用
   */
  static isAnchorEnabled(roomId: string | number): boolean {
    const anchorConfig = this.getAnchorConfig(roomId);
    return anchorConfig?.enabled ?? false;
  }

  /**
   * 获取延迟回复配置
   */
  static getDelayedReplyConfig(): DelayedReplyConfig {
    const bilibiliConfig = this.getBilibiliConfig();
    return bilibiliConfig.delayedReply || {
      enabled: false,
      delayMinutes: 10,
      maxRetries: 3,
      retryDelayMinutes: 5,
    };
  }

  /**
   * 检查延迟回复是否全局启用
   */
  static isDelayedReplyGloballyEnabled(): boolean {
    const config = this.getDelayedReplyConfig();
    return config.enabled;
  }

  /**
   * 检查主播是否启用延迟回复
   */
  static isDelayedReplyEnabledForAnchor(roomId: string | number): boolean {
    const anchorConfig = this.getAnchorConfig(roomId);
    return anchorConfig?.delayedReplyEnabled ?? false;
  }

  /**
   * 获取完整的延迟回复设置
   */
  static getDelayedReplySettings(roomId: string | number): DelayedReplySettings | null {
    const globalConfig = this.getDelayedReplyConfig();

    if (!globalConfig.enabled) {
      this.logger.debug('延迟回复功能未全局启用');
      return null;
    }

    const anchorConfig = this.getAnchorConfig(roomId);
    if (!anchorConfig) {
      this.logger.debug(`未找到主播配置: ${roomId}`);
      return null;
    }

    if (!anchorConfig.delayedReplyEnabled) {
      this.logger.debug(`主播未启用延迟回复: ${roomId}`);
      return null;
    }

    return {
      enabled: globalConfig.enabled,
      anchorEnabled: anchorConfig.delayedReplyEnabled,
      delayMinutes: globalConfig.delayMinutes,
      maxRetries: globalConfig.maxRetries,
      retryDelayMinutes: globalConfig.retryDelayMinutes,
    };
  }

  /**
   * 获取所有启用的主播列表
   */
  static getAllEnabledAnchors(): AnchorConfig[] {
    const bilibiliConfig = this.getBilibiliConfig();
    const anchors: AnchorConfig[] = [];

    for (const [key, anchor] of Object.entries(bilibiliConfig.anchors || {})) {
      if (anchor.enabled) {
        anchors.push({
          uid: anchor.uid,
          name: anchor.name,
          roomId: anchor.roomId || key,
          enabled: anchor.enabled,
          delayedReplyEnabled: anchor.delayedReplyEnabled ?? false,
        });
      }
    }

    return anchors;
  }

  /**
   * 获取所有启用了延迟回复的主播列表
   */
  static getDelayedReplyEnabledAnchors(): AnchorConfig[] {
    const anchors = this.getAllEnabledAnchors();
    return anchors.filter(anchor => anchor.delayedReplyEnabled);
  }
}
