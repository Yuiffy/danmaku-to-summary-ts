/**
 * 直播会话管理器
 * 用于管理同一场直播的多个片段，并在StreamEnded时触发合并
 * 使用RoomId作为主键，因为一场直播（Stream）可能有多个Session
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';

/**
 * 直播片段信息
 */
export interface LiveSegment {
  videoPath: string;
  xmlPath: string;
  fileOpenTime: Date;
  fileCloseTime: Date;
  eventTimestamp: Date;
}

/**
 * 直播会话信息（使用RoomId作为主键）
 */
export interface LiveSession {
  roomId: string;
  roomName: string;
  title: string;
  startTime: Date;
  endTime?: Date;
  segments: LiveSegment[];
  status: 'collecting' | 'merging' | 'processing' | 'completed';
}

/**
 * 直播会话管理器
 */
export class LiveSessionManager {
  private logger = getLogger('LiveSessionManager');
  private sessions: Map<string, LiveSession> = new Map();

  /**
   * 创建或获取会话（使用RoomId）
   */
  createOrGetSession(roomId: string, roomName: string, title: string): LiveSession {
    let session = this.sessions.get(roomId);
    
    // 如果会话不存在，或者已经标记为已完成（说明由于超时或手动结束已处理过一次），则重置
    // 注意：WebhookHandler 会在 30 秒内的 handleSessionStarted 中取消结算定时器
    // 因此，如果状态已变为 completed，说明已经超过 30s 的判定窗口，应当作为新直播开始
    if (!session || session.status === 'completed') {
      session = {
        roomId,
        roomName,
        title,
        startTime: new Date(),
        segments: [],
        status: 'collecting'
      };
      this.sessions.set(roomId, session);
      this.logger.info(`${session ? '重置' : '创建'}直播会话: ${roomId}`, {
        roomId,
        roomName,
        title
      });
    } else {
      // 仍然在收集中的活跃会话：更新信息并继续使用现有片段（支持断线重连）
      session.roomName = roomName;
      session.title = title;
    }
    
    return session;
  }

  /**
   * 添加片段（使用RoomId）
   */
  addSegment(roomId: string, videoPath: string, xmlPath: string, fileOpenTime: Date, fileCloseTime: Date, eventTimestamp: Date): void {
    const session = this.sessions.get(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      return;
    }

    // 检查是否正在合并，如果是则跳过添加
    if (session.status === 'merging') {
      this.logger.warn(`会话正在合并中，跳过添加片段: ${roomId}`, {
        roomId,
        videoPath: path.basename(videoPath)
      });
      return;
    }

    const segment: LiveSegment = {
      videoPath,
      xmlPath,
      fileOpenTime,
      fileCloseTime,
      eventTimestamp
    };

    session.segments.push(segment);
    this.logger.info(`添加片段到会话: ${roomId}`, {
      roomId,
      segmentCount: session.segments.length,
      videoPath: path.basename(videoPath),
      xmlPath: path.basename(xmlPath)
    });
  }

  /**
   * 获取会话（使用RoomId）
   */
  getSession(roomId: string): LiveSession | undefined {
    return this.sessions.get(roomId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): Map<string, LiveSession> {
    return new Map(this.sessions);
  }

  /**
   * 检查会话是否正在合并
   */
  isMerging(roomId: string): boolean {
    const session = this.sessions.get(roomId);
    return session?.status === 'merging' || false;
  }

  /**
   * 标记会话为合并中
   */
  markAsMerging(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (session) {
      session.status = 'merging';
      this.logger.info(`标记会话为合并中: ${roomId}`);
    }
  }

  /**
   * 标记会话为处理中
   */
  markAsProcessing(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (session) {
      session.status = 'processing';
      this.logger.info(`标记会话为处理中: ${roomId}`);
    }
  }

  /**
   * 标记会话为完成
   */
  markAsCompleted(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (session) {
      session.status = 'completed';
      session.endTime = new Date();
      this.logger.info(`标记会话为完成: ${roomId}`, {
        duration: session.endTime.getTime() - session.startTime.getTime()
      });
    }
  }

  /**
   * 重置会话状态为收集中（用于合并失败后的降级处理）
   */
  resetToCollecting(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (session) {
      session.status = 'collecting';
      this.logger.info(`重置会话状态为收集中: ${roomId}`);
    }
  }

  /**
   * 删除会话
   */
  removeSession(roomId: string): void {
    this.sessions.delete(roomId);
    this.logger.info(`删除会话: ${roomId}`);
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAgeHours: number = 24): void {
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    let cleanedCount = 0;

    for (const [roomId, session] of this.sessions.entries()) {
      // 只清理已完成的会话
      if (session.status === 'completed') {
        const age = now - session.startTime.getTime();
        if (age > maxAge) {
          this.sessions.delete(roomId);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      this.logger.info(`清理了 ${cleanedCount} 个过期会话`);
    }
  }

  /**
   * 检查并移除过期片段
   * @param roomId 房间ID
   * @param maxAgeHours 最大年龄(小时),默认18小时
   * @returns 移除的片段数量
   */
  removeExpiredSegments(roomId: string, maxAgeHours: number = 18): number {
    const session = this.sessions.get(roomId);
    if (!session) {
      return 0;
    }

    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    const originalCount = session.segments.length;

    // 过滤掉过期的片段
    session.segments = session.segments.filter(segment => {
      const age = now - segment.fileCloseTime.getTime();
      if (age > maxAge) {
        this.logger.warn(`移除过期片段: ${path.basename(segment.videoPath)} (年龄: ${(age / 3600000).toFixed(1)}小时)`);
        return false;
      }
      return true;
    });

    const removedCount = originalCount - session.segments.length;
    if (removedCount > 0) {
      this.logger.info(`移除了 ${removedCount} 个过期片段 (房间: ${roomId})`);
    }

    return removedCount;
  }

  /**
   * 检查片段是否有效(未过期且未被处理)
   * @param roomId 房间ID
   * @param maxAgeHours 最大年龄(小时)
   * @returns 是否有有效片段
   */
  hasValidSegments(roomId: string, maxAgeHours: number = 2): boolean {
    const session = this.sessions.get(roomId);
    if (!session || session.segments.length === 0) {
      return false;
    }

    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    // 检查是否有未过期的片段
    return session.segments.some(segment => {
      const age = now - segment.fileCloseTime.getTime();
      return age <= maxAge;
    });
  }

  /**
   * 检查是否需要合并
   */
  shouldMerge(roomId: string): boolean {
    const session = this.sessions.get(roomId);
    if (!session) {
      return false;
    }

    // 单片段场景：不需要合并
    if (session.segments.length === 1) {
      this.logger.info(`单片段场景，不需要合并: ${roomId}`);
      return false;
    }

    // 多片段场景：需要合并
    return true;
  }

  /**
   * 获取合并配置
   */
  getMergeConfig(): { enabled: boolean; maxSegments: number; fillGaps: boolean; backupOriginals: boolean; copyCover: boolean } {
    // TODO: 从配置文件读取合并配置
    // 目前使用默认值
    return {
      enabled: true,
      maxSegments: 20,
      fillGaps: true,
      backupOriginals: true,
      copyCover: true
    };
  }
}
