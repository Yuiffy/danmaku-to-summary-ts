import { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IWebhookHandler } from '../IWebhookService';
import { getLogger } from '../../../core/logging/LogManager';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { FileStabilityChecker } from '../FileStabilityChecker';
import { DuplicateProcessorGuard } from '../DuplicateProcessorGuard';
import { IBilibiliAPIService } from '../../../services/bilibili/interfaces/IBilibiliAPIService';
import { IDelayedReplyService } from '../../../services/bilibili/interfaces/IDelayedReplyService';
import { LIVE_RECONNECT_GRACE_MS, LiveSessionManager, LiveSegment } from '../LiveSessionManager';
import { FileMerger } from '../FileMerger';
import { VideoScreenshotService } from '../../video/VideoScreenshotService';
import { listRelevantProcesses, terminateProcessTree } from '../../../utils/processCleanup';
import { ProcessingAlertService } from '../../monitoring/ProcessingAlertService';
import {
  RecorderStallDiagnostics,
  RecorderStallDiagnosticSnapshot
} from '../../monitoring/RecorderStallDiagnostics';
import { applyFfmpegProcessPriority, getFfmpegResourceConfig } from '../../../utils/ffmpegResource';
import {
  MikufansOfflineFallbackCandidate,
  MikufansOfflineFallbackMonitor,
  MikufansOfflineFallbackTrigger
} from '../MikufansOfflineFallbackMonitor';
import { MikufansAsrResourceController } from './mikufans/MikufansAsrResourceController';
import { MikufansDelayedReplyCoordinator } from './mikufans/MikufansDelayedReplyCoordinator';

const queueManager = require(path.join(process.cwd(), 'src', 'scripts', 'whisper_queue_manager.js'));
const speakerOnceRegistry = require(path.join(process.cwd(), 'src', 'scripts', 'asr', 'speaker_once_registry.js'));
const ASR_PHASE_DONE_SENTINEL = '[[ASR_PHASE_DONE]]';
const LEGACY_WHISPER_PHASE_DONE_SENTINEL = '[[WHISPER_PHASE_DONE]]';

interface QueuedSummaryTask {
  id: string;
  mediaPath: string;
  roomId?: string | number | null;
  priority?: number;
  addedTime?: number;
  status: string;
  xmlPath?: string | null;
  screenshotPath?: string | null;
  enableSpeakerRecognition?: boolean;
  speakerRecognitionRequest?: Record<string, unknown> | null;
}

function encodeSpeakerRequestEnv(request: Record<string, unknown> | null | undefined): string {
  if (!request || typeof request !== 'object') {
    return '';
  }
  try {
    return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  } catch {
    return '';
  }
}

/**
 * 延迟动作类型
 */
enum DelayedActionType {
  STREAM_ENDED = 'stream_ended',           // StreamEnded后等待更多片段
  SESSION_ENDED = 'session_ended',         // SessionEnded后等待SessionStart
  FILE_WITHOUT_SESSION = 'file_no_session', // FileClosed但会话不存在
  SEGMENT_COLLECTION = 'segment_collection', // 收集片段后等待更多片段或结算
  FILE_CLOSE_ALERT = 'file_close_alert',
  RECORDING_START_ALERT = 'recording_start_alert',
  STREAM_END_SEGMENT_ALERT = 'stream_end_segment_alert',
  FINALIZATION_WATCHDOG = 'finalization_watchdog'
}

/**
 * Mikufans Webhook处理器
 */
export class MikufansWebhookHandler implements IWebhookHandler {
  readonly name = 'Mikufans Webhook Handler';
  readonly path = '/mikufans';
  readonly enabled = true;

  private logger = getLogger('MikufansWebhookHandler');
  private stabilityChecker = new FileStabilityChecker();
  private duplicateGuard = new DuplicateProcessorGuard();
  private liveSessionManager = new LiveSessionManager();
  private fileMerger = new FileMerger();
  private screenshotService = new VideoScreenshotService();
  private queueWorkerPromise: Promise<void> | null = null;
  private queueWorkerProcess: ChildProcess | null = null;
  private queueWorkerShouldStop = false;
  private asrGamePaused = false;
  private readonly asrResources = new MikufansAsrResourceController();

  // 延迟处理定时器管理器(roomId -> Map<actionType, timer>)
  private delayedActions: Map<string, Map<DelayedActionType, NodeJS.Timeout>> = new Map();
  // SessionEnded延迟期间收到的待处理文件(roomId -> {videoPath, payload}[])
  private pendingFiles: Map<string, Array<{videoPath: string, payload: any}>> = new Map();
  // Stream事件时间戳记录(roomId -> {startTime?, endTime?})
  private streamTimestamps: Map<string, {startTime?: Date, endTime?: Date}> = new Map();
  private readonly delayedReplyCoordinator: MikufansDelayedReplyCoordinator;
  // Webhook 已明确观察到仍在直播的房间。用于拦截已经开始执行、来不及 clearTimeout 的旧结算回调。
  private activeLiveRooms: Set<string> = new Set();
  private finalFileClosedRooms: Map<string, Date> = new Map();
  // 记录在线 SessionStarted/FileOpening，用于识别先于 StreamStarted 到达的同场录制信号。
  private recorderReadyTimestamps: Map<string, Date> = new Map();
  // 只对本进程实际观察到 FileOpening 的直播报警，避免服务重启后误报历史 StreamEnded。
  private fileOpeningTimestamps: Map<string, Date> = new Map();
  private readonly FILE_CLOSE_ALERT_DELAY_MS = 60 * 1000;
  private readonly MIN_PROCESSABLE_FILE_BYTES = 1024 * 1024;
  // 最大等待时间(毫秒)
  // 断流重连可恢复最近会话；在此窗口内不能把单个分段结算，避免原文件与后续 _merged 文件各处理一次。
  private readonly MAX_DELAY_MS = LIVE_RECONNECT_GRACE_MS;
  private offlineFallbackMonitor: MikufansOfflineFallbackMonitor;
  private recorderStallDiagnostics: RecorderStallDiagnostics;

  constructor() {
    this.delayedReplyCoordinator = new MikufansDelayedReplyCoordinator(
      this.liveSessionManager,
      this.streamTimestamps
    );
    this.offlineFallbackMonitor = new MikufansOfflineFallbackMonitor(
      () => this.getOfflineFallbackCandidates(),
      details => this.handleConfirmedOfflineFallback(details)
    );
    this.recorderStallDiagnostics = new RecorderStallDiagnostics({
      onSnapshot: snapshot => this.handleRecorderStallDiagnostic(snapshot),
      getState: roomId => this.getRecorderDiagnosticState(roomId)
    });
  }


  /**
   * 注册Express路由
   */
  registerRoutes(app: any): void {
    app.post(this.path, this.handleRequest.bind(this));
    this.logger.info(`注册Mikufans Webhook处理器，路径: ${this.path}`);
    this.ensureQueueWorkerRunning();
    this.offlineFallbackMonitor.start();
  }

  /**
   * 处理Webhook请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const eventType = payload.EventType || 'Unknown';
      const eventTime = new Date().toLocaleString();

      // 验证请求
      if (!this.validateRequest(req)) {
        res.status(400).send('Invalid request');
        return;
      }

      // 记录事件
      this.logEvent(payload, eventType, eventTime);

      // 检查是否启用
      const config = ConfigProvider.getConfig();
      if (!config.webhook.endpoints.mikufans.enabled) {
        this.logger.warn('Mikufans录播姬支持未启用');
        res.send('Mikufans recorder not enabled');
        return;
      }

      // 处理事件
      await this.handleEvent(payload, eventType);

      res.send('Mikufans processing started');
    } catch (error: any) {
      this.logger.error(`处理Mikufans Webhook时出错: ${error.message}`, { error });
      res.status(500).send('Internal server error');
    }
  }

  /**
   * 验证请求有效性
   */
  validateRequest(req: Request): boolean {
    // 检查请求体是否存在
    if (!req.body || typeof req.body !== 'object') {
      this.logger.warn('无效的请求体');
      return false;
    }

    // 检查必要字段
    const payload = req.body;
    if (!payload.EventType) {
      this.logger.warn('缺少EventType字段');
      return false;
    }

    return true;
  }

  /**
   * 记录事件日志
   */
  private logEvent(payload: any, eventType: string, eventTime: string): void {
    this.logger.info(`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`);
    this.logger.info(`📅 时间: ${eventTime}`);
    this.logger.info(`📨 事件 (mikufans): ${eventType}`);

    // 提取主播信息
    const roomName = payload.EventData?.Name || '未知主播';
    const roomId = payload.EventData?.RoomId || '未知房间';
    this.logger.info(`👤 主播: ${roomName} (房间: ${roomId})`);

    this.logger.info(`📦 事件数据:`, { payload });
    this.logger.info(`▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`);
  }

  /**
   * 启动延迟处理(统一的30秒计时器管理)
   */
  private startDelayedAction(
    roomId: string | number,
    actionType: DelayedActionType,
    action: () => Promise<void>,
    description: string,
    delayMs = this.MAX_DELAY_MS
  ): void {
    const roomKey = String(roomId);

    // 清除已有的同类型定时器
    this.cancelDelayedAction(roomKey, actionType);

    this.logger.info(`⏳ 启动延迟处理: ${description} (等待 ${delayMs / 1000} 秒)`);

    const timer = setTimeout(async () => {
      // 只移除本次 timer；若同类动作已被新 timer 替换，不会误删新记录。
      this.removeDelayedAction(roomKey, actionType, timer);
      this.logger.info(`⏰ 延迟处理超时触发: ${description}`);
      try {
        await action();
      } catch (error: any) {
        this.logger.error(`延迟处理失败: ${description}: ${error.message}`, { error });
      }
    }, delayMs);

    // 保存定时器
    if (!this.delayedActions.has(roomKey)) {
      this.delayedActions.set(roomKey, new Map());
    }
    this.delayedActions.get(roomKey)!.set(actionType, timer);
  }

  /**
   * 取消延迟处理
   */
  private cancelDelayedAction(roomId: string | number, actionType: DelayedActionType): boolean {
    const roomKey = String(roomId);
    const roomActions = this.delayedActions.get(roomKey);
    if (!roomActions) return false;

    const timer = roomActions.get(actionType);
    if (timer) {
      clearTimeout(timer);
      roomActions.delete(actionType);
      this.logger.info(`🔄 取消延迟处理: ${actionType} (roomId: ${roomKey})`);
      
      // 如果该房间没有其他定时器了,删除整个Map
      if (roomActions.size === 0) {
        this.delayedActions.delete(roomKey);
      }
      return true;
    }
    return false;
  }

  /**
   * 移除延迟处理记录(定时器已执行完毕)
   */
  private removeDelayedAction(
    roomId: string | number,
    actionType: DelayedActionType,
    expectedTimer?: NodeJS.Timeout
  ): void {
    const roomKey = String(roomId);
    const roomActions = this.delayedActions.get(roomKey);
    if (roomActions) {
      if (expectedTimer && roomActions.get(actionType) !== expectedTimer) {
        return;
      }
      roomActions.delete(actionType);
      if (roomActions.size === 0) {
        this.delayedActions.delete(roomKey);
      }
    }
  }

  private hasDelayedAction(roomId: string | number, actionType: DelayedActionType): boolean {
    return this.delayedActions.get(String(roomId))?.has(actionType) === true;
  }

  private getPendingFinalizationActions(roomId: string | number): DelayedActionType[] {
    const roomActions = this.delayedActions.get(String(roomId));
    if (!roomActions) return [];

    return [
      DelayedActionType.STREAM_ENDED,
      DelayedActionType.SEGMENT_COLLECTION
    ].filter(actionType => roomActions.has(actionType));
  }

  private getProcessingAlertDelayMs(configKey: string, defaultSeconds: number): number {
    try {
      const config = ConfigProvider.getConfig() as any;
      const configuredSeconds = Number(config.monitoring?.processingAlerts?.[configKey]);
      if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
        return configuredSeconds * 1000;
      }
    } catch {
      // Use the local default when configuration is unavailable during startup.
    }
    return defaultSeconds * 1000;
  }

  private getRecorderDiagnosticState(roomId: string): Record<string, unknown> {
    const session = this.liveSessionManager.getSession(roomId);
    const timestamps = this.streamTimestamps.get(roomId);
    return {
      activeLive: this.activeLiveRooms.has(roomId),
      sessionStatus: session?.status,
      segmentCount: session?.segments.length || 0,
      streamStartedAt: timestamps?.startTime?.toISOString(),
      streamEndedAt: timestamps?.endTime?.toISOString(),
      pendingDelayedActions: this.getPendingFinalizationActions(roomId)
    };
  }

  private async handleRecorderStallDiagnostic(snapshot: RecorderStallDiagnosticSnapshot): Promise<void> {
    await ProcessingAlertService.notifyRecorderStallDiagnostics(snapshot);
  }

  private rememberRecorderReady(roomId: string | number, timestamp: unknown): Date {
    const roomKey = String(roomId);
    const parsedTime = timestamp ? new Date(String(timestamp)) : new Date();
    const readyTime = Number.isNaN(parsedTime.getTime()) ? new Date() : parsedTime;
    const previous = this.recorderReadyTimestamps.get(roomKey);
    if (!previous || readyTime.getTime() >= previous.getTime()) {
      this.recorderReadyTimestamps.set(roomKey, readyTime);
      return readyTime;
    }
    return previous;
  }

  private isStaleOnlineResumeEvent(
    payload: any,
    source: 'SessionStarted' | 'FileOpening'
  ): boolean {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) return false;

    const roomKey = String(roomId);
    const timestamps = this.streamTimestamps.get(roomKey);
    if (!timestamps) return false;

    const rawEventTime = source === 'FileOpening'
      ? payload.EventData?.FileOpenTime || payload.EventTimestamp
      : payload.EventTimestamp;
    if (!rawEventTime) return false;

    const eventTime = new Date(String(rawEventTime));
    if (Number.isNaN(eventTime.getTime())) return false;

    if (timestamps.endTime && eventTime.getTime() <= timestamps.endTime.getTime()) {
      this.logger.warn(`忽略晚于送达但发生在下播前的 ${source}: ${roomKey}`, {
        eventTime: eventTime.toISOString(),
        streamEndedAt: timestamps.endTime.toISOString()
      });
      return true;
    }

    const clockSkewToleranceMs = 5 * 1000;
    if (
      !timestamps.endTime &&
      timestamps.startTime &&
      eventTime.getTime() < timestamps.startTime.getTime() - clockSkewToleranceMs
    ) {
      this.logger.warn(`忽略早于当前开播时间的过期 ${source}: ${roomKey}`, {
        eventTime: eventTime.toISOString(),
        streamStartedAt: timestamps.startTime.toISOString()
      });
      return true;
    }

    return false;
  }

  private hasCurrentStreamSegment(roomId: string | number): boolean {
    const roomKey = String(roomId);
    const session = this.liveSessionManager.getSession(roomKey);
    if (!session || session.segments.length === 0) return false;

    const streamStartTime = this.streamTimestamps.get(roomKey)?.startTime?.getTime();
    const clockSkewToleranceMs = 5 * 1000;

    return session.segments.some(segment => {
      if (
        streamStartTime !== undefined &&
        segment.fileCloseTime.getTime() < streamStartTime - clockSkewToleranceMs
      ) {
        return false;
      }

      try {
        return fs.existsSync(segment.videoPath) &&
          fs.statSync(segment.videoPath).size >= this.MIN_PROCESSABLE_FILE_BYTES &&
          fs.existsSync(segment.xmlPath);
      } catch {
        return false;
      }
    });
  }

  private shouldMonitorRecordingLifecycle(roomId: string | number, payload: any): boolean {
    if (payload.EventData?.Recording !== false) return true;

    const roomKey = String(roomId);
    const streamStartTime = this.streamTimestamps.get(roomKey)?.startTime?.getTime();
    const recorderReadyAt = this.recorderReadyTimestamps.get(roomKey)?.getTime();
    const clockSkewToleranceMs = 5 * 1000;
    if (
      recorderReadyAt !== undefined &&
      (streamStartTime === undefined || recorderReadyAt >= streamStartTime - clockSkewToleranceMs)
    ) {
      return true;
    }

    return this.hasCurrentStreamSegment(roomKey);
  }

  private ignoreOfflineResumeEvent(payload: any, source: 'SessionStarted' | 'FileOpening'): void {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) return;

    const roomKey = String(roomId);
    const pendingFinalization = this.getPendingFinalizationActions(roomKey);
    const timestamps = this.streamTimestamps.get(roomKey);
    this.logger.warn(`忽略 Streaming=false 的 ${source}，保留当前收尾状态: ${roomKey}`, {
      pendingFinalization,
      streamEndedAt: timestamps?.endTime?.toISOString()
    });

  }

  private markLiveResumed(roomId: string | number, source: string): void {
    const roomKey = String(roomId);
    this.activeLiveRooms.add(roomKey);
    this.finalFileClosedRooms.delete(roomKey);
    this.offlineFallbackMonitor.reset(roomKey);

    const cancelled = [
      DelayedActionType.STREAM_ENDED,
      DelayedActionType.SESSION_ENDED,
      DelayedActionType.FILE_WITHOUT_SESSION,
      DelayedActionType.SEGMENT_COLLECTION,
      DelayedActionType.FILE_CLOSE_ALERT
    ].filter(actionType => this.cancelDelayedAction(roomKey, actionType));

    if (cancelled.length > 0) {
      this.logger.info(`直播已恢复，取消旧结算: ${roomKey}`, {
        source,
        cancelled
      });
    }
  }

  /**
   * 处理事件
   */
  private async handleEvent(payload: any, eventType: string): Promise<void> {
    const sessionId = payload.EventData?.SessionId;
    const recording = payload.EventData?.Recording;

    // 处理直播开始事件（记录时间戳）
    if (eventType === 'StreamStarted') {
      await this.handleStreamStarted(payload);
      return;
    }

    // 处理会话开始事件
    if (eventType === 'SessionStarted' && recording === true) {
      await this.handleSessionStarted(sessionId, payload);
      return;
    }

    // 处理会话结束事件
    if (eventType === 'SessionEnded') {
      await this.handleSessionEnded(sessionId, payload);
      return;
    }

    // 处理直播结束事件
    if (eventType === 'StreamEnded') {
      await this.handleStreamEnded(sessionId, payload);
      return;
    }

    // 处理文件打开事件
    if (eventType === 'FileOpening') {
      await this.handleFileOpening(payload);
      return;
    }

    // 只处理文件关闭事件
    if (eventType !== 'FileClosed') {
      this.logger.info(`忽略非文件事件: ${eventType}`);
      return;
    }

    // 处理文件关闭事件
    await this.handleFileClosed(payload);
  }

  /**
   * 处理直播开始事件（记录时间戳）
   */
  private async handleStreamStarted(payload: any): Promise<void> {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) {
      this.logger.warn(`StreamStarted事件缺少RoomId`);
      return;
    }
    const roomKey = String(roomId);

    // 从 EventTimestamp 提取时间
    const eventTimestamp = payload.EventTimestamp;
    const parsedStartTime = eventTimestamp ? new Date(eventTimestamp) : new Date();
    const startTime = Number.isNaN(parsedStartTime.getTime()) ? new Date() : parsedStartTime;
    const previousTimestamps = this.streamTimestamps.get(roomKey);
    if (
      previousTimestamps?.endTime &&
      startTime.getTime() <= previousTimestamps.endTime.getTime()
    ) {
      this.logger.info(`忽略不晚于已观察下播时间的过期 StreamStarted: ${roomKey}`, {
        startTime: startTime.toISOString(),
        endTime: previousTimestamps.endTime.toISOString()
      });
      return;
    }

    const recorderReadyAt = this.recorderReadyTimestamps.get(roomKey);
    const recorderAlreadyReady = !!recorderReadyAt &&
      recorderReadyAt.getTime() >= startTime.getTime() - 5 * 1000;

    this.cancelDelayedAction(roomKey, DelayedActionType.RECORDING_START_ALERT);
    if (!recorderAlreadyReady) {
      this.fileOpeningTimestamps.delete(roomKey);
      this.recorderReadyTimestamps.delete(roomKey);
    }
    this.markLiveResumed(roomKey, 'StreamStarted');

    this.streamTimestamps.set(roomKey, {
      startTime,
      endTime: undefined
    });
    this.recorderStallDiagnostics.observe('StreamStarted', payload);

    this.logger.info(`📅 记录直播开始时间: ${roomId} -> ${startTime.toISOString()}`);

    if (payload.EventData?.Recording === false) {
      this.logger.info(`跳过缺录制告警: ${roomKey} 的 StreamStarted 明确标记 Recording=false`);
      return;
    }

    if (recorderAlreadyReady) {
      this.logger.info(`StreamStarted 到达前已观察到同场录制信号，不启动缺录制告警: ${roomKey}`, {
        recorderReadyAt: recorderReadyAt?.toISOString(),
        startTime: startTime.toISOString()
      });
      return;
    }

    const expectedStartTime = startTime.getTime();
    this.startDelayedAction(
      roomKey,
      DelayedActionType.RECORDING_START_ALERT,
      async () => {
        const currentStartTime = this.streamTimestamps.get(roomKey)?.startTime?.getTime();
        if (currentStartTime !== expectedStartTime || !this.activeLiveRooms.has(roomKey)) return;

        await ProcessingAlertService.notifyStreamStartedWithoutFileOpening({
          roomId: roomKey,
          roomName: payload.EventData?.Name,
          title: payload.EventData?.Title,
          streamStartedAt: startTime.toISOString(),
          reason: 'StreamStarted was observed, but neither an online SessionStarted nor FileOpening followed'
        });
      },
      `RecordingStartMissing: ${roomKey}`,
      this.getProcessingAlertDelayMs('streamStartNoFileOpeningSeconds', 480)
    );
  }

  /**
   * 处理会话开始事件
   */
  private async handleSessionStarted(sessionId: string, payload: any): Promise<void> {
    const roomName = payload.EventData?.Name || '未知主播';
    const roomId = String(payload.EventData?.RoomId || 'unknown');
    const title = payload.EventData?.Title || '直播';
    const roomKey = String(roomId);

    if (payload.EventData?.Streaming === false) {
      this.ignoreOfflineResumeEvent(payload, 'SessionStarted');
      return;
    }

    if (this.isStaleOnlineResumeEvent(payload, 'SessionStarted')) return;

    this.recorderStallDiagnostics.startSession(payload);

    // 使用LiveSessionManager创建或获取会话（使用RoomId）
    this.liveSessionManager.createOrGetSession(roomId, roomName, title);
    this.rememberRecorderReady(roomKey, payload.EventTimestamp);

    // 任一开播信号都说明旧的 StreamEnded/SessionEnded 结算已经失效。
    this.markLiveResumed(roomKey, 'SessionStarted');
    this.cancelDelayedAction(roomKey, DelayedActionType.RECORDING_START_ALERT);

    // 恢复待处理的文件到新会话（说明是断线重连或事件乱序，这些文件属于当前会话）
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`🔄 恢复待处理文件到会话: ${roomId} (${pendingFiles.length}个文件)`);
      for (const item of pendingFiles) {
        await this.collectSegment(roomId, item.videoPath, item.payload);
      }
      this.pendingFiles.delete(roomId);
    }

    this.logger.info(`🎬 直播开始: ${roomName} (Session: ${sessionId}, Room: ${roomId})`);
  }

  /**
   * 处理文件打开事件
   */
  private ensureSessionFromPayload(roomId: string, payload: any, reason: string): void {
    const roomName = payload.EventData?.Name || 'unknown';
    const title = payload.EventData?.Title || 'live';
    const startTimeValue = payload.EventData?.FileOpenTime || payload.EventData?.StreamStartTime;
    const startTime = startTimeValue ? new Date(startTimeValue) : undefined;
    this.liveSessionManager.createOrGetSession(roomId, roomName, title, startTime);
    this.logger.info(`Rebuilt live session from webhook event: ${roomId} (${reason})`);
  }

  private async handleFileOpening(payload: any): Promise<void> {
    const roomId = payload.EventData?.RoomId;
    if (!roomId) {
      this.logger.warn(`FileOpening事件缺少RoomId`);
      return;
    }
    const roomKey = String(roomId);

    if (payload.EventData?.Streaming === false) {
      this.ignoreOfflineResumeEvent(payload, 'FileOpening');
      return;
    }

    if (this.isStaleOnlineResumeEvent(payload, 'FileOpening')) return;

    this.recorderStallDiagnostics.observe('FileOpening', payload);
    this.markLiveResumed(roomKey, 'FileOpening');
    this.cancelDelayedAction(roomKey, DelayedActionType.RECORDING_START_ALERT);

    const eventTime = payload.EventData?.FileOpenTime || payload.EventTimestamp;
    const openTime = eventTime ? new Date(eventTime) : new Date();
    if (!Number.isNaN(openTime.getTime())) {
      this.fileOpeningTimestamps.set(roomKey, openTime);
      this.rememberRecorderReady(roomKey, openTime);
    } else {
      this.rememberRecorderReady(roomKey, undefined);
    }
    this.logger.info(`📂 FileOpening: ${roomId} (已取消相关延迟处理)`);
  }

  /**
   * 处理会话结束事件
   */
  private async handleSessionEnded(sessionId: string, payload: any): Promise<void> {
    const rawRoomId = payload.EventData?.RoomId;
    if (!rawRoomId) {
      this.logger.warn(`SessionEnded事件缺少RoomId`);
      return;
    }

    const roomId = String(rawRoomId);
    const roomKey = roomId;
    this.recorderStallDiagnostics.observe('SessionEnded', payload);
    const timestamps = this.streamTimestamps.get(roomKey);
    if (timestamps?.endTime && !this.activeLiveRooms.has(roomKey)) {
      const pendingFinalization = this.getPendingFinalizationActions(roomKey);
      if (pendingFinalization.length > 0) {
        this.logger.info(`SessionEnded arrived after StreamEnded; existing finalization remains active: ${roomKey}`, {
          pendingFinalization
        });
        return;
      }

      const sessionAfterEnd = this.liveSessionManager.getSession(roomKey);
      if (!sessionAfterEnd) {
        this.ensureStreamEndSegmentAlert(roomKey, payload, timestamps.endTime);
        this.logger.info(`SessionEnded 在 FileClosed 前到达，继续等待下播片段宽限: ${roomKey}`);
        return;
      }

      if (sessionAfterEnd.status !== 'collecting') {
        this.logger.info(`SessionEnded arrived after finalization had already advanced: ${roomKey}`, {
          status: sessionAfterEnd.status
        });
        return;
      }

      if (!this.hasCurrentStreamSegment(roomId)) {
        this.ensureStreamEndSegmentAlert(roomKey, payload, timestamps.endTime);
        this.logger.info(`SessionEnded 到达时尚无有效片段，继续等待下播片段宽限: ${roomKey}`);
        return;
      }

      this.startDelayedAction(
        roomId,
        DelayedActionType.STREAM_ENDED,
        async () => {
          await this.processStreamEnded(roomId);
        },
        `RecoveredFinalizationAfterSessionEnded: ${roomKey}`
      );
      this.startFinalizationWatchdog(roomId, payload, timestamps.endTime);

      void ProcessingAlertService.notifyFinalizationStuck({
        roomId: roomKey,
        roomName: payload.EventData?.Name,
        title: payload.EventData?.Title,
        sessionId,
        streamStartedAt: timestamps.startTime?.toISOString(),
        streamEndedAt: timestamps.endTime.toISOString(),
        segmentCount: sessionAfterEnd?.segments.length || 0,
        status: sessionAfterEnd?.status,
        cancelledActions: [],
        reason: 'SessionEnded observed an earlier StreamEnded, but no finalization timer remained'
      });
      return;
    }

    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      // 会话存在,启动延迟处理,等待FileOpen或SessionStart
      this.logger.info(`📝 会话结束 (会话存在): ${session.roomName} (Room: ${roomId})`);
      
      this.startDelayedAction(
        roomId,
        DelayedActionType.SESSION_ENDED,
        async () => {
          await this.processSessionEndedWithSession(roomId);
        },
        `SessionEnded(会话存在): ${roomId}`
      );
      return;
    }

    // 会话不存在，可能是网络不稳定导致的SessionStart丢失
    // 启动延迟处理，等待30秒看是否有SessionStart
    this.startDelayedAction(
      roomId,
      DelayedActionType.SESSION_ENDED,
      async () => {
        await this.processSessionEndedWithoutSession(roomId, payload);
      },
      `SessionEnded(会话不存在): ${roomId}`
    );
  }

  /**
   * 处理会话存在时的SessionEnded（延迟30秒后执行）
   */
  private async processSessionEndedWithSession(roomId: string): Promise<void> {
    // 再次检查会话是否存在
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.info(`📝 延迟处理时会话已不存在: ${roomId}`);
      return;
    }

    this.logger.info(`SessionEnded delay elapsed for ${roomId}; waiting for StreamEnded before final processing`);
  }

  /**
   * 处理没有会话的SessionEnded（延迟30秒后执行）
   */
  private async processSessionEndedWithoutSession(roomId: string, payload: any): Promise<void> {
    // 再次检查会话是否存在（可能在延迟期间收到了SessionStart）
    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      this.logger.info(`📝 延迟处理时发现会话已存在，跳过处理: ${roomId}`);
      // 清除待处理文件（这些文件属于新会话）
      this.pendingFiles.delete(roomId);
      return;
    }

    this.logger.info(`📝 SessionEnded延迟结束: ${roomId} (会话仍不存在，开始处理待处理文件)`);

    // 处理延迟期间收到的文件
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`Keeping ${pendingFiles.length} pending files for ${roomId}; waiting for StreamEnded`);
    } else {
      this.logger.info(`ℹ️  没有待处理的文件`);
    }
  }

  /**
   * 处理没有会话时收到的文件（延迟30秒后执行）
   */
  private async processFilesWithoutSession(roomId: string): Promise<void> {
    // 再次检查会话是否存在（可能在延迟期间收到了SessionStart或FileOpening）
    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      this.logger.info(`📝 延迟处理时发现会话已存在，跳过处理: ${roomId}`);
      // 清除待处理文件（这些文件属于新会话）
      this.pendingFiles.delete(roomId);
      return;
    }

    this.logger.info(`📝 延迟结束: ${roomId} (会话仍不存在，开始处理待处理文件)`);

    // 处理延迟期间收到的文件
    const pendingFiles = this.pendingFiles.get(roomId);
    if (pendingFiles && pendingFiles.length > 0) {
      this.logger.info(`Keeping ${pendingFiles.length} pending files for ${roomId}; waiting for StreamEnded`);
    } else {
      this.logger.info(`ℹ️  没有待处理的文件`);
    }
  }

  /**
   * 处理直播结束事件
   */
  private async handleStreamEnded(sessionId: string, payload: any): Promise<void> {
    const rawRoomId = payload.EventData?.RoomId;
    if (!rawRoomId) {
      this.logger.warn(`StreamEnded事件缺少RoomId`);
      return;
    }
    const roomId = String(rawRoomId);
    const roomKey = roomId;

    // 从 EventTimestamp 提取时间并记录
    const eventTimestamp = payload.EventTimestamp;
    const parsedEndTime = eventTimestamp ? new Date(eventTimestamp) : new Date();
    const endTime = Number.isNaN(parsedEndTime.getTime()) ? new Date() : parsedEndTime;
    const existing = this.streamTimestamps.get(roomKey) || {};
    if (existing.endTime && !this.activeLiveRooms.has(roomKey)) {
      this.logger.info(`忽略未观察到恢复信号的重复 StreamEnded: ${roomKey}`, {
        previousEndTime: existing.endTime.toISOString(),
        duplicateEndTime: endTime.toISOString()
      });
      return;
    }
    if (existing.startTime && endTime.getTime() <= existing.startTime.getTime()) {
      this.logger.info(`忽略早于最近开播时间的过期 StreamEnded: ${roomKey}`, {
        startTime: existing.startTime.toISOString(),
        endTime: endTime.toISOString()
      });
      return;
    }
    this.streamTimestamps.set(roomKey, {
      ...existing,
      endTime
    });
    this.recorderStallDiagnostics.observe('StreamEnded', payload);

    this.logger.info(`📅 记录直播结束时间: ${roomId} -> ${endTime.toISOString()}`);
    this.cancelDelayedAction(roomKey, DelayedActionType.RECORDING_START_ALERT);
    this.activeLiveRooms.delete(roomKey);
    this.startStreamEndSegmentAlert(roomId, payload, endTime);

    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      this.startMissingFileCloseAlert(roomKey, payload, 'StreamEnded(no session)');
      return;
    }

    this.logger.info(`🏁 直播结束 (收到事件): ${session.roomName} (Room: ${roomId}, 当前片段数: ${session.segments.length})`);
    this.startMissingFileCloseAlert(roomKey, payload, 'StreamEnded');

    if (session.status !== 'collecting') {
      this.logger.info(`StreamEnded 不会重新处理已进入后续阶段的会话: ${roomKey}`, {
        status: session.status
      });
      return;
    }

    // 启动动态延迟等待
    this.startDelayedAction(
      roomId,
      DelayedActionType.STREAM_ENDED,
      async () => {
        await this.processStreamEnded(roomId);
      },
      `StreamEnded: ${roomId}`
    );
    this.startFinalizationWatchdog(roomId, payload, endTime);
  }

  private startStreamEndSegmentAlert(roomId: string | number, payload: any, endTime: Date): void {
    const roomKey = String(roomId);
    if (!this.shouldMonitorRecordingLifecycle(roomKey, payload)) {
      this.logger.info(`跳过下播无片段告警: ${roomKey} 明确未录制且没有本场录制证据`);
      return;
    }

    const expectedEndTime = endTime.getTime();
    this.startDelayedAction(
      roomKey,
      DelayedActionType.STREAM_END_SEGMENT_ALERT,
      async () => {
        const timestamps = this.streamTimestamps.get(roomKey);
        if (
          timestamps?.endTime?.getTime() !== expectedEndTime ||
          this.activeLiveRooms.has(roomKey) ||
          this.hasCurrentStreamSegment(roomId)
        ) {
          return;
        }

        const session = this.liveSessionManager.getSession(roomKey);
        void ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment({
          roomId: roomKey,
          roomName: payload.EventData?.Name,
          title: payload.EventData?.Title,
          sessionId: payload.EventData?.SessionId,
          streamStartedAt: timestamps?.startTime?.toISOString(),
          streamEndedAt: endTime.toISOString(),
          segmentCount: session?.segments.length || 0,
          status: session?.status,
          reason: 'StreamEnded was observed without a processable segment from the current stream'
        });
      },
      `StreamEndNoSegment: ${roomKey}`,
      this.getProcessingAlertDelayMs('streamEndNoSegmentGraceSeconds', 60)
    );
  }

  private ensureStreamEndSegmentAlert(roomId: string | number, payload: any, endTime: Date): void {
    if (this.hasDelayedAction(roomId, DelayedActionType.STREAM_END_SEGMENT_ALERT)) return;
    this.startStreamEndSegmentAlert(roomId, payload, endTime);
  }

  private startFinalizationWatchdog(roomId: string | number, payload: any, endTime: Date): void {
    const roomKey = String(roomId);
    const expectedEndTime = endTime.getTime();
    const watchdogDelayMs = this.MAX_DELAY_MS +
      this.getProcessingAlertDelayMs('finalizationWatchdogGraceSeconds', 60);

    this.startDelayedAction(
      roomKey,
      DelayedActionType.FINALIZATION_WATCHDOG,
      async () => {
        const timestamps = this.streamTimestamps.get(roomKey);
        if (
          timestamps?.endTime?.getTime() !== expectedEndTime ||
          this.activeLiveRooms.has(roomKey)
        ) {
          return;
        }

        const session = this.liveSessionManager.getSession(roomKey);
        if (!session || session.status !== 'collecting') return;

        const pendingFinalization = this.getPendingFinalizationActions(roomKey);
        if (pendingFinalization.length > 0) return;

        void ProcessingAlertService.notifyFinalizationStuck({
          roomId: roomKey,
          roomName: payload.EventData?.Name,
          title: payload.EventData?.Title,
          sessionId: payload.EventData?.SessionId,
          streamStartedAt: timestamps?.startTime?.toISOString(),
          streamEndedAt: endTime.toISOString(),
          segmentCount: session.segments.length,
          status: session.status,
          cancelledActions: [],
          reason: 'No finalization timer remained after the reconnect grace window; attempting recovery'
        });

        if (this.hasCurrentStreamSegment(roomId)) {
          await this.processStreamEnded(roomKey);
        }
      },
      `FinalizationWatchdog: ${roomKey}`,
      watchdogDelayMs
    );
  }

  private startMissingFileCloseAlert(roomId: string, payload: any, reason: string): void {
    const roomKey = String(roomId);
    const openedAt = this.fileOpeningTimestamps.get(roomKey);
    if (!openedAt) {
      this.logger.info(`跳过FileClose缺失提醒: ${roomKey} 本轮直播未观察到FileOpening`);
      return;
    }

    this.startDelayedAction(
      roomKey,
      DelayedActionType.FILE_CLOSE_ALERT,
      async () => {
        await ProcessingAlertService.notifyMissingFileCloseAfterStreamEnd({
          roomId: roomKey,
          roomName: payload.EventData?.Name,
          title: payload.EventData?.Title,
          sessionId: payload.EventData?.SessionId,
          fileOpenedAt: openedAt.toISOString(),
          eventTimestamp: payload.EventTimestamp,
          reason
        });
      },
      `FileCloseMissingAlert: ${roomKey}`,
      this.FILE_CLOSE_ALERT_DELAY_MS
    );
  }

  /**
   * 延迟处理直播结束（等待FileClosed事件完成）
   */
  private async processStreamEnded(roomId: string): Promise<void> {
    // 立即取消所有相关的延迟处理，防止重复触发结算
    this.cancelDelayedAction(roomId, DelayedActionType.STREAM_ENDED);
    this.cancelDelayedAction(roomId, DelayedActionType.SESSION_ENDED);
    this.cancelDelayedAction(roomId, DelayedActionType.SEGMENT_COLLECTION);
    const roomKey = String(roomId);

    if (this.activeLiveRooms.has(roomKey)) {
      this.logger.info(`直播已恢复，忽略过期的结束结算: ${roomKey}`);
      return;
    }

    this.finalFileClosedRooms.delete(roomKey);

    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`延迟处理时会话不存在: ${roomId}`);
      return;
    }

    if (session.status !== 'collecting') {
      this.logger.info(`忽略已进入后续阶段会话的重复结束结算: ${roomId}`, {
        status: session.status
      });
      return;
    }

    if (!this.hasCurrentStreamSegment(roomId)) {
      const timestamps = this.streamTimestamps.get(roomKey);
      void ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment({
        roomId: roomKey,
        roomName: session.roomName,
        title: session.title,
        streamStartedAt: timestamps?.startTime?.toISOString(),
        streamEndedAt: timestamps?.endTime?.toISOString(),
        segmentCount: session.segments.length,
        status: session.status,
        reason: 'Finalization was skipped because the session has no processable segment from the current stream'
      });
      return;
    }

    this.logger.info(`🏁 直播结束 (延迟处理): ${session.roomName} (Room: ${roomId}, 最终片段数: ${session.segments.length})`);

    const mergeConfig = this.liveSessionManager.getMergeConfig();
    if (mergeConfig.nearbySegmentRecovery) {
      const recoveredCount = this.liveSessionManager.augmentSessionWithNearbySegments(roomId, {
        enabled: mergeConfig.nearbySegmentRecovery,
        maxGapSeconds: mergeConfig.nearbySegmentMaxGapSeconds,
        maxSegments: mergeConfig.maxSegments
      });
      if (recoveredCount > 0) {
        this.logger.info(`🔄 已补收同场直播的邻近片段: ${roomId} (+${recoveredCount})`);
      }
    }

    // ⚠️ 关键修复: 移除过期片段(超过18小时的片段)
    const removedCount = this.liveSessionManager.removeExpiredSegments(roomId, 18);
    if (removedCount > 0) {
      this.logger.warn(`⚠️ 移除了 ${removedCount} 个过期片段 (房间: ${roomId})`);
    }

    // ⚠️ 关键修复: 检查是否还有有效片段
    if (!this.liveSessionManager.hasValidSegments(roomId, 2)) {
      this.logger.warn(`⚠️ 会话中没有有效片段(所有片段都已过期或被处理), 跳过处理: ${roomId}`);
      this.liveSessionManager.markAsCompleted(roomId);
      return;
    }

    // 重新获取会话(因为可能已经移除了过期片段)
    const updatedSession = this.liveSessionManager.getSession(roomId);
    if (!updatedSession || updatedSession.segments.length === 0) {
      this.logger.warn(`移除过期片段后会话为空: ${roomId}`);
      this.liveSessionManager.markAsCompleted(roomId);
      return;
    }

    this.logger.info(`📊 有效片段数: ${updatedSession.segments.length}`);

    // 检查是否需要合并
    const shouldMerge = this.liveSessionManager.shouldMerge(roomId);

    if (shouldMerge) {
      // 多片段场景：触发合并
      await this.mergeAndProcessSession(roomId);
    } else if (updatedSession.segments.length === 1) {
      // 单片段场景：直接处理
      await this.processSingleSegment(roomId);
    } else {
      this.logger.warn(`会话没有片段: ${roomId}`);
      this.liveSessionManager.markAsCompleted(roomId);
    }
  }

  /**
   * 处理文件关闭事件
   */
  private async handleFileClosed(payload: any): Promise<void> {
    const relativePath = payload.EventData?.RelativePath;
    if (!relativePath) {
      this.logger.warn('未找到RelativePath字段');
      return;
    }

    // 构建完整文件路径
    const config = ConfigProvider.getConfig();
    const basePath = config.webhook.endpoints.mikufans.basePath || 'D:/files/videos/DDTV录播';
    const fullPath = path.join(basePath, relativePath);
    const normalizedPath = path.normalize(fullPath);

    this.logger.info(`📁 文件路径: ${normalizedPath}`);

    const rawRoomId = payload.EventData?.RoomId;
    const roomId = rawRoomId ? String(rawRoomId) : undefined;
    if (roomId) this.recorderStallDiagnostics.observe('FileClosed', payload);
    let observedEndBeforeFileClose: Date | undefined;
    if (roomId) {
      const roomKey = String(roomId);
      this.cancelDelayedAction(roomKey, DelayedActionType.FILE_CLOSE_ALERT);
      this.fileOpeningTimestamps.delete(roomKey);
      const timestamps = this.streamTimestamps.get(roomKey);
      const hasObservedOfflineEnd = !!timestamps?.endTime && !this.activeLiveRooms.has(roomKey);
      if (payload.EventData?.Streaming === false || hasObservedOfflineEnd) {
        const closeTime = new Date(payload.EventData?.FileCloseTime || payload.EventTimestamp || Date.now());
        const normalizedCloseTime = Number.isNaN(closeTime.getTime()) ? new Date() : closeTime;
        const latestStartTime = timestamps?.startTime;
        const clockSkewToleranceMs = 5 * 1000;
        if (
          !latestStartTime ||
          normalizedCloseTime.getTime() >= latestStartTime.getTime() - clockSkewToleranceMs
        ) {
          this.finalFileClosedRooms.set(roomKey, normalizedCloseTime);
          this.activeLiveRooms.delete(roomKey);
          observedEndBeforeFileClose = hasObservedOfflineEnd ? timestamps?.endTime : undefined;
          this.logger.info(`FileClosed indicates stream is offline; will finalize after segment collection timeout: ${roomKey}`);
        } else {
          this.logger.info(`忽略早于最近开播时间的过期 FileClosed 结束标记: ${roomKey}`, {
            startTime: latestStartTime.toISOString(),
            closeTime: normalizedCloseTime.toISOString()
          });
        }
      }
    }

    // 检查文件扩展名
    const ext = path.extname(normalizedPath).toLowerCase();
    const supportedExtensions = ['.mp4', '.flv', '.mkv', '.ts', '.mov', '.m4a', '.aac', '.mp3', '.wav'];

    if (!supportedExtensions.includes(ext)) {
      this.logger.warn(`不支持的文件类型: ${ext}`);
      return;
    }

    // 检查文件大小，小于1MB则跳过处理
    try {
      if (fs.existsSync(normalizedPath)) {
        const fileSize = fs.statSync(normalizedPath).size;
        const fileSizeInMB = fileSize / (1024 * 1024);
        const minSizeMB = this.MIN_PROCESSABLE_FILE_BYTES / (1024 * 1024);

        if (fileSizeInMB < minSizeMB) {
          this.logger.info(`⏭️  文件过小 (${fileSizeInMB.toFixed(2)}MB < ${minSizeMB}MB)，跳过处理: ${path.basename(normalizedPath)}`);
          return;
        }
      }
    } catch (error: any) {
      this.logger.warn(`检查文件大小时出错: ${error.message}`);
    }

    // 收集片段到会话
    if (roomId) {
      await this.collectSegment(roomId, normalizedPath, payload);
      if (this.hasCurrentStreamSegment(roomId)) {
        this.cancelDelayedAction(roomId, DelayedActionType.STREAM_END_SEGMENT_ALERT);
      }
      const session = this.liveSessionManager.getSession(roomId);
      if (
        observedEndBeforeFileClose &&
        session?.status === 'collecting' &&
        !this.hasDelayedAction(roomId, DelayedActionType.FINALIZATION_WATCHDOG)
      ) {
        this.startFinalizationWatchdog(roomId, payload, observedEndBeforeFileClose);
      }
    } else {
      // 如果没有roomId，直接处理文件（兼容旧逻辑）
      await this.processMikufansFile(normalizedPath, payload);
    }
  }

  /**
   * 收集片段到会话
   */
  private async collectSegment(roomId: string, videoPath: string, payload: any): Promise<void> {
    let session = this.liveSessionManager.getSession(roomId);
    const reconstructedSession = !session;
    if (!session) {
      this.ensureSessionFromPayload(roomId, payload, 'FileClosed without active session');
      session = this.liveSessionManager.getSession(roomId);
      if (!session) {
        // 会话不存在，将文件加入待处理队列
        if (!this.pendingFiles.has(roomId)) {
          this.pendingFiles.set(roomId, []);
        }
        this.pendingFiles.get(roomId)!.push({videoPath, payload});

        // 启动延迟处理
        this.startDelayedAction(
          roomId,
          DelayedActionType.FILE_WITHOUT_SESSION,
          async () => {
            await this.processFilesWithoutSession(roomId);
          },
          `FileClosed(会话不存在): ${roomId}`
        );

        this.logger.info(`📝 会话不存在，文件加入待处理队列: ${roomId} (${path.basename(videoPath)})`);
        return;
      }
    }

    // 查找对应的xml文件
    const dir = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const xmlPath = path.join(dir, `${baseName}.xml`);

    // 检查xml文件是否存在
    if (!fs.existsSync(xmlPath)) {
      this.logger.warn(`未找到XML文件: ${path.basename(xmlPath)}，跳过收集`);
      return;
    }

    // 获取文件时间信息
    const fileOpenTime = new Date(payload.EventData?.FileOpenTime || Date.now());
    const fileCloseTime = new Date(payload.EventData?.FileCloseTime || Date.now());
    const eventTimestamp = new Date();

    // 添加片段到会话
    const added = this.liveSessionManager.addSegment(
      roomId,
      videoPath,
      xmlPath,
      fileOpenTime,
      fileCloseTime,
      eventTimestamp
    );

    if (!added) {
      this.logger.warn(`⚠️  片段未加入会话，跳过片段收集定时器: ${roomId} (${path.basename(videoPath)})`);
      return;
    }

    if (reconstructedSession) {
      const mergeConfig = this.liveSessionManager.getMergeConfig();
      if (mergeConfig.nearbySegmentRecovery) {
        const recoveredCount = this.liveSessionManager.augmentSessionWithNearbySegments(roomId, {
          enabled: mergeConfig.nearbySegmentRecovery,
          maxGapSeconds: mergeConfig.nearbySegmentMaxGapSeconds,
          maxSegments: mergeConfig.maxSegments
        });
        if (recoveredCount > 0) {
          this.logger.info(`🔄 重建会话后立即补收同场直播片段: ${roomId} (+${recoveredCount})`);
        }
      }
    }

    this.logger.info(`📦 收集片段: ${path.basename(videoPath)} (会话: ${roomId}, 片段数: ${session.segments.length})`);

    // 启动/重置片段收集延迟处理(等待更多片段或超时结算)
    this.startDelayedAction(
      roomId,
      DelayedActionType.SEGMENT_COLLECTION,
      async () => {
        await this.processSegmentCollectionTimeout(roomId);
      },
      `SegmentCollection: ${roomId}`
    );
  }

  /**
   * 处理片段收集超时
   */
  private async processSegmentCollectionTimeout(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.info(`📝 片段收集超时，但会话已不存在: ${roomId}`);
      return;
    }

    const finalFileClosedAt = this.finalFileClosedRooms.get(String(roomId));
    if (finalFileClosedAt) {
      this.logger.info(`Segment collection timeout for ${roomId}; final FileClosed observed at ${finalFileClosedAt.toISOString()}, processing stream end`);
      await this.processStreamEnded(roomId);
      return;
    }

    this.logger.info(`Segment collection timeout for ${roomId}; waiting for StreamEnded before final processing`);
  }

  private getOfflineFallbackCandidates(): MikufansOfflineFallbackCandidate[] {
    const candidates: MikufansOfflineFallbackCandidate[] = [];

    for (const [roomId, session] of this.liveSessionManager.getAllSessions()) {
      // Downstream processing may already have completed while the recorder's
      // active-room flag remained stale, so do not require collecting here.
      if (
        !this.activeLiveRooms.has(roomId) ||
        this.streamTimestamps.get(roomId)?.endTime ||
        !this.hasCurrentStreamSegment(roomId)
      ) {
        continue;
      }

      const latestSegmentActivityAt = session.segments.reduce<Date | undefined>((latest, segment) => {
        const candidateTimes = [segment.eventTimestamp, segment.fileCloseTime]
          .filter(value => value && !Number.isNaN(value.getTime()));
        const segmentLatest = candidateTimes.reduce<Date | undefined>((current, value) => {
          if (!current || value.getTime() > current.getTime()) return value;
          return current;
        }, undefined);
        if (!segmentLatest || (latest && latest.getTime() >= segmentLatest.getTime())) return latest;
        return segmentLatest;
      }, undefined);

      candidates.push({
        roomId,
        roomName: session.roomName,
        title: session.title,
        segmentCount: session.segments.length,
        streamStartedAt: this.streamTimestamps.get(roomId)?.startTime || session.startTime,
        latestSegmentActivityAt
      });
    }

    return candidates;
  }

  private async handleConfirmedOfflineFallback(details: MikufansOfflineFallbackTrigger): Promise<void> {
    const roomId = details.candidate.roomId;
    const session = this.liveSessionManager.getSession(roomId);
    const timestamps = this.streamTimestamps.get(roomId);
    if (
      !session ||
      !this.activeLiveRooms.has(roomId) ||
      timestamps?.endTime ||
      !this.hasCurrentStreamSegment(roomId)
    ) {
      this.logger.info(`Offline fallback became stale before sending its alert: ${roomId}`);
      return;
    }

    await ProcessingAlertService.notifyMikufansOfflineStateStuck({
      roomId,
      roomName: session.roomName,
      title: session.title,
      streamStartedAt: timestamps?.startTime?.toISOString() || session.startTime.toISOString(),
      segmentCount: session.segments.length,
      status: session.status,
      consecutiveConfirmations: details.consecutiveConfirmations,
      offlineSince: details.offlineSince.toISOString(),
      offlineGraceSeconds: details.offlineGraceSeconds,
      bilibiliLiveStatus: details.status.liveStatus
    });
  }

  /**
   * 处理Mikufans文件
   */
  private async processMikufansFile(filePath: string, payload: any): Promise<void> {
    const fileName = path.basename(filePath);

    // 检查去重
    if (this.duplicateGuard.isDuplicate(filePath)) {
      this.logger.warn(`跳过：文件已在处理队列中 -> ${fileName}`);
      return;
    }

    // 加入去重缓存
    this.duplicateGuard.markAsProcessing(filePath);

    this.logger.info(`FileClosed事件：检查文件稳定... (${fileName})`);

    // 等待文件稳定
    const isStable = await this.stabilityChecker.waitForFileStability(filePath);
    if (!isStable) {
      this.logger.error(`文件稳定性检查失败: ${fileName}`);
      this.duplicateGuard.markAsProcessed(filePath);
      return;
    }

    this.logger.info(`✅ 文件已稳定，开始处理: ${fileName}`);

    // 查找对应的xml文件（如果有）
    let targetXml = null;
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // 尝试查找同目录下的xml文件
    try {
      const expectedXmlName = baseName + '.xml';
      const xmlPath = path.join(dir, expectedXmlName);
      if (fs.existsSync(xmlPath)) {
        targetXml = xmlPath;
        this.logger.info(`📄 找到对应的弹幕文件: ${path.basename(targetXml)}`);
      } else {
        // 如果没有完全匹配的同名文件，可以尝试查找包含视频文件名的xml文件作为备选
        const files = fs.readdirSync(dir);
        const xmlFiles = files.filter(f => f.endsWith('.xml') && f.includes(baseName));
        if (xmlFiles.length > 0) {
          targetXml = path.join(dir, xmlFiles[0]);
          this.logger.info(`📄 找到备选弹幕文件（包含视频名）: ${path.basename(targetXml)}`);
        } else {
          this.logger.info(`ℹ️ 未找到弹幕文件: 目录中没有 ${expectedXmlName}`);
        }
      }
    } catch (error: any) {
      this.logger.info(`ℹ️ 查找弹幕文件时出错: ${error.message}`);
    }

    // 获取roomId
    let roomId = payload.EventData?.RoomId || null;

    // 如果 payload 中没有 roomId，尝试从文件名中提取
    if (!roomId) {
      const fileNameForMatch = path.basename(filePath);
      // 尝试匹配 "录制-23197314-..." 或 "23197314-..." 格式
      const match = fileNameForMatch.match(/(?:录制-)?(\d+)-/);
      if (match) {
        roomId = match[1];
        this.logger.info(`🔍 从文件名提取房间ID: ${roomId}`);
      }
    }

    const finalRoomId = roomId || 'unknown';

    // 启动处理流程
    await this.startProcessing(filePath, targetXml, finalRoomId);
  }

  /**
   * 延迟等待
   */
  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async isGpuBusyForWhisper(): Promise<{ busy: boolean; reason: string }> {
    return this.asrResources.isLegacyGpuBusy();
  }

  private async isAsrGameRunning(): Promise<{ busy: boolean; reason: string; waitMs: number }> {
    return this.asrResources.isGameRunning();
  }

  private isAdaptiveParaformerGpuProtectionEnabled(config: any): boolean {
    return this.asrResources.isAdaptiveGpuProtectionEnabled(config);
  }

  private async ensurePersistentAsrWorker(): Promise<void> {
    await this.asrResources.ensurePersistentWorker();
  }

  private async stopPersistentAsrWorker(reason: string): Promise<void> {
    await this.asrResources.stopPersistentWorker(reason);
  }

  private ensureQueueWorkerRunning(): void {
    if (this.queueWorkerPromise) {
      return;
    }

    this.queueWorkerShouldStop = false;
    this.queueWorkerPromise = this.runQueueWorkerLoop()
      .catch((error: any) => {
        this.logger.error(`Mikufans队列Worker异常退出: ${error.message}`, { error });
      })
      .finally(async () => {
        await this.stopPersistentAsrWorker('队列 worker 退出');
        this.queueWorkerPromise = null;
        this.queueWorkerProcess = null;
        this.asrGamePaused = false;
        const pendingTask = queueManager.getNextPendingTask({ reload: true }) as QueuedSummaryTask | null;
        if (pendingTask) {
          this.logger.info('队列 worker 清理期间收到新任务，立即重新唤醒');
          this.ensureQueueWorkerRunning();
        }
      });
  }

  /**
   * 集中队列 worker 主循环
   */
  private async runQueueWorkerLoop(): Promise<void> {
    this.logger.info('Mikufans队列Worker已启动');
    const config: any = ConfigProvider.getConfig();
    const idleWaitMs = config.whisper?.gpuDetection?.checkIntervalSeconds
      ? config.whisper.gpuDetection.checkIntervalSeconds * 1000
      : 30000;

    const recoveredCount = queueManager.recoverInterruptedTasks();
    if (recoveredCount > 0) {
      this.logger.info(`Mikufans队列Worker已恢复 ${recoveredCount} 个中断任务`);
    }

    while (!this.queueWorkerShouldStop) {
      queueManager.loadQueue({ silent: true, cleanupStale: false });

      if (!this.queueWorkerProcess && queueManager.hasActiveProcessing()) {
        this.logger.info('检测到已有Whisper任务在处理，队列Worker等待当前任务结束');
        await this.sleep(idleWaitMs);
        continue;
      }

      const nextTask = queueManager.getNextPendingTask({ reload: true }) as QueuedSummaryTask | null;
      if (!nextTask) {
        await this.stopPersistentAsrWorker('ASR 队列已清空');
        this.logger.info('Mikufans队列Worker空闲，退出等待下次唤醒');
        return;
      }

      const gameStatus = await this.isAsrGameRunning();
      if (gameStatus.busy) {
        await this.stopPersistentAsrWorker(`游戏运行: ${gameStatus.reason}`);
        if (!this.asrGamePaused) {
          this.logger.info(`检测到游戏运行，ASR 队列暂停: ${gameStatus.reason}`);
          this.asrGamePaused = true;
        }
        await this.sleep(Math.min(idleWaitMs, gameStatus.waitMs));
        continue;
      }
      if (this.asrGamePaused) {
        this.logger.info('游戏已退出，ASR 队列恢复');
        this.asrGamePaused = false;
      }

      // Paraformer owns the adaptive GPU policy in Python. The legacy total
      // GPU gate would stop the persistent worker before it can shrink its
      // batch and yield, so keep it only for non-adaptive backends.
      if (!this.isAdaptiveParaformerGpuProtectionEnabled(config)) {
        const gpuStatus = await this.isGpuBusyForWhisper();
        if (gpuStatus.busy) {
          await this.stopPersistentAsrWorker(`GPU 繁忙: ${gpuStatus.reason}`);
          this.logger.info(`GPU 当前繁忙，队列Worker继续等待: ${gpuStatus.reason}`);
          await this.sleep(idleWaitMs);
          continue;
        }
      }

      await this.ensurePersistentAsrWorker();
      await this.executeQueuedTask(nextTask);
    }
  }

  /**
   * 执行单个排队任务
   */
  private async executeQueuedTask(task: QueuedSummaryTask): Promise<void> {
    if (!task?.mediaPath) {
      return;
    }

    if (!fs.existsSync(task.mediaPath) || !fs.statSync(task.mediaPath).isFile()) {
      this.logger.warn(`队列任务媒体文件不存在，标记失败: ${task.mediaPath}`);
      queueManager.markFailed(task.id, `媒体文件不存在: ${task.mediaPath}`);
      return;
    }

    const scriptPath = 'src/scripts/enhanced_auto_summary.js';
    const args = [scriptPath, task.mediaPath];
    let resolvedXmlPath = task.xmlPath;
    if (!resolvedXmlPath) {
      const inferredXmlPath = path.join(
        path.dirname(task.mediaPath),
        `${path.basename(task.mediaPath, path.extname(task.mediaPath))}.xml`
      );
      if (fs.existsSync(inferredXmlPath) && fs.statSync(inferredXmlPath).isFile()) {
        resolvedXmlPath = inferredXmlPath;
        queueManager.addTask(task.mediaPath, task.roomId, {
          xmlPath: inferredXmlPath,
          screenshotPath: task.screenshotPath || undefined,
          trackOwnershipWhilePending: false
        });
        this.logger.info(`队列Worker自动补全XML路径: ${path.basename(task.mediaPath)} -> ${path.basename(inferredXmlPath)}`);
      }
    }

    if (resolvedXmlPath && fs.existsSync(resolvedXmlPath) && fs.statSync(resolvedXmlPath).isFile()) {
      args.push(resolvedXmlPath);
    } else {
      this.logger.warn(`队列Worker未找到XML，将仅基于ASR处理: ${path.basename(task.mediaPath)}`);
    }

    const roomId = task.roomId ? String(task.roomId) : 'unknown';
    if (!task.enableSpeakerRecognition && roomId !== 'unknown') {
      const oneShotRequest = speakerOnceRegistry.consume(roomId, {
        taskId: task.id,
        mediaPath: task.mediaPath,
        addedTime: task.addedTime
      });
      if (oneShotRequest) {
        queueManager.setTaskSpeakerRecognition(task.id, oneShotRequest);
        task.enableSpeakerRecognition = true;
        task.speakerRecognitionRequest = oneShotRequest;
        this.logger.info(
          `本场启用一次性说话人识别: roomId=${roomId}, taskId=${task.id}, requestId=${oneShotRequest.id}`
        );
      }
    }
    const encodedSpeakerRequest = encodeSpeakerRequestEnv(task.speakerRecognitionRequest || null);
    const resourceConfig = getFfmpegResourceConfig();
    const asrWorkerConnection = this.asrResources.getConnection();
    this.logger.info(`Mikufans队列Worker开始执行: ${path.basename(task.mediaPath)} (taskId=${task.id})`);

    const ps: ChildProcess = spawn('node', args, {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ROOM_ID: roomId,
        AUTOMATION: 'true',
        BYPASS_WHISPER_QUEUE: 'true',
        SCREENSHOT_PATH: task.screenshotPath || '',
        FFMPEG_THREADS: String(resourceConfig.threads),
        FFMPEG_PRIORITY: resourceConfig.priority,
        ASR_PERSISTENT_WORKER_PORT: asrWorkerConnection.port
          ? String(asrWorkerConnection.port)
          : '',
        ASR_PERSISTENT_WORKER_TOKEN: asrWorkerConnection.token || '',
        ASR_ENABLE_SPEAKER_ONCE: task.enableSpeakerRecognition ? 'true' : '',
        ASR_SPEAKER_REQUEST_JSON: encodedSpeakerRequest
      }
    });
    applyFfmpegProcessPriority(ps.pid, resourceConfig.priority);

    this.queueWorkerProcess = ps;
    this.logger.info(`Mikufans队列Worker子进程已启动: pid=${ps.pid ?? 'unknown'}, file=${path.basename(task.mediaPath)}`);

    const config = ConfigProvider.getConfig();
    const processTimeout = config.webhook.timeouts.processTimeout || 30 * 60 * 1000;
    let timedOut = false;
    let asrStartedAt: number | null = null;
    let asrTimingSummary: Record<string, any> | null = null;
    let stdoutLineBuffer = '';

    const timeoutId = setTimeout(async () => {
      timedOut = true;
      this.logger.warn(`队列Worker任务超时，强制终止: ${path.basename(task.mediaPath)}`);
      await terminateProcessTree(ps, {
        gracePeriodMs: 5000,
        label: `Mikufans队列Worker(${path.basename(task.mediaPath)})`,
        logger: this.logger
      });
      const processes = await listRelevantProcesses();
      if (processes.length > 0) {
        this.logger.warn(`队列Worker超时清理后的相关进程快照: ${processes.join(' | ')}`);
      }
      queueManager.markFailed(task.id, `队列Worker超时终止: ${path.basename(task.mediaPath)}`);
    }, processTimeout);

    await new Promise<void>((resolve) => {
      let workerSlotReleased = false;
      const releaseWorkerSlot = (reason: string) => {
        if (workerSlotReleased) {
          return;
        }

        workerSlotReleased = true;
        if (this.queueWorkerProcess === ps) {
          this.queueWorkerProcess = null;
        }
        this.logger.info(`Mikufans队列Worker释放ASR槽位 (${reason}): ${path.basename(task.mediaPath)}`);
        resolve();
      };

      const handleWorkerOutput = (output: string) => {
        const line = output.trim();
        if (!line) {
          return;
        }
        this.logger.info(`[Mikufans队列Worker] ${line}`);
        if (!asrStartedAt && line.includes('-> [ASR]')) {
          asrStartedAt = Date.now();
        }
        const timingMatch = line.match(/\[\[ASR_TIMING\]\]\s+({[^\r\n]+})/);
        if (timingMatch) {
          try {
            asrTimingSummary = JSON.parse(timingMatch[1]);
          } catch (error: any) {
            this.logger.warn(`解析 ASR 阶段耗时失败: ${error.message}`);
          }
        }
        void this.handleDelayedReplyReadyOutput(line, task.mediaPath);
        if (line.includes(ASR_PHASE_DONE_SENTINEL) || line.includes(LEGACY_WHISPER_PHASE_DONE_SENTINEL)) {
          if (asrStartedAt) {
            const asrElapsedSeconds = (Date.now() - asrStartedAt) / 1000;
            const speakerProcessing = asrTimingSummary?.speakerProcessing;
            void ProcessingAlertService.notifyIfSlowStage(
              'ASR',
              asrElapsedSeconds,
              ProcessingAlertService.getThresholds().asrSlowSeconds,
              task.mediaPath,
              {
                taskId: task.id,
                roomId,
                ...(asrTimingSummary ? {
                  模型缓存: asrTimingSummary.cacheHit ? '命中' : '未命中',
                  模型加载秒: asrTimingSummary.modelLoadSeconds,
                  真正转写秒: asrTimingSummary.transcriptionSeconds,
                  真正转写速度: asrTimingSummary.trueAsrSpeed
                    ? `${asrTimingSummary.trueAsrSpeed}x`
                    : 'N/A',
                  VAD秒: asrTimingSummary.vadSeconds,
                  说话人状态: speakerProcessing?.status || '未知',
                  说话人探测秒: (
                    Number(asrTimingSummary.speakerProbeEmbeddingSeconds || 0) +
                    Number(asrTimingSummary.speakerProbeClusteringSeconds || 0)
                  ).toFixed(1),
                  说话人全量秒: Number(asrTimingSummary.speakerFullEmbeddingSeconds || 0).toFixed(1),
                  说话人聚类秒: Number(asrTimingSummary.speakerFullClusteringSeconds || 0).toFixed(1),
                  说话人匹配秒: asrTimingSummary.speakerMatchingSeconds,
                  说话人总计秒: asrTimingSummary.speakerTotalSeconds
                } : {})
              }
            );
          }
          this.logger.info(`Mikufans队列Worker已完成ASR阶段，释放队列槽位，AI/漫画阶段继续后台执行: ${path.basename(task.mediaPath)}`);
          releaseWorkerSlot('asr-phase-done');
        }
      };

      ps.stdout?.on('data', (data: Buffer) => {
        stdoutLineBuffer += data.toString();
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() || '';
        for (const line of lines) {
          handleWorkerOutput(line);
        }
      });

      ps.stdout?.on('end', () => {
        if (stdoutLineBuffer) {
          handleWorkerOutput(stdoutLineBuffer);
          stdoutLineBuffer = '';
        }
      });

      ps.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.logger.info(`[Mikufans队列Worker stderr] ${output}`);
        }
      });

      ps.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        this.queueWorkerProcess = null;
        this.logger.error(`Mikufans队列Worker子进程错误: ${error.message}`);
        queueManager.markFailed(task.id, `队列Worker启动失败: ${error.message}`);
        releaseWorkerSlot('spawn-error');
      });

      ps.on('close', async (code: number | null) => {
        clearTimeout(timeoutId);
        if (this.queueWorkerProcess === ps) {
          this.queueWorkerProcess = null;
        }
        this.logger.info(`Mikufans队列Worker任务结束 (退出码: ${code}, 超时: ${timedOut}): ${path.basename(task.mediaPath)}`);

        if (task.mediaPath.includes('_merged')) {
          const session = this.findSessionByVideoPath(task.mediaPath);
          if (session) {
            this.liveSessionManager.markAsCompleted(session.roomId);
            this.logger.info(`✅ 会话处理完成: ${session.roomId}`);
          }
        }

        if (code === 0) {
          const taskId = task.id;
          if (taskId && queueManager.getTaskById(taskId, { reload: true })?.status !== 'completed') {
            queueManager.markCompleted(taskId, { exitCode: code, reason: 'success' });
          }
        } else if (!timedOut) {
          const reason = `队列Worker异常退出: exitCode=${code ?? 'null'}, file=${path.basename(task.mediaPath)}`;
          const requeued = queueManager.requeueAfterWorkerFailure(task.id, reason);
          this.logger[requeued ? 'warn' : 'error'](
            requeued ? `${reason}，已重新入队` : `${reason}，重试已耗尽`
          );
        }

        await this.checkAndTriggerDelayedReply(task.mediaPath, roomId);
        releaseWorkerSlot('process-close');
      });
    });
  }

  /**
   * 启动处理流程
   */
  private async startProcessing(videoPath: string, xmlPath: string | null, roomId: string): Promise<boolean> {
    try {
      if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
        this.logger.error(`处理流程未启动，视频文件不存在或无效: ${videoPath}`);
        this.duplicateGuard.markAsProcessed(videoPath);
        return false;
      }

      let validatedXmlPath = xmlPath;
      if (validatedXmlPath) {
        if (!fs.existsSync(validatedXmlPath) || !fs.statSync(validatedXmlPath).isFile()) {
          this.logger.warn(`弹幕文件不存在或无效，将按无XML继续处理: ${validatedXmlPath}`);
          validatedXmlPath = null;
        }
      }

      this.logger.info(`Mikufans任务准备入队: ${path.basename(videoPath)}`);

      // 生成视频截图
      let screenshotPath: string | null = null;
      try {
        this.logger.info(`开始生成视频截图...`);
        screenshotPath = await this.screenshotService.generateScreenshots(videoPath);
        if (screenshotPath) {
          this.logger.info(`视频截图生成成功: ${path.basename(screenshotPath)}`);
        } else {
          this.logger.warn(`视频截图生成失败，将继续处理流程`);
        }
      } catch (screenshotError: any) {
        this.logger.error(`生成视频截图时出错: ${screenshotError.message}，将继续处理流程`);
      }

      const task = queueManager.addTask(videoPath, roomId, {
        xmlPath: validatedXmlPath || undefined,
        screenshotPath: screenshotPath || undefined,
        trackOwnershipWhilePending: false
      }) as QueuedSummaryTask;

      this.logger.info(`Mikufans任务已入队: ${path.basename(videoPath)} (taskId=${task.id}, priority=${task.priority ?? 0})`);
      this.duplicateGuard.markAsProcessed(videoPath);
      this.ensureQueueWorkerRunning();

      return true;

    } catch (error: any) {
      this.logger.error(`启动Mikufans处理流程时出错: ${error.message}`, { error });
      this.duplicateGuard.markAsProcessed(videoPath);
      return false;
    }
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string) {
    return this.liveSessionManager.getSession(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAllSessions() {
    return this.liveSessionManager.getAllSessions();
  }

  /**
   * 设置延迟回复服务
   */
  setDelayedReplyService(service: IDelayedReplyService): void {
    this.delayedReplyCoordinator.setService(service);
    this.logger.info('延迟回复服务已设置');
  }

  setBilibiliAPIService(service: IBilibiliAPIService): void {
    const getRoomLiveStatus = service.getRoomLiveStatus;
    if (typeof getRoomLiveStatus !== 'function') {
      this.logger.warn('Bilibili API service does not expose room live status; offline fallback is unavailable');
      this.offlineFallbackMonitor.setProvider(undefined);
      return;
    }

    this.offlineFallbackMonitor.setProvider({
      getRoomLiveStatus: roomId => getRoomLiveStatus.call(service, roomId)
    });
    this.logger.info('Bilibili room status provider injected into Mikufans handler');
  }

  stop(): void {
    this.offlineFallbackMonitor.stop();
    this.delayedReplyCoordinator.stop();
  }

  private get pendingDelayedReplyFileTimers(): Map<string, NodeJS.Timeout> {
    return this.delayedReplyCoordinator.pendingFileTimers;
  }

  private async checkAndTriggerDelayedReply(videoPath: string, roomId: string): Promise<void> {
    await this.delayedReplyCoordinator.checkAfterProcessing(videoPath, roomId);
  }

  private async handleDelayedReplyReadyOutput(output: string, fallbackMediaPath: string): Promise<void> {
    await this.delayedReplyCoordinator.handleReadyOutput(output, fallbackMediaPath);
  }

  private resolveLiveTimesForDelayedReply(mediaPath: string, roomId: string): {
    liveStartTime?: Date;
    liveEndTime?: Date;
  } {
    return this.delayedReplyCoordinator.resolveLiveTimes(mediaPath, roomId);
  }

  private async mergeAndProcessSession(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session) {
      this.logger.warn(`会话不存在: ${roomId}`);
      return;
    }

    this.logger.info(`🔄 开始合并会话: ${roomId} (${session.segments.length} 个片段)`);

    // 标记为合并中
    this.liveSessionManager.markAsMerging(roomId);

    try {
      // 获取合并配置
      const mergeConfig = this.liveSessionManager.getMergeConfig();

      // 确定输出文件路径
      const firstSegment = session.segments[0];
      const outputDir = this.resolveMergedOutputDir(session.segments);
      const outputBaseName = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));
      const mergedVideoPath = path.join(outputDir, `${outputBaseName}_merged.flv`);
      const mergedXmlPath = path.join(outputDir, `${outputBaseName}_merged.xml`);

      // 合并视频文件
      await this.fileMerger.mergeVideos(session.segments, mergedVideoPath, mergeConfig.fillGaps);

      // 合并XML文件
      await this.fileMerger.mergeXmlFiles(session.segments, mergedXmlPath);

      // 复制封面图
      if (mergeConfig.copyCover) {
        await this.fileMerger.copyCover(session.segments, outputDir);
      }

      this.logger.info(`✅ 合并完成: ${path.basename(mergedVideoPath)}`);

      // 备份原始片段（合并成功后才备份）
      if (mergeConfig.backupOriginals) {
        await this.fileMerger.backupSegments(session.segments, outputDir);
      }

      // 标记为处理中
      this.liveSessionManager.markAsProcessing(roomId);

      // 处理合并后的文件
      await this.startProcessing(mergedVideoPath, mergedXmlPath, session.roomId);
    } catch (error: any) {
      this.logger.error(`合并会话失败: ${error.message}`, { error });

      // 降级处理：使用最大的片段
      this.logger.warn(`🔄 合并失败，使用降级处理（最大片段）: ${roomId}`);
      await this.fallbackToLargestSegment(roomId);
    }
  }

  /**
   * 降级处理：使用最大的片段
   */
  private async fallbackToLargestSegment(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session || session.segments.length === 0) {
      this.logger.warn(`会话或片段不存在: ${roomId}`);
      return;
    }

    // 获取最大的片段
    const largestSegment = this.fileMerger.getLargestSegment(session.segments);
    if (!largestSegment) {
      this.logger.error(`无法获取最大片段: ${roomId}`);
      return;
    }

    this.logger.info(`📄 降级处理: 使用最大片段 ${path.basename(largestSegment.videoPath)}`);

    // 重置会话状态为收集中
    this.liveSessionManager.resetToCollecting(roomId);

    // 标记为处理中
    this.liveSessionManager.markAsProcessing(roomId);

    // 处理最大片段
    const started = await this.startProcessing(largestSegment.videoPath, largestSegment.xmlPath, session.roomId);

    this.liveSessionManager.markAsCompleted(roomId);
    if (started) {
      this.logger.info(`✅ 降级处理已启动，会话已标记为完成: ${roomId}`);
    } else {
      this.logger.warn(`⚠️ 降级处理未能启动，但会话已标记为完成以避免复用脏片段: ${roomId}`);
    }
  }

  /**
   * 处理单个片段（单片段场景）
   */
  private async processSingleSegment(roomId: string): Promise<void> {
    const session = this.liveSessionManager.getSession(roomId);
    if (!session || session.segments.length === 0) {
      this.logger.warn(`会话或片段不存在: ${roomId}`);
      return;
    }

    const segment = session.segments[0];
    this.logger.info(`📄 处理单个片段: ${path.basename(segment.videoPath)}`);

    // 标记为处理中
    this.liveSessionManager.markAsProcessing(roomId);

    // 直接处理单个片段
    const started = await this.startProcessing(segment.videoPath, segment.xmlPath, session.roomId);

    this.liveSessionManager.markAsCompleted(roomId);
    if (started) {
      this.logger.info(`✅ 单片段处理已启动,会话已标记为完成: ${roomId}`);
    } else {
      this.logger.warn(`⚠️ 单片段处理未能启动，但会话已标记为完成以避免重复复用: ${roomId}`);
    }
  }

  /**
   * 根据视频路径查找会话
   */
  private resolveMergedOutputDir(segments: LiveSegment[]): string {
    const segment = segments.find(item => path.basename(path.dirname(item.videoPath)).toLowerCase() !== 'bak')
      || segments[0];
    const dir = path.dirname(segment.videoPath);
    return path.basename(dir).toLowerCase() === 'bak' ? path.dirname(dir) : dir;
  }

  private findSessionByVideoPath(videoPath: string) {
    const allSessions = this.liveSessionManager.getAllSessions();
    for (const [roomId, session] of allSessions.entries()) {
      for (const segment of session.segments) {
        if (segment.videoPath === videoPath) {
          return session;
        }
      }
    }
    return null;
  }

  /**
   * 清理过期的会话
   */
  cleanupExpiredSessions(maxAgeHours: number = 24): void {
    this.liveSessionManager.cleanupExpiredSessions(maxAgeHours);
  }
}
