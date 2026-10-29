import { SAFETY_NOTICE, publishableAnswer, shanghaiDay, unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { QQConfig, QQInbound, QQRequest, QQ_FAILURE_REPLY, QQ_LIMITS, QQ_QUOTA_REPLY, qqFixedReply, qqRequest } from './QQPolicy';
import { QQState } from './QQState';
import { QQRecordUpdate } from './QQRecords';
import { QQ_MODEL } from './QQPolicy';
import { QQExecuteImage, QQImageCommand, QQImageDelivery, QQImageResult, QQImageToolResult, QQ_IMAGE_LIMITS, QQ_IMAGE_SOURCE_REPLY, qqImageCommandReply } from './QQImagePolicy';
import { QQAgentTrace } from '../../core/admin/qqRecords';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { QQDiagnosticError, qqDiagnostic, qqFailure } from './QQDiagnostics';
import { QQImageInputDiagnostic, qqImageInputDiagnostic } from './QQImageInputPolicy';

export type QQTextAnswer = string | { text: string; tokens: number };
export interface QQLogEvent {
  event: string; scope?: string; requestId?: string; failure?: QQDiagnostic; agent?: QQAgentTrace;
  queuedMs?: number; elapsedMs?: number; route?: 'image' | 'text';
  imageInput?: QQImageInputDiagnostic;
  imageSourceCount?: number;
}
export interface QQWorkerIO {
  now(): number;
  save(state: QQState): Promise<void>;
  record(request: QQRequest, update: QQRecordUpdate): Promise<void>;
  answer(request: QQRequest, signal: AbortSignal, executeImage?: QQExecuteImage): Promise<QQTextAnswer>;
  image?(request: QQRequest, signal: AbortSignal, command?: QQImageCommand): Promise<QQImageResult>;
  pendingImage?(request: QQRequest): Promise<QQImageDelivery | undefined>;
  imageAdmission?(request: QQRequest): string | undefined;
  enqueueImage?(request: QQRequest, command: QQImageCommand): Promise<QQImageToolResult>;
  waitImage?(request: QQRequest, signal: AbortSignal, waitMs: number): Promise<QQImageDelivery | undefined>;
  send(request: QQRequest, text: string, image?: QQImageResult): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  report(event: QQLogEvent): void;
}

/** Serial, bounded replies. Only authenticated mentions and fixed private guidance enter this worker. */
export class QQWorker {
  private queue: QQRequest[] = [];
  private pending = new Map<string, QQRequest>();
  private running?: Promise<void>;
  private lifetime = new AbortController();
  private botId?: string;
  constructor(private readonly config: QQConfig, readonly state: QQState, private readonly io: QQWorkerIO) {}
  setBotId(id: string): void { this.botId = id; }
  receive(message: QQInbound): boolean {
    if (this.lifetime.signal.aborted || this.state.paused) return false;
    const request = qqRequest(message, this.io.now(), this.botId);
    if (!request || this.state.receipts[request.key] || this.pending.has(request.key) || this.pending.size >= this.config.maxQueue ||
      [...this.pending.values()].filter(item => item.user === request.user).length >= this.config.maxUserQueue) return false;
    this.pending.set(request.key, request); this.queue.push(request);
    this.io.report({ event: 'qq_request_accepted', scope: request.scope, requestId: request.key });
    if (request.scope === 'group' && this.config.images?.enabled) this.io.report({ event: 'qq_image_input', scope: request.scope,
      requestId: request.key, imageInput: qqImageInputDiagnostic(message, request.imageInput) });
    if (!this.running) this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = undefined; });
    return true;
  }
  stop(): void { this.lifetime.abort(); this.queue = []; }
  async idle(): Promise<void> { await this.running; }
  private async drain(): Promise<void> {
    let active: QQRequest | undefined;
    try {
      while (this.queue.length && !this.lifetime.signal.aborted && !this.state.paused) {
        const request = this.queue.shift()!;
        active = request;
        try { await this.process(request); }
        finally { this.pending.delete(request.key); }
      }
    } catch (error) {
      // A checkpoint failure cannot authorize further model calls or sending.
      this.state.paused = true;
      this.io.report({ event: 'qq_state_failure', requestId: active?.key, scope: active?.scope,
        failure: qqDiagnostic(error, 'state', 'state_failed') });
    } finally {
      if (this.state.paused || this.lifetime.signal.aborted) { this.queue = []; this.pending.clear(); }
    }
  }
  private async process(request: QQRequest): Promise<void> {
    const state = this.state, now = this.io.now(), day = shanghaiDay(now);
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
    let pendingMessage: string | undefined;
    if (request.scope === 'group' && this.config.images?.enabled && !unsafeComment(request.text)) {
      const delivery = await this.io.pendingImage?.(request);
      if (delivery) {
        answer = delivery.text; image = delivery.image;
        if (image) await this.io.record(request, { status: 'accepted', image: { sha256: image.sha256, prompt: image.prompt } });
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
          state.starts.length >= QQ_LIMITS.startsPerMinute || user.starts.length >= QQ_LIMITS.userWindowReplies;
        if (limited) {
          answer = (user.noticeUntil || 0) > now ? '' : QQ_QUOTA_REPLY;
          if (answer) user.noticeUntil = now + 3600000;
        } else {
          state.tokens += QQ_LIMITS.reservation; user.count++; user.starts.push(now); state.starts.push(now);
          state.receipts[request.key].status = 'generating';
          await checkpoint(); // Reserve/dedupe and archive before any provider IO.
          await this.io.record(request, { status: 'generating', model: QQ_MODEL });
          if (this.lifetime.signal.aborted) {
            state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
          }
          const started = this.io.now();
          this.io.report({ event: 'qq_generation_started', requestId: request.key, scope: request.scope, route: 'text', queuedMs: Math.max(0, started - request.createdAt) });
          const controller = new AbortController(), abort = () => controller.abort(qqFailure('agent_run', 'aborted'));
          this.lifetime.signal.addEventListener('abort', abort, { once: true });
          const remaining = this.config.images?.enabled ? Math.max(1, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 10000) : QQ_LIMITS.timeoutMs;
          const timer = setTimeout(() => controller.abort(qqFailure('agent_run', 'timeout')), remaining);
          try {
            let imageAttempted = false;
            const executeImage: QQExecuteImage = async command => {
              controller.signal.throwIfAborted();
              const options = this.config.images;
              const blocked = (message: string): QQImageToolResult => ({ status: 'blocked', message });
              if (!options?.enabled || !this.io.image && !this.io.enqueueImage) return blocked('图片功能未启用。');
              const confirmation = qqImageCommandReply(request, command, options);
              if (confirmation) return blocked(confirmation);
              if (unsafeComment(command.instruction)) return blocked(SAFETY_NOTICE);
              if (imageAttempted) return blocked('本题已尝试过一次图片生成，不能重复付费调用。');
              const admission = this.io.imageAdmission?.(request);
              if (admission) return blocked(admission);
              const at = this.io.now();
              user.imageStarts = (user.imageStarts || []).filter(value => at - value < QQ_IMAGE_LIMITS.userWindowMs);
              if ((user.images || 0) >= options.userDailyLimit) return blocked(`生图需要歇一会儿～每人每天最多${options.userDailyLimit}张，请明天再试。`);
              if (user.imageStarts.length >= QQ_IMAGE_LIMITS.userWindowImages) return blocked(`生图需要歇一会儿～每人每5小时最多${QQ_IMAGE_LIMITS.userWindowImages}张，请稍后再试。`);
              if ((state.images || 0) >= options.dailyLimit) return blocked(`生图需要歇一会儿～全局每天最多${options.dailyLimit}张，请明天再试。`);
              if (state.lastImageAt !== undefined && at - state.lastImageAt < QQ_IMAGE_LIMITS.intervalMs) return blocked('生图需要歇一会儿～全局生图间隔至少1分钟，请稍后再试。');
              imageAttempted = true;
              state.images = (state.images || 0) + 1; user.images = (user.images || 0) + 1;
              user.imageStarts.push(at); state.lastImageAt = at;
              const persistImage = async (update: QQRecordUpdate) => {
                try { await this.io.save(state); await this.io.record(request, update); }
                catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, 'state', 'record_failed')); }
              };
              await persistImage({ status: 'generating', model: options.model });
              this.io.report({ event: 'qq_generation_started', requestId: request.key, scope: request.scope, route: 'image', queuedMs: Math.max(0, at - request.createdAt) });
              if (this.io.enqueueImage) {
                try {
                  const result = await this.io.enqueueImage(request, command);
                  if (result.status === 'pending') pendingMessage = result.message;
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
                return { status: 'failed', message: request.imageInput && failure.stage === 'image_prepare' ? QQ_IMAGE_SOURCE_REPLY : '这次生图没能完成，请稍后重新艾特我试试。' };
              } finally { clearTimeout(imageTimer); controller.signal.removeEventListener('abort', abortImage); }
              await persistImage({ status: 'generating', image: { sha256: image.sha256, prompt: image.prompt } });
              return { status: 'generated', message: command.mode === 'edit' ? '原图编辑完成。' : '图片生成完成。' };
            };
            const result = await this.io.answer(request, controller.signal, this.config.images?.enabled ? executeImage : undefined);
            controller.signal.throwIfAborted();
            answer = pendingMessage || publishableAnswer(typeof result === 'string' ? result : result.text);
            if (!answer) throw qqFailure('answer_validation', 'unsafe_answer');
            if (typeof result !== 'string') {
              if (!Number.isSafeInteger(result.tokens) || result.tokens < 1 || result.tokens > QQ_LIMITS.reservation) throw qqFailure('answer_validation', 'invalid_tokens');
              // The full ceiling is durable before IO. Settle a successful run only; failures retain it.
              state.tokens -= QQ_LIMITS.reservation - result.tokens;
            }
          }
          catch (error) {
            const failure = qqDiagnostic(error, 'agent_run', 'unexpected', controller.signal, { elapsedMs: Math.max(0, this.io.now() - started) });
            this.io.report({ event: 'qq_model_failed', scope: request.scope, requestId: request.key, failure });
            if (failure.code === 'record_failed') throw error;
            answer = pendingMessage || (image ? '图片已生成。' : QQ_FAILURE_REPLY);
            await this.io.record(request, { status: 'generating', error: 'model_failed', failure });
          }
          finally {
            clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort);
            state.starts[state.starts.length - 1] = this.io.now(); user.starts[user.starts.length - 1] = this.io.now();
          }
        }
      }
    }
    if (pendingMessage && !this.lifetime.signal.aborted && !state.paused && this.io.waitImage) {
      // Keep paid work alive; reserve twenty seconds of the original window for persistence/upload/send.
      const waitMs = Math.max(0, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 20000);
      const delivery = await this.io.waitImage(request, this.lifetime.signal, waitMs);
      if (delivery) {
        answer = delivery.text; image = delivery.image;
        if (image) {
          await this.io.record(request, { status: 'generating', image: { sha256: image.sha256, prompt: image.prompt } });
          this.io.report({ event: 'qq_image_inline_ready', scope: request.scope, requestId: request.key,
            elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
        }
      } else if (!this.lifetime.signal.aborted) this.io.report({ event: 'qq_image_deferred', scope: request.scope, requestId: request.key,
        elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
    }
    if (!answer || state.paused || this.lifetime.signal.aborted || this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) {
      state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
    }
    const delay = Math.max(0, state.lastSendAt + QQ_LIMITS.sendIntervalMs - this.io.now());
    if (delay) {
      try { await this.io.sleep(delay, this.lifetime.signal); }
      catch { state.receipts[request.key].status = 'skipped'; await checkpoint(); return; }
    }
    if (this.lifetime.signal.aborted || this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) {
      state.receipts[request.key].status = 'skipped'; await checkpoint(); return;
    }
    // Save intent before a single passive reply. An uncertain send is never retried.
    state.lastSendAt = this.io.now(); state.receipts[request.key].status = 'sending'; await this.io.save(state);
    await this.io.record(request, { status: 'sending', answer });
    try {
      await this.io.send(request, answer, image);
      state.receipts[request.key].status = 'sent';
      this.io.report({ event: 'qq_reply_sent', scope: request.scope, requestId: request.key, elapsedMs: Math.max(0, this.io.now() - request.createdAt) });
    } catch (error) {
      state.receipts[request.key].status = 'unknown'; state.paused = true;
      const failure = qqDiagnostic(error, 'send', 'send_failed');
      this.io.report({ event: 'qq_send_unknown', scope: request.scope, requestId: request.key, failure });
      await this.io.record(request, { status: 'unknown', sendFailure: failure });
    }
    await checkpoint();
  }
}
