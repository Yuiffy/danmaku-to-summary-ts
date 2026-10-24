import { CommentAudience, CommentEvent, CommentPlatformBlocked, CommentReplyConfig, LIMITS, positiveId, publishableAnswer,
  SAFETY_NOTICE, shanghaiDay, unsafeComment, validateCommentConfig } from './CommentPolicy';
import { CommentJob, CommentState } from './CommentState';
import { HOUR_MS, quotaExceeded, reserveCommentQuota } from './CommentQuota';

export interface CommentAdapters {
  save(state: CommentState): Promise<void>;
  answer(text: string, signal: AbortSignal, event?: CommentEvent, audience?: CommentAudience): Promise<string>;
  send(event: CommentEvent, answer: string, signal: AbortSignal): Promise<string>;
  now(): number;
  like?(event: CommentEvent, signal: AbortSignal): Promise<void>;
  audience?(uid: string, signal: AbortSignal): Promise<CommentAudience>;
}
const active = (job: CommentJob) => ['queued', 'generating', 'ready', 'sending'].includes(job.status);

/** No timers/HTTP/files here; the CLI is the sole serialized owner of all operations. */
export class CommentWorker {
  private busy = false;
  private stopped = false;
  private controller?: AbortController;
  constructor(readonly config: CommentReplyConfig, readonly state: CommentState, private readonly adapters: CommentAdapters) {
    validateCommentConfig(config);
    if (state.botUid !== config.botUid) throw new Error('Comment worker account mismatch');
  }

  stop(): void { this.stopped = true; this.controller?.abort(); }

  async admit(event: CommentEvent): Promise<'accepted' | 'duplicate' | 'ignored' | 'full'> {
    const now = this.adapters.now();
    if (this.stopped || event.uid === this.config.botUid || !positiveId(event.uid) ||
        event.type === 1 && event.trigger !== 'mention' ||
        event.createdAt < now - LIMITS.maxAgeMs || event.createdAt > now + 60000) return 'ignored';
    if (this.state.jobs.some(job => job.event.key === event.key)) return 'duplicate';
    const usage = this.state.days[shanghaiDay(now)]?.users[event.uid];
    if (!this.config.fanQuota && !this.config.unlimitedUids.includes(event.uid) && usage?.notice && usage.count >= LIMITS.dailyUserReplies) return 'ignored';
    const queue = this.state.jobs.filter(active);
    if (queue.length >= this.config.maxQueue || queue.filter(job => job.event.uid === event.uid).length >= this.config.maxUserQueue ||
        this.state.jobs.length >= LIMITS.maxTracked) return 'full';
    this.state.jobs.push({ event: { ...event }, status: 'queued', admittedAt: now });
    if (!this.state.rotation.includes(event.uid)) this.state.rotation.push(event.uid);
    await this.adapters.save(this.state);
    return 'accepted';
  }

  private choose(now: number): CommentJob | undefined {
    const queue = this.state.jobs.filter(job => job.status === 'queued' || job.status === 'ready');
    this.state.rotation = this.state.rotation.filter(uid => queue.some(job => job.event.uid === uid));
    const day = this.state.days[shanghaiDay(now)];
    const modelAvailable = this.state.starts.length < LIMITS.startsPerMinute &&
      (day?.tokens || 0) + LIMITS.tokenReservation <= this.config.dailyTokenBudget;
    for (const uid of this.state.rotation) {
      const job = queue.find(job => job.event.uid === uid)!;
      if (job.status === 'ready' || modelAvailable || unsafeComment(job.event.text) ||
          this.adapters.audience && !job.audience || quotaExceeded(this.config, this.state, job, now)) return job;
    }
    return undefined;
  }

  private served(job: CommentJob): void {
    this.state.rotation = this.state.rotation.filter(uid => uid !== job.event.uid);
    if (this.state.jobs.some(other => other.event.uid === job.event.uid && active(other))) this.state.rotation.push(job.event.uid);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try { await this.work(); } finally { this.busy = false; }
  }

  private async work(): Promise<void> {
    let now = this.adapters.now();
    const state = this.state;
    state.jobs = state.jobs.filter(job => job.event.createdAt >= now - LIMITS.retentionMs);
    for (const job of state.jobs) if (active(job) && job.event.createdAt < now - LIMITS.maxAgeMs) job.status = 'expired';
    for (const day of Object.keys(state.days)) if (day < shanghaiDay(now - LIMITS.retentionMs)) delete state.days[day];
    state.starts = state.starts.filter(at => at > now - 60000);
    for (const [uid, window] of Object.entries(state.userWindows || {})) {
      window.starts = window.starts.filter(at => at > now - HOUR_MS);
      if (!window.starts.length && (window.noticeUntil || 0) <= now) delete state.userWindows![uid];
    }
    if (state.paused || now - state.lastSentAt < LIMITS.sendIntervalMs) return;
    const job = this.choose(now);
    if (!job) return;
    if (job.event.type === 1 && job.event.trigger !== 'mention') {
      job.status = 'skipped'; this.served(job); await this.adapters.save(state); return;
    }
    if (job.status === 'queued' && !job.audience && this.adapters.audience) {
      this.controller = new AbortController();
      const timeout = setTimeout(() => this.controller?.abort(), 5000);
      try { job.audience = await this.adapters.audience(job.event.uid, this.controller.signal); }
      catch (error) {
        if (error instanceof CommentPlatformBlocked) { state.paused = true; await this.adapters.save(state); return; }
        job.audience = { status: 'unavailable' };
      } finally { clearTimeout(timeout); this.controller = undefined; }
      await this.adapters.save(state);
      if (this.stopped) return;
    }
    now = this.adapters.now();
    const day = state.days[shanghaiDay(now)] ||= { tokens: 0, users: {} };
    // A ready notice from yesterday must not tell someone their fresh quota is exhausted.
    if (job.status === 'ready' && job.notice && (this.config.unlimitedUids.includes(job.event.uid) ||
      job.quotaDay !== shanghaiDay(now) || job.noticeUntil !== undefined && job.noticeUntil <= now)) {
      job.status = 'queued'; delete job.answer; delete job.notice; delete job.quotaDay; delete job.noticeUntil;
    }
    if (job.status === 'queued') {
      const unsafe = unsafeComment(job.event.text);
      if (!quotaExceeded(this.config, state, job, now) && !unsafe && (state.starts.length >= LIMITS.startsPerMinute ||
        day.tokens + LIMITS.tokenReservation > this.config.dailyTokenBudget)) return;
      const quota = reserveCommentQuota(this.config, state, job, now);
      if (quota !== 'allowed') {
        if (quota === 'skip') {
          job.status = 'skipped'; this.served(job);
          await this.adapters.save(state); return;
        }
      } else {
        if (unsafe) job.answer = SAFETY_NOTICE;
        else {
          state.starts.push(now); day.tokens += LIMITS.tokenReservation;
          job.status = 'generating'; job.processingAt = now;
          job.likeStatus = this.adapters.like && job.event.parent !== '0' ? 'pending' : 'skipped';
          await this.adapters.save(state); // Reserve quota/cost before the provider can see the request.
          this.controller = new AbortController();
          const timeout = setTimeout(() => this.controller?.abort(), LIMITS.timeoutMs);
          try {
            if (job.likeStatus === 'pending') {
              try {
                await this.adapters.like!(job.event, this.controller.signal);
                job.likeStatus = 'liked';
              } catch {
                job.likeStatus = 'unknown'; state.paused = true;
                throw new Error('Like unconfirmed');
              } finally { state.lastSentAt = this.adapters.now(); }
              await this.adapters.save(state);
            }
            if (this.stopped || this.controller.signal.aborted) throw new Error('Comment stopped');
            const answer = await this.adapters.answer(job.event.text, this.controller.signal, job.event, job.audience);
            job.answer = this.controller.signal.aborted || this.stopped ? undefined : publishableAnswer(answer);
          } catch (error) { if (error instanceof CommentPlatformBlocked) state.paused = true; job.answer = undefined; }
          finally {
            clearTimeout(timeout); this.controller = undefined;
            state.starts[state.starts.length - 1] = this.adapters.now();
          }
          if (!job.answer) {
            job.status = 'failed'; job.completedAt = this.adapters.now(); this.served(job);
            await this.adapters.save(state); return;
          }
        }
      }
      job.quotaDay = shanghaiDay(now); job.status = 'ready';
      await this.adapters.save(state);
    }
    if (this.stopped || state.paused) return;
    // All outputs, including free notices, share this persisted send gate.
    const sentAt = this.adapters.now();
    if (sentAt - state.lastSentAt < LIMITS.sendIntervalMs) return;
    if (!job.notice && reserveCommentQuota(this.config, state, job, sentAt) === 'skip') {
      job.status = 'skipped'; this.served(job); await this.adapters.save(state); return;
    }
    job.status = 'sending'; state.lastSentAt = sentAt;
    await this.adapters.save(state);
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), LIMITS.timeoutMs);
    try {
      const id = await this.adapters.send(job.event, job.answer!, this.controller.signal);
      if (!positiveId(id)) throw new Error('Unconfirmed comment receipt');
      job.status = 'sent'; job.replyId = id; job.completedAt = this.adapters.now();
    } catch {
      // Includes risk control, auth expiry, HTTP errors and ambiguous network outcomes.
      // Never automatically retry a POST or rotate credentials to bypass a restriction.
      job.status = 'unknown'; state.paused = true;
    } finally { clearTimeout(timeout); this.controller = undefined; }
    // Conservatively space from completion too: slow disk/HTTP cannot compress actual POST starts.
    state.lastSentAt = Math.max(state.lastSentAt, this.adapters.now());
    this.served(job);
    await this.adapters.save(state);
  }
}
