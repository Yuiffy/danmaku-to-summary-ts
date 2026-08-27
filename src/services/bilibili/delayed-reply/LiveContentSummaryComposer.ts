import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../../core/logging/LogManager';
import { BilibiliConfigHelper } from '../BilibiliConfigHelper';
import {
  DelayedReplyTask,
  LiveContentSummaryDeliveryMode
} from '../interfaces/types';

export type LiveContentSummaryReadResult =
  | { kind: 'missing'; error?: string }
  | { kind: 'failed'; error: string }
  | { kind: 'success'; text: string };

/** Parses, bounds, and composes live-content summaries without publishing them. */
export class LiveContentSummaryComposer {
  static readonly MAX_COMMENT_CHARACTERS = 1000;
  private static readonly SUI_ROOM_ID = '25788785';
  private static readonly SHIORI_ROOM_ID = '26966466';
  private readonly logger = getLogger('LiveContentSummaryComposer');

  getSummaryLiveTimes(task: DelayedReplyTask): { startTime: Date; endTime: Date } {
    let startTime = task.liveStartTime;
    if (!startTime) {
      const match = path.basename(task.goodnightTextPath).match(
        /(?:录制-)?\d+-(\d{8})-(\d{6})-\d{3}/u
      );
      if (match) {
        const date = match[1];
        const time = match[2];
        const parsed = new Date(
          `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+08:00`
        );
        if (!Number.isNaN(parsed.getTime())) {
          startTime = parsed;
        }
      }
    }

    let endTime = task.liveEndTime;
    if (!endTime) {
      try {
        endTime = fs.statSync(task.goodnightTextPath).mtime;
      } catch {
        endTime = undefined;
      }
    }

    startTime = startTime || task.createTime;
    endTime = endTime && endTime.getTime() >= startTime.getTime() ? endTime : startTime;
    return { startTime, endTime };
  }

  buildSummaryReplyText(task: DelayedReplyTask, replyText: string): string {
    const anchorName = BilibiliConfigHelper.getAnchorConfig(task.roomId)?.name || task.roomId;
    const { startTime, endTime } = this.getSummaryLiveTimes(task);
    const start = this.getShanghaiDateParts(startTime);
    const end = this.getShanghaiDateParts(endTime);
    const endLabel = start.month === end.month && start.day === end.day
      ? `${end.hour}点`
      : `${end.month}月${end.day}日${end.hour}点`;
    return `to ${anchorName} ${start.month}月${start.day}日${start.hour}点~${endLabel}的直播。\n${replyText}`;
  }

  resolveDeliveryMode(
    roomId: string,
    requestedMode?: LiveContentSummaryDeliveryMode
  ): LiveContentSummaryDeliveryMode {
    if (requestedMode === 'separate' || requestedMode === 'attach_if_ready') {
      return requestedMode;
    }
    if (String(roomId) === LiveContentSummaryComposer.SHIORI_ROOM_ID) {
      return 'attach_if_ready';
    }
    if (String(roomId) === LiveContentSummaryComposer.SUI_ROOM_ID) {
      return 'separate';
    }
    return 'separate';
  }

  isDelivered(task: DelayedReplyTask): boolean {
    return task.liveContentSummaryState === 'attached_main' ||
      task.liveContentSummaryState === 'attached_supplemental' ||
      task.liveContentSummaryState === 'published_separate' ||
      !!task.liveContentSummaryCompletedAt;
  }

  getTaskUpdates(task: DelayedReplyTask): Partial<DelayedReplyTask> {
    return {
      liveContentSummaryPath: task.liveContentSummaryPath,
      liveContentSummaryDeliveryMode: task.liveContentSummaryDeliveryMode,
      liveContentSummaryState: task.liveContentSummaryState,
      liveContentSummaryReplyId: task.liveContentSummaryReplyId,
      liveContentSummaryAttachedTo: task.liveContentSummaryAttachedTo,
      liveContentSummaryCompletedAt: task.liveContentSummaryCompletedAt,
      liveContentSummaryRetryCount: task.liveContentSummaryRetryCount,
      liveContentSummaryError: task.liveContentSummaryError,
      liveContentSummaryForceSeparate: task.liveContentSummaryForceSeparate,
      liveContentSummaryPublishingAt: task.liveContentSummaryPublishingAt
    };
  }

  read(task: DelayedReplyTask): LiveContentSummaryReadResult {
    const summaryPath = task.liveContentSummaryPath;
    if (!summaryPath || !fs.existsSync(summaryPath)) {
      return { kind: 'missing' };
    }

    try {
      const payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
        status?: string;
        error?: unknown;
        content?: {
          overview?: unknown;
          activityTypes?: unknown;
          songs?: unknown;
          games?: unknown;
          topics?: unknown;
        };
      };
      if (payload.status === 'failed') {
        return { kind: 'failed', error: String(payload.error || '直播梗概生成失败') };
      }
      if (payload.status !== 'success') {
        return {
          kind: 'missing',
          error: `直播梗概状态尚未完成: ${payload.status || 'unknown'}`
        };
      }

      const content = payload.content || {};
      const overview = String(content.overview || '').trim();
      const activityTypes = this.normalizeStringList(content.activityTypes);
      const songs = this.normalizeStringList(content.songs);
      const games = this.normalizeStringList(content.games);
      const topics = this.normalizeStringList(content.topics);
      const primaryOverview = overview || (
        activityTypes.length > 0 ? `内容：${activityTypes.join('、')}` : ''
      );
      if (!primaryOverview && songs.length === 0 && games.length === 0 && topics.length === 0) {
        return { kind: 'failed', error: '直播梗概内容为空' };
      }
      return {
        kind: 'success',
        text: this.buildBoundedText(primaryOverview, [
          { label: '歌曲：', items: songs },
          { label: '游戏：', items: games },
          { label: '话题：', items: topics }
        ])
      };
    } catch (error) {
      return {
        kind: 'missing',
        error: `直播梗概 JSON 暂不可读: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  compose(
    task: DelayedReplyTask,
    replyText: string,
    target: 'main' | 'supplemental'
  ): { text: string; attached: boolean } {
    if (
      !task.liveContentSummaryPath ||
      task.liveContentSummaryDeliveryMode !== 'attach_if_ready' ||
      task.liveContentSummaryForceSeparate ||
      this.isDelivered(task)
    ) {
      return { text: replyText, attached: false };
    }

    const summary = this.read(task);
    if (summary.kind === 'failed') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = summary.error;
      return { text: replyText, attached: false };
    }
    if (summary.kind !== 'success') {
      task.liveContentSummaryState = 'waiting';
      task.liveContentSummaryError = summary.error;
      return { text: replyText, attached: false };
    }

    task.liveContentSummaryState = 'ready';
    task.liveContentSummaryError = undefined;
    const combined = `${replyText}\n\n${summary.text}`;
    if (combined.length > LiveContentSummaryComposer.MAX_COMMENT_CHARACTERS) {
      task.liveContentSummaryForceSeparate = true;
      this.logger.info('晚安回复拼接直播梗概后超过 B 站评论上限，改为独立发布', {
        taskId: task.taskId,
        roomId: task.roomId,
        target,
        combinedLength: combined.length,
        maxLength: LiveContentSummaryComposer.MAX_COMMENT_CHARACTERS
      });
      return { text: replyText, attached: false };
    }
    return { text: combined, attached: true };
  }

  markAttached(
    task: DelayedReplyTask,
    target: 'main' | 'supplemental',
    replyId: string
  ): void {
    task.liveContentSummaryState = target === 'main' ? 'attached_main' : 'attached_supplemental';
    task.liveContentSummaryAttachedTo = target;
    task.liveContentSummaryReplyId = replyId;
    task.liveContentSummaryCompletedAt = new Date();
    task.liveContentSummaryError = undefined;
    task.liveContentSummaryPublishingAt = undefined;
  }

  private getShanghaiDateParts(value: Date): { month: number; day: number; hour: number } {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(value);
    const getPart = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(part => part.type === type)?.value || 0);
    return {
      month: getPart('month'),
      day: getPart('day'),
      hour: getPart('hour')
    };
  }

  private normalizeStringList(value: unknown): string[] {
    const values = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    return values.map(item => String(item || '').trim()).filter(Boolean);
  }

  private buildBoundedText(
    overview: string,
    groups: Array<{ label: string; items: string[] }>
  ): string {
    const prefix = '本场直播内容：';
    const limit = LiveContentSummaryComposer.MAX_COMMENT_CHARACTERS;
    let result = prefix;
    if (overview) {
      const remaining = limit - result.length;
      if (overview.length <= remaining) {
        result += overview;
      } else if (remaining > 3) {
        return `${result}${overview.slice(0, remaining - 3)}...`;
      } else {
        return `${result}${overview.slice(0, Math.max(0, remaining))}`;
      }
    }

    for (const group of groups) {
      if (group.items.length === 0 || result.length >= limit) {
        continue;
      }
      const separator = result === prefix ? '' : '；';
      let selectedSegment = '';
      for (let count = 1; count <= group.items.length; count++) {
        const omittedCount = group.items.length - count;
        const omittedSuffix = omittedCount > 0 ? `、等${omittedCount}项` : '';
        const segment = `${group.label}${group.items.slice(0, count).join('、')}${omittedSuffix}`;
        if (`${result}${separator}${segment}`.length > limit) {
          break;
        }
        selectedSegment = segment;
      }
      if (!selectedSegment) {
        const countOnlySegment = `${group.label}共${group.items.length}项`;
        if (`${result}${separator}${countOnlySegment}`.length <= limit) {
          selectedSegment = countOnlySegment;
        }
      }
      if (selectedSegment) {
        result = `${result}${separator}${selectedSegment}`;
      }
    }
    return result;
  }
}
