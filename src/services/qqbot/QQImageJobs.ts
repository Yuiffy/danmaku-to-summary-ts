import * as fs from 'fs/promises';
import * as path from 'path';
import { QQRequest, QQ_LIMITS, qqDigest } from './QQPolicy';
import { QQImageCommand, QQImageDelivery, QQImageResult, QQImageToolResult } from './QQImagePolicy';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { qqDiagnostic, qqFailure } from './QQDiagnostics';

type JobStatus = 'running' | 'ready' | 'failed' | 'unknown' | 'delivering' | 'delivered';
interface Job {
  key: string; user: string; conversation: string; date: string; createdAt: number; updatedAt: number; status: JobStatus;
  image?: Omit<QQImageResult, 'file'>; deliveryRequest?: string; failure?: QQDiagnostic;
}
interface Journal { version: 1; appId: string; jobs: Record<string, Job> }
interface JobIO {
  generate(request: QQRequest, signal: AbortSignal, command: QQImageCommand): Promise<QQImageResult>;
  now(): number;
  report(event: { event: string; requestId: string; scope: 'group'; failure?: QQDiagnostic }): void;
  fatal(error: unknown): Promise<void>;
}
const PENDING = '图片任务已接收，正在后台生成。稍后在本群再次艾特我即可领取，不用重复提交生图。';
const MAX_JOBS = 1000;
const HASH = /^[a-f0-9]{64}$/u;
const conversation = (request: QQRequest) => qqDigest(JSON.stringify([request.scope, request.targetId]));

/** Durable image attempts, independent of passive QQ replies. A new authenticated mention owns each delivery. */
export class QQImageJobs {
  private state: Journal;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  private readonly file: string;
  constructor(private readonly root: string, private readonly appId: string, private readonly timeoutMs: number, private readonly io: JobIO) {
    if (!/^[1-9]\d{0,24}$/u.test(appId) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('Invalid QQ image jobs configuration');
    this.file = path.join(root, 'data/runtime/qqbot/image-jobs', `${appId}.json`);
    this.state = { version: 1, appId, jobs: {} };
  }
  async open(): Promise<void> {
    try {
      if ((await fs.stat(this.file)).size > 8 * 1024 * 1024) throw new Error('QQ image journal too large');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value?.version !== 1 || value.appId !== this.appId || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs) ||
        Object.keys(value.jobs).length > MAX_JOBS) throw new Error('Invalid QQ image journal');
      for (const [key, job] of Object.entries(value.jobs) as Array<[string, Job]>) {
        if (!HASH.test(key) || job.key !== key || !HASH.test(job.user) || !HASH.test(job.conversation) ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(job.date) || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt) ||
          !['running', 'ready', 'failed', 'unknown', 'delivering', 'delivered'].includes(job.status) ||
          job.deliveryRequest !== undefined && !HASH.test(job.deliveryRequest) ||
          job.status === 'ready' && !job.image || job.image && (!HASH.test(job.image.sha256) ||
            typeof job.image.model !== 'string' || job.image.model.length > 80 || typeof job.image.prompt !== 'string' || job.image.prompt.length > 24000)) {
          throw new Error('Invalid QQ image job');
        }
      }
      this.state = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A process interruption cannot authorize another paid attempt or another uncertain delivery.
    if (Object.values(this.state.jobs).some(job => job.status === 'running')) await this.change(state => {
      for (const job of Object.values(state.jobs)) if (job.status === 'running') {
        job.status = 'unknown'; job.updatedAt = this.io.now();
      }
    });
  }
  admission(request: QQRequest): string | undefined {
    if (this.stopping) return '图片服务正在停止，请稍后再试。';
    if (Object.values(this.state.jobs).some(job => job.user === request.user && job.conversation === conversation(request) && job.status !== 'delivered')) {
      return '上一张图片任务还未领取，请再次艾特我查看结果。';
    }
    if (Object.values(this.state.jobs).filter(job => job.status === 'running').length >= 2) return '后台已有两张图在生成，请稍后再试。';
    if (Object.keys(this.state.jobs).length >= MAX_JOBS && !Object.values(this.state.jobs).some(job => job.status === 'delivered' &&
      this.io.now() - job.updatedAt > 86400000)) return '图片任务记录暂满，请稍后再试。';
    return undefined;
  }
  async enqueue(request: QQRequest, command: QQImageCommand): Promise<QQImageToolResult> {
    if (request.scope !== 'group' || !HASH.test(request.key) || !HASH.test(request.user)) throw new Error('Invalid QQ image job request');
    const blocked = this.admission(request);
    if (blocked) return { status: 'blocked', message: blocked };
    await this.change(state => {
      const admission = this.admission(request);
      if (admission) throw new Error('QQ image admission changed');
      if (state.jobs[request.key]) throw new Error('QQ image attempt already recorded');
      for (const job of Object.values(state.jobs)) if (job.status === 'delivered' && this.io.now() - job.updatedAt > 86400000) delete state.jobs[job.key];
      state.jobs[request.key] = { key: request.key, user: request.user, conversation: conversation(request),
        date: shanghaiDay(request.createdAt), createdAt: request.createdAt, updatedAt: this.io.now(), status: 'running' };
    });
    const controller = new AbortController();
    const promise = this.run(request, command, controller).catch(async error => {
      this.stop();
      try { await this.io.fatal(error); } catch { /* Runtime fatal always stops the owner, even if saving its pause fails. */ }
    }).finally(() => { this.active.delete(request.key); });
    this.active.set(request.key, { controller, promise });
    return { status: 'pending', message: PENDING };
  }
  private async run(request: QQRequest, command: QQImageCommand, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(qqFailure('image_http', 'timeout')), this.timeoutMs);
    try {
      let result: QQImageResult;
      try {
        // The durable running intent above always precedes provider IO.
        result = await this.io.generate(request, controller.signal, command);
        controller.signal.throwIfAborted();
      } catch (error) {
        const failure = qqDiagnostic(error, 'image_http', 'unexpected', controller.signal);
        await this.change(state => {
          state.jobs[request.key] = { ...state.jobs[request.key], status: controller.signal.aborted ? 'unknown' : 'failed',
            failure, updatedAt: this.io.now() };
        });
        this.io.report({ event: 'qq_image_job_failed', requestId: request.key, scope: 'group', failure });
        return;
      }
      await this.change(state => {
        state.jobs[request.key] = { ...state.jobs[request.key], status: 'ready', updatedAt: this.io.now(),
          image: { model: result.model, sha256: result.sha256, prompt: result.prompt } };
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
    return this.pending(request);
  }
  async pending(request: QQRequest): Promise<QQImageDelivery | undefined> {
    await this.writes;
    if (request.scope !== 'group') return;
    const job = Object.values(this.state.jobs).filter(item => item.user === request.user && item.conversation === conversation(request) && item.status !== 'delivered')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return;
    if (job.status === 'running') return { text: '上一张图还在后台生成，完成可能需要几分钟。稍后再艾特我领取，不用重复生图。' };
    if (job.status === 'delivering' || job.deliveryRequest) return { text: '上一张图的发送结果尚待核对，为避免重复发送，暂不再次发图。' };
    let image: QQImageResult | undefined;
    if (job.status === 'ready') {
      const directory = await fs.realpath(path.join(this.root, 'data/runtime/qqbot/records', this.appId));
      const source = await fs.realpath(path.join(directory, job.date, `${job.key}.png`));
      const relative = path.relative(directory, source);
      if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.stat(source)).size > 10 * 1024 * 1024) throw new Error('Invalid QQ job image');
      const bytes = await fs.readFile(source);
      if (qqDigest(bytes) !== job.image!.sha256) throw new Error('QQ job image changed');
      const output = path.join(directory, shanghaiDay(request.createdAt), `${request.key}.png`);
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
      if (current.status !== job.status || current.deliveryRequest) throw new Error('QQ image delivery already claimed');
      current.status = 'delivering'; current.deliveryRequest = request.key; current.updatedAt = this.io.now();
    });
    return { text: image ? job.key === request.key ? '图片生成完成。' : '上次的图片生成完成，给你发来啦。' : job.status === 'unknown' ?
      '上次图片任务因超时或服务中断未能确认结果，没有重复调用生图接口。如需重画，请再次艾特并说明绘图要求。' :
      '上次图片生成失败。如需重试，请再次艾特并说明绘图要求。', ...(image ? { image } : {}) };
  }
  async delivered(request: QQRequest): Promise<void> {
    const job = Object.values(this.state.jobs).find(item => item.status === 'delivering' && item.deliveryRequest === request.key &&
      item.user === request.user && item.conversation === conversation(request));
    if (!job) return;
    await this.change(state => { state.jobs[job.key].status = 'delivered'; state.jobs[job.key].updatedAt = this.io.now(); });
  }
  stop(): void {
    this.stopping = true;
    for (const task of this.active.values()) task.controller.abort(new Error('QQ image service stopped'));
  }
  async idle(): Promise<void> { await Promise.all([...this.active.values()].map(task => task.promise)); await this.writes; }
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
