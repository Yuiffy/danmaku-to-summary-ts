import { ChildProcess, spawn } from 'child_process';

export interface AsrResourceGuardConfig {
  enabled?: boolean;
  game_process_names?: string[] | string;
  process_names?: string[] | string;
  pause_when_game_running?: boolean;
  poll_interval_s?: number;
  wait_s?: number;
  max_wait_s?: number;
  priority?: string;
  eco_qos?: boolean;
  prefer_e_cores?: boolean;
  e_core_efficiency_class?: number | null;
  torch_num_threads?: number;
  torch_num_interop_threads?: number;
  soft_gpu?: {
    enabled?: boolean;
    sm_threshold?: number;
    mem_threshold?: number;
    fb_threshold_mb?: number;
    total_memory_threshold_pct?: number;
    include_total_utilization?: boolean;
  };
}

function normalizeProcessName(value: unknown): string {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  normalized = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (normalized && !normalized.endsWith('.exe')) {
    normalized += '.exe';
  }
  return normalized;
}

export function normalizeAsrProcessNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.map(normalizeProcessName).filter(Boolean)));
}

export function parseTasklistImageNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)"/);
    if (match?.[1]) {
      const normalized = normalizeProcessName(match[1]);
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

export function getAsrResourceGuardConfig(config: any): AsrResourceGuardConfig {
  const value = config?.resource_guard;
  return value && typeof value === 'object' ? value : {};
}

export function getAsrGamePollIntervalMs(config: any, fallbackMs = 5000): number {
  const seconds = Number(getAsrResourceGuardConfig(config).poll_interval_s);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(250, seconds * 1000)
    : fallbackMs;
}

export function isAnyWindowsProcessRunning(processNames: unknown): Promise<boolean> {
  if (process.platform !== 'win32') {
    return Promise.resolve(false);
  }

  const wanted = new Set(normalizeAsrProcessNames(processNames));
  if (wanted.size === 0) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let child: ChildProcess;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolve(result);
    };

    timeout = setTimeout(() => finish(false), 3000);

    try {
      child = spawn('tasklist', ['/FO', 'CSV', '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false
      });
    } catch {
      finish(false);
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('error', () => finish(false));
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      const running = parseTasklistImageNames(stdout);
      finish(Array.from(wanted).some(name => running.has(name)));
    });
  });
}
