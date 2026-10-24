import * as fs from 'node:fs';
import * as path from 'node:path';

type Data = Record<string, any>;
export interface SpeakerLoad {
  cpuBusy?: boolean;
  gpuBusy?: boolean;
  pendingJobs?: number;
  oldestWaitSeconds?: number;
  queueKnown?: boolean;
}

/** A missing policy preserves existing behavior; production can opt into auto. */
export function decideSpeakerProcessing(policy: Data = {}, load: SpeakerLoad = {}): Data {
  const mode = policy.mode || 'on';
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('Invalid speaker_processing.mode');
  const maxPending = Number(policy.max_pending_jobs ?? 3), maxWait = Number(policy.max_wait_s ?? 900);
  if (!Number.isInteger(maxPending) || maxPending < 1 || !Number.isFinite(maxWait) || maxWait <= 0) {
    throw new Error('Invalid speaker_processing thresholds');
  }
  const reason = mode === 'off' ? 'manual_off' : mode === 'on' ? 'manual_on'
    : load.cpuBusy || load.gpuBusy ? 'resource_busy'
    : Number(load.pendingJobs || 0) >= maxPending ? 'queue_backlog'
    : Number(load.oldestWaitSeconds || 0) >= maxWait ? 'queue_wait'
    : 'capacity_available';
  return { mode, enabled: ['manual_on', 'capacity_available'].includes(reason), reason,
    max_pending_jobs: maxPending, max_wait_s: maxWait, ...load };
}

/** Read only the central queue snapshot; this module never claims or changes jobs. */
export function currentSpeakerProcessing(config: Data = {}, context: Data = {}, now = Date.now()): Data {
  const policy = config.asr?.speaker_processing || {};
  const queueFile = path.resolve(process.env.WHISPER_QUEUE_FILE
    || path.join(process.env.DANMAKU_PROJECT_ROOT || process.cwd(), 'src/scripts/.whisper_queue.json'));
  const load: SpeakerLoad = { cpuBusy: process.env.ASR_CPU_FALLBACK === '1', queueKnown: false };
  if (policy.mode === 'auto') {
    try {
      if (fs.statSync(queueFile).size > 16 * 1024 * 1024) throw new Error('Queue snapshot too large');
      const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8')).tasks;
      if (!Array.isArray(queue)) throw new Error('Invalid queue snapshot');
      const current = path.resolve(context.sourceMediaPath || context.input || '').toLowerCase();
      const pending = queue.filter((task: Data) => task.status === 'pending'
        && path.resolve(task.mediaPath || '').toLowerCase() !== current);
      const waits = pending.map((task: Data) => Number(task.addedTime))
        .filter((at: number) => Number.isFinite(at) && at > 0 && at <= now);
      Object.assign(load, { pendingJobs: pending.length,
        oldestWaitSeconds: waits.length ? (now - Math.min(...waits)) / 1000 : 0, queueKnown: true });
    } catch { /* Missing queue data cannot prove a backlog; resource admission still applies. */ }
  }
  return { ...decideSpeakerProcessing(policy, load), queue_file: queueFile,
    source_path: context.sourceMediaPath || context.input || '', evaluated_at: new Date(now).toISOString() };
}
