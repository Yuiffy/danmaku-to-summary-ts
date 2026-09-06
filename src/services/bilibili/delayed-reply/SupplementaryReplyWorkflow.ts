import { getLogger } from '../../../core/logging/LogManager';
import { BilibiliConfigHelper } from '../BilibiliConfigHelper';
import { IDelayedReplyStore } from '../interfaces/IDelayedReplyStore';
import { IBilibiliAPIService } from '../interfaces/IBilibiliAPIService';
import { DelayedReplyTask, PublishCommentResponse } from '../interfaces/types';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { DelayedReplyPolicy } from './DelayedReplyPolicy';
import { ReplyContentReader } from './ReplyContentReader';
import { DelayedReplyArtifactResolver } from './DelayedReplyArtifactResolver';
import { DelayedReplyDiagnostics } from './DelayedReplyDiagnostics';
import { LiveContentSummaryComposer } from './LiveContentSummaryComposer';

export interface SupplementaryReplyPorts {
  bilibiliAPI: Pick<IBilibiliAPIService, 'publishComment'>;
  store: Pick<IDelayedReplyStore, 'updateTask'>;
  policy: DelayedReplyPolicy;
  replyContent: ReplyContentReader;
  artifactResolver: DelayedReplyArtifactResolver;
  diagnostics: DelayedReplyDiagnostics;
  liveContentSummaryComposer: LiveContentSummaryComposer;
  notifier?: Pick<WeChatWorkNotifier, 'sendImage' | 'sendMarkdown'>;
  scheduleTask(task: DelayedReplyTask): void;
  checkFileExists(filePath: string): Promise<boolean>;
  notifyComicGenerationFailure(task: DelayedReplyTask): Promise<void>;
}

/** Executes follow-up publications under the parent service's task lock. */
export class SupplementaryReplyWorkflow {
  private readonly logger = getLogger('SupplementaryReplyWorkflow');
  private static readonly COMIC_WAIT_INTERVAL_MS = 2 * 60 * 1000;
  private static readonly MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT = 30;
  private static readonly LIVE_CONTENT_WAIT_INTERVAL_MS = 60 * 1000;
  private static readonly SUPPLEMENTAL_COMIC_REPLY_PREFIX = '（补图）';

  constructor(private readonly ports: SupplementaryReplyPorts) {}

  private async notifySupplementalComicReplySuccess(
    task: DelayedReplyTask,
    comicImagePath: string,
    result: PublishCommentResponse,
    replyText: string
  ): Promise<void> {
    if (!this.ports.notifier || !task.repliedDynamicId || !task.supplementalReplyId) {
      return;
    }

    const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
    const replyUrl = `https://www.bilibili.com/opus/${task.repliedDynamicId}#reply${task.supplementalReplyId}`;
    const imageGenerationInfo = this.ports.diagnostics.getComicGenerationInfo(comicImagePath);
    const textGenerationInfo = this.ports.diagnostics.getTextGenerationInfo(task.goodnightTextPath, comicImagePath);
    const lines = [
      '✅ 补直播图片总结已发送',
      '',
      anchorConfig?.name ? `主播: ${anchorConfig.name}` : undefined,
      `动态ID: ${task.repliedDynamicId}`,
      task.replyId ? `主回复ID: ${task.replyId}` : undefined,
      `补图回复ID: ${task.supplementalReplyId}`,
      `回复内容: ${replyText}`,
      '',
      result.imageUrl ? `[B站附图](${result.imageUrl})` : undefined,
      `[查看补图回复](${replyUrl})`,
      textGenerationInfo ? `\n文本生成:\n${textGenerationInfo}` : undefined,
      imageGenerationInfo ? `\n生图状态:\n${imageGenerationInfo}` : undefined
    ].filter((line): line is string => Boolean(line));

    try {
      const imageSent = await this.ports.notifier.sendImage(comicImagePath);
      if (!imageSent) {
        this.logger.warn('补图回复已发布，但企微图片消息发送失败，将继续发送文字通知', {
          taskId: task.taskId,
          dynamicId: task.repliedDynamicId,
          supplementalReplyId: task.supplementalReplyId,
          comicImagePath
        });
      }
    } catch (notifyImageError) {
      this.logger.warn('补图回复已发布，但企微图片消息发送异常，将继续发送文字通知', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId,
        error: notifyImageError instanceof Error ? notifyImageError.message : String(notifyImageError)
      });
    }

    try {
      const markdownSent = await this.ports.notifier.sendMarkdown(lines.join('\n'));
      if (!markdownSent) {
        this.logger.warn('补图回复已发布，但企微文字通知发送失败；不会重试补图避免重复评论', {
          taskId: task.taskId,
          dynamicId: task.repliedDynamicId,
          supplementalReplyId: task.supplementalReplyId
        });
      }
    } catch (notifyMarkdownError) {
      this.logger.warn('补图回复已发布，但企微文字通知发送异常；不会重试补图避免重复评论', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId,
        error: notifyMarkdownError instanceof Error ? notifyMarkdownError.message : String(notifyMarkdownError)
      });
    }
  }

  private async notifyLiveContentSummaryReplySuccess(
    task: DelayedReplyTask,
    summaryText: string
  ): Promise<void> {
    if (!this.ports.notifier || !task.repliedDynamicId || !task.liveContentSummaryReplyId) {
      return;
    }

    try {
      const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
      const replyUrl =
        `https://www.bilibili.com/opus/${task.repliedDynamicId}#reply${task.liveContentSummaryReplyId}`;
      const lines = [
        '✅ 直播梗概已发送',
        '',
        anchorConfig?.name ? `主播: ${anchorConfig.name}` : undefined,
        `动态ID: ${task.repliedDynamicId}`,
        `梗概回复ID: ${task.liveContentSummaryReplyId}`,
        '',
        `梗概内容:\n${summaryText}`,
        '',
        `[查看梗概回复](${replyUrl})`
      ].filter((line): line is string => line !== undefined);
      const sent = await this.ports.notifier.sendMarkdown(lines.join('\n'));
      if (!sent) {
        this.logger.warn('直播梗概已发布，但企微通知发送失败；不会重试评论', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: task.repliedDynamicId,
          liveContentSummaryReplyId: task.liveContentSummaryReplyId
        });
      }
    } catch (notifyError) {
      this.logger.warn('直播梗概已发布，但企微通知发送异常；不会重试评论', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId,
        liveContentSummaryReplyId: task.liveContentSummaryReplyId,
        error: notifyError instanceof Error ? notifyError.message : String(notifyError)
      });
    }
  }

  async tryPublishLiveContentSummarySeparately(
    task: DelayedReplyTask
  ): Promise<'done' | 'waiting' | 'retry' | 'failed'> {
    if (!task.liveContentSummaryPath || this.ports.liveContentSummaryComposer.isDelivered(task)) {
      return 'done';
    }
    if (!task.repliedDynamicId || !task.replyId) {
      return 'waiting';
    }
    if (task.liveContentSummaryState === 'publishing') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = '直播梗概发布结果不确定，为避免重启后重复评论，已停止自动重发';
      await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));
      this.logger.warn(task.liveContentSummaryError, {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId
      });
      return 'failed';
    }

    const summary = this.ports.liveContentSummaryComposer.read(task);
    if (summary.kind === 'missing') {
      task.liveContentSummaryState = 'waiting';
      task.liveContentSummaryError = summary.error;
      await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));
      return 'waiting';
    }
    if (summary.kind === 'failed') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = summary.error;
      await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));
      this.logger.warn('直播梗概生成失败，不影响晚安回复流程', {
        taskId: task.taskId,
        roomId: task.roomId,
        error: summary.error
      });
      return 'failed';
    }

    task.liveContentSummaryState = 'publishing';
    task.liveContentSummaryPublishingAt = new Date();
    task.liveContentSummaryError = undefined;
    await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));

    try {
      const result = await this.ports.bilibiliAPI.publishComment({
        dynamicId: task.repliedDynamicId,
        content: summary.text
      });
      task.liveContentSummaryState = 'published_separate';
      task.liveContentSummaryAttachedTo = 'separate';
      task.liveContentSummaryReplyId = String(result.replyId);
      task.liveContentSummaryCompletedAt = new Date();
      task.liveContentSummaryPublishingAt = undefined;
      task.liveContentSummaryError = undefined;
      await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));
      this.logger.info('本场直播梗概已单独发布', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId,
        replyId: task.liveContentSummaryReplyId,
        contentLength: summary.text.length
      });
      await this.notifyLiveContentSummaryReplySuccess(task, summary.text);
      return 'done';
    } catch (error) {
      if (this.ports.liveContentSummaryComposer.isDelivered(task)) {
        this.logger.error('Live content was published; follow-up failure must not repeat the comment', {
          taskId: task.taskId, replyId: task.liveContentSummaryReplyId, error
        });
        return 'done';
      }
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isBlacklistError = errorMessage.includes('黑名单') || errorMessage.includes('12035');
      const canRetry =
        !isBlacklistError &&
        !this.ports.policy.isCredentialError(error) &&
        !this.ports.policy.isPermanentReplyError(error) &&
        (task.liveContentSummaryRetryCount || 0) < delayedReplyConfig.maxRetries;

      task.liveContentSummaryPublishingAt = undefined;
      task.liveContentSummaryRetryCount = (task.liveContentSummaryRetryCount || 0) + (canRetry ? 1 : 0);
      task.liveContentSummaryState = canRetry ? 'ready' : 'failed';
      task.liveContentSummaryError = `直播梗概评论发布失败: ${errorMessage}`;
      await this.ports.store.updateTask(task.taskId, this.ports.liveContentSummaryComposer.getTaskUpdates(task));
      this.logger[canRetry ? 'warn' : 'error'](
        canRetry ? '直播梗概评论发布失败，将独立重试' : '直播梗概评论发布最终失败，晚安回复不受影响',
        {
          taskId: task.taskId,
          roomId: task.roomId,
          retryCount: task.liveContentSummaryRetryCount,
          error: errorMessage
        }
      );
      return canRetry ? 'retry' : 'failed';
    }
  }

  async executeLiveContentSummaryReply(task: DelayedReplyTask): Promise<void> {
    const outcome = await this.tryPublishLiveContentSummarySeparately(task);
    if (outcome === 'waiting' || outcome === 'retry') {
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const waitMs = outcome === 'retry'
        ? delayedReplyConfig.retryDelayMinutes * 60 * 1000
        : SupplementaryReplyWorkflow.LIVE_CONTENT_WAIT_INTERVAL_MS;
      task.status = 'waiting_live_content';
      task.scheduledTime = new Date(Date.now() + waitMs);
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        scheduledTime: task.scheduledTime,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });
      this.ports.scheduleTask(task);
      return;
    }

    task.status = 'completed';
    await this.ports.store.updateTask(task.taskId, {
      status: task.status,
      ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
    });
  }

  async completeOrWaitForLiveContentSummary(task: DelayedReplyTask): Promise<void> {
    if (!task.liveContentSummaryPath || this.ports.liveContentSummaryComposer.isDelivered(task)) {
      task.status = 'completed';
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        summaryReplyId: task.summaryReplyId,
        summaryCompletedAt: task.summaryCompletedAt,
        summaryPublishingAt: task.summaryPublishingAt,
        summaryRetryCount: task.summaryRetryCount,
        error: task.error,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });
      return;
    }

    if (task.liveContentSummaryState === 'publishing') {
      task.liveContentSummaryState = 'failed';
      task.liveContentSummaryError = '直播梗概发布结果不确定，为避免重复评论，已停止自动重发';
    } else {
      const summary = this.ports.liveContentSummaryComposer.read(task);
      task.liveContentSummaryState = summary.kind === 'success'
        ? 'ready'
        : summary.kind === 'failed'
          ? 'failed'
          : 'waiting';
      task.liveContentSummaryError = summary.kind === 'failed' || summary.kind === 'missing'
        ? summary.error
        : undefined;
    }

    if (task.liveContentSummaryState === 'failed') {
      task.status = 'completed';
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        summaryReplyId: task.summaryReplyId,
        summaryCompletedAt: task.summaryCompletedAt,
        summaryPublishingAt: task.summaryPublishingAt,
        summaryRetryCount: task.summaryRetryCount,
        error: task.error,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });
      return;
    }

    task.status = 'waiting_live_content';
    task.scheduledTime = task.liveContentSummaryState === 'ready'
      ? new Date()
      : new Date(Date.now() + SupplementaryReplyWorkflow.LIVE_CONTENT_WAIT_INTERVAL_MS);
    await this.ports.store.updateTask(task.taskId, {
      status: task.status,
      scheduledTime: task.scheduledTime,
      summaryReplyId: task.summaryReplyId,
      summaryCompletedAt: task.summaryCompletedAt,
      summaryPublishingAt: task.summaryPublishingAt,
      summaryRetryCount: task.summaryRetryCount,
      error: task.error,
      ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
    });
    this.ports.scheduleTask(task);
  }

  private async completeWithoutSummaryDynamic(task: DelayedReplyTask): Promise<void> {
    await this.completeOrWaitForLiveContentSummary(task);
  }

  async executeSummaryDynamicReply(
    task: DelayedReplyTask,
    replyText?: string,
    imagePath?: string
  ): Promise<void> {
    const summarySettings = BilibiliConfigHelper.getSummaryDynamicSettings();
    if (!summarySettings) {
      await this.completeWithoutSummaryDynamic(task);
      return;
    }

    if (task.summaryReplyId || task.summaryCompletedAt) {
      await this.completeWithoutSummaryDynamic(task);
      return;
    }

    if (task.summaryPublishingAt) {
      task.error = 'Summary publication outcome is unknown; automatic resend stopped';
      await this.completeWithoutSummaryDynamic(task);
      return;
    }

    const content = this.ports.liveContentSummaryComposer.buildSummaryReplyText(
      task,
      replyText || await this.ports.replyContent.readReplyText(task.goodnightTextPath)
    );
    const resolvedImagePath = imagePath ||
      (task.comicImagePath && await this.ports.checkFileExists(task.comicImagePath)
        ? task.comicImagePath
        : undefined);

    task.summaryPublishingAt = new Date();
    await this.ports.store.updateTask(task.taskId, { summaryPublishingAt: task.summaryPublishingAt });
    try {
      const result = await this.ports.bilibiliAPI.publishComment({
        dynamicId: summarySettings.dynamicId,
        content,
        images: resolvedImagePath ? [resolvedImagePath] : undefined
      });

      task.summaryReplyId = String(result.replyId);
      task.summaryCompletedAt = new Date();
      task.summaryPublishingAt = undefined;
      task.error = undefined;
      await this.completeOrWaitForLiveContentSummary(task);
      this.logger.info('晚安回复已发布到汇总动态', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: summarySettings.dynamicId,
        replyId: task.summaryReplyId,
        hasImage: !!resolvedImagePath
      });
    } catch (error) {
      if (task.summaryReplyId || task.summaryCompletedAt) {
        this.logger.error('Summary was published; follow-up failure must not repeat the comment', {
          taskId: task.taskId, replyId: task.summaryReplyId, error
        });
        return;
      }
      task.summaryPublishingAt = undefined;
      await this.ports.store.updateTask(task.taskId, { summaryPublishingAt: undefined });
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isBlacklistError = errorMessage.includes('黑名单') || errorMessage.includes('12035');
      const isCredentialError = this.ports.policy.isCredentialError(error);
      const canRetry =
        !isBlacklistError &&
        !isCredentialError &&
        !this.ports.policy.isPermanentReplyError(error) &&
        (task.summaryRetryCount || 0) < delayedReplyConfig.maxRetries;

      if (canRetry) {
        task.summaryRetryCount = (task.summaryRetryCount || 0) + 1;
        task.status = 'waiting_summary';
        task.scheduledTime = new Date(
          Date.now() + delayedReplyConfig.retryDelayMinutes * 60 * 1000
        );
        task.error = `汇总动态回复发布失败，等待重试: ${errorMessage}`;
        await this.ports.store.updateTask(task.taskId, {
          status: task.status,
          summaryRetryCount: task.summaryRetryCount,
          scheduledTime: task.scheduledTime,
          error: task.error
        });
        this.ports.scheduleTask(task);
        this.logger.warn('汇总动态回复发布失败，将独立重试', {
          taskId: task.taskId,
          roomId: task.roomId,
          retryCount: task.summaryRetryCount,
          nextRetryTime: task.scheduledTime.toISOString(),
          error: errorMessage
        });
        return;
      }

      task.error = `汇总动态回复发布失败，已停止重试: ${errorMessage}`;
      await this.ports.store.updateTask(task.taskId, {
        summaryRetryCount: task.summaryRetryCount || 0,
        error: task.error
      });
      this.logger.error('汇总动态回复发布最终失败，主人动态下的晚安回复已保留', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: summarySettings.dynamicId
      }, error instanceof Error ? error : new Error(errorMessage));
      await this.completeOrWaitForLiveContentSummary(task);
    }
  }

  async executeSupplementalComicReply(task: DelayedReplyTask): Promise<void> {
    if (task.supplementalReplyId || task.supplementalCompletedAt) {
      this.logger.info('补图回复已完成，继续确认汇总动态回复', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        supplementalReplyId: task.supplementalReplyId
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    if (task.supplementalPublishingAt) {
      task.error = 'Supplemental publication outcome is unknown; automatic resend stopped';
      await this.ports.store.updateTask(task.taskId, { error: task.error });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    if (!task.repliedDynamicId) {
      task.status = 'failed';
      task.error = '补图任务缺少已回复的动态ID';
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        error: task.error
      });
      return;
    }

    if (
      task.liveContentSummaryDeliveryMode === 'separate' ||
      task.liveContentSummaryForceSeparate
    ) {
      await this.tryPublishLiveContentSummarySeparately(task);
    }

    if (!task.comicImagePath) {
      task.error = '补图任务没有漫画图片路径';
      await this.ports.store.updateTask(task.taskId, {
        error: task.error
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    const resolvedPaths = this.ports.artifactResolver.resolve(task.roomId, task.goodnightTextPath, task.comicImagePath);
    if (resolvedPaths.goodnightTextPath !== task.goodnightTextPath || resolvedPaths.comicImagePath !== task.comicImagePath) {
      task.goodnightTextPath = resolvedPaths.goodnightTextPath;
      task.comicImagePath = resolvedPaths.comicImagePath;
      await this.ports.store.updateTask(task.taskId, {
        goodnightTextPath: task.goodnightTextPath,
        comicImagePath: task.comicImagePath
      });
    }

    const comicImagePath = task.comicImagePath;
    if (!comicImagePath) {
      task.error = '补图任务路径修复后没有漫画图片路径';
      await this.ports.store.updateTask(task.taskId, {
        error: task.error
      });
      await this.executeSummaryDynamicReply(task);
      return;
    }

    const hasComicImage = await this.ports.checkFileExists(comicImagePath);
    if (!hasComicImage) {
      task.comicWaitCount = (task.comicWaitCount || 0) + 1;

      if (this.ports.artifactResolver.isComicGenerationTerminalFailure(comicImagePath)) {
        await this.ports.notifyComicGenerationFailure(task);
        task.error = '漫画图片生成已失败，补图停止';
        await this.ports.store.updateTask(task.taskId, {
          error: task.error,
          comicWaitCount: task.comicWaitCount
        });
        this.logger.warn('漫画图片生成已失败，停止补图等待', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: task.repliedDynamicId,
          comicImagePath
        });
        await this.executeSummaryDynamicReply(task);
        return;
      }

      if (task.comicWaitCount >= SupplementaryReplyWorkflow.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT) {
        task.error = `补图等待达到上限 (${task.comicWaitCount}/${SupplementaryReplyWorkflow.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT})，停止等待`;
        this.ports.artifactResolver.writeComicGenerationFailureMeta(
          comicImagePath,
          task.error,
          task.taskId,
          task.roomId,
          task.repliedDynamicId
        );
        await this.ports.store.updateTask(task.taskId, {
          error: task.error,
          comicWaitCount: task.comicWaitCount
        });
        this.logger.warn('补图等待达到上限，停止等待漫画图片生成', {
          taskId: task.taskId,
          roomId: task.roomId,
          dynamicId: task.repliedDynamicId,
          comicImagePath,
          comicWaitCount: task.comicWaitCount,
          maxComicWaitCount: SupplementaryReplyWorkflow.MAX_SUPPLEMENTAL_COMIC_WAIT_COUNT
        });
        await this.executeSummaryDynamicReply(task);
        return;
      }

      task.status = 'waiting_comic';
      task.scheduledTime = new Date(Date.now() + SupplementaryReplyWorkflow.COMIC_WAIT_INTERVAL_MS);
      task.error = `等待漫画图片生成后补图 (${task.comicWaitCount})`;
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        scheduledTime: task.scheduledTime,
        comicWaitCount: task.comicWaitCount,
        error: task.error
      });
      this.logger.info('补图任务继续等待漫画图片生成', {
        taskId: task.taskId,
        roomId: task.roomId,
        dynamicId: task.repliedDynamicId,
        comicImagePath,
        nextCheckTime: task.scheduledTime.toISOString()
      });
      this.ports.scheduleTask(task);
      return;
    }

    try {
      const baseReplyText = this.buildSupplementalComicReplyText(await this.ports.replyContent.readReplyText(task.goodnightTextPath));
      const composition = this.ports.liveContentSummaryComposer.compose(task, baseReplyText, 'supplemental');
      const replyText = composition.text;
      task.supplementalPublishingAt = new Date();
      if (composition.attached) {
        task.liveContentSummaryState = 'publishing';
        task.liveContentSummaryPublishingAt = task.supplementalPublishingAt;
      }
      await this.ports.store.updateTask(task.taskId, {
        supplementalPublishingAt: task.supplementalPublishingAt,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });
      const result = await this.ports.bilibiliAPI.publishComment({
        dynamicId: task.repliedDynamicId,
        content: replyText,
        images: [comicImagePath]
      });

      task.status = BilibiliConfigHelper.getSummaryDynamicSettings()
        ? 'waiting_summary'
        : 'completed';
      task.supplementalReplyId = String(result.replyId);
      task.supplementalCompletedAt = new Date();
      task.supplementalPublishingAt = undefined;
      task.error = undefined;
      if (composition.attached) {
        this.ports.liveContentSummaryComposer.markAttached(task, 'supplemental', task.supplementalReplyId);
      }
      await this.ports.store.updateTask(task.taskId, {
        status: task.status,
        supplementalReplyId: task.supplementalReplyId,
        supplementalCompletedAt: task.supplementalCompletedAt,
        supplementalPublishingAt: undefined,
        error: undefined,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });

      this.logger.info('补图回复发布成功', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        replyId: task.supplementalReplyId,
        comicImagePath
      });

      if (this.ports.notifier) {
        await this.notifySupplementalComicReplySuccess(task, comicImagePath, result, replyText);
      }

      if (
        !composition.attached &&
        (task.liveContentSummaryDeliveryMode === 'separate' || task.liveContentSummaryForceSeparate)
      ) {
        await this.tryPublishLiveContentSummarySeparately(task);
      }

      await this.executeSummaryDynamicReply(
        task,
        await this.ports.replyContent.readReplyText(task.goodnightTextPath),
        comicImagePath
      );
    } catch (error) {
      if (task.supplementalReplyId || task.supplementalCompletedAt) {
        this.logger.error('Supplemental comic was published; follow-up failure must not repeat the comment', {
          taskId: task.taskId, replyId: task.supplementalReplyId, error
        });
        return;
      }
      task.supplementalPublishingAt = undefined;
      if (task.liveContentSummaryState === 'publishing') {
        task.liveContentSummaryState = 'ready';
        task.liveContentSummaryPublishingAt = undefined;
      }
      await this.ports.store.updateTask(task.taskId, {
        supplementalPublishingAt: undefined,
        ...this.ports.liveContentSummaryComposer.getTaskUpdates(task)
      });
      const delayedReplyConfig = BilibiliConfigHelper.getDelayedReplyConfig();
      const maxRetries = delayedReplyConfig.maxRetries;
      const isBlacklistError = String(error instanceof Error ? error.message : error).includes('黑名单') ||
        String(error instanceof Error ? error.message : error).includes('12035');
      const isCredentialError = this.ports.policy.isCredentialError(error);

      if (!isBlacklistError && !isCredentialError && !this.ports.policy.isPermanentReplyError(error) && task.retryCount < maxRetries) {
        task.retryCount++;
        task.status = 'waiting_comic';
        task.scheduledTime = new Date(Date.now() + delayedReplyConfig.retryDelayMinutes * 60 * 1000);
        task.error = `补图回复发布失败，等待重试: ${error instanceof Error ? error.message : String(error)}`;
        await this.ports.store.updateTask(task.taskId, {
          status: task.status,
          retryCount: task.retryCount,
          scheduledTime: task.scheduledTime,
          error: task.error
        });
        this.ports.scheduleTask(task);
        this.logger.warn('补图回复发布失败，将重试补图', {
          taskId: task.taskId,
          retryCount: task.retryCount,
          maxRetries,
          nextRetryTime: task.scheduledTime.toISOString(),
          error: task.error
        });
        return;
      }

      task.error = `补图回复发布失败，已停止重试: ${error instanceof Error ? error.message : String(error)}`;
      await this.ports.store.updateTask(task.taskId, {
        error: task.error
      });
      this.logger.error('补图回复发布最终失败，主文字回复已保留', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        comicImagePath
      }, error instanceof Error ? error : new Error(String(error)));
      await this.executeSummaryDynamicReply(task, undefined, comicImagePath);
    }
  }

  private buildSupplementalComicReplyText(replyText: string): string {
    return `${SupplementaryReplyWorkflow.SUPPLEMENTAL_COMIC_REPLY_PREFIX}${replyText}`;
  }
}
