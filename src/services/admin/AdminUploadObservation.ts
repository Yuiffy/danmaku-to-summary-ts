import { UploadObservation, UploadSubmission } from '../../core/admin/uploadStatus';
import { UploadTelemetry } from './AdminUploadTelemetry';

const HOUR = 3600000;
const windows = [3, 24, 48];
const at = (value: unknown): number => {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/iu.test(value) ? value : `${value}Z`);
};
const iso = (value: number) => new Date(value).toISOString();
function upperBound(values: number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}
const count = (values: number[], end: number, duration: number) => upperBound(values, end) - upperBound(values, end - duration);

/** Exact step changes and open lower boundaries; observed evidence never implies causality. */
export function uploadObservation(submissions: UploadSubmission[], queue: Record<string, any>, now: number,
  telemetry: UploadTelemetry = { available: false, truncated: false, events: [] }): UploadObservation {
  const from = now - 48 * HOUR;
  const times = submissions.map(row => at(row.at)).filter(time => Number.isFinite(time) && time > now - 96 * HOUR && time <= now).sort((a, b) => a - b);
  const incidents: UploadObservation['incidents'] = [];
  const starts = new Map<string, number[]>();
  for (const event of telemetry.events) {
    if (event.event !== 'preupload_start' || !Number.isFinite(at(event.at))) continue;
    const values = starts.get(event.accountId) || []; values.push(at(event.at)); starts.set(event.accountId, values);
  }
  for (const values of starts.values()) values.sort((a, b) => a - b);
  function add(event: Omit<UploadObservation['incidents'][number], 'counts'>) {
    const time = at(event.at);
    if (!Number.isFinite(time) || time < from || time > now) return;
    incidents.push({ ...event, at: iso(time), counts: windows.map(hours => count(times, time, hours * HOUR)) });
  }
  for (const event of telemetry.events) if (event.httpStatus === 406) {
    // The outer uploader reports the same failed initialization again on exception unwind.
    if (event.event === 'upload_failed' && telemetry.events.some(previous => previous.accountId === event.accountId
      && previous.event === 'preupload_failed' && previous.httpStatus === 406 && at(previous.at) <= at(event.at)
      && at(event.at) - at(previous.at) < 5000)) continue;
    add({
      id: `ledger-${event.id}`, at: event.at, kind: 'http406', source: 'ledger', stage: event.stage,
      accountId: event.accountId, partIndex: event.partIndex,
      preupload5m: count(starts.get(event.accountId) || [], at(event.at), 300000)
    });
  }
  const history = Array.isArray(queue.submissionRateLimitHistory) ? queue.submissionRateLimitHistory : [];
  for (const row of history) if (row && row.code === 137022) add({ id: `history-${row.at}-${row.jobId}`, at: row.at,
    kind: 'submission137022', source: 'history', stage: 'submit', jobId: String(row.jobId || '') });
  const cooldown = queue.submissionRateLimit;
  if (cooldown?.code === 137022 && !history.some(row => row?.jobId === cooldown.jobId && at(row.at) === at(cooldown.updatedAt))) {
    add({ id: 'cooldown-snapshot', at: cooldown.updatedAt, kind: 'submission137022', source: 'snapshot', stage: 'submit', jobId: String(cooldown.jobId || '') });
  }
  // Old queues retain only the latest output per job. Mark timestamps as snapshots, never invent earlier retries.
  for (const job of Array.isArray(queue.jobs) ? queue.jobs : []) {
    if (!job || !job.startedAt || ['running', 'pending', 'done'].includes(job.status)) continue;
    const output = `${job.error || ''}\n${job.lastOutput || ''}`;
    const time = at(job.updatedAt);
    if (job.retryKind === 'bilibili_submission_rate_limit' || /(?<!\d)137022(?!\d)/u.test(output)) {
      if (!incidents.some(row => row.kind === 'submission137022' && row.jobId === String(job.id) && Math.abs(at(row.at) - time) < 5000))
        add({ id: `job-${job.id}-137022`, at: job.updatedAt, kind: 'submission137022', source: 'snapshot', stage: 'submit', jobId: String(job.id) });
    }
    if (job.retryKind === 'bilibili_http_406' || /\[RATE_LIMIT_406\]|HTTP\s*406\b/iu.test(output)) {
      if (!incidents.some(row => row.kind === 'http406' && Math.abs(at(row.at) - time) < 60000))
        add({ id: `job-${job.id}-406`, at: job.updatedAt, kind: 'http406', source: 'snapshot', stage: 'unknown', jobId: String(job.id) });
    }
  }
  return { from: iso(from), until: iso(now), telemetry: { available: telemetry.available, since: telemetry.since, truncated: telemetry.truncated },
    historySince: Number.isFinite(at(queue.submissionRateLimitHistorySince)) ? iso(at(queue.submissionRateLimitHistorySince)) : undefined,
    windows: windows.map(hours => {
      const duration = hours * HOUR;
      const changes = [...new Set([from, now, ...times.flatMap(time => [time, time + duration]).filter(time => time >= from && time <= now)])].sort((a, b) => a - b);
      return { hours, count: count(times, now, duration), points: changes.map(time => ({ at: iso(time), count: count(times, time, duration) })) };
    }), incidents: incidents.sort((a, b) => at(a.at) - at(b.at) || a.id.localeCompare(b.id)) };
}
