import * as fs from 'fs';
import * as path from 'path';
import { AsrQueueItem, AsrQueueStatus } from '../../core/admin/asrStatus';
import { AdminError, readJson } from './AdminFiles';
import { AdminAsrTelemetry } from './AdminAsrTelemetry';
import { readAsrHistory } from './AdminAsrHistory';
import { AdminAsrHistoryIndex, AsrHistoryFilter, queryAsrHistory } from './AdminAsrHistoryIndex';
import { backfillAsrHistory } from './AdminAsrHistoryBackfill';

type Data = Record<string, any>;
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000
  ? new Date(value).toISOString() : undefined;
const seconds = (from: unknown, to: number): number | undefined => iso(from) ? Math.max(0, Math.floor((to - Number(from)) / 1000)) : undefined;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Parse only worker telemetry after this task started; never return raw log text. */
export function asrActivity(log: string, task: Data, now: number, until = Infinity): AsrQueueItem['activity'] {
  if (!iso(task.startTime)) return undefined;
  let activity: AsrQueueItem['activity'];
  let device: 'cpu' | 'gpu' | 'unknown' = 'unknown';
  const telemetry = new AdminAsrTelemetry();
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/gu, '');
    const stamp = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/u)?.[1];
    const at = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(at) || at < task.startTime || at >= until || at > now + 5000 || !line.includes('MikufansSummaryQueueWorker')) continue;
    // Another invocation must not lend its progress/device to this task.
    const invocation = line.match(/Mikufans队列Worker开始执行:.*\(taskId=(.+)\)/u);
    if (invocation && invocation[1] !== task.id) break;
    if (!line.includes('[Mikufans队列Worker]')) continue;
    if (line.includes('[[ASR_PHASE_DONE]]') && line.includes(`taskId=${task.id} media=`)) {
      const progress = telemetry.current(now);
      return { device, phase: '字幕已生成，后续处理中', asrCompleted: true, at: stamp!, stale: false,
        ...(progress ? { progress: { audioDoneSeconds: progress.audioTotalSeconds, audioTotalSeconds: progress.audioTotalSeconds,
          percent: 100, performanceTier: 'postprocessing' } } : {}) };
    }
    if (/CPU 后台 ASR|低优先级 CPU ASR|ASR module=\['cpu'\]/u.test(line)) device = 'cpu';
    if (/ASR module=\['cuda(?::\d+)?'\]/u.test(line)) device = 'gpu';
    let phase = '', batch: number | undefined;
    const status = telemetry.accept(line, at);
    const inference = line.match(/开始 (ASR batch|VAD) \((CPU|GPU|CUDA)\) #(\d+)/iu);
    const handoff = line.match(/ASR 分段接力:.*→\s*(cpu|cuda(?::\d+)?)/iu);
    const checkpoint = line.match(/ASR 接力已保存:.*device=(cpu|cuda(?::\d+)?)/iu);
    if (status) {
      device = status.device;
      phase = status.phase;
    } else if (handoff || checkpoint) {
      device = (handoff || checkpoint)![1].toLowerCase() === 'cpu' ? 'cpu' : 'gpu';
      phase = handoff ? '切换转写设备' : '已保存分段进度';
    } else if (inference) {
      device = inference[2].toUpperCase() === 'CPU' ? 'cpu' : 'gpu';
      phase = inference[1] === 'VAD' ? '检测语音' : '转写中';
      batch = Number(inference[3]);
    } else if (/ASR 接力中断:/u.test(line)) phase = '切换转写设备';
    else if (/低优先级 CPU ASR|设备检查:/u.test(line)) phase = '准备转写';
    else if (/等待.*GPU|GPU.*等待|等待资源/u.test(line)) phase = '等待计算资源';
    else if (/开始.*(?:说话人|声纹)/u.test(line)) phase = '识别说话人';
    else if (/开始.*情感/u.test(line)) phase = '分析语气';
    else if (/开始.*(?:谐音|校正|纠错)/u.test(line)) phase = '校正字幕';
    if (phase) activity = { device, phase, batch, at: stamp!, stale: now - at > 120000 };
  }
  if (activity) activity.progress = telemetry.current(now);
  return activity;
}

/** Match the central queue's priority, addedTime and ID ordering without importing its mutating singleton. */
export function asrQueueStatus(queue: unknown, log: string | undefined, config: Data = {}, now = Date.now(), isAlive = alive): AsrQueueStatus {
  if (!queue || typeof queue !== 'object' || !Array.isArray((queue as Data).tasks)) throw new AdminError('字幕队列数据无效，请稍后重试', 503);
  const data = queue as Data, tasks: Data[] = data.tasks.filter((row: unknown) => row && typeof row === 'object');
  const priority = (task: Data): number => {
    const room = config.ai?.roomSettings?.[String(task.roomId)] || config.roomSettings?.[String(task.roomId)];
    return Number.isFinite(task.priority) ? task.priority : Number.isFinite(room?.whisperPriority) ? room.whisperPriority : String(task.roomId) === '25788785' ? 100 : 0;
  };
  const running = tasks.filter(task => task.status === 'processing').sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0));
  const pending = tasks.filter(task => task.status === 'pending').sort((a, b) => priority(b) - priority(a)
    || (Number(a.addedTime) || 0) - (Number(b.addedTime) || 0) || String(a.id).localeCompare(String(b.id)));
  const item = (task: Data, position?: number): AsrQueueItem => {
    const parts = String(task.mediaPath || '').split(/[\\/]/u), filename = parts.at(-1) || '';
    const roomDirectory = parts.find(part => part.startsWith(`${task.roomId}_`));
    const match = filename.match(/^录制-\d+-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-\d+-(.+)\.[^.]+$/u);
    const ownerAlive = Number.isInteger(task.ownerPid) && task.ownerPid > 0 ? isAlive(task.ownerPid) : undefined;
    const nextStart = Math.min(...running.filter(other => other.startTime > task.startTime).map(other => Number(other.startTime)));
    const ambiguousStart = running.some(other => other !== task && other.startTime === task.startTime);
    let activity = task.status === 'processing' && !ambiguousStart && ownerAlive !== false && log !== undefined ? asrActivity(log, task, now, nextStart) : undefined;
    // Older tasks can continue AI work after releasing the single ASR slot. Only a bound completion sentinel proves that stage.
    if (Number.isFinite(nextStart) && !activity?.asrCompleted) activity = undefined;
    return { id: String(task.id || ''), roomId: String(task.roomId || ''),
      streamerName: roomDirectory?.slice(String(task.roomId).length + 1) || String(task.roomId || '未知主播'),
      title: match ? match[7].replace(/_merged$/u, '') : filename || '未记录场次',
      recordedAt: match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00` : undefined,
      status: task.status, priority: priority(task), position, addedAt: iso(task.addedTime), startedAt: iso(task.startTime),
      waitSeconds: seconds(task.addedTime, task.status === 'processing' && iso(task.startTime) ? task.startTime : now),
      elapsedSeconds: task.status === 'processing' ? seconds(task.startTime, now) : undefined, ownerAlive, activity };
  };
  const fallback = config.asr?.cpu_fallback;
  return { observedAt: new Date(now).toISOString(), queueUpdatedAt: typeof data.lastUpdate === 'string' ? data.lastUpdate : iso(data.lastUpdate),
    activeJobs: running.length, queuedJobs: pending.length, failedJobs: tasks.filter(task => task.status === 'failed').length,
    queue: [...running.map(task => item(task)), ...pending.map((task, i) => item(task, i + 1))],
    policy: { cpuFallbackEnabled: fallback?.enabled === true, minAvailableMemoryGb: Math.max(4, Number(fallback?.min_available_memory_gb) || 10),
      deviceHandoffEnabled: config.asr?.device_handoff?.enabled === true }, logAvailable: log !== undefined };
}

/** Bounded, read-only file adapter. No queue manager, model, GPU query or worker is started by a page read. */
export class AdminAsrStatus {
  private historyTimer?: ReturnType<typeof setInterval>;
  private historyIndex?: AdminAsrHistoryIndex;
  private readonly historyFile: string;
  constructor(private readonly root: string, private readonly options: { queueFile?: string; logFile?: string; now?: () => number; isAlive?: (pid: number) => boolean } = {}) {
    this.historyFile = path.join(root, 'data/runtime/admin/asr-history.sqlite');
  }
  private recordingRoots(): string[] {
    const production = path.join(this.root, 'config/production.json');
    const config = readJson(fs.existsSync(production) ? production : path.join(this.root, 'config/default.json'), {});
    return [config.webhook?.endpoints?.mikufans?.basePath, config.audio?.storage?.archiveTargetBasePath]
      .filter((value): value is string => typeof value === 'string').map(value => path.resolve(this.root, value));
  }
  history(page?: unknown, pageSize?: unknown, filter?: AsrHistoryFilter) {
    if (fs.existsSync(this.historyFile)) return queryAsrHistory(this.historyFile, page, pageSize, filter);
    return readAsrHistory(this.options.queueFile || path.join(this.root, 'src/scripts/.whisper_queue.json'), this.recordingRoots(),
      page, pageSize, this.options.now?.() ?? Date.now());
  }
  startHistoryIndex(): void {
    if (this.historyIndex) return;
    const index = this.historyIndex = new AdminAsrHistoryIndex(this.historyFile);
    const sync = () => {
      try {
        const queueFile = this.options.queueFile || path.join(this.root, 'src/scripts/.whisper_queue.json');
        const queue = readJson(queueFile), roots = this.recordingRoots();
        const paths = new Map<string, string>((queue.tasks || []).filter((task: Data) => typeof task.mediaPath === 'string')
          .map((task: Data) => { const parsed = path.parse(task.mediaPath); return [String(task.id), path.join(parsed.dir, `${parsed.name}.asr_meta.json`)]; }));
        for (let page = 1; page <= 20; page++) {
          const result = readAsrHistory(queueFile, roots, page, 50);
          for (const row of result.items) { const source = paths.get(row.id); if (source) index.upsert(source, row); }
          if (page * 50 >= result.total) break;
        }
      } catch { console.warn('ASR 历史索引同步失败，保留已有记录'); }
    };
    sync();
    this.historyTimer = setInterval(sync, 30000); this.historyTimer.unref();
    void backfillAsrHistory(this.recordingRoots(), index, () => this.historyIndex !== index)
      .then(count => { if (this.historyIndex === index) { sync(); console.log(`ASR 历史索引导入 ${count} 份统计文件`); } })
      .catch(() => console.warn('ASR 历史文件导入失败，保留已有索引'));
  }
  close(): void {
    if (this.historyTimer) clearInterval(this.historyTimer);
    const index = this.historyIndex; this.historyIndex = undefined; index?.close();
  }
  status(): AsrQueueStatus {
    let queue: unknown;
    try { queue = readJson(this.options.queueFile || path.join(this.root, 'src/scripts/.whisper_queue.json')); }
    catch { throw new AdminError('字幕队列暂时无法读取，请稍后重试', 503); }
    let log: string | undefined;
    try {
      const file = this.options.logFile || path.join(this.root, 'logs/pm2-out-0.log');
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size, start = Math.max(0, size - 256 * 1024), buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString('utf8');
        log = start ? text.slice(text.indexOf('\n') + 1) : text;
      } finally { fs.closeSync(fd); }
    } catch { /* Missing/rotated logs leave device and phase explicitly unknown. */ }
    // The worker selects production.json as a whole; default.json is only a missing-file fallback.
    const productionFile = path.join(this.root, 'config/production.json');
    const config = readJson(fs.existsSync(productionFile) ? productionFile : path.join(this.root, 'config/default.json'), {});
    return asrQueueStatus(queue, log, config, this.options.now?.() ?? Date.now(), this.options.isAlive);
  }
}
