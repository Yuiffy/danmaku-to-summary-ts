import { UploadQueueItem, UploadQueueStatus, UploadSubmission } from '../../core/admin/uploadStatus';
import { uploadObservation } from './AdminUploadObservation';
import { UploadTelemetry } from './AdminUploadTelemetry';

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(object) : [];
// Mirrors clip_upload_registry.py's account guard; this projection never schedules work.
const LIMIT = 90, WINDOW_SECONDS = 86400, BUFFER_SECONDS = 5;
function time(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().replace(/(\.\d{3})\d+/u, '$1');
  const at = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/iu.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(at) ? at : undefined;
}
const iso = (at: number | undefined): string | undefined => at === undefined ? undefined : new Date(at).toISOString();
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function reason(job: RecordValue): string {
  const output = `${text(job.error)}\n${text(job.lastOutput)}`;
  if (job.status === 'running') return job.phase === 'rendering' ? '正在制作成片' : '正在上传 / 投稿';
  if (/submission outcome unknown/iu.test(output)) return '投稿结果待核对（尚无成功回执）';
  if (job.retryKind === 'bilibili_submission_rate_limit') return 'B 站投稿接口频控（137022），等待重试';
  if (job.retryKind === 'account_rolling_upload_limit') return '等待滚动 24 小时额度释放';
  if (/automatic retry limit reached/iu.test(output)) return '已达到自动重试次数上限，需要人工核对';
  if (job.status === 'pending') return '等待按队列处理';
  return text(job.error).split('\n').find(Boolean)?.slice(0, 240) || (job.status === 'retry_wait' ? '等待自动重试' : '需要人工处理');
}

/** Read-only view of the full worker queue and registry, with an injected clock. */
export function uploadQueueStatus(queueValue: unknown, recordsValue: unknown, now = Date.now(), telemetry?: UploadTelemetry): UploadQueueStatus {
  const queue = object(queueValue), records = object(recordsValue), jobs = array(queue.jobs);
  const guard = object(queue.accountRollingUploadGuard), cooldown = object(queue.submissionRateLimit);
  const cutoff = now - WINDOW_SECONDS * 1000;
  const merged = new Map<string, UploadSubmission>();
  function addEvent(raw: RecordValue) {
    const at = time(raw.at);
    if (at === undefined || at > now) return;
    const key = raw.bvid ? `bvid:${raw.bvid}` : raw.aid ? `aid:${raw.aid}` : raw.clipId != null
      ? `clip:${raw.jobId || ''}:${raw.clipId}` : `at:${iso(at)}:${raw.title || ''}`;
    const previous = merged.get(key);
    if (previous && Date.parse(previous.at) > at) return;
    merged.set(key, { at: iso(at)!, title: text(raw.title), ...(raw.bvid ? { bvid: String(raw.bvid) } : {}),
      ...(Number.isSafeInteger(Number(raw.clipId)) && raw.clipId != null ? { clipId: Number(raw.clipId) } : {}) });
  }
  array(guard.events).forEach(addEvent);
  for (const clip of Object.values(records).map(object)) {
    if (clip.status !== 'uploaded') continue;
    const uploaded = object(clip.uploadState);
    addEvent({ at: uploaded.submittedAt || clip.uploadedAt, bvid: uploaded.bvid, aid: uploaded.aid, clipId: clip.id,
      title: uploaded.onlineTitle || uploaded.title || `${clip.prefix || ''}${clip.title || ''}` });
  }
  const allEvents = [...merged.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const events = allEvents.filter(event => Date.parse(event.at) > cutoff);
  const calculatedBlock = events.length >= LIMIT ? Date.parse(events[events.length - LIMIT].at) + (WINDOW_SECONDS + BUFFER_SECONDS) * 1000 : 0;
  const rollingUntil = Math.max(calculatedBlock, time(guard.blockedUntil) || 0);
  const cooldownUntil = time(cooldown.cooldownUntil) || 0;
  const globalUntil = Math.max(now, rollingUntil, cooldownUntil);
  const releases: UploadQueueStatus['rolling']['releases'] = [];
  let count = events.length;
  for (const event of events) {
    count--;
    const at = iso(Date.parse(event.at) + WINDOW_SECONDS * 1000)!;
    const previous = releases[releases.length - 1];
    if (previous?.at === at) { previous.count++; previous.remainingCount = count; }
    else releases.push({ at, count: 1, remainingCount: count });
  }
  const queuedRaw = jobs.filter(job => ['pending', 'retry_wait'].includes(job.status));
  const running = jobs.filter(job => job.status === 'running');
  const blocked = jobs.filter(job => job.status === 'blocked');
  function eligible(job: RecordValue): number | undefined {
    if (job.status === 'pending') return globalUntil;
    if (job.status !== 'retry_wait') return undefined;
    const retry = time(job.retryAt);
    // Matches next_pending_job: a malformed nonempty timestamp is retryable, a missing one is not.
    return retry !== undefined ? Math.max(globalUntil, retry) : job.retryAt ? globalUntil : undefined;
  }
  const sorted = queuedRaw.map((job, index) => ({ job, index, at: eligible(job) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.index - b.index);
  function item(job: RecordValue): UploadQueueItem {
    return { id: String(job.id || ''), status: text(job.status), phase: text(job.phase),
      clips: (Array.isArray(job.clipIds) ? job.clipIds : []).map(Number).filter(Number.isSafeInteger).map((id: number) => {
        const clip = object(records[String(id)]);
        return { id, title: `${clip.prefix || ''}${clip.title || ''}`, done: clip.status === 'uploaded' && !job.allowDuplicateTitle,
          ...(object(job.cancellationRequests)[String(id)] ? { cancelled: true,
            cancelling: !job.cancellationAcknowledgedIds?.includes(id) } : {}),
          ...(job.submissionStartedClipIds?.includes(id) ? { submissionStarted: true } : {}),
          excluded: Object.hasOwn(object(job.renderFailures), String(id)) };
      }), createdAt: iso(time(job.createdAt)), updatedAt: iso(time(job.updatedAt)), retryAt: job.status === 'retry_wait' ? iso(time(job.retryAt)) : undefined,
      eligibleAt: iso(eligible(job)), reason: reason(job) };
  }
  const entries = [...running, ...sorted.map(next => next.job), ...blocked].map(item);
  const waitingIds = new Set(entries.filter(entry => entry.status !== 'blocked').flatMap(entry => entry.clips.filter(clip => !clip.done && !clip.excluded && !clip.cancelled).map(clip => clip.id)));
  const next = sorted.find(entry => entry.at !== undefined);
  const reasons: string[] = [];
  if (running.length) reasons.push('当前任务尚在执行，后续任务等待');
  if (cooldownUntil > now) reasons.push('B 站投稿接口返回 137022，账号冷却中');
  if (rollingUntil > now) reasons.push('滚动 24 小时投稿保护正在等待额度释放');
  if (!running.length && next && next.at! > globalUntil) reasons.push('待处理任务尚未到各自重试时间');
  if (queuedRaw.some(job => job.status === 'retry_wait' && !job.retryAt)) reasons.push('部分重试任务缺少时间，需要人工核对');
  if (!running.length && !next && blocked.length) reasons.push('有任务被阻塞，需要人工处理');
  const state = running.length ? 'running' : next ? next.at! > now ? 'waiting' : 'ready' : queuedRaw.length || blocked.length ? 'blocked' : 'idle';
  const completed = jobs.filter(job => job.startedAt && !['running', 'pending', 'cancelled'].includes(job.status))
    .sort((a, b) => (time(b.updatedAt) || 0) - (time(a.updatedAt) || 0))[0];
  const output = completed ? `${text(completed.error)}\n${text(completed.lastOutput)}` : '';
  return {
    observedAt: iso(now)!, state,
    observation: uploadObservation(allEvents, queue, now, telemetry),
    summary: { running: '正在执行投稿任务', waiting: '等待后自动尝试', ready: '已到可尝试时间，等待投稿进程处理', blocked: '需要核对队列', idle: '暂无排队投稿' }[state],
    reasons, queuedJobs: queuedRaw.length, queuedClips: waitingIds.size, activeJobs: running.length,
    blockedJobs: blocked.length, failedJobs: jobs.filter(job => job.status === 'failed').length,
    nextAttemptAt: running.length ? undefined : iso(next?.at), nextJobId: next ? String(next.job.id) : undefined,
    lastSubmission: allEvents[allEvents.length - 1],
    lastAttempt: completed ? { jobId: String(completed.id), at: iso(time(completed.updatedAt) || time(completed.startedAt))!, status: text(completed.status),
      submissionRateLimited: /(?<!\d)137022(?!\d)/u.test(output) || completed.retryKind === 'bilibili_submission_rate_limit',
      preuploadRateLimited: /\[rate-limit\]|您上传视频过快/u.test(output), outcomeUnknown: /submission outcome unknown/iu.test(output) } : undefined,
    rateLimit: Object.keys(cooldown).length ? { code: Number(cooldown.code) || 137022, streak: Number(cooldown.streak) || 0,
      at: iso(time(cooldown.updatedAt)), until: iso(cooldownUntil || undefined), active: cooldownUntil > now } : undefined,
    rolling: { available: Array.isArray(guard.events), limit: LIMIT, windowSeconds: WINDOW_SECONDS, boundaryBufferSeconds: BUFFER_SECONDS,
      count: events.length, remaining: Math.max(0, LIMIT - events.length), blockedUntil: rollingUntil > now ? iso(rollingUntil) : undefined,
      nextDecreaseAt: releases[0]?.at, syncedAt: iso(time(guard.lastRemoteSyncAt)), syncFailed: !!guard.lastRemoteSyncError,
      events, releases }, queue: entries
  };
}
