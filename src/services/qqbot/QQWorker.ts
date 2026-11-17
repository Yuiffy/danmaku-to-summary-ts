import { SAFETY_NOTICE, shanghaiDay, unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { QQConfig, QQInbound, QQRequest, QQ_FAILURE_REPLY, QQ_LIMITS, QQ_QUOTA_REPLY, publishableQQAnswer, publishableQQVideoReview, qqFixedReply, qqRequest, qqImageReplyTrigger } from './QQPolicy';
import { QQState } from './QQState';
import { QQRecordUpdate } from './QQRecords';
import { QQ_MODEL } from './QQPolicy';
import { QQExecuteImage, QQImageCommand, QQImageDelivery, QQImageResult, QQImageToolResult, QQ_IMAGE_LIMITS, qqImageFailureReply, qqImageCommandForRequest, qqImageCommandReply, qqImageQuota, qqImageModel } from './QQImagePolicy';
import { QQAgentTrace } from '../../core/admin/qqRecords';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { QQDiagnosticError, qqDiagnostic, qqFailure } from './QQDiagnostics';
import { QQImageInputDiagnostic, qqImageInputDiagnostic } from './QQImageInputPolicy';
import type { QQImageSourceRead } from './QQImageInputs';
import type { QQSendReceiptDiagnostic } from './QQSendReceipt';
import { QQSendRejectedError } from './QQSendReceipt';
import type { QQImageRejectionEvent } from './QQImageRejections';
import type { QQVideoResult } from './QQVideoPolicy';
import { qqVideoMentioned, qqVideoRequested, qqVideoConfirmRequested } from './QQVideoPolicy';
import { qqImageRequested, qqImageCreationConfirmed, qqImageEditRequested } from './QQImagePolicy';
import type { QQImageTaskActions, QQImageTaskStatus } from './QQImageTaskTools';
import { qqMediaOperator, QQ_MEDIA_OPERATOR_LIMITS } from './QQMediaAccess';
import { QQ_IMAGE_QUEUE } from './QQImageSchedule';
import { qqReplyParts } from './QQReplyDelivery';

export type QQTextAnswer = string | { text: string; tokens: number; video?: QQVideoResult; videoReview?: boolean };
export interface QQLogEvent {
  event: string; scope?: string; requestId?: string; failure?: QQDiagnostic; agent?: QQAgentTrace;
  queuedMs?: number; elapsedMs?: number; route?: 'image' | 'text';
  retryAttempt?: number;
  imageInput?: QQImageInputDiagnostic;
  imageSourceCount?: number;
  imageSourceDiagnosticsVersion?: 1;
  attachmentDiagnosticsVersion?: 1;
  videoSourceErrorsVersion?: 1;
  videoReferencesVersion?: 1;
  mediaSourceAwarenessVersion?: 1;
  imageCharacterAliasesVersion?: 1;
  imageSourceModeVersion?: 1;
  sendReceiptDiagnosticsVersion?: 1;
  sendRejectionIsolationVersion?: 1;
  imageRejectionNotificationsVersion?: 1;
  recentImageContextVersion?: 1;
  replyProgressVersion?: 1;
  multipartReplyVersion?: 1;
  mediaLimitsVersion?: 1;
  imageQueueVersion?: 1;
  automaticImageRepliesVersion?: 1;
  deferredImageNoticeVersion?: 1;
  rejectionNotice?: QQImageRejectionEvent['rejectionNotice'];
  sendReceipt?: QQSendReceiptDiagnostic;
  sourceRead?: QQImageSourceRead;
  imageLimit?: { reason: 'user_daily' | 'user_window' | 'global_daily' | 'interval'; retryAt: number };
}
export interface QQWorkerIO {
  now(): number;
  save(state: QQState): Promise<void>;
  record(request: QQRequest, update: QQRecordUpdate): Promise<void>;
  acknowledge?(request: QQRequest, text: string): Promise<boolean>;
  answer(request: QQRequest, signal: AbortSignal, executeImage?: QQExecuteImage, imageTasks?: QQImageTaskActions): Promise<QQTextAnswer>;
  image?(request: QQRequest, signal: AbortSignal, command?: QQImageCommand): Promise<QQImageResult>;
  pendingImage?(request: QQRequest): Promise<QQImageDelivery | undefined>;
  readImageTask?(request: QQRequest): Promise<QQImageTaskStatus>;
  collectImage?(request: QQRequest): Promise<QQImageDelivery | undefined>;
  imageAdmission?(request: QQRequest): string | undefined;
  enqueueImage?(request: QQRequest, command: QQImageCommand): Promise<QQImageToolResult>;
  waitImage?(request: QQRequest, signal: AbortSignal, waitMs: number): Promise<QQImageDelivery | undefined>;
  hasReadyImage?(request: QQRequest): boolean;
  imagePending?(key: string): boolean;
  readyImage?(request: QQRequest, key?: string): Promise<(QQImageDelivery & { request: QQRequest }) | undefined>;
  schedule?(callback: () => void, ms: number): () => void;
  send(request: QQRequest, text: string, image?: QQImageResult, video?: QQVideoResult): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  report(event: QQLogEvent): void;
}

/** Serial, bounded replies. Ordinary group events may only deliver already generated same-group images. */
export class QQWorker {
  private queue: QQRequest[] = [];
  private pending = new Map<string, QQRequest>();
  private imageOrigins = new Map<string, QQRequest>();
  private imageReplies = new Map<string, QQRequest>();
  private imageTimers = new Map<string, () => void>();
  private imageDue = new Set<string>();
  private supplementOnly = new Set<string>();
  private running?: Promise<void>;
  private lifetime = new AbortController();
  private botId?: string;
  constructor(private readonly config: QQConfig, readonly state: QQState, private readonly io: QQWorkerIO) {}
  setBotId(id: string): void { this.botId = id; }
  imageReady(key: string): void {
    this.pruneImageOrigins();
    const request = this.imageOrigins.get(key);
    if (!request || this.state.paused || this.lifetime.signal.aborted) return;
    this.imageReplies.set(key, request); this.start();
  }
  private pruneImageOrigins(): void {
    for (const [key, request] of this.imageOrigins) if (this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) this.imageReplies.set(key, request);
    if (this.imageReplies.size) this.start();
  }
  private forgetImageOrigin(key: string): void {
    this.imageTimers.get(key)?.(); this.imageTimers.delete(key); this.imageDue.delete(key);
    this.imageOrigins.delete(key); this.imageReplies.delete(key);
  }
  private watchImage(request: QQRequest): void {
    this.imageOrigins.set(request.key, request);
    const callback = () => { this.imageDue.add(request.key); this.imageReady(request.key); };
    const ms = Math.max(0, QQ_LIMITS.maxAgeMs - 20000 - (this.io.now() - request.createdAt));
    const cancel = this.io.schedule ? this.io.schedule(callback, ms) : (() => {
      const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
    })();
    this.imageTimers.set(request.key, cancel);
    this.imageReady(request.key); // A fast completion may precede registration.
  }
  private start(): void {
    if (!this.running) this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = undefined;
      if (!this.lifetime.signal.aborted && !this.state.paused && (this.queue.length || this.imageReplies.size)) this.start();
    });
  }
  receive(message: QQInbound): boolean {
    if (this.lifetime.signal.aborted || this.state.paused) return false;
    this.pruneImageOrigins();
    let request = qqRequest(message, this.io.now(), this.botId);
    const supplementOnly = !request;
    if (!request && this.config.images?.enabled && this.config.groupMessageMode !== 'mention' && this.io.readyImage) {
      const trigger = qqImageReplyTrigger(message, this.io.now(), this.botId);
      if (trigger && this.io.hasReadyImage?.(trigger)) request = trigger;
    }
    const imageSubmission = request?.scope === 'group' && this.config.images?.enabled && !qqVideoMentioned(request.text) &&
      qqImageRequested(request.text, request.imageInput) && (qqImageCreationConfirmed(request.text) || qqImageEditRequested(request.text));
    const userQueue = Math.max(this.config.maxUserQueue, imageSubmission ? QQ_IMAGE_QUEUE.waiting : 0,
      request && qqMediaOperator(this.config, request.user) ? QQ_MEDIA_OPERATOR_LIMITS.maxUserQueue : 0);
    if (!request || this.state.receipts[request.key] || this.pending.has(request.key) || this.pending.size >= this.config.maxQueue ||
      [...this.pending.values()].filter(item => item.user === request.user).length >= userQueue) return false;
    this.pending.set(request.key, request); this.queue.push(request);
    if (supplementOnly) this.supplementOnly.add(request.key);
    this.io.report({ event: 'qq_request_accepted', scope: request.scope, requestId: request.key });
    if (request.scope === 'group' && this.config.images?.enabled) this.io.report({ event: 'qq_image_input', scope: request.scope,
      requestId: request.key, imageInput: qqImageInputDiagnostic(message, request.imageInput) });
    this.start();
    return true;
  }
  stop(): void {
    this.lifetime.abort(); this.queue = [];
    for (const key of this.imageOrigins.keys()) this.forgetImageOrigin(key);
    this.supplementOnly.clear();
  }
  async idle(): Promise<void> { while (this.running) await this.running; }
  private async drain(): Promise<void> {
    let active: QQRequest | undefined;
    try {
      while ((this.queue.length || this.imageReplies.size) && !this.lifetime.signal.aborted && !this.state.paused) {
        if (this.imageReplies.size) {
          const [key, request] = this.imageReplies.entries().next().value!;
          this.imageReplies.delete(key); active = request;
          const age = this.io.now() - request.createdAt;
          if (age <= QQ_LIMITS.maxAgeMs - 20000 && this.remainingReplies(request) > 1) {
            const result = await this.io.readyImage?.(request, key);
            if (result) {
              this.forgetImageOrigin(key);
              await this.sendReply(result.request, result.text, result.image);
              this.io.report({ event: result.image ? 'qq_image_inline_ready' : 'qq_image_inline_failed', scope: request.scope, requestId: request.key,
                elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
              if (this.state.receipts[request.key]?.status === 'sent') await this.supplement(request);
            }
          }
          if (this.imageOrigins.has(key) && (this.imageDue.has(key) || age >= QQ_LIMITS.maxAgeMs - 20000)) {
            this.forgetImageOrigin(key);
            if (age < QQ_LIMITS.maxAgeMs && this.io.imagePending?.(key) !== false) {
              await this.sendReply(request, '这张图还在生成或排队，完成后会在本群有回复机会时补发，也可以稍后艾特我领取，不用重复生图。');
              this.io.report({ event: 'qq_image_deferred', scope: request.scope, requestId: request.key,
                elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
            } else {
              this.state.receipts[key].status = 'skipped'; await this.io.save(this.state);
              await this.io.record(request, { status: 'skipped' });
            }
          }
          continue;
        }
        const request = this.queue.shift()!;
        active = request;
        try {
          if (this.supplementOnly.delete(request.key)) await this.supplement(request);
          else await this.process(request);
        }
        finally { this.pending.delete(request.key); }
      }
    } catch (error) {
      // A checkpoint failure cannot authorize further model calls or sending.
      this.state.paused = true;
      this.io.report({ event: 'qq_state_failure', requestId: active?.key, scope: active?.scope,
        failure: qqDiagnostic(error, 'state', 'state_failed') });
    } finally {
      if (this.state.paused || this.lifetime.signal.aborted) {
        this.queue = []; this.pending.clear();
        for (const key of this.imageOrigins.keys()) this.forgetImageOrigin(key);
        this.supplementOnly.clear();
      }
    }
  }
  private async process(request: QQRequest): Promise<void> {
    const state = this.state, now = this.io.now(), day = shanghaiDay(now);
    const operator = qqMediaOperator(this.config, request.user);
    if (now - request.createdAt >= QQ_LIMITS.maxAgeMs) return;
    for (const [key, receipt] of Object.entries(state.receipts)) if (now - receipt.at >= QQ_LIMITS.retentionMs) delete state.receipts[key];
    if (Object.keys(state.receipts).length >= QQ_LIMITS.maxReceipts) return;
    if (state.day !== day) {
      state.day = day; state.tokens = 0; state.images = 0;
      for (const [key, user] of Object.entries(state.users)) {
        user.count = 0; user.images = 0; user.starts = user.starts.filter(at => now - at < QQ_LIMITS.userWindowMs);
        user.imageStarts = (user.imageStarts || []).filter(at => now - at < QQ_IMAGE_LIMITS.userWindowMs);
        if (!user.starts.length && !user.imageStarts.length && now - (user.privateAt || 0) >= QQ_LIMITS.privateIntervalMs && (user.noticeUntil || 0) <= now) delete state.users[key];
      }
    }
    if (!state.users[request.user] && Object.keys(state.users).length >= QQ_LIMITS.maxReceipts) return;
    const user = state.users[request.user] ||= { count: 0, starts: [] };
    state.receipts[request.key] = { at: now, status: 'accepted' };
    await this.io.record(request, { status: 'accepted', queuedMs: Math.max(0, now - request.createdAt) });
    const checkpoint = async () => {
      await this.io.save(state);
      await this.io.record(request, { status: state.receipts[request.key].status });
    };
    let answer = qqFixedReply(request, this.config);
    let image: QQImageResult | undefined;
    let video: QQVideoResult | undefined;
    let pendingMessage: string | undefined;
    let collageNotice: string | undefined, collageNotified = false;
    let imageQueued = false, imageTaskUsed = false;
    let imageTaskMessage: string | undefined;
    let imageLimitMessage: string | undefined;
    const imageRequest = request.scope === 'group' && this.config.images?.enabled && !qqVideoMentioned(request.text) &&
      qqImageRequested(request.text, request.imageInput) && (qqImageCreationConfirmed(request.text) || qqImageEditRequested(request.text));
    if (request.scope === 'group' && this.config.images?.enabled && !request.text.trim()) {
      const delivery = await this.io.pendingImage?.(request);
      if (delivery) {
        imageTaskUsed = true;
        answer = delivery.text; image = delivery.image;
        if (image) await this.io.record(request, { status: 'accepted', model: image.model,
          image: { sha256: image.sha256, prompt: image.prompt, ...(image.format ? { format: image.format } : {}) } });
      }
    }
    if (!answer && imageRequest && !unsafeComment(request.text)) {
      answer = this.io.imageAdmission?.(request);
      if (!answer) {
        user.imageStarts = (user.imageStarts || []).filter(at => now - at < QQ_IMAGE_LIMITS.userWindowMs);
        const limit = qqImageQuota(now, this.config.images!, user, state, operator);
        if (limit) {
          answer = limit.message;
          this.io.report({ event: 'qq_image_limited', scope: request.scope, requestId: request.key,
            imageLimit: { reason: limit.reason, retryAt: limit.retryAt } });
        }
      }
    }
    if (request.scope === 'c2c') {
      if (user.privateAt !== undefined && now - user.privateAt < QQ_LIMITS.privateIntervalMs) answer = '';
      else user.privateAt = now;
    } else if (!answer) {
      if (unsafeComment(request.text)) answer = SAFETY_NOTICE;
      else {
        state.starts = state.starts.filter(at => now - at < 60000);
        user.starts = user.starts.filter(at => now - at < QQ_LIMITS.userWindowMs);
        const limited = state.tokens + QQ_LIMITS.reservation > this.config.dailyTokenBudget ||
          (!imageRequest && state.starts.length >= QQ_LIMITS.startsPerMinute) || user.starts.length >= QQ_LIMITS.userWindowReplies;
        if (limited) {
          answer = (user.noticeUntil || 0) > now ? '' : QQ_QUOTA_REPLY;
          if (answer) user.noticeUntil = now + 3600000;
        } else {
          state.tokens += QQ_LIMITS.reservation; user.count++; user.starts.push(now); state.starts.push(now);
          state.starts = state.starts.slice(-QQ_LIMITS.startsPerMinute);
          state.receipts[request.key].status = 'generating';
          await checkpoint(); // Reserve/dedupe and archive before any provider IO.
          await this.io.record(request, { status: 'generating', model: QQ_MODEL });
          if (this.lifetime.signal.aborted) {
            state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
          }
          const progress = this.config.videos?.enabled && (qqVideoRequested(request.text) || qqVideoConfirmRequested(request.text))
            ? '收到视频要求，正在处理；需要确认的草稿会先发给你检查。'
            : imageRequest ? '收到生图要求，正在处理。' : undefined;
          if (progress && this.io.acknowledge && !await this.io.acknowledge(request, progress)) {
            state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
          }
          const started = this.io.now();
          this.io.report({ event: 'qq_generation_started', requestId: request.key, scope: request.scope, route: 'text', queuedMs: Math.max(0, started - request.createdAt) });
          const controller = new AbortController(), abort = () => controller.abort(qqFailure('agent_run', 'aborted'));
          this.lifetime.signal.addEventListener('abort', abort, { once: true });
          const remaining = this.config.images?.enabled ? Math.max(1, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 10000) : QQ_LIMITS.timeoutMs;
          const timer = setTimeout(() => controller.abort(qqFailure('agent_run', 'timeout')), remaining);
          try {
            let imageAttempted = false, collected = false;
            const executeImage: QQExecuteImage = async requestedCommand => {
              const command = qqImageCommandForRequest(request, requestedCommand);
              controller.signal.throwIfAborted();
              const options = this.config.images;
              const blocked = (message: string): QQImageToolResult => ({ status: 'blocked', message });
              if (collected) return blocked('本条消息已领取已有图片，不能重新提交生图。');
              if (!options?.enabled || !this.io.image && !this.io.enqueueImage) return blocked('图片功能未启用。');
              const confirmation = qqImageCommandReply(request, command, options);
              if (confirmation) return blocked(confirmation);
              if (unsafeComment(command.instruction)) return blocked(SAFETY_NOTICE);
              if (imageAttempted) return blocked('本题已尝试过一次图片生成，不能重复付费调用。');
              const admission = this.io.imageAdmission?.(request);
              if (admission) return blocked(admission);
              const at = this.io.now();
              user.imageStarts = (user.imageStarts || []).filter(value => at - value < QQ_IMAGE_LIMITS.userWindowMs);
              const limit = qqImageQuota(at, options, user, state, operator);
              if (limit) {
                imageLimitMessage = limit.message;
                this.io.report({ event: 'qq_image_limited', scope: request.scope, requestId: request.key,
                  imageLimit: { reason: limit.reason, retryAt: limit.retryAt } });
                return blocked(limit.message);
              }
              imageLimitMessage = undefined;
              imageAttempted = true;
              state.images = (state.images || 0) + 1; user.images = (user.images || 0) + 1;
              user.imageStarts.push(at); state.lastImageAt = at;
              const persistImage = async (update: QQRecordUpdate) => {
                try { await this.io.save(state); await this.io.record(request, update); }
                catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, 'state', 'record_failed')); }
              };
              await persistImage({ status: 'generating', model: qqImageModel(request, options) });
              this.io.report({ event: 'qq_generation_started', requestId: request.key, scope: request.scope, route: 'image', queuedMs: Math.max(0, at - request.createdAt) });
              if (this.io.enqueueImage) {
                try {
                  const result = await this.io.enqueueImage(request, command);
                  imageQueued = !!(result.queued || result.background);
                  if (result.status === 'blocked' || result.status === 'failed') {
                    state.images!--; user.images!--; user.imageStarts.pop(); await checkpoint();
                    imageLimitMessage = result.message;
                  }
                  if (result.status === 'pending') {
                    pendingMessage = result.message; collageNotice = result.collageNotice;
                    if (collageNotice && this.io.acknowledge) {
                      await this.io.acknowledge(request, collageNotice); collageNotified = true;
                    }
                  }
                  return result;
                } catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, 'state', 'record_failed')); }
              }
              const imageController = new AbortController(), abortImage = () => imageController.abort(controller.signal.reason);
              controller.signal.addEventListener('abort', abortImage, { once: true });
              if (controller.signal.aborted) abortImage();
              const imageTimer = setTimeout(() => imageController.abort(qqFailure('image_http', 'timeout')), Math.max(1,
                Math.min(options.timeoutMs, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 10000)));
              try {
                imageController.signal.throwIfAborted();
                image = await this.io.image!(request, imageController.signal, command);
                imageController.signal.throwIfAborted();
              } catch (error) {
                image = undefined;
                const failure = qqDiagnostic(error, 'image_http', 'unexpected', imageController.signal, { elapsedMs: Math.max(0, this.io.now() - at) });
                this.io.report({ event: 'qq_image_failed', scope: request.scope, requestId: request.key, failure });
                await persistImage({ status: 'generating', error: 'image_failed', failure });
                return { status: 'failed', message: qqImageFailureReply(failure, { sourceInput: !!request.imageInput }) };
              } finally { clearTimeout(imageTimer); controller.signal.removeEventListener('abort', abortImage); }
              await persistImage({ status: 'generating', model: image.model,
                image: { sha256: image.sha256, prompt: image.prompt, ...(image.format ? { format: image.format } : {}) } });
              return { status: 'generated', message: (image.collageNotice || '') + (command.mode === 'edit' ? '原图编辑完成。' : '图片生成完成。') };
            };
            const imageTasks: QQImageTaskActions | undefined = this.config.images?.enabled && this.io.collectImage ? {
              read: async () => {
                controller.signal.throwIfAborted(); imageTaskUsed = true;
                return this.io.readImageTask?.(request) ?? { status: 'none', message: '图片任务查询未启用。' };
              },
              collect: async () => {
                controller.signal.throwIfAborted(); imageTaskUsed = true;
                if (collected || imageAttempted) return { status: 'none', message: '本条消息已经领取或提交图片任务，不能重复操作。' };
                collected = true;
                try {
                  const delivery = await this.io.collectImage!(request);
                  imageTaskMessage = delivery?.text || '本人在本群没有可领取的图片任务。'; image = delivery?.image;
                  if (image) await this.io.record(request, { status: 'generating', model: image.model,
                    image: { sha256: image.sha256, prompt: image.prompt, ...(image.format ? { format: image.format } : {}) } });
                  return { status: image ? 'collected' : 'reported', message: imageTaskMessage };
                } catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, 'state', 'record_failed')); }
              }
            } : undefined;
            const result = await this.io.answer(request, controller.signal, this.config.images?.enabled ? executeImage : undefined, imageTasks);
            controller.signal.throwIfAborted();
            answer = imageTaskMessage || pendingMessage || imageLimitMessage || (typeof result !== 'string' && result.videoReview ? publishableQQVideoReview(result.text) : publishableQQAnswer(typeof result === 'string' ? result : result.text));
            if (!answer) throw qqFailure('answer_validation', 'unsafe_answer');
            if (typeof result !== 'string') {
              video = result.video;
              if (!Number.isSafeInteger(result.tokens) || result.tokens < 1 || result.tokens > QQ_LIMITS.reservation) throw qqFailure('answer_validation', 'invalid_tokens');
              // The full ceiling is durable before IO. Settle a successful run only; failures retain it.
              state.tokens -= QQ_LIMITS.reservation - result.tokens;
            }
          }
          catch (error) {
            const failure = qqDiagnostic(error, 'agent_run', 'unexpected', controller.signal, { elapsedMs: Math.max(0, this.io.now() - started) });
            this.io.report({ event: 'qq_model_failed', scope: request.scope, requestId: request.key, failure });
            if (failure.code === 'record_failed') throw error;
            answer = imageTaskMessage || pendingMessage || imageLimitMessage || (image ? '图片已生成。' : QQ_FAILURE_REPLY);
            await this.io.record(request, { status: 'generating', error: 'model_failed', failure });
          }
          finally {
            clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort);
            state.starts[state.starts.length - 1] = this.io.now(); user.starts[user.starts.length - 1] = this.io.now();
          }
        }
      }
    }
    if (pendingMessage && !imageQueued && !operator && !this.io.readyImage && !this.lifetime.signal.aborted && !state.paused && this.io.waitImage) {
      // Keep paid work alive; reserve twenty seconds of the original window for persistence/upload/send.
      const waitMs = Math.max(0, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 20000);
      const delivery = await this.io.waitImage(request, this.lifetime.signal, waitMs);
      if (delivery) {
        answer = delivery.text; image = delivery.image;
        if (image) {
          await this.io.record(request, { status: 'generating', model: image.model,
            image: { sha256: image.sha256, prompt: image.prompt, ...(image.format ? { format: image.format } : {}) } });
          this.io.report({ event: 'qq_image_inline_ready', scope: request.scope, requestId: request.key,
            elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
        }
      } else if (!this.lifetime.signal.aborted) this.io.report({ event: 'qq_image_deferred', scope: request.scope, requestId: request.key,
        elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
    }
    if (!answer || state.paused || this.lifetime.signal.aborted || this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) {
      state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
    }
    if (pendingMessage && !image && this.io.readyImage) {
      if (collageNotice && !collageNotified) await this.sendReply(request, collageNotice);
      await checkpoint(); this.watchImage(request); return;
    }
    if (image?.collageNotice && answer && !answer.includes(image.collageNotice)) answer = image.collageNotice + answer;
    await this.sendReply(request, answer, image, video);
    if (!pendingMessage && !imageTaskUsed && state.receipts[request.key].status === 'sent') await this.supplement(request);
  }
  private remainingReplies(request: QQRequest): number { return 5 - (this.state.receipts[request.key]?.replies || 0); }
  private async supplement(trigger: QQRequest): Promise<void> {
    if (!this.io.readyImage || trigger.scope !== 'group') return;
    // Borrow at most one reply per trigger, keeping one for a possible image-rejection notice.
    if (!this.state.paused && !this.lifetime.signal.aborted && this.remainingReplies(trigger) > 1 &&
      this.io.now() - trigger.createdAt < QQ_LIMITS.maxAgeMs - 20000) {
      const needed = this.state.receipts[trigger.key] ? 1 : 2;
      if (Object.keys(this.state.receipts).length + needed > QQ_LIMITS.maxReceipts) return;
      const result = await this.io.readyImage(trigger);
      if (!result) return;
      if (!this.state.receipts[trigger.key]) this.state.receipts[trigger.key] = { at: this.io.now(), status: 'accepted' };
      this.state.receipts[result.request.key] = { at: this.io.now(), status: 'accepted' };
      await this.io.record(result.request, { status: 'accepted' });
      await this.sendReply(result.request, result.text, result.image, undefined, trigger);
      if (this.state.receipts[result.request.key].status !== 'sent') return;
    }
    // Plain group events have no answer of their own; dedupe their borrowed window too.
    if (this.state.receipts[trigger.key]?.status === 'accepted') {
      this.state.receipts[trigger.key].status = 'sent'; await this.io.save(this.state);
    }
  }
  private async sendReply(request: QQRequest, answer: string, image?: QQImageResult, video?: QQVideoResult, trigger = request): Promise<void> {
    const state = this.state;
    const checkpoint = async () => {
      await this.io.save(state); await this.io.record(request, { status: state.receipts[request.key].status });
    };
    const count = image || video ? 1 : qqReplyParts(answer).length;
    if (state.paused || this.lifetime.signal.aborted || this.remainingReplies(trigger) < count) return;
    const delay = Math.max(0, state.lastSendAt + QQ_LIMITS.sendIntervalMs - this.io.now());
    if (delay) {
      try { await this.io.sleep(delay, this.lifetime.signal); }
      catch { state.receipts[request.key].status = 'skipped'; await checkpoint(); return; }
    }
    if (this.lifetime.signal.aborted || this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) {
      state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
    }
    // Save intent before a single passive reply. An uncertain send is never retried.
    state.receipts[trigger.key].replies = (state.receipts[trigger.key].replies || 0) + count;
    state.lastSendAt = this.io.now(); state.receipts[request.key].status = 'sending'; await this.io.save(state);
    await this.io.record(request, { status: 'sending', answer, ...(image ? { model: image.model,
      image: { sha256: image.sha256, prompt: image.prompt, ...(image.format ? { format: image.format } : {}) } } : {}) });
    try {
      if (video) await this.io.send(request, answer, image, video);
      else await this.io.send(request, answer, image);
      state.receipts[request.key].status = 'sent';
      this.io.report({ event: 'qq_reply_sent', scope: request.scope, requestId: request.key, elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
    } catch (error) {
      const rejected = error instanceof QQSendRejectedError;
      state.receipts[request.key].status = 'unknown';
      if (!rejected) state.paused = true;
      const failure = { ...qqDiagnostic(error, 'send', 'send_failed'), ...(rejected ? { httpStatus: error.httpStatus } : {}) };
      this.io.report({ event: rejected ? 'qq_send_rejected' : 'qq_send_unknown', scope: request.scope, requestId: request.key, failure });
      await this.io.record(request, { status: 'unknown', sendFailure: failure });
    }
    await checkpoint();
  }
}
