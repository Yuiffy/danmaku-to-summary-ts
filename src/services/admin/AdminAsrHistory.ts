import * as fs from 'fs';
import * as path from 'path';
import { AsrHistory, AsrHistoryItem, AsrHistoryTier } from '../../core/admin/asrHistory';
import { AdminError, readText } from './AdminFiles';

type Data = Record<string, any>;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const ratio = (audio?: number, wall?: number): number | undefined => audio !== undefined && wall !== undefined && wall > 0 ? audio / wall : undefined;

/** Only observed timing fields; legacy backend selection does not prove a device. */
export function asrHistoryMetrics(meta: Data): Pick<AsrHistoryItem, 'tiers' | 'speakerState'> & Partial<AsrHistoryItem> {
  const timing = meta.stageTimings || {}, tiers: AsrHistoryTier[] = [];
  const add = (tier: AsrHistoryTier['tier'], key: string) => {
    const audioSeconds = number(timing[`handoff_${key}_audio_s`]);
    if (audioSeconds === undefined || audioSeconds === 0) return;
    const windowSeconds = number(timing[`handoff_${key}_window_s`]);
    tiers.push({ tier, audioSeconds, windowSeconds, speedX: ratio(audioSeconds, windowSeconds),
      batchSeconds: number(timing[`handoff_${key}_batch_s`]) });
  };
  add('cpu_background', 'cpu'); add('gpu_low_impact', 'gpu_low_impact'); add('gpu_throughput', 'gpu_throughput');
  const gpu = number(timing.handoff_gpu_audio_s), split = tiers.filter(row => row.tier.startsWith('gpu_')).reduce((sum, row) => sum + row.audioSeconds, 0);
  if (gpu !== undefined && gpu > split + .01) {
    // Older metadata has only aggregate GPU totals. Never infer its batch/tier.
    const audioSeconds = gpu - split;
    const windowSeconds = split === 0 ? number(timing.handoff_gpu_window_s) : undefined;
    tiers.push({ tier: 'gpu_unknown', audioSeconds, windowSeconds, speedX: ratio(audioSeconds, windowSeconds) });
  }
  const cpu = number(timing.handoff_cpu_audio_s), transcriptionSeconds = number(timing.handoff_transcription_s);
  const audio = cpu !== undefined && gpu !== undefined ? cpu + gpu : undefined;
  const speaker = meta.speakerProcessing || {};
  return { tiers, elapsedSeconds: number(meta.elapsedSeconds), mediaSeconds: number(meta.mediaDurationSeconds),
    transcriptionSeconds, speedX: ratio(audio, transcriptionSeconds), reusedSeconds: number(timing.handoff_reused_audio_s),
    modelLoadSeconds: number(timing.handoff_model_load_s), speakerSeconds: number(timing.speaker_total_s),
    switches: number(timing.handoff_switches), interruptions: number(timing.handoff_interruptions),
    speakerState: speaker.skipped === true || speaker.enabled === false || speaker.status === 'disabled' || speaker.load_policy?.enabled === false ? 'skipped'
      : number(timing.speaker_total_s) !== undefined && timing.speaker_total_s > 0 ? 'processed' : 'unknown',
    generatedAt: typeof meta.generatedAt === 'string' && Number.isFinite(Date.parse(meta.generatedAt)) ? meta.generatedAt : undefined };
}

/** Reads only queue-bound sidecars beneath configured recording roots; no directory crawl or queue singleton. */
export function readAsrHistory(queueFile: string, roots: string[], pageInput: unknown = 1, sizeInput: unknown = 20, now = Date.now()): AsrHistory {
  const page = Number(pageInput), pageSize = Number(sizeInput);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new AdminError('历史分页参数无效');
  let queue: Data;
  try { queue = JSON.parse(readText(queueFile, 16 * 1024 * 1024)); }
  catch { throw new AdminError('字幕历史暂时无法读取', 503); }
  if (!Array.isArray(queue?.tasks)) throw new AdminError('字幕历史数据无效', 503);
  const tasks: Data[] = queue.tasks.filter((task: Data) => task && typeof task === 'object' && !['pending', 'processing'].includes(task.status))
    .sort((a: Data, b: Data) => (number(b.completedTime) || number(b.startTime) || 0) - (number(a.completedTime) || number(a.startTime) || 0));
  const trusted = roots.flatMap(root => { try { return [fs.realpathSync(root)]; } catch { return []; } });
  const items = tasks.slice((page - 1) * pageSize, page * pageSize).map(task => {
    const parts = String(task.mediaPath || '').split(/[\\/]/u), name = parts.at(-1) || '';
    const row: AsrHistoryItem = { id: String(task.id || ''),
      streamerName: parts.find(part => part.startsWith(`${task.roomId}_`))?.slice(String(task.roomId).length + 1) || String(task.roomId || '未知主播'),
      title: name.replace(/^录制-\d+-\d{8}-\d{6}-\d+-/u, '').replace(/(?:_merged)?\.[^.]+$/u, ''),
      status: ['completed', 'completed_with_cleanup_crash', 'failed', 'cancelled', 'ignored'].includes(task.status) ? task.status : 'unknown',
      metadata: 'missing', tiers: [], speakerState: 'unknown' };
    try {
      if (typeof task.mediaPath !== 'string' || !path.isAbsolute(task.mediaPath)) return row;
      const parsed = path.parse(task.mediaPath), file = fs.realpathSync(path.join(parsed.dir, `${parsed.name}.asr_meta.json`));
      if (!trusted.some(root => { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) return { ...row, metadata: 'unavailable' as const };
      const meta = JSON.parse(readText(file, 4 * 1024 * 1024));
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Invalid metadata');
      return { ...row, ...asrHistoryMetrics(meta), metadata: 'available' as const };
    } catch (error) {
      return { ...row, metadata: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unavailable' as const };
    }
  });
  return { observedAt: new Date(now).toISOString(), page, pageSize, total: tasks.length, items };
}
