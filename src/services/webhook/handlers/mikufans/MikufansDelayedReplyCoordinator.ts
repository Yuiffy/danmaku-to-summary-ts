import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../../../core/logging/LogManager';
import { IDelayedReplyService } from '../../../bilibili/interfaces/IDelayedReplyService';
import { LiveContentSummaryDeliveryMode } from '../../../bilibili/interfaces/types';
import { LiveSessionManager } from '../../LiveSessionManager';

const DELAYED_REPLY_READY_SENTINEL = '[[DELAYED_REPLY_READY]]';

interface DelayedReplyTriggerParams {
  roomId: string;
  goodnightTextPath: string;
  comicImagePath?: string | null;
  liveContentSummaryPath?: string | null;
  liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode;
  mediaPath: string;
  source: string;
}

interface StreamTimestamps {
  startTime?: Date;
  endTime?: Date;
}

/** Coordinates generated files with delayed-reply tasks after media processing. */
export class MikufansDelayedReplyCoordinator {
  private readonly logger = getLogger('MikufansDelayedReplyCoordinator');
  private readonly initialRetryMs = 30 * 1000;
  private readonly retryIntervalMs = 5 * 60 * 1000;
  private readonly maxRetryMs = 2 * 60 * 60 * 1000;
  private delayedReplyService?: IDelayedReplyService;
  readonly pendingFileTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly liveSessionManager: LiveSessionManager,
    private readonly streamTimestamps: Map<string, StreamTimestamps>
  ) {}

  setService(service: IDelayedReplyService): void {
    this.delayedReplyService = service;
  }

  stop(): void {
    for (const timer of this.pendingFileTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFileTimers.clear();
  }

  async checkAfterProcessing(videoPath: string, roomId: string): Promise<void> {
    this.logger.info(
      `🔍 [延迟回复检查] 开始检查: roomId=${roomId}, videoPath=${path.basename(videoPath)}`
    );
    if (!this.delayedReplyService) {
      this.logger.warn('⚠️  延迟回复服务未设置，跳过触发');
      return;
    }
    if (!roomId || roomId === 'unknown') {
      this.logger.warn(`⚠️  房间ID无效 (${roomId})，跳过触发延迟回复`);
      return;
    }

    try {
      const dir = path.dirname(videoPath);
      const baseName = path.basename(videoPath, path.extname(videoPath));
      const goodnightTextPath = path.join(dir, `${baseName}_晚安回复.md`);
      const comicImagePath = path.join(dir, `${baseName}_COMIC_FACTORY.png`);
      const liveContentSummaryPath = path.join(dir, `${baseName}_LIVE_CONTENT.json`);
      const hasGoodnightText = fs.existsSync(goodnightTextPath);
      const hasComicImage = fs.existsSync(comicImagePath);
      const hasLiveContentSummary = fs.existsSync(liveContentSummaryPath);

      this.logger.info('🔍 [延迟回复检查] 检查文件:');
      this.logger.info(`   晚安回复路径: ${goodnightTextPath}`);
      this.logger.info(`   漫画路径: ${comicImagePath}`);
      this.logger.info(`   晚安回复存在: ${hasGoodnightText}`);
      this.logger.info(`   漫画存在: ${hasComicImage}`);

      if (hasGoodnightText) {
        await this.triggerFromPaths({
          roomId,
          goodnightTextPath,
          comicImagePath: hasComicImage ? comicImagePath : undefined,
          liveContentSummaryPath: hasLiveContentSummary ? liveContentSummaryPath : undefined,
          mediaPath: videoPath,
          source: hasComicImage ? 'process-close-with-comic' : 'process-close-text-only'
        });
      } else {
        this.logger.info('ℹ️  未找到晚安回复文件，跳过延迟回复');
        this.scheduleFileRetry({
          roomId,
          goodnightTextPath,
          comicImagePath,
          liveContentSummaryPath,
          mediaPath: videoPath,
          source: 'process-close-missing-text'
        });
      }
    } catch (error: any) {
      this.logger.error(`❌ 检查并触发延迟回复失败: ${error.message}`, { error });
    }
  }

  async handleReadyOutput(output: string, fallbackMediaPath: string): Promise<void> {
    if (!output.includes(DELAYED_REPLY_READY_SENTINEL)) {
      return;
    }

    for (const line of output.split(/\r?\n/)) {
      const markerIndex = line.indexOf(DELAYED_REPLY_READY_SENTINEL);
      if (markerIndex < 0) {
        continue;
      }
      const jsonText = line.slice(markerIndex + DELAYED_REPLY_READY_SENTINEL.length).trim();
      if (!jsonText) {
        this.logger.warn('延迟回复提前触发事件缺少JSON载荷');
        continue;
      }

      try {
        const payload = JSON.parse(jsonText) as {
          roomId?: string;
          goodnightTextPath?: string;
          comicImagePath?: string;
          liveContentSummaryPath?: string;
          liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode;
          mediaPath?: string;
        };
        if (!payload.roomId || !payload.goodnightTextPath) {
          this.logger.warn('延迟回复提前触发事件字段不完整', { payload });
          continue;
        }
        await this.triggerFromPaths({
          roomId: String(payload.roomId),
          goodnightTextPath: payload.goodnightTextPath,
          comicImagePath: payload.comicImagePath,
          liveContentSummaryPath: payload.liveContentSummaryPath,
          liveContentSummaryDeliveryMode: payload.liveContentSummaryDeliveryMode,
          mediaPath: payload.mediaPath || fallbackMediaPath,
          source: 'text-ready'
        });
      } catch (error: any) {
        this.logger.error(`解析延迟回复提前触发事件失败: ${error.message}`, { line, error });
      }
    }
  }

  resolveLiveTimes(mediaPath: string, roomId: string): {
    liveStartTime?: Date;
    liveEndTime?: Date;
  } {
    const fallbackTimes = this.extractLiveTimeFallback(mediaPath, roomId);
    const session = this.liveSessionManager.getSession(roomId);
    if (session) {
      const liveStartTime = session.startTime;
      const latestSegmentEndTime = session.segments
        .map(segment => segment.fileCloseTime)
        .filter(value => value && !Number.isNaN(value.getTime()))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const liveEndTime = session.endTime || fallbackTimes?.endTime || latestSegmentEndTime || new Date();
      const fallbackStartTime = fallbackTimes?.startTime;
      const fallbackEndTime = fallbackTimes?.endTime;
      const mismatchToleranceMs = 10 * 60 * 1000;
      if (
        fallbackTimes?.source !== '文件系统时间' &&
        fallbackStartTime &&
        fallbackEndTime &&
        Math.abs(liveStartTime.getTime() - fallbackStartTime.getTime()) > mismatchToleranceMs
      ) {
        this.logger.warn(
          `当前会话与录播文件时间不匹配，延迟回复改用录播时间: session=${liveStartTime.toISOString()}, file=${fallbackStartTime.toISOString()}, media=${path.basename(mediaPath)}`
        );
        return {
          liveStartTime: fallbackStartTime,
          liveEndTime: fallbackEndTime
        };
      }

      this.logger.info(
        `📅 [时间来源: 会话] 开始=${liveStartTime.toISOString()}, 结束=${liveEndTime.toISOString()}`
      );
      return { liveStartTime, liveEndTime };
    }

    this.logger.warn('⚠️  未找到会话信息，尝试从其他来源获取直播时间');
    if (fallbackTimes) {
      const startStr = fallbackTimes.startTime?.toISOString() || 'undefined';
      const endStr = fallbackTimes.endTime?.toISOString() || 'undefined';
      this.logger.info(`📅 [时间来源: ${fallbackTimes.source}] 开始=${startStr}, 结束=${endStr}`);
      return {
        liveStartTime: fallbackTimes.startTime,
        liveEndTime: fallbackTimes.endTime
      };
    }

    this.logger.warn('⚠️  无法从任何来源获取直播时间，将使用 undefined');
    return {};
  }

  private async triggerFromPaths(params: DelayedReplyTriggerParams): Promise<void> {
    if (!this.delayedReplyService) {
      this.logger.warn('⚠️  延迟回复服务未设置，跳过触发');
      return;
    }
    const { roomId, goodnightTextPath, mediaPath, source } = params;
    const comicImagePath = params.comicImagePath || '';
    if (!roomId || roomId === 'unknown') {
      this.logger.warn(`⚠️  房间ID无效 (${roomId})，跳过触发延迟回复`);
      return;
    }
    if (!fs.existsSync(goodnightTextPath)) {
      this.logger.info('ℹ️  晚安回复文件暂不存在，跳过延迟回复触发', {
        goodnightTextPath,
        source
      });
      this.scheduleFileRetry(params);
      return;
    }

    const hasComicImage = !!comicImagePath && fs.existsSync(comicImagePath);
    const { liveStartTime, liveEndTime } = this.resolveLiveTimes(mediaPath, roomId);
    this.logger.info('✅ 找到晚安回复文件，触发延迟回复任务', { source });
    this.logger.info(`   房间ID: ${roomId}`);
    this.logger.info(`   晚安回复: ${path.basename(goodnightTextPath)}`);
    if (comicImagePath) {
      this.logger.info(
        `   漫画: ${hasComicImage ? path.basename(comicImagePath) : `${path.basename(comicImagePath)}（等待生成）`}`
      );
    } else {
      this.logger.info('   漫画: 未计划生成（将只发送晚安回复）');
    }
    this.logger.info(
      liveStartTime && liveEndTime
        ? `   直播时间: ${liveStartTime.toISOString()} ~ ${liveEndTime.toISOString()}`
        : '   直播时间: 未知（将不显示直播时长信息）'
    );

    const taskId = await this.delayedReplyService.addTask(
      roomId,
      goodnightTextPath,
      comicImagePath,
      undefined,
      liveStartTime,
      liveEndTime,
      params.liveContentSummaryPath || undefined,
      params.liveContentSummaryDeliveryMode
    );
    this.logger.info(
      taskId
        ? `✅ 延迟回复任务已触发: ${taskId}`
        : 'ℹ️  延迟回复任务未添加（可能配置未启用）',
      { source }
    );
  }

  private scheduleFileRetry(params: DelayedReplyTriggerParams): void {
    if (!this.delayedReplyService) {
      return;
    }
    const key = `${params.roomId}:${path.normalize(params.goodnightTextPath)}`;
    if (this.pendingFileTimers.has(key)) {
      this.logger.info('Delayed reply file wait is already scheduled', {
        roomId: params.roomId,
        goodnightTextPath: params.goodnightTextPath,
        source: params.source
      });
      return;
    }

    const startedAt = Date.now();
    const scheduleNext = (delayMs: number) => {
      const timer = setTimeout(() => {
        void checkOnce();
      }, delayMs);
      timer.unref?.();
      this.pendingFileTimers.set(key, timer);
    };
    const checkOnce = async () => {
      try {
        if (fs.existsSync(params.goodnightTextPath)) {
          this.pendingFileTimers.delete(key);
          this.logger.info('Delayed reply file appeared after wait; triggering task', {
            roomId: params.roomId,
            goodnightTextPath: params.goodnightTextPath,
            source: params.source
          });
          await this.triggerFromPaths({
            ...params,
            source: `${params.source}-file-ready`
          });
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= this.maxRetryMs) {
          this.pendingFileTimers.delete(key);
          this.logger.warn('Delayed reply file did not appear before wait timeout', {
            roomId: params.roomId,
            goodnightTextPath: params.goodnightTextPath,
            elapsedMs,
            source: params.source
          });
          return;
        }
        scheduleNext(this.retryIntervalMs);
      } catch (error: any) {
        this.pendingFileTimers.delete(key);
        this.logger.error(`Delayed reply file wait failed: ${error.message}`, {
          roomId: params.roomId,
          goodnightTextPath: params.goodnightTextPath,
          source: params.source,
          error
        });
      }
    };

    this.logger.info('Scheduled delayed reply file wait', {
      roomId: params.roomId,
      goodnightTextPath: params.goodnightTextPath,
      maxWaitMs: this.maxRetryMs,
      source: params.source
    });
    scheduleNext(this.initialRetryMs);
  }

  private extractLiveTimeFallback(
    videoPath: string,
    roomId: string
  ): { startTime?: Date; endTime?: Date; source: string } | null {
    try {
      const fileName = path.basename(videoPath, path.extname(videoPath));
      const recordingStartTime = this.parseRecordingStartTime(fileName);
      let fileStats: fs.Stats | undefined;
      try {
        fileStats = fs.statSync(videoPath);
      } catch {
        fileStats = undefined;
      }

      const timestamps = this.streamTimestamps.get(roomId);
      if (timestamps && (timestamps.startTime || timestamps.endTime)) {
        let startTime = timestamps.startTime;
        let endTime = timestamps.endTime;
        const toleranceMs = 10 * 60 * 1000;
        if (recordingStartTime) {
          const recordingStartMs = recordingStartTime.getTime();
          if (startTime && Math.abs(startTime.getTime() - recordingStartMs) > toleranceMs) {
            this.logger.warn(
              `Stream开始时间与当前文件名不匹配，改用文件名时间: stream=${startTime.toISOString()}, file=${recordingStartTime.toISOString()}, fileName=${fileName}`
            );
            startTime = recordingStartTime;
          }
          if (endTime && endTime.getTime() < recordingStartMs - toleranceMs) {
            this.logger.warn(
              `Stream结束时间早于当前文件开始时间，丢弃旧结束时间: streamEnd=${endTime.toISOString()}, fileStart=${recordingStartTime.toISOString()}, fileName=${fileName}`
            );
            endTime = fileStats && fileStats.mtime.getTime() >= recordingStartMs
              ? fileStats.mtime
              : undefined;
          }
          if (!endTime && fileStats && fileStats.mtime.getTime() >= recordingStartMs) {
            endTime = fileStats.mtime;
          }
        }
        if (startTime && endTime && endTime.getTime() < startTime.getTime()) {
          this.logger.warn(
            `Stream时间范围异常，使用文件修改时间兜底: start=${startTime.toISOString()}, end=${endTime.toISOString()}, fileName=${fileName}`
          );
          endTime = fileStats && fileStats.mtime.getTime() >= startTime.getTime()
            ? fileStats.mtime
            : undefined;
        }
        this.logger.info(
          `🎯 从Stream事件记录中找到时间: start=${startTime?.toISOString() || 'undefined'}, end=${endTime?.toISOString() || 'undefined'}`
        );
        return { startTime, endTime, source: 'Stream事件记录' };
      }

      if (recordingStartTime) {
        const endTime = fileStats?.mtime
          || new Date(recordingStartTime.getTime() + 2 * 60 * 60 * 1000);
        if (endTime.getTime() >= recordingStartTime.getTime()) {
          return {
            startTime: recordingStartTime,
            endTime,
            source: '文件名解析'
          };
        }
        this.logger.warn(
          `文件名兜底时间异常，结束时间早于开始时间，放弃文件名解析: ${fileName}, start=${recordingStartTime.toISOString()}, end=${endTime.toISOString()}`
        );
      }

      if (fileStats) {
        return {
          startTime: fileStats.birthtime,
          endTime: fileStats.mtime,
          source: '文件系统时间'
        };
      }
      return null;
    } catch (error: any) {
      this.logger.error(`提取兜底时间失败: ${error.message}`, { error });
      return null;
    }
  }

  private parseRecordingStartTime(fileName: string): Date | undefined {
    const match = fileName.match(/(?:录制-)?\d+-(\d{8})-(\d{6})-(\d{3})-/);
    if (!match) {
      return undefined;
    }
    const date = match[1];
    const time = match[2];
    const year = Number.parseInt(date.slice(0, 4), 10);
    const parsed = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+08:00`
    );
    return !Number.isNaN(parsed.getTime()) && year >= 2020 && year <= 2100
      ? parsed
      : undefined;
  }
}
