/**
 * 直播会话管理器
 * 用于管理同一场直播的多个片段，并在StreamEnded时触发合并
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
 * 直播会话信息
 */
export interface LiveSession {
  sessionId: string;
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
   * 创建会话
   */
  createSession(sessionId: string, roomId: string, roomName: string, title: string): void {
    const session: LiveSession = {
      sessionId,
      roomId,
      roomName,
      title,
      startTime: new Date(),
      segments: [],
      status: 'collecting'
    };

    this.sessions.set(sessionId, session);
    this.logger.info(`创建直播会话: ${sessionId}`, {
      roomId,
      roomName,
      title
    });
  }

  /**
   * 添加片段
   */
  addSegment(sessionId: string, videoPath: string, xmlPath: string, fileOpenTime: Date, fileCloseTime: Date, eventTimestamp: Date): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`会话不存在: ${sessionId}`);
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
    this.logger.info(`添加片段到会话: ${sessionId}`, {
      sessionId,
      segmentCount: session.segments.length,
      videoPath: path.basename(videoPath),
      xmlPath: path.basename(xmlPath)
    });
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): Map<string, LiveSession> {
    return new Map(this.sessions);
  }

  /**
   * 根据房间ID获取会话（返回最近有片段的活跃会话）
   */
  getSessionByRoomId(roomId: string): LiveSession | undefined {
    let latestSession: LiveSession | undefined;
    let latestTime = 0;

    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && session.status !== 'completed' && session.segments.length > 0) {
        // 找到最近有片段的会话
        const sessionTime = session.startTime.getTime();
        if (sessionTime > latestTime) {
          latestTime = sessionTime;
          latestSession = session;
        }
      }
    }

    return latestSession;
  }

  /**
   * 标记会话为合并中
   */
  markAsMerging(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'merging';
      this.logger.info(`标记会话为合并中: ${sessionId}`);
    }
  }

  /**
   * 标记会话为处理中
   */
  markAsProcessing(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'processing';
      this.logger.info(`标记会话为处理中: ${sessionId}`);
    }
  }

  /**
   * 标记会话为完成
   */
  markAsCompleted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'completed';
      session.endTime = new Date();
      this.logger.info(`标记会话为完成: ${sessionId}`, {
        duration: session.endTime.getTime() - session.startTime.getTime()
      });
    }
  }

  /**
   * 删除会话
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.logger.info(`删除会话: ${sessionId}`);
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAgeHours: number = 24): void {
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      // 只清理已完成的会话
      if (session.status === 'completed') {
        const age = now - session.startTime.getTime();
        if (age > maxAge) {
          this.sessions.delete(sessionId);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      this.logger.info(`清理了 ${cleanedCount} 个过期会话`);
    }
  }

  /**
   * 检查是否需要合并
   */
  shouldMerge(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // 单片段场景：不需要合并
    if (session.segments.length === 1) {
      this.logger.info(`单片段场景，不需要合并: ${sessionId}`);
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
