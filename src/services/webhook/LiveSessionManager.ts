/**
 * 直播会话管理器
 * 用于管理同一场直播的多个片段，并在StreamEnded时触发合并
 * 使用RoomId作为主键，因为一场直播（Stream）可能有多个Session
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';

export const LIVE_RECONNECT_GRACE_MS = 5 * 60 * 1000;

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

export interface NearbySegmentRecoveryOptions {
  enabled?: boolean;
  maxGapSeconds?: number;
  maxSegments?: number;
  minSizeBytes?: number;
  includeBak?: boolean;
  supportedExtensions?: string[];
}

interface RecordingFileInfo {
  roomId: string;
  startTime: Date;
}

interface SegmentCandidate extends LiveSegment {
  startMs: number;
  endMs: number;
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
  private readonly reconnectGraceMs = LIVE_RECONNECT_GRACE_MS;

  /**
   * 创建或获取会话（使用RoomId）
   */
  createOrGetSession(roomId: string, roomName: string, title: string, startTime?: Date): LiveSession {
    let session = this.sessions.get(roomId);
    const previousStatus = session?.status;
    const lastSegment = session?.segments[session.segments.length - 1];
    const now = Date.now();
    const canResumeRecentSession = !!session &&
      session.status !== 'collecting' &&
      !!lastSegment &&
      now - lastSegment.fileCloseTime.getTime() >= 0 &&
      now - lastSegment.fileCloseTime.getTime() <= this.reconnectGraceMs;
    
    // 如果会话不存在，或者旧会话已经进入处理阶段，则重置为新直播会话。
    // 注意：WebhookHandler 会在短时间内的 handleSessionStarted 中取消结算定时器；
    // 如果结算已经启动但又很快开播，仍应当恢复原会话，避免几秒断流被拆成两场。
    if (canResumeRecentSession) {
      const resumedSession = session!;
      const resumedSegment = lastSegment!;
      resumedSession.status = 'collecting';
      resumedSession.roomName = roomName;
      resumedSession.title = title;
      resumedSession.endTime = undefined;
      this.logger.info(`恢复最近直播会话: ${roomId}`, {
        roomId,
        roomName,
        title,
        previousStatus,
        lastSegment: path.basename(resumedSegment.videoPath),
        gapMs: now - resumedSegment.fileCloseTime.getTime()
      });
      session = resumedSession;
    } else if (!session || session.status !== 'collecting') {
      session = {
        roomId,
        roomName,
        title,
        // FileClosed may rebuild a session after a process restart. In that case
        // the recording's FileOpenTime is the only reliable start, not "now".
        startTime: startTime && !Number.isNaN(startTime.getTime()) ? startTime : new Date(),
        segments: [],
        status: 'collecting'
      };
      this.sessions.set(roomId, session);
      this.logger.info(`${previousStatus ? '重置' : '创建'}直播会话: ${roomId}`, {
        roomId,
        roomName,
        title,
        previousStatus
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
  addSegment(roomId: string, videoPath: string, xmlPath: string, fileOpenTime: Date, fileCloseTime: Date, eventTimestamp: Date): boolean {
    const session = this.sessions.get(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      return false;
    }

    const videoPathKey = this.normalizePathKey(videoPath);
    if (session.segments.some(segment => this.normalizePathKey(segment.videoPath) === videoPathKey)) {
      this.logger.info(`忽略重复 FileClosed 片段: ${roomId}`, {
        roomId,
        videoPath: path.basename(videoPath),
        status: session.status
      });
      return false;
    }

    if (session.status !== 'collecting') {
      const lastSegment = session.segments[session.segments.length - 1];
      const reconnectGapMs = lastSegment
        ? fileOpenTime.getTime() - lastSegment.fileCloseTime.getTime()
        : Number.POSITIVE_INFINITY;

      if (lastSegment && reconnectGapMs >= 0 && reconnectGapMs <= this.reconnectGraceMs) {
        const previousStatus = session.status;
        session.status = 'collecting';
        session.endTime = undefined;
        this.logger.info(`恢复最近直播会话以收集续播片段: ${roomId}`, {
          roomId,
          previousStatus,
          reconnectGapMs,
          previousSegment: path.basename(lastSegment.videoPath),
          videoPath: path.basename(videoPath)
        });
      } else {
        this.logger.warn(`会话不在收集状态，跳过添加片段: ${roomId}`, {
          roomId,
          status: session.status,
          videoPath: path.basename(videoPath)
        });
        return false;
      }
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
    return true;
  }

  /**
   * Recover same-stream segments that were missed by in-memory session tracking.
   * This covers process restarts, recorder restarts, and title changes.
   */
  augmentSessionWithNearbySegments(roomId: string, options: NearbySegmentRecoveryOptions = {}): number {
    const session = this.sessions.get(roomId);
    if (!session || session.segments.length === 0) {
      return 0;
    }

    if (options.enabled === false) {
      return 0;
    }

    const maxGapSeconds = Number.isFinite(options.maxGapSeconds)
      ? Number(options.maxGapSeconds)
      : 1800;
    const maxGapMs = Math.max(0, maxGapSeconds) * 1000;
    const maxSegments = Math.max(1, Number(options.maxSegments) || 20);
    const minSizeBytes = Number.isFinite(options.minSizeBytes)
      ? Math.max(0, Number(options.minSizeBytes))
      : 1024 * 1024;
    const supportedExtensions = (options.supportedExtensions || ['.mp4', '.flv', '.mkv', '.ts', '.mov', '.m4a', '.aac', '.mp3', '.wav'])
      .map(ext => ext.toLowerCase());

    const originalKeys = new Set(session.segments.map(segment => this.normalizePathKey(segment.videoPath)));
    const candidatesByPath = new Map<string, SegmentCandidate>();
    const scanDirs = this.getNearbySegmentScanDirs(session.segments, options.includeBak !== false);
    const rejected = {
      unreadableDirectory: 0,
      unsupportedExtension: 0,
      generatedRecording: 0,
      invalidFileName: 0,
      differentRoom: 0,
      missingXml: 0,
      statFailed: 0,
      invalidOrTooSmall: 0,
      alreadyCollected: 0
    };
    let scannedEntries = 0;

    for (const segment of session.segments) {
      const key = this.normalizePathKey(segment.videoPath);
      candidatesByPath.set(key, this.toSegmentCandidate(segment));
    }

    for (const dir of scanDirs) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        rejected.unreadableDirectory += 1;
        continue;
      }

      for (const entry of entries) {
        scannedEntries += 1;
        const fullPath = path.join(dir, entry);
        const ext = path.extname(fullPath).toLowerCase();
        if (!supportedExtensions.includes(ext)) {
          rejected.unsupportedExtension += 1;
          continue;
        }

        const baseName = path.basename(fullPath, ext);
        if (baseName.includes('_merged') || baseName.startsWith('blank_')) {
          rejected.generatedRecording += 1;
          continue;
        }

        const info = this.parseRecordingFileName(path.basename(fullPath));
        if (!info) {
          rejected.invalidFileName += 1;
          continue;
        }
        if (info.roomId !== roomId) {
          rejected.differentRoom += 1;
          continue;
        }

        const xmlPath = path.join(dir, `${baseName}.xml`);
        if (!fs.existsSync(xmlPath)) {
          rejected.missingXml += 1;
          continue;
        }

        let stats: fs.Stats;
        try {
          stats = fs.statSync(fullPath);
        } catch {
          rejected.statFailed += 1;
          continue;
        }

        if (!stats.isFile() || stats.size < minSizeBytes) {
          rejected.invalidOrTooSmall += 1;
          continue;
        }

        const key = this.normalizePathKey(fullPath);
        if (candidatesByPath.has(key)) {
          rejected.alreadyCollected += 1;
          continue;
        }

        const closeTime = stats.mtime > info.startTime ? stats.mtime : info.startTime;
        candidatesByPath.set(key, this.toSegmentCandidate({
          videoPath: fullPath,
          xmlPath,
          fileOpenTime: info.startTime,
          fileCloseTime: closeTime,
          eventTimestamp: closeTime
        }));
      }
    }

    const allCandidates = Array.from(candidatesByPath.entries());
    const selectedKeys = new Set(originalKeys);
    let changed = true;
    while (changed) {
      changed = false;
      const selected = allCandidates
        .filter(([key]) => selectedKeys.has(key))
        .map(([, candidate]) => candidate);

      for (const [key, candidate] of allCandidates) {
        if (selectedKeys.has(key)) {
          continue;
        }

        if (selected.some(selectedCandidate => this.isWithinGap(candidate, selectedCandidate, maxGapMs))) {
          selectedKeys.add(key);
          changed = true;
        }
      }
    }

    let recoveredSegments = allCandidates
      .filter(([key]) => selectedKeys.has(key))
      .map(([, candidate]) => candidate)
      .sort((a, b) => a.fileOpenTime.getTime() - b.fileOpenTime.getTime())
      .slice(0, maxSegments)
      .map(({ startMs, endMs, ...segment }) => segment);

    const addedCount = recoveredSegments.filter(segment => !originalKeys.has(this.normalizePathKey(segment.videoPath))).length;
    if (addedCount === 0) {
      this.logger.info(`Nearby same-stream recovery found no additional segments: ${roomId}`, {
        roomId,
        sessionSegmentCount: session.segments.length,
        maxGapSeconds,
        scanDirs,
        scannedEntries,
        eligibleCandidateCount: Math.max(0, allCandidates.length - originalKeys.size),
        outsideGapCount: Math.max(0, allCandidates.length - selectedKeys.size),
        rejected
      });
      return 0;
    }

    session.segments = recoveredSegments;
    this.logger.info(`Recovered nearby same-stream segments: ${roomId}`, {
      roomId,
      addedCount,
      segmentCount: session.segments.length,
      maxGapSeconds,
      scanDirs,
      scannedEntries,
      outsideGapCount: Math.max(0, allCandidates.length - selectedKeys.size),
      rejected,
      segments: session.segments.map(segment => path.basename(segment.videoPath))
    });

    return addedCount;
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
  getMergeConfig(): { enabled: boolean; maxSegments: number; fillGaps: boolean; backupOriginals: boolean; copyCover: boolean; nearbySegmentRecovery: boolean; nearbySegmentMaxGapSeconds: number } {
    let config: any = {};
    try {
      config = ConfigProvider.getWebhookConfig().streamMerge || {};
    } catch (error) {
      config = {};
    }

    return {
      enabled: true,
      maxSegments: 20,
      fillGaps: true,
      backupOriginals: true,
      copyCover: true,
      nearbySegmentRecovery: true,
      nearbySegmentMaxGapSeconds: 1800,
      ...config
    };
  }

  private getNearbySegmentScanDirs(segments: LiveSegment[], includeBak: boolean): string[] {
    const dirs = new Set<string>();

    for (const segment of segments) {
      const dir = path.dirname(segment.videoPath);
      const base = path.basename(dir).toLowerCase() === 'bak'
        ? path.dirname(dir)
        : dir;

      for (const scanBase of this.getAdjacentDateDirs(base)) {
        dirs.add(scanBase);
        if (includeBak) {
          dirs.add(path.join(scanBase, 'bak'));
        }
      }
    }

    return Array.from(dirs);
  }

  private getAdjacentDateDirs(dir: string): string[] {
    const dirName = path.basename(dir);
    const match = dirName.match(/^(\d{4})([_-]?)(\d{2})\2(\d{2})$/);
    if (!match) {
      return [dir];
    }

    const [, year, separator, month, day] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      parsed.getFullYear() !== Number(year)
      || parsed.getMonth() !== Number(month) - 1
      || parsed.getDate() !== Number(day)
    ) {
      return [dir];
    }

    const parent = path.dirname(dir);
    return [-1, 0, 1].map(offset => {
      const date = new Date(parsed);
      date.setDate(date.getDate() + offset);
      const dateName = [
        String(date.getFullYear()).padStart(4, '0'),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      ].join(separator);
      return path.join(parent, dateName);
    });
  }

  private parseRecordingFileName(fileName: string): RecordingFileInfo | null {
    const match = fileName.match(/^录制-(\d+)-(\d{8})-(\d{6})-\d+-.+\.[^.]+$/);
    if (!match) {
      return null;
    }

    const [, roomId, date, time] = match;
    // Recording filenames contain wall-clock Asia/Shanghai time. Do not let the
    // host process timezone change the resulting instant.
    const startTime = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+08:00`
    );

    if (Number.isNaN(startTime.getTime())) {
      return null;
    }

    return { roomId, startTime };
  }

  private toSegmentCandidate(segment: LiveSegment): SegmentCandidate {
    const startMs = segment.fileOpenTime.getTime();
    const closeMs = segment.fileCloseTime.getTime();
    const endMs = Number.isFinite(closeMs) && closeMs >= startMs ? closeMs : startMs;
    return {
      ...segment,
      startMs,
      endMs
    };
  }

  private isWithinGap(a: SegmentCandidate, b: SegmentCandidate, maxGapMs: number): boolean {
    const gap = Math.max(a.startMs - b.endMs, b.startMs - a.endMs, 0);
    return gap <= maxGapMs;
  }

  private normalizePathKey(filePath: string): string {
    return path.resolve(filePath).toLowerCase();
  }
}
