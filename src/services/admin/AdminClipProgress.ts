import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClipProgressItem, ClipProgressStatus, clipStages } from '../../core/admin/clipProgress';
import { AdminError, readText } from './AdminFiles';
import { readClipVideoMedia, readClipVideos } from './AdminClipArtifacts';

const tailBytes = 64 * 1024;
function json(file: string): any { return JSON.parse(readText(file, 4 * 1024 * 1024)); }
function optionalJson(file: string): any { try { return json(file); } catch { return undefined; } }
function timestamp(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function tail(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - tailBytes), buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      return start ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}

/** Only fixed labels leave the service; provider payloads, paths and raw error text do not. */
export function clipActivity(log: string | undefined, since: string | undefined, now: number): ClipProgressItem['activity'] {
  let activity: ClipProgressItem['activity'];
  for (const line of (log || '').split('\n')) {
    const match = /^\[([^\]]+)\] \[(?:LOG|WARN|ERROR)\] (.*)$/u.exec(line);
    if (!match) continue;
    const at = timestamp(match[1]);
    if (!at || Date.parse(at) < Date.parse(since || '') || Date.parse(at) > now) continue;
    const text = match[2];
    const label = /\[WAIT\] 正在通过/u.test(text) ? '等待 AI 处理结果'
      : /AI clip validation rejected/u.test(text) ? '候选证据校验与修正'
      : /API调用成功/u.test(text) ? '收到 AI 处理结果'
      : /^Full-context AI input:/u.test(text) ? '全场内容选材'
      : /^\d+\. .* \d{1,2}:\d{2}(?::\d{2})? /u.test(text) ? '已生成切片，继续处理'
      : /^Review list:/u.test(text) ? '本场审核清单已生成'
      : /后台自动切片子进程完成/u.test(text) ? '本场切片流程完成' : undefined;
    if (label && (!activity || at >= activity.at)) activity = { label, at };
  }
  return activity;
}

interface Snapshot {
  id: string;
  kind: 'pending' | 'working' | 'done' | 'failed';
  entry: any;
  payload?: any;
  progress?: any;
  log?: string;
}
export function clipProgressItem(snapshot: Snapshot, worker: ClipProgressStatus['worker'], workerPid: number | undefined, now: number): ClipProgressItem {
  const { entry, payload, progress, kind } = snapshot;
  const source = String(payload?.originalMediaPath || payload?.processedMediaPath || payload?.context?.filename || '');
  const filename = source.split(/[\\/]/u).at(-1) || '';
  const roomId = String(entry.roomId || payload?.roomId || '未知');
  const streamerName = String(payload?.context?.streamerName || payload?.context?.streamer_name
    || /(?:^|[\\/])\d+_([^\\/]+)/u.exec(source)?.[1] || `直播间 ${roomId}`).slice(0, 120);
  const enqueuedAt = timestamp(entry.enqueuedAt), updatedAt = timestamp(progress?.updatedAt);
  const ownerMismatch = !!progress?.pid && !!workerPid && progress.pid !== workerPid;
  const status = kind === 'working' ? worker === 'online' && !ownerMismatch ? 'processing' : 'interrupted'
    : kind === 'pending' ? Number(entry.nextAttemptAt) > now ? 'retry_wait' : 'pending' : kind;
  const activity = clipActivity(snapshot.log, updatedAt || enqueuedAt, now);
  const latest = activity?.at || updatedAt;
  const steps = payload?.earlyCampaign || progress?.stage === 'earlyCampaign' ? ['earlyCampaign']
    : progress?.stage === 'recordingJob' ? ['recordingJob'] : payload?.activityOptions || progress?.stage === 'activity' ? ['activity']
      : ['topics', 'own', 'songs', 'games', 'watch'];
  return { id: snapshot.id, roomId, streamerName,
    title: filename.replace(/\.[^.]+$/u, '').replace(/_merged$/u, '') || '场次信息暂不可读', status, enqueuedAt,
    stage: typeof progress?.stage === 'string' && Object.hasOwn(clipStages, progress.stage) ? progress.stage : undefined,
    steps, completedStages: Object.keys(progress?.completed || {}).filter(stage => Object.hasOwn(clipStages, stage)),
    updatedAt, activity, stale: status === 'interrupted' || !latest || now - Date.parse(latest) > 120_000,
    attempts: Math.max(0, Number(entry.attempts) || 0), nextAttemptAt: timestamp(entry.nextAttemptAt),
    logAvailable: snapshot.log !== undefined, progressAvailable: !!progress };
}

/** Reads existing owner files only: no queue imports, lock recovery, worker launch or publication. */
export class AdminClipProgress {
  constructor(private readonly root: string, private readonly options: {
    queueDirectory?: string; now?: () => number; isAlive?: (pid: number) => boolean;
  } = {}) {}
  private location() {
    const production = path.join(this.root, 'config/production.json');
    const config = json(fs.existsSync(production) ? production : path.join(this.root, 'config/default.json'));
    const raw = config.clipTopics?.backgroundQueue || config.backgroundClipQueue || {};
    const directory = path.resolve(this.root, this.options.queueDirectory || process.env.DANMAKU_BACKGROUND_CLIP_QUEUE_DIR
      || raw.directory || path.join(os.tmpdir(), 'danmaku-to-summary-background-clip-queue'));
    return { config, directory };
  }
  media(id: string, index: string, key: string): string {
    if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(id) || !/^[1-9]\d{0,2}$/u.test(index) || Number(index) > 200 || !/^[a-f0-9]{64}$/u.test(key))
      throw new AdminError('切片预览不存在', 404);
    const { config, directory } = this.location();
    for (const kind of ['working', 'done', 'failed', 'pending']) {
      const entry = optionalJson(path.join(directory, `${id}.${kind}.json`));
      if (typeof entry?.payloadPath !== 'string') continue;
      const file = readClipVideoMedia(optionalJson(entry.payloadPath), config, timestamp(entry.enqueuedAt),
        this.options.now?.() ?? Date.now(), Number(index), key);
      if (file) return file;
    }
    throw new AdminError('视频尚未生成或版本已更新，请刷新进度后重试', 404);
  }
  status(): ClipProgressStatus {
    const now = this.options.now?.() ?? Date.now();
    const { config, directory } = this.location();
    let files: string[];
    try { files = fs.readdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AdminError('自动切片队列暂时无法读取', 503);
      files = [];
    }
    const lockFile = path.join(directory, 'worker.lock'), lock = optionalJson(lockFile);
    let heartbeatAt: string | undefined;
    try { heartbeatAt = fs.statSync(lockFile).mtime.toISOString(); } catch { /* Worker has not started or released its lock. */ }
    const workerPid = Number(lock?.pid), validPid = Number.isInteger(workerPid) && workerPid > 0;
    const worker = validPid ? (this.options.isAlive || alive)(workerPid) ? 'online' : 'offline' : heartbeatAt ? 'unknown' : 'offline';
    const active = files.filter(file => /\.(pending|working)\.json$/u.test(file)).sort();
    const endedFiles = files.filter(file => /\.(done|failed)\.json$/u.test(file)).map(file => {
      // Explicit legacy job IDs are not chronological; rank by the queue file's observed update time.
      try { return { file, at: fs.statSync(path.join(directory, file)).mtimeMs }; }
      catch { return { file, at: 0 }; }
    }).sort((a, b) => b.at - a.at || b.file.localeCompare(a.file)).slice(0, 30).map(item => item.file);
    let unreadableJobs = 0;
    const snapshots = new Map<string, ClipProgressItem | undefined>();
    const read = (file: string): ClipProgressItem | undefined => {
      if (snapshots.has(file)) return snapshots.get(file);
      snapshots.set(file, undefined);
      try {
        const entryPath = path.join(directory, file), entry = json(entryPath);
        if (!entry || typeof entry.payloadPath !== 'string') throw new Error('Invalid entry');
        const kind = /\.(pending|working|done|failed)\.json$/u.exec(file)![1] as Snapshot['kind'];
        const payload = optionalJson(entry.payloadPath), progress = optionalJson(`${entry.payloadPath}.progress.json`);
        const log = typeof entry.logPath === 'string' ? tail(entry.logPath) : undefined;
        const item = clipProgressItem({ id: file.replace(/\.(pending|working|done|failed)\.json$/u, ''), kind, entry, payload, progress, log }, worker, validPid ? workerPid : undefined, now);
        if (item.stage === 'own' || item.completedStages.includes('own')) item.videos = readClipVideos(payload, config, item.enqueuedAt, now);
        snapshots.set(file, item);
        return item;
      } catch (error) {
        // A queue rename between listing and reading is normal; malformed extant entries remain visible as a count.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableJobs++;
        return undefined;
      }
    };
    const queue = active.map(read).filter((item): item is ClipProgressItem => !!item)
      .sort((a, b) => Number(b.status === 'processing' || b.status === 'interrupted') - Number(a.status === 'processing' || a.status === 'interrupted') || a.id.localeCompare(b.id));
    const recent = endedFiles.slice(0, 3).map(read).filter((item): item is ClipProgressItem => !!item);
    let latestOutput: ClipProgressItem | undefined;
    for (const file of endedFiles) {
      const item = read(file);
      if (item?.videos?.items.some(video => video.previewKey)) { latestOutput = item; break; }
    }
    return { observedAt: new Date(now).toISOString(), worker, heartbeatAt, queue, recent, latestOutput, unreadableJobs,
      activeJobs: queue.filter(item => item.status === 'processing').length,
      queuedJobs: queue.filter(item => item.status === 'pending' || item.status === 'retry_wait').length };
  }
}
