import * as fs from 'fs/promises';
import * as path from 'path';
import { QQRequest, QQ_LIMITS, qqDigest } from './QQPolicy';
import { QQImageCommand, QQImageDelivery, QQImageResult, QQImageToolResult, qqImageFailureReply, qqImageRecoveryRequested } from './QQImagePolicy';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { qqDiagnostic, qqFailure } from './QQDiagnostics';
import { validQQImageFormat } from '../../core/qqImageFormat';
import { QQMediaAccess } from './QQMediaAccess';
import { QQ_IMAGE_QUEUE, qqImageCanStart, qqImageQueueEstimate, qqImageWindowAt } from './QQImageSchedule';
import { QQImageQueuedInput, qqImageQueuedInput, validQQImageQueuedInput } from './QQImageQueueInputs';
import { qqImagePackingNotice } from './QQImagePacking';
import type { QQImageTaskStatus } from './QQImageTaskTools';

type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'unknown' | 'delivering' | 'delivered';
interface Job {
  key: string; user: string; conversation: string; date: string; createdAt: number; updatedAt: number; status: JobStatus;
  image?: Omit<QQImageResult, 'file'>; deliveryRequest?: string; deliveryRecovery?: boolean; failure?: QQDiagnostic;
  input?: QQImageQueuedInput; startedAt?: number; completedAt?: number;
  replyMsgId?: string;
}
interface Journal { version: 1; appId: string; jobs: Record<string, Job>; starts?: number[] }
interface JobIO {
  prepare?(request: QQRequest, command: QQImageCommand, signal: AbortSignal): Promise<QQImageQueuedInput>;
  generate(request: QQRequest, signal: AbortSignal, command: QQImageCommand, input?: QQImageQueuedInput): Promise<QQImageResult>;
  now(): number;
  report(event: { event: string; requestId: string; scope: 'group'; failure?: QQDiagnostic; retryAttempt?: number }): void;
  fatal(error: unknown): Promise<void>;
}
const PENDING = '图片任务已接收，正在后台生成。四分钟内完成会直接回图；超时后可在本群艾特领取，也会在本群有回复机会时自动补发，不用重复生图。';
const MAX_JOBS = 1000;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_GENERATION_ATTEMPTS = 2;
const conversation = (request: QQRequest) => qqDigest(JSON.stringify([request.scope, request.targetId]));

/** Retry only an explicit upstream gateway failure; moderation and uncertain timeouts stay single-shot. */
const retryableImageFailure = (failure: QQDiagnostic) => failure.stage === 'image_http' && failure.code === 'http_error' &&
  [502, 503, 504].includes(failure.httpStatus || 0);

/** Durable image attempts, independent of passive QQ replies. A new authenticated mention owns each delivery. */
export class QQImageJobs {
  private state: Journal;
  private writes: Promise<unknown> = Promise.resolve();
  private dispatches: Promise<void> = Promise.resolve();
  private wake?: ReturnType<typeof setTimeout>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  private readonly file: string;
  constructor(private readonly root: string, private readonly appId: string, private readonly timeoutMs: number, private readonly io: JobIO,
    private readonly access: QQMediaAccess = {}) {
    if (!/^[1-9]\d{0,24}$/u.test(appId) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('Invalid QQ image jobs configuration');
    this.file = path.join(root, 'data/runtime/qqbot/image-jobs', `${appId}.json`);
    this.state = { version: 1, appId, jobs: {} };
  }
  async open(): Promise<void> {
    try {
      if ((await fs.stat(this.file)).size > 8 * 1024 * 1024) throw new Error('QQ image journal too large');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value?.version !== 1 || value.appId !== this.appId || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs) ||
        Object.keys(value.jobs).length > MAX_JOBS || value.starts !== undefined && (!Array.isArray(value.starts) ||
          value.starts.length > QQ_IMAGE_QUEUE.starts || value.starts.some((at: number) => !Number.isSafeInteger(at) || at < 0))) throw new Error('Invalid QQ image journal');
      for (const [key, job] of Object.entries(value.jobs) as Array<[string, Job]>) {
        if (!HASH.test(key) || job.key !== key || !HASH.test(job.user) || !HASH.test(job.conversation) ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(job.date) || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt) ||
          !['queued', 'running', 'ready', 'failed', 'unknown', 'delivering', 'delivered'].includes(job.status) ||
          job.status === 'queued' && !job.input || job.input && !validQQImageQueuedInput(job.input, key, job.user) ||
          job.startedAt !== undefined && !Number.isSafeInteger(job.startedAt) || job.completedAt !== undefined && !Number.isSafeInteger(job.completedAt) ||
          job.deliveryRequest !== undefined && !HASH.test(job.deliveryRequest) ||
          job.replyMsgId !== undefined && (typeof job.replyMsgId !== 'string' || !/^[\w.-]{1,256}$/u.test(job.replyMsgId)) ||
          job.deliveryRecovery !== undefined && typeof job.deliveryRecovery !== 'boolean' ||
          job.status === 'ready' && !job.image || job.image && (!HASH.test(job.image.sha256) ||
            !validQQImageFormat(job.image.format) ||
            typeof job.image.model !== 'string' || job.image.model.length > 80 || typeof job.image.prompt !== 'string' || job.image.prompt.length > 24000)) {
          throw new Error('Invalid QQ image job');
        }
      }
      this.state = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A process interruption cannot authorize another paid attempt or another uncertain delivery.
    if (Object.values(this.state.jobs).some(job => job.status === 'running')) await this.change(state => {
      for (const job of Object.values(state.jobs)) if (job.status === 'running') {
        job.status = 'unknown'; job.updatedAt = this.io.now(); delete job.input;
      }
    });
    if (!this.state.starts) await this.change(state => {
      state.starts = Object.values(state.jobs).map(job => job.startedAt || job.createdAt)
        .filter(at => this.io.now() - at < QQ_IMAGE_QUEUE.windowMs).sort((a, b) => a - b).slice(-QQ_IMAGE_QUEUE.starts);
    });
    await this.dispatch();
  }
  admission(request: QQRequest): string | undefined {
    if (this.stopping) return '图片服务正在停止，请稍后再试。';
    if (this.state.jobs[request.key]) return undefined;
    if (Object.values(this.state.jobs).filter(job => job.status === 'queued').length >= QQ_IMAGE_QUEUE.waiting) return '生图排队满了（最多20张），请稍后再试。';
    if (Object.keys(this.state.jobs).length >= MAX_JOBS && !Object.values(this.state.jobs).some(job => job.status === 'delivered' &&
      this.io.now() - job.updatedAt > 86400000)) return '图片任务记录暂满，请稍后再试。';
    return undefined;
  }
  async enqueue(request: QQRequest, command: QQImageCommand): Promise<QQImageToolResult> {
    if (request.scope !== 'group' || !HASH.test(request.key) || !HASH.test(request.user) ||
      typeof request.msgId !== 'string' || !/^[\w.-]{1,256}$/u.test(request.msgId)) throw new Error('Invalid QQ image job request');
    const blocked = this.admission(request);
    if (blocked) return { status: 'blocked', message: blocked };
    if (this.state.jobs[request.key]) return this.receipt(this.state.jobs[request.key]);
    let input: QQImageQueuedInput;
    try { input = this.io.prepare ? await this.io.prepare(request, command, AbortSignal.timeout(120000)) : qqImageQueuedInput(request, command); }
    catch (error) {
      const failure = qqDiagnostic(error, 'image_prepare', 'unexpected');
      this.io.report({ event: 'qq_image_job_failed', requestId: request.key, scope: 'group', failure });
      return { status: 'failed', message: qqImageFailureReply(failure, { sourceInput: !!request.imageInput }) };
    }
    if (!validQQImageQueuedInput(input, request.key, request.user)) throw new Error('Invalid prepared image request');
    const notice = qqImagePackingNotice(input.sources.length, input.referenceCount || 0);
    const rejection = await this.change(state => {
      if (state.jobs[request.key]) return;
      const admission = this.admission(request);
      if (admission) return admission;
      for (const job of Object.values(state.jobs)) if (job.status === 'delivered' && this.io.now() - job.updatedAt > 86400000) delete state.jobs[job.key];
      state.jobs[request.key] = { key: request.key, user: request.user, conversation: conversation(request),
        replyMsgId: request.msgId,
        date: shanghaiDay(request.createdAt), createdAt: request.createdAt, updatedAt: this.io.now(), status: 'queued', input };
      return undefined;
    });
    if (rejection) return { status: 'blocked', message: rejection };
    await this.dispatch();
    return this.receipt(this.state.jobs[request.key], notice);
  }
  private receipt(job: Job, notice = job.input ? qqImagePackingNotice(job.input.sources.length, job.input.referenceCount || 0) : ''): QQImageToolResult {
    const collage = notice ? { collageNotice: notice } : {};
    if (job.status !== 'queued') return { status: 'pending', background: true, ...collage, message: notice + PENDING };
    const durations = Object.values(this.state.jobs).filter(item => item.completedAt && item.startedAt)
      .sort((a, b) => b.completedAt! - a.completedAt!).slice(0, 20).map(item => item.completedAt! - item.startedAt!);
    const duration = Math.max(30000, Math.min(this.timeoutMs, durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 180000));
    const estimate = qqImageQueueEstimate(job.key, this.io.now(), Object.values(this.state.jobs), this.state.starts || [], duration, this.access);
    return { status: 'pending', queued: true, ...collage, message: `${notice}图片已排队，目前第${estimate.position}位，预计约${Math.max(1, Math.ceil(estimate.waitMs / 60000))}分钟后开始生成（仅供参考）。四分钟内完成会直接回图；超时后可在本群艾特领取，也会在本群有回复机会时自动补发。` };
  }
  private dispatch(): Promise<void> {
    const result = this.dispatches.then(async () => {
      clearTimeout(this.wake);
      while (!this.stopping) {
        const all = Object.values(this.state.jobs), now = this.io.now();
        const waiting = all.filter(job => job.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
        if (!waiting.length) return;
        const at = qqImageWindowAt(now, this.state.starts || []);
        if (at > now) {
          this.wake = setTimeout(() => { void this.dispatch(); }, at - now); this.wake.unref(); return;
        }
        const job = waiting.find(item => qqImageCanStart(item, all.filter(other => other.status === 'running'), this.access));
        if (!job) return;
        const started = await this.change(state => {
          if (this.stopping || state.jobs[job.key].status !== 'queued' || qqImageWindowAt(now, state.starts || []) > now ||
            !qqImageCanStart(job, Object.values(state.jobs).filter(item => item.status === 'running'), this.access)) return false;
          state.jobs[job.key].status = 'running'; state.jobs[job.key].startedAt = now; state.jobs[job.key].updatedAt = now;
          state.starts = [...(state.starts || []).filter(at => now - at < QQ_IMAGE_QUEUE.windowMs), now];
          return true;
        });
        if (this.stopping) return;
        if (!started) continue;
        const controller = new AbortController(), input = job.input!;
        const promise = this.run(input.request, input.command, controller, input).catch(error => this.fatal(error)).finally(() => {
          this.active.delete(job.key); if (!this.stopping) void this.dispatch();
        });
        this.active.set(job.key, { controller, promise });
      }
    }).catch(error => this.fatal(error));
    this.dispatches = result;
    return result;
  }
  private async fatal(error: unknown): Promise<void> {
    this.stop(); try { await this.io.fatal(error); } catch { /* Stop even when saving the pause fails. */ }
  }
  private async run(request: QQRequest, command: QQImageCommand, controller: AbortController, input: QQImageQueuedInput): Promise<void> {
    const timer = setTimeout(() => controller.abort(qqFailure('image_http', 'timeout')), this.timeoutMs);
    try {
      let result: QQImageResult | undefined;
      let failure: QQDiagnostic | undefined;
      for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        try {
          // The durable running intent above always precedes provider IO.
          result = await this.io.generate(request, controller.signal, command, input);
          controller.signal.throwIfAborted();
          failure = undefined;
          break;
        } catch (error) {
          failure = qqDiagnostic(error, 'image_http', 'unexpected', controller.signal);
          if (attempt < MAX_GENERATION_ATTEMPTS && retryableImageFailure(failure) && !this.stopping &&
            qqImageWindowAt(this.io.now(), this.state.starts || []) <= this.io.now()) {
            const reserved = await this.change(state => {
              const now = this.io.now();
              if (qqImageWindowAt(now, state.starts || []) > now) return false;
              state.starts = [...(state.starts || []).filter(at => now - at < QQ_IMAGE_QUEUE.windowMs), now]; return true;
            });
            if (reserved) {
            this.io.report({ event: 'qq_image_job_retry', requestId: request.key, scope: 'group', failure, retryAttempt: attempt + 1 });
            continue;
            }
          }
          await this.change(state => {
            state.jobs[request.key] = { ...state.jobs[request.key], status: controller.signal.aborted ? 'unknown' : 'failed',
              failure, input: undefined, updatedAt: this.io.now() };
          });
          this.io.report({ event: 'qq_image_job_failed', requestId: request.key, scope: 'group', failure });
          return;
        }
      }
      if (!result) return;
      await this.change(state => {
        state.jobs[request.key] = { ...state.jobs[request.key], status: 'ready', updatedAt: this.io.now(), completedAt: this.io.now(), input: undefined,
          image: { model: result.model, sha256: result.sha256, prompt: result.prompt, ...(result.format ? { format: result.format } : {}) } };
      });
      this.io.report({ event: 'qq_image_job_ready', requestId: request.key, scope: 'group' });
    } finally { clearTimeout(timer); }
  }
  /** Wait for the original attempt only; releasing this waiter never cancels paid work. */
  async wait(request: QQRequest, signal: AbortSignal, waitMs: number): Promise<QQImageDelivery | undefined> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > QQ_LIMITS.maxAgeMs) throw new Error('Invalid QQ image wait');
    await this.writes;
    const job = this.state.jobs[request.key];
    if (signal.aborted || request.scope !== 'group' || !job || job.user !== request.user || job.conversation !== conversation(request)) return;
    if (job.status === 'queued') return;
    if (job.status === 'running') {
      const task = this.active.get(request.key);
      if (!task || !waitMs) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let release: () => void = () => {};
      const deadline = new Promise<boolean>(resolve => {
        release = () => resolve(false);
        signal.addEventListener('abort', release, { once: true });
        timer = setTimeout(release, waitMs);
        if (signal.aborted) release();
      });
      try {
        if (!await Promise.race([task.promise.then(() => true), deadline])) return;
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', release);
      }
    }
    if (signal.aborted) return;
    return this.pending(request, request.key);
  }
  private latest(request: QQRequest, key?: string): Job | undefined {
    return request.scope === 'group' ? Object.values(this.state.jobs).reverse()
      .filter(item => (!key || item.key === key) && item.user === request.user && item.conversation === conversation(request))
      .sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
  }
  async status(request: QQRequest): Promise<QQImageTaskStatus> {
    await this.writes;
    const job = this.latest(request);
    if (!job) return { status: 'none', message: '本人在本群没有可查询的图片任务。' };
    const message = job.status === 'queued' ? this.receipt(job).message :
      job.status === 'running' ? '上一张图还在后台生成，完成可能需要几分钟。' :
      job.status === 'ready' ? '图片已经生成，可以领取。' :
      job.status === 'failed' || job.status === 'delivered' && !job.image ? qqImageFailureReply(job.failure) :
      job.status === 'unknown' ? '上次图片任务未能确认生成结果，没有重复调用生图接口。' :
      job.deliveryRecovery ? '上一张图已补发过一次，已停止重发。' :
      job.status === 'delivering' ? '上一张图的发送结果尚待核对，如确认没收到可领取补发一次。' : '最近的图片已发送，如未收到可领取补发一次。';
    return { status: job.status, message };
  }
  async collect(request: QQRequest): Promise<QQImageDelivery | undefined> {
    return this.pending(request, undefined, true);
  }
  async pending(request: QQRequest, key?: string, recover?: boolean): Promise<QQImageDelivery | undefined> {
    await this.writes;
    if (request.scope !== 'group') return;
    // Choose the latest task before checking status; a terminal task must never expose an older result.
    const job = this.latest(request, key);
    if (!job) return;
    const recovery = recover ?? qqImageRecoveryRequested(request.text);
    if (job.status === 'delivered' && (key || !recovery)) return;
    if (job.status === 'delivered' && !job.image) return { text: job.failure ? qqImageFailureReply(job.failure) : '最近的图片任务未能确认生成结果，没有可领取的新图。请重新艾特并说明绘图要求。' };
    if (job.status === 'queued') return { text: this.receipt(job).message };
    if (job.status === 'running') return { text: '上一张图还在后台生成，完成可能需要几分钟。稍后再艾特我领取，不用重复生图。' };
    const uncertain = job.status === 'delivering' || !!job.deliveryRequest;
    if (uncertain && request.text && !recovery) return;
    if (uncertain && (!recovery || job.deliveryRecovery || !job.image)) return {
      text: job.deliveryRecovery ? '上一张图已补发过一次，已停止重发。你可以继续聊天，或引用图片提出新的改图要求。' :
        '上一张图的发送结果尚待核对。如确认没收到，请艾特我并说“收图”，可补发一次；也可以直接提出新问题或新的绘图要求。' };
    let image: QQImageResult | undefined;
    if (job.status === 'ready' || uncertain) {
      const directory = await fs.realpath(path.join(this.root, 'data/runtime/qqbot/records', this.appId));
      const format = job.image!.format || 'png';
      const source = await fs.realpath(path.join(directory, job.date, `${job.key}.${format}`));
      const relative = path.relative(directory, source);
      if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.stat(source)).size > 10 * 1024 * 1024) throw new Error('Invalid QQ job image');
      const bytes = await fs.readFile(source);
      if (qqDigest(bytes) !== job.image!.sha256) throw new Error('QQ job image changed');
      const output = path.join(directory, shanghaiDay(request.createdAt), `${request.key}.${format}`);
      await fs.mkdir(path.dirname(output), { recursive: true });
      const temporary = `${output}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, output);
      image = { ...job.image!, file: output };
    }
    // Persist the delivery intent before the worker performs any platform send.
    await this.change(state => {
      const current = state.jobs[job.key];
      if (current.status !== job.status || current.deliveryRequest !== job.deliveryRequest || current.deliveryRecovery !== job.deliveryRecovery) throw new Error('QQ image delivery already claimed');
      current.status = 'delivering'; current.deliveryRequest = request.key; current.updatedAt = this.io.now();
      if (uncertain) current.deliveryRecovery = true;
    });
    return { text: image ? job.key === request.key ? '图片生成完成。' : '上次的图片生成完成，给你发来啦。' : job.status === 'unknown' ?
      '上次图片任务因超时或服务中断未能确认结果，没有重复调用生图接口。如需重画，请再次艾特并说明绘图要求。' :
      qqImageFailureReply(job.failure), ...(image ? { image } : {}) };
  }
  hasReady(request: QQRequest): boolean {
    return request.scope === 'group' && Object.values(this.state.jobs).some(job => job.status === 'ready' &&
      !job.deliveryRequest && job.conversation === conversation(request) && (!!job.replyMsgId || job.user === request.user));
  }
  isPending(key: string): boolean {
    return ['queued', 'running'].includes(this.state.jobs[key]?.status);
  }
  /** A borrowed window must quote the creation message. Legacy jobs can only use their owner's window. */
  async ready(request: QQRequest, key?: string): Promise<(QQImageDelivery & { request: QQRequest }) | undefined> {
    await this.writes;
    if (request.scope !== 'group') return;
    const job = Object.values(this.state.jobs).filter(item => (item.status === 'ready' || key && ['failed', 'unknown'].includes(item.status)) && !item.deliveryRequest &&
      item.conversation === conversation(request) && (key ? item.key === key && item.user === request.user : !!item.replyMsgId || item.user === request.user))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return;
    const deliveryRequest: QQRequest = key ? request : { scope: 'group', targetId: request.targetId, msgId: request.msgId,
      replyMsgId: job.replyMsgId || request.msgId,
      createdAt: request.createdAt, user: job.user, key: qqDigest(JSON.stringify(['image-delivery', request.key, job.key])),
      text: '补发本群此前已生成的图片。' };
    const result = await this.pending(deliveryRequest, job.key);
    return result && (key || result.image) ? { ...result, request: deliveryRequest,
      text: result.image ? key ? '图片生成完成。' : '本群此前的图片已生成，补发在这里。' : result.text } : undefined;
  }
  async delivered(request: QQRequest): Promise<void> {
    const job = Object.values(this.state.jobs).find(item => item.status === 'delivering' && item.deliveryRequest === request.key &&
      item.user === request.user && item.conversation === conversation(request));
    if (!job) return;
    await this.change(state => { state.jobs[job.key].status = 'delivered'; state.jobs[job.key].updatedAt = this.io.now(); });
  }
  stop(): void {
    this.stopping = true;
    clearTimeout(this.wake);
    for (const task of this.active.values()) task.controller.abort(new Error('QQ image service stopped'));
  }
  async idle(): Promise<void> {
    while (true) {
      const dispatches = this.dispatches;
      await dispatches;
      if (!this.active.size && dispatches === this.dispatches) { await this.writes; return; }
      await Promise.all([...this.active.values()].map(task => task.promise));
    }
  }
  async close(): Promise<void> { this.stop(); await this.idle(); }
  private change<T>(operation: (state: Journal) => T): Promise<T> {
    const result = this.writes.then(async () => {
      const next = structuredClone(this.state);
      const value = operation(next);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(next), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file); this.state = next;
      return value;
    });
    this.writes = result.then(() => {}, () => {});
    return result;
  }
}
