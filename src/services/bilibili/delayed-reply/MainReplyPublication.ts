import { IBilibiliAPIService } from '../interfaces/IBilibiliAPIService';
import { IDelayedReplyStore } from '../interfaces/IDelayedReplyStore';
import { DelayedReplyTask, PublishCommentRequest, PublishCommentResponse } from '../interfaces/types';
import { commentPublicationOutcome } from '../CommentPublicationError';

/** Owns only the main send intent and recovery; the service still owns scheduling and follow-ups. */
export class MainReplyPublication {
  constructor(private readonly api: IBilibiliAPIService, private readonly store: IDelayedReplyStore,
    private readonly defer: (task: DelayedReplyTask) => Promise<void>) {}

  canReconcile(task: DelayedReplyTask): boolean {
    const intent = task.mainReplyIntent;
    return !!this.api.reconcileCommentPublication && !!intent && Number.isFinite(intent.startedAt)
      && intent.startedAt > 0 && typeof intent.request?.dynamicId === 'string'
      && typeof intent.request?.content === 'string' && !!intent.request.content.trim();
  }

  async publish(task: DelayedReplyTask, request: PublishCommentRequest, attachedSummary: boolean): Promise<PublishCommentResponse | undefined> {
    task.mainReplyIntent = { request: structuredClone(request), startedAt: Date.now(), attachedSummary };
    task.mainReplyState = 'publishing';
    await this.store.updateTask(task.taskId, { mainReplyState: task.mainReplyState, mainReplyIntent: task.mainReplyIntent });
    try {
      return await this.api.publishComment(request);
    } catch (error) {
      if (commentPublicationOutcome(error) !== 'unknown') {
        task.mainReplyState = 'ready';
        await this.store.updateTask(task.taskId, { mainReplyState: task.mainReplyState });
        throw error;
      }
      task.mainReplyState = 'unknown';
      await this.store.updateTask(task.taskId, { mainReplyState: task.mainReplyState });
      return this.reconcile(task);
    }
  }

  async reconcile(task: DelayedReplyTask): Promise<PublishCommentResponse | undefined> {
    if (this.canReconcile(task)) {
      try {
        const receipt = await this.api.reconcileCommentPublication!(task.mainReplyIntent!);
        if (receipt) return receipt;
      } catch { /* A failed read cannot authorize another publication; retry the read on the existing scheduler. */ }
      await this.defer(task);
    } else {
      task.status = 'failed';
      task.error = 'Main publication outcome is unknown; no receipt lookup is available';
      await this.store.updateTask(task.taskId, { status: task.status, mainReplyState: 'unknown', error: task.error });
    }
    return undefined;
  }
}
