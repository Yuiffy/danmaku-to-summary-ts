import { QQMediaAccess, qqMediaOperator, QQ_MEDIA_OPERATOR_LIMITS } from './QQMediaAccess';

export const QQ_IMAGE_QUEUE = { windowMs: 600000, starts: 10, waiting: 20, ordinary: 2, concurrent: 6 } as const;
export interface QQScheduledImage { key: string; user: string; status: string; createdAt: number; startedAt?: number }

/** Start gates apply to execution, never to acceptance into the waiting queue. */
export function qqImageCanStart(job: QQScheduledImage, running: QQScheduledImage[], access: QQMediaAccess): boolean {
  if (running.length >= QQ_IMAGE_QUEUE.concurrent) return false;
  return qqMediaOperator(access, job.user)
    ? running.filter(item => item.user === job.user).length < QQ_MEDIA_OPERATOR_LIMITS.maxConcurrent
    : running.filter(item => !qqMediaOperator(access, item.user)).length < QQ_IMAGE_QUEUE.ordinary;
}

export function qqImageWindowAt(now: number, starts: number[]): number {
  const recent = starts.filter(at => at > now - QQ_IMAGE_QUEUE.windowMs).sort((a, b) => a - b);
  return recent.length < QQ_IMAGE_QUEUE.starts ? now : recent[recent.length - QQ_IMAGE_QUEUE.starts] + QQ_IMAGE_QUEUE.windowMs;
}

/** Simulate the same FIFO/eligible-slot policy. Duration is an estimate, not a completion promise. */
export function qqImageQueueEstimate(key: string, now: number, jobs: QQScheduledImage[], starts: number[], durationMs: number,
  access: QQMediaAccess): { position: number; waitMs: number } {
  const waiting = jobs.filter(job => job.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const position = waiting.findIndex(job => job.key === key) + 1;
  let running = jobs.filter(job => job.status === 'running').map(job => ({ ...job, end: Math.max(now + 30000, (job.startedAt || now) + durationMs) }));
  const history = [...starts];
  let at = now;
  while (waiting.length) {
    running = running.filter(job => job.end > at);
    const windowAt = qqImageWindowAt(at, history);
    const index = waiting.findIndex(job => qqImageCanStart(job, running, access));
    if (windowAt <= at && index >= 0) {
      const [job] = waiting.splice(index, 1);
      if (job.key === key) return { position, waitMs: Math.max(0, at - now) };
      running.push({ ...job, end: at + durationMs }); history.push(at);
    } else {
      const next = Math.min(windowAt > at ? windowAt : Infinity, ...running.map(job => job.end));
      if (!Number.isFinite(next)) break;
      at = next;
    }
  }
  return { position, waitMs: 0 };
}
