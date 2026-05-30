import { ChildProcess, execFile, spawn } from 'child_process';

export interface ProcessTreeTerminationOptions {
  gracePeriodMs?: number;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  label?: string;
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('close', onExit);
      child.removeListener('exit', onExit);
    };

    child.once('close', onExit);
    child.once('exit', onExit);
  });
}

export async function listRelevantProcesses(): Promise<string[]> {
  try {
    const script = 'Get-Process python,node,ffmpeg -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => `pid=${row.Id} name=${row.ProcessName} path=${row.Path ?? 'unknown'}`);
  } catch {
    return [];
  }
}

export async function terminateProcessTree(child: ChildProcess, options: ProcessTreeTerminationOptions = {}): Promise<void> {
  const pid = child.pid;
  const gracePeriodMs = options.gracePeriodMs ?? 5000;
  const label = options.label ?? '子进程';

  if (!pid) {
    options.logger?.warn?.(`${label} 没有有效 PID，跳过进程树清理`);
    return;
  }

  try {
    options.logger?.warn?.(`${label} 开始温和终止，PID=${pid}`);
    child.kill('SIGTERM');
  } catch (error: any) {
    options.logger?.warn?.(`${label} 发送 SIGTERM 失败，PID=${pid}: ${error.message}`);
  }

  const exitedGracefully = await waitForExit(child, gracePeriodMs);
  if (exitedGracefully) {
    options.logger?.info?.(`${label} 已在宽限期内退出，PID=${pid}`);
    return;
  }

  try {
    options.logger?.warn?.(`${label} 宽限期后仍存活，执行 taskkill /T /F，PID=${pid}`);
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch (error: any) {
    options.logger?.warn?.(`${label} taskkill 失败，PID=${pid}: ${error.message}`);
  }

  const exitedAfterForce = await waitForExit(child, 3000);
  if (exitedAfterForce) {
    options.logger?.info?.(`${label} 已强制结束，PID=${pid}`);
  } else {
    options.logger?.warn?.(`${label} 强制结束后仍未确认退出，PID=${pid}`);
  }
}

export function spawnWithInheritedOutput(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
