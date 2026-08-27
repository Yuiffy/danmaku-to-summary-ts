import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigProvider } from '../core/config/ConfigProvider';

export interface FfmpegResourceConfig {
  threads: number;
  priority: string;
  asrGuard?: {
    enabled: boolean;
    claimFile: string;
    staleMs: number;
    pollMs: number;
    maxWaitMs: number;
    overlapThreads: number;
  };
  resourcePeak?: {
    enabled: boolean;
    sampleIntervalMs: number;
  };
}

export interface AsrAvailabilityResult {
  waitedMs: number;
  asrActive: boolean;
}

export interface FfmpegResourcePeak {
  stage: string;
  hostCpuPeakPct: number | null;
  nodeCpuPeakPct: number | null;
  nodeCorePeakPct: number | null;
  samples: number;
}

const DEFAULT_THREADS = 2;
const DEFAULT_PRIORITY = 'belowNormal';

const WINDOWS_PRIORITY_CLASSES: Record<string, string> = {
  idle: 'Idle',
  belownormal: 'BelowNormal',
  below_normal: 'BelowNormal',
  belowNormal: 'BelowNormal',
  normal: 'Normal',
  abovenormal: 'AboveNormal',
  above_normal: 'AboveNormal',
  aboveNormal: 'AboveNormal',
  high: 'High'
};

export function getFfmpegResourceConfig(): FfmpegResourceConfig {
  try {
    const config = ConfigProvider.getConfig() as any;
    const ffmpeg = config.audio?.ffmpeg || {};
    return {
      threads: normalizeThreads(ffmpeg.threads, DEFAULT_THREADS),
      priority: String(ffmpeg.priority || DEFAULT_PRIORITY),
      asrGuard: {
        enabled: normalizeBoolean(
          process.env.DANMAKU_ASR_GUARD_ENABLED ?? ffmpeg.asrGuard?.enabled,
          false
        ),
        claimFile: String(
          process.env.DANMAKU_RESOURCE_STATE_FILE
          || ffmpeg.asrGuard?.claimFile
          || path.join(os.tmpdir(), 'danmaku-to-summary-asr.claim')
        ),
        staleMs: normalizeNumber(ffmpeg.asrGuard?.staleMs, 15000, 1000),
        pollMs: normalizeNumber(ffmpeg.asrGuard?.pollMs, 1000, 100),
        maxWaitMs: normalizeNumber(ffmpeg.asrGuard?.maxWaitMs, 15000, 0),
        overlapThreads: normalizeThreads(ffmpeg.asrGuard?.overlapThreads, 1)
      },
      resourcePeak: {
        enabled: ffmpeg.resourcePeak?.enabled !== false,
        sampleIntervalMs: normalizeNumber(ffmpeg.resourcePeak?.sampleIntervalMs, 1000, 250)
      }
    };
  } catch {
    return {
      threads: DEFAULT_THREADS,
      priority: DEFAULT_PRIORITY,
      asrGuard: {
        enabled: false,
        claimFile: path.join(os.tmpdir(), 'danmaku-to-summary-asr.claim'),
        staleMs: 15000,
        pollMs: 1000,
        maxWaitMs: 15000,
        overlapThreads: 1
      },
      resourcePeak: {
        enabled: true,
        sampleIntervalMs: 1000
      }
    };
  }
}

export function withFfmpegResourceLimits(args: string[], resourceConfig = getFfmpegResourceConfig()): string[] {
  const threads = normalizeThreads(resourceConfig.threads, DEFAULT_THREADS);
  if (threads <= 0 || args.includes('-threads')) {
    return [...args];
  }

  const limitedArgs = [...args];
  const outputIndex = Math.max(limitedArgs.length - 1, 0);
  limitedArgs.splice(outputIndex, 0, '-threads', String(threads));
  return limitedArgs;
}

export function applyFfmpegProcessPriority(pid: number | undefined, priority = getFfmpegResourceConfig().priority): void {
  if (process.platform !== 'win32' || !pid) {
    return;
  }

  const priorityClass = WINDOWS_PRIORITY_CLASSES[String(priority)] || WINDOWS_PRIORITY_CLASSES[String(priority).toLowerCase()];
  if (!priorityClass || priorityClass === 'Normal') {
    return;
  }

  const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = '${priorityClass}' }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function normalizeThreads(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
    ? true
    : ['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
      ? false
      : fallback;
}

function normalizeNumber(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

export async function waitForAsrAvailability(
  stage: string,
  resourceConfig = getFfmpegResourceConfig(),
  log: (message: string) => void = message => console.log(message)
): Promise<AsrAvailabilityResult> {
  const guard = resourceConfig.asrGuard;
  if (!guard?.enabled) return { waitedMs: 0, asrActive: false };

  const isActive = (): boolean => {
    try {
      const stats = fs.statSync(guard.claimFile);
      const ageMs = Date.now() - stats.mtimeMs;
      return ageMs >= 0 && ageMs <= guard.staleMs;
    } catch {
      return false;
    }
  };

  let waitedMs = 0;
  let announced = false;
  while (isActive()) {
    if (!announced) {
      announced = true;
      log(`[resource] ASR 正在使用资源，延后 ${stage} 启动`);
    }
    if (guard.maxWaitMs > 0 && waitedMs >= guard.maxWaitMs) {
      log(`[resource] ASR 租约等待达到上限，继续 ${stage}: ${(waitedMs / 1000).toFixed(1)}s`);
      break;
    }
    const currentWaitMs = guard.maxWaitMs > 0
      ? Math.min(guard.pollMs, guard.maxWaitMs - waitedMs)
      : guard.pollMs;
    await new Promise(resolve => setTimeout(resolve, currentWaitMs));
    waitedMs += currentWaitMs;
  }

  const asrActive = isActive();
  if (announced && !asrActive) {
    log(`[resource] ASR 租约已释放，继续 ${stage}: 已等待 ${(waitedMs / 1000).toFixed(1)}s`);
  }
  return { waitedMs, asrActive };
}

function readCpuSnapshot(): { idle: number; total: number } {
  return os.cpus().reduce<{ idle: number; total: number }>((totals, cpu) => {
    const times: os.CpuInfo['times'] = cpu.times;
    const total = Object.values(times).reduce<number>((sum, value) => sum + Number(value || 0), 0);
    totals.idle += Number(times.idle || 0);
    totals.total += total;
    return totals;
  }, { idle: 0, total: 0 });
}

export function startFfmpegResourcePeakMonitor(
  stage: string,
  resourceConfig = getFfmpegResourceConfig(),
  log: (message: string) => void = message => console.log(message)
): { stop: () => FfmpegResourcePeak | null } {
  if (resourceConfig.resourcePeak?.enabled === false) {
    return { stop: () => null };
  }

  const cpuCount = Math.max(1, os.cpus().length || 1);
  let lastSnapshot = readCpuSnapshot();
  let lastUsage = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  let hostPeak: number | null = null;
  let nodePeak: number | null = null;
  let nodeCorePeak: number | null = null;
  let samples = 0;
  let stopped = false;

  const sample = () => {
    if (stopped) return;
    const currentSnapshot = readCpuSnapshot();
    const idleDelta = currentSnapshot.idle - lastSnapshot.idle;
    const totalDelta = currentSnapshot.total - lastSnapshot.total;
    if (totalDelta > 0) {
      const hostPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
      hostPeak = hostPeak === null ? hostPercent : Math.max(hostPeak, hostPercent);
    }
    lastSnapshot = currentSnapshot;
    const currentAt = process.hrtime.bigint();
    const elapsedMs = Math.max(0.1, Number(currentAt - lastAt) / 1e6);
    const usage = process.cpuUsage(lastUsage);
    const corePercent = ((usage.user + usage.system) / 1000) / elapsedMs * 100;
    const totalPercent = corePercent / cpuCount;
    nodeCorePeak = nodeCorePeak === null ? corePercent : Math.max(nodeCorePeak, corePercent);
    nodePeak = nodePeak === null ? totalPercent : Math.max(nodePeak, totalPercent);
    lastUsage = process.cpuUsage();
    lastAt = currentAt;
    samples += 1;
  };

  const timer = setInterval(sample, resourceConfig.resourcePeak?.sampleIntervalMs || 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => {
      if (stopped) return null;
      clearInterval(timer);
      sample();
      stopped = true;
      const result: FfmpegResourcePeak = {
        stage,
        hostCpuPeakPct: hostPeak === null ? null : Number(hostPeak.toFixed(2)),
        nodeCpuPeakPct: nodePeak === null ? null : Number(nodePeak.toFixed(2)),
        nodeCorePeakPct: nodeCorePeak === null ? null : Number(nodeCorePeak.toFixed(2)),
        samples
      };
      log(`[resource] 峰值 ${stage}: host_cpu_peak=${result.hostCpuPeakPct ?? 'n/a'}%, node_cpu_peak=${result.nodeCpuPeakPct ?? 'n/a'}%, node_core_peak=${result.nodeCorePeakPct ?? 'n/a'}%, samples=${samples}`);
      return result;
    }
  };
}
