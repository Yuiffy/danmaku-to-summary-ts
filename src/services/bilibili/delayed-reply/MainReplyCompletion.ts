import { getLogger } from '../../../core/logging/LogManager';
import { BilibiliConfigHelper } from '../BilibiliConfigHelper';
import { IDelayedReplyStore } from '../interfaces/IDelayedReplyStore';
import { DelayedReplyTask, PublishCommentRequest, PublishCommentResponse } from '../interfaces/types';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { DelayedReplyArtifactResolver } from './DelayedReplyArtifactResolver';
import { DelayedReplyDiagnostics } from './DelayedReplyDiagnostics';
import { LiveContentSummaryComposer } from './LiveContentSummaryComposer';

interface CompletionOptions {
  store: IDelayedReplyStore;
  notifier?: WeChatWorkNotifier;
  artifactResolver: DelayedReplyArtifactResolver;
  diagnostics: DelayedReplyDiagnostics;
  liveContentSummaryComposer: LiveContentSummaryComposer;
  scheduleTask(task: DelayedReplyTask): void;
  tryPublishLiveContentSummarySeparately(task: DelayedReplyTask): Promise<'waiting' | 'failed' | 'done' | 'retry'>;
  executeSummaryDynamicReply(task: DelayedReplyTask, text: string, image?: string): Promise<void>;
}

/** Common receipt completion for normal sends and recovered sends. Never sends the main comment. */
export class MainReplyCompletion {
  private readonly logger = getLogger('MainReplyCompletion');
  constructor(private readonly options: CompletionOptions) {}
  async complete(task: DelayedReplyTask, request: PublishCommentRequest,
    result: PublishCommentResponse, attachedSummary: boolean): Promise<void> {
    const replyText = request.content, imagePath = request.images;
    this.logger.info(`延迟回复评论发布成功: ${task.taskId}`, {
      dynamicId: String(request.dynamicId),
      replyId: String(result.replyId)
    });
    // 输出回复链接
    const replyUrl = `https://www.bilibili.com/opus/${String(request.dynamicId)}#reply${String(result.replyId)}`;
    this.logger.info(`回复链接: ${replyUrl}`);

    task.repliedDynamicId = String(request.dynamicId);
    task.replyId = String(result.replyId);
    task.mainReplyState = 'published';
    task.mainReplyHasImage = !!imagePath?.length;
    // A ready event may attach a comic while the main request is in flight.
    const shouldWaitForSupplementalComic = !task.mainReplyHasImage && !!task.comicImagePath &&
      !this.options.artifactResolver.isComicGenerationTerminalFailure(task.comicImagePath);
    task.completedAt = new Date();
    task.error = undefined;
    if (attachedSummary) {
      this.options.liveContentSummaryComposer.markAttached(task, 'main', task.replyId);
    }

    if (shouldWaitForSupplementalComic) {
      task.comicWaitCount = 0;
      task.status = 'waiting_comic';
      task.scheduledTime = new Date(Date.now() + 2 * 60 * 1000);
      task.error = '已发送纯文字晚安回复，等待漫画图片生成后补图';

      await this.options.store.updateTask(task.taskId, {
        status: task.status,
        repliedDynamicId: task.repliedDynamicId,
        replyId: task.replyId,
        mainReplyState: task.mainReplyState,
        mainReplyHasImage: task.mainReplyHasImage,
        completedAt: task.completedAt,
        scheduledTime: task.scheduledTime,
        comicWaitCount: task.comicWaitCount,
        error: task.error,
        ...this.options.liveContentSummaryComposer.getTaskUpdates(task)
      });

      this.logger.info('已发送纯文字晚安回复，继续等待漫画图片生成后补图', {
        taskId: task.taskId,
        dynamicId: task.repliedDynamicId,
        replyId: task.replyId,
        comicImagePath: task.comicImagePath,
        nextCheckTime: task.scheduledTime.toISOString()
      });

      this.options.scheduleTask(task);
    } else {
      const hasPendingLiveContent = !!task.liveContentSummaryPath &&
        !this.options.liveContentSummaryComposer.isDelivered(task) &&
        task.liveContentSummaryState !== 'failed';
      task.status = BilibiliConfigHelper.getSummaryDynamicSettings()
        ? 'waiting_summary'
        : hasPendingLiveContent
          ? 'waiting_live_content'
          : 'completed';
      await this.options.store.updateTask(task.taskId, {
        status: task.status,
        repliedDynamicId: task.repliedDynamicId,
        replyId: task.replyId,
        mainReplyState: task.mainReplyState,
        mainReplyHasImage: task.mainReplyHasImage,
        completedAt: task.completedAt,
        error: undefined,
        ...this.options.liveContentSummaryComposer.getTaskUpdates(task)
      });

      this.logger.info(`延迟回复完成: ${task.taskId}`, {
        dynamicId: String(request.dynamicId)
      });
    }

    if (
      !attachedSummary &&
      (task.liveContentSummaryDeliveryMode === 'separate' || task.liveContentSummaryForceSeparate)
    ) {
      await this.options.tryPublishLiveContentSummarySeparately(task);
    }

    // B站评论已经成功发布并持久化，通知失败不能触发重试，否则会重复评论。
    if (this.options.notifier) {
      try {
        const anchorConfig = BilibiliConfigHelper.getAnchorConfig(task.roomId);
        const anchorName = anchorConfig?.name;
        const imageGenerationInfo = this.options.diagnostics.getComicGenerationInfo(task.comicImagePath);
        const textGenerationInfo = this.options.diagnostics.getTextGenerationInfo(task.goodnightTextPath, task.comicImagePath);
        await this.options.notifier.notifyReplySuccess(
          String(request.dynamicId),
          String(result.replyId),
          anchorName,
          replyText,
          result.imageUrl,
          imagePath ? imagePath[0] : undefined,
          imageGenerationInfo,
          textGenerationInfo
        );
      } catch (notifyError) {
        this.logger.warn('动态回复已发布，但成功通知发送异常；不会重试评论避免重复回复', {
          taskId: task.taskId,
          dynamicId: String(request.dynamicId),
          replyId: String(result.replyId),
          error: notifyError instanceof Error ? notifyError.message : String(notifyError)
        });
      }
    }

    if (shouldWaitForSupplementalComic) {
      return;
    }

    await this.options.executeSummaryDynamicReply(
      task,
      replyText,
      imagePath ? imagePath[0] : undefined
    );
  }

}
