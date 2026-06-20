import { spawn } from 'child_process';
import { ConfigProvider } from '../core/config/ConfigProvider';

export interface FfmpegResourceConfig {
  threads: number;
  priority: string;
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
      priority: String(ffmpeg.priority || DEFAULT_PRIORITY)
    };
  } catch {
    return {
      threads: DEFAULT_THREADS,
      priority: DEFAULT_PRIORITY
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
