import { SAFETY_NOTICE, publishableAnswer, shanghaiDay, unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { QQConfig, QQInbound, QQRequest, QQ_FAILURE_REPLY, QQ_LIMITS, QQ_QUOTA_REPLY, qqFixedReply, qqRequest } from './QQPolicy';
import { QQState } from './QQState';
import { QQRecordUpdate } from './QQRecords';
import { QQ_MODEL } from './QQPolicy';
import { QQImageResult, qqImageRequested } from './QQImagePolicy';

export interface QQWorkerIO {
  now(): number;
  save(state: QQState): Promise<void>;
  record(request: QQRequest, update: QQRecordUpdate): Promise<void>;
  answer(request: QQRequest, signal: AbortSignal): Promise<string>;
  image?(request: QQRequest, signal: AbortSignal): Promise<QQImageResult>;
  send(request: QQRequest, text: string, image?: QQImageResult): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  report(event: { event: string; scope?: string }): void;
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
    if (!this.running) this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = undefined; });
    return true;
  }
  stop(): void { this.lifetime.abort(); this.queue = []; }
  async idle(): Promise<void> { await this.running; }
  private async drain(): Promise<void> {
    try {
      while (this.queue.length && !this.lifetime.signal.aborted && !this.state.paused) {
        const request = this.queue.shift()!;
        try { await this.process(request); }
        finally { this.pending.delete(request.key); }
      }
    } catch {
      // A checkpoint failure cannot authorize further model calls or sending.
      this.state.paused = true;
      this.io.report({ event: 'qq_state_failure' });
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
        user.count = 0; user.images = 0; user.starts = user.starts.filter(at => now - at < 3600000);
        if (!user.starts.length && now - (user.privateAt || 0) >= QQ_LIMITS.privateIntervalMs && (user.noticeUntil || 0) <= now) delete state.users[key];
      }
    }
    if (!state.users[request.user] && Object.keys(state.users).length >= QQ_LIMITS.maxReceipts) return;
    const user = state.users[request.user] ||= { count: 0, starts: [] };
    state.receipts[request.key] = { at: now, status: 'accepted' };
    await this.io.record(request, { status: 'accepted' });
    const checkpoint = async () => {
      await this.io.save(state);
      await this.io.record(request, { status: state.receipts[request.key].status });
    };
    let answer = qqFixedReply(request, this.config);
    let image: QQImageResult | undefined;
    if (request.scope === 'c2c') {
      if (user.privateAt !== undefined && now - user.privateAt < QQ_LIMITS.privateIntervalMs) answer = '';
      else user.privateAt = now;
    } else if (!answer && this.config.images?.enabled && qqImageRequested(request.text)) {
      const options = this.config.images;
      if (unsafeComment(request.text)) answer = SAFETY_NOTICE;
      else if ((state.images || 0) >= options.dailyLimit || (user.images || 0) >= options.userDailyLimit ||
        state.lastImageAt !== undefined && now - state.lastImageAt < 60000) answer = `生图需要歇一会儿～每人每天最多${options.userDailyLimit}张，请稍后再试。`;
      else {
        state.images = (state.images || 0) + 1; user.images = (user.images || 0) + 1; state.lastImageAt = now;
        state.receipts[request.key].status = 'generating'; await checkpoint();
        await this.io.record(request, { status: 'generating', model: options.model });
        const controller = new AbortController(), abort = () => controller.abort();
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        const remaining = Math.min(options.timeoutMs, QQ_LIMITS.maxAgeMs - (this.io.now() - request.createdAt) - 10000);
        const timer = setTimeout(abort, Math.max(1, remaining));
        try {
          controller.signal.throwIfAborted();
          if (!this.io.image || remaining <= 0) throw new Error('QQ image adapter unavailable');
          image = await this.io.image(request, controller.signal); controller.signal.throwIfAborted();
          answer = '给你画好啦～';
        } catch {
          image = undefined; answer = '这次生图没能完成，请稍后重新艾特我试试。';
          await this.io.record(request, { status: 'generating', error: 'image_failed' });
          this.io.report({ event: 'qq_image_failed', scope: request.scope });
        } finally { clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort); }
        if (image) await this.io.record(request, { status: 'generating', image: { sha256: image.sha256, prompt: image.prompt } });
      }
    } else if (!answer) {
      if (unsafeComment(request.text)) answer = SAFETY_NOTICE;
      else {
        state.starts = state.starts.filter(at => now - at < 60000);
        user.starts = user.starts.filter(at => now - at < 3600000);
        const limited = state.tokens + QQ_LIMITS.reservation > this.config.dailyTokenBudget ||
          state.starts.length >= QQ_LIMITS.startsPerMinute || user.count >= QQ_LIMITS.dailyUserReplies || user.starts.length >= QQ_LIMITS.hourlyUserReplies;
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
          const controller = new AbortController(), abort = () => controller.abort();
          this.lifetime.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, QQ_LIMITS.timeoutMs);
          try { answer = publishableAnswer(await this.io.answer(request, controller.signal)) || QQ_FAILURE_REPLY; }
          catch {
            answer = QQ_FAILURE_REPLY;
            await this.io.record(request, { status: 'generating', error: 'model_failed' });
            this.io.report({ event: 'qq_model_failed', scope: request.scope });
          }
          finally {
            clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort);
            state.starts[state.starts.length - 1] = this.io.now(); user.starts[user.starts.length - 1] = this.io.now();
          }
        }
      }
    }
    if (!answer || this.lifetime.signal.aborted || this.io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) {
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
      this.io.report({ event: 'qq_reply_sent', scope: request.scope });
    } catch {
      state.receipts[request.key].status = 'unknown'; state.paused = true;
      this.io.report({ event: 'qq_send_unknown', scope: request.scope });
    }
    await checkpoint();
  }
}
