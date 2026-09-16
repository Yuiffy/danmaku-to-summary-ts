import * as crypto from 'crypto';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { ConfigProvider } from '../../../../core/config/ConfigProvider';
import { getLogger } from '../../../../core/logging/LogManager';
import { terminateProcessTree } from '../../../../utils/processCleanup';
import { applyFfmpegProcessPriority, getFfmpegResourceConfig } from '../../../../utils/ffmpegResource';
import {
  getAsrGamePollIntervalMs,
  getAsrResourceGuardConfig,
  isAnyWindowsProcessRunning,
  normalizeAsrProcessNames
} from '../../../../utils/asrResourceGuard';

export interface AsrWorkerConnection {
  port: number | null;
  token: string | null;
}

/** Owns GPU admission checks and the reusable Python ASR worker lifecycle. */
export class MikufansAsrResourceController {
  private readonly logger = getLogger('MikufansAsrResourceController');
  private workerProcess: ChildProcess | null = null;
  private workerPort: number | null = null;
  private workerToken: string | null = null;
  private workerStarting: Promise<void> | null = null;

  getConnection(): AsrWorkerConnection {
    return {
      port: this.workerPort,
      token: this.workerToken
    };
  }

  async isLegacyGpuBusy(): Promise<{ busy: boolean; reason: string }> {
    const config: any = ConfigProvider.getConfig();
    const gpuConfig = config.whisper?.gpuDetection;
    if (!gpuConfig?.enabled) {
      return { busy: false, reason: 'gpuDetection disabled' };
    }

    const usage = await this.getGpuUsage();
    if (!usage) {
      return { busy: false, reason: 'nvidia-smi unavailable' };
    }

    const utilThreshold = gpuConfig.gpuUtilizationThreshold ?? 60;
    const vramThreshold = gpuConfig.vramUsageThreshold ?? 70;
    const vramPct = usage.vramTotal > 0 ? (usage.vramUsed / usage.vramTotal) * 100 : 0;
    const busy = usage.gpuUtil >= utilThreshold || vramPct >= vramThreshold;
    const reason = `运算: ${usage.gpuUtil.toFixed(0)}%, 显存: ${usage.vramUsed.toFixed(0)}/${usage.vramTotal.toFixed(0)} MB (${vramPct.toFixed(1)}%)`;
    return { busy, reason };
  }

  async isGameRunning(): Promise<{ busy: boolean; reason: string; waitMs: number }> {
    const config: any = ConfigProvider.getConfig();
    const resourceConfig = getAsrResourceGuardConfig(config.asr?.paraformer);
    if (!resourceConfig.enabled || resourceConfig.pause_when_game_running === false) {
      return { busy: false, reason: 'ASR 游戏保护未启用', waitMs: 5000 };
    }

    const names = normalizeAsrProcessNames(
      resourceConfig.game_process_names || resourceConfig.process_names || []
    );
    if (names.length === 0) {
      return { busy: false, reason: '未配置游戏进程名', waitMs: 5000 };
    }

    const running = await isAnyWindowsProcessRunning(names);
    return {
      busy: running,
      reason: running ? `检测到游戏进程: ${names.join(', ')}` : '',
      waitMs: getAsrGamePollIntervalMs({ resource_guard: resourceConfig })
    };
  }

  isAdaptiveGpuProtectionEnabled(config: any): boolean {
    const backend = String(config.asr?.default_backend || config.asr?.backend || 'paraformer');
    if (backend !== 'paraformer') {
      return false;
    }

    const paraformerConfig = config.asr?.paraformer || {};
    const resourceConfig = getAsrResourceGuardConfig(paraformerConfig);
    const gpuConfig = paraformerConfig.gpu_throttle;
    const softGpuConfig = gpuConfig?.soft_gpu || resourceConfig.soft_gpu;
    const gpuEnabled = gpuConfig === true || Boolean(
      gpuConfig && typeof gpuConfig === 'object' && gpuConfig.enabled !== false
    );
    return Boolean(
      resourceConfig.enabled !== false &&
      gpuEnabled &&
      softGpuConfig?.enabled === true
    );
  }

  async ensurePersistentWorker(): Promise<void> {
    const config: any = ConfigProvider.getConfig();
    const paraformerConfig = config.asr?.paraformer || {};
    if (paraformerConfig.persistent_worker?.enabled === false) {
      return;
    }
    if (this.workerProcess && this.workerPort) {
      return;
    }
    if (this.workerStarting) {
      return this.workerStarting;
    }

    this.workerStarting = new Promise<void>((resolve, reject) => {
      const executable = String(
        paraformerConfig.python_executable || process.env.ASR_PYTHON || 'python'
      );
      const pythonArgs = Array.isArray(paraformerConfig.python_args)
        ? paraformerConfig.python_args.map((value: unknown) => String(value)).filter(Boolean)
        : [];
      const workerScript = path.join(
        process.cwd(),
        'src',
        'scripts',
        'python',
        'asr_persistent_worker.py'
      );
      const token = crypto.randomBytes(24).toString('hex');
      const args = [...pythonArgs, workerScript, '--port', '0', '--token', token];
      const resourceConfig = getFfmpegResourceConfig();
      const asrResourceConfig = getAsrResourceGuardConfig(paraformerConfig);
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: '1' }
      });
      applyFfmpegProcessPriority(
        child.pid,
        String(asrResourceConfig.priority || resourceConfig.priority || 'belowNormal')
      );

      this.workerProcess = child;
      this.workerToken = token;
      let stdoutBuffer = '';
      let ready = false;
      const readyTimeoutMs = Number(paraformerConfig.persistent_worker?.startup_timeout_s || 60) * 1000;
      const readyTimeout = setTimeout(() => {
        if (!ready) {
          reject(new Error(`ASR 常驻 worker 启动超时: ${readyTimeoutMs / 1000}s`));
          void terminateProcessTree(child, {
            gracePeriodMs: 1000,
            label: 'ASR常驻Worker启动超时',
            logger: this.logger
          });
        }
      }, readyTimeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          const readyMatch = line.match(/^\[ASR_WORKER_READY\]\s+(.+)$/);
          if (readyMatch && !ready) {
            try {
              const payload = JSON.parse(readyMatch[1]);
              this.workerPort = Number(payload.port);
              ready = true;
              clearTimeout(readyTimeout);
              this.logger.info(
                `ASR 常驻 worker 已就绪: pid=${child.pid ?? payload.pid}, port=${this.workerPort}`
              );
              resolve();
            } catch (error: any) {
              reject(new Error(`ASR 常驻 worker ready 消息无效: ${error.message}`));
            }
          } else if (line.trim()) {
            this.logger.info(`[ASR常驻Worker] ${line}`);
          }
        }
      });
      child.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.logger.info(`[ASR常驻Worker] ${output}`);
        }
      });
      child.on('error', (error: Error) => {
        clearTimeout(readyTimeout);
        if (!ready) {
          reject(error);
        }
      });
      child.on('close', (code: number | null) => {
        clearTimeout(readyTimeout);
        if (!ready) {
          reject(new Error(`ASR 常驻 worker 提前退出: code=${code}`));
        }
        if (this.workerProcess === child) {
          this.workerProcess = null;
          this.workerPort = null;
          this.workerToken = null;
        }
        this.logger.info(`ASR 常驻 worker 已退出: code=${code}`);
      });
    }).finally(() => {
      this.workerStarting = null;
    });

    return this.workerStarting;
  }

  async stopPersistentWorker(reason: string): Promise<void> {
    const child = this.workerProcess;
    if (!child) {
      return;
    }
    this.workerProcess = null;
    this.workerPort = null;
    this.workerToken = null;
    this.logger.info(`释放 ASR 常驻模型与显存: ${reason}, pid=${child.pid ?? 'unknown'}`);
    await terminateProcessTree(child, {
      gracePeriodMs: 3000,
      label: `ASR常驻Worker(${reason})`,
      logger: this.logger
    });
  }

  private async getGpuUsage(): Promise<{
    gpuUtil: number;
    vramUsed: number;
    vramTotal: number;
  } | null> {
    return new Promise(resolve => {
      const child = spawn(
        'nvidia-smi',
        [
          '--query-gpu=utilization.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits'
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        }
      );
      let stdout = '';
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.on('close', (code: number | null) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const firstLine = stdout.trim().split(/\r?\n/)[0];
        const values = firstLine?.split(',').map(item => Number.parseFloat(item.trim())) || [];
        if (values.length < 3 || values.some(value => Number.isNaN(value))) {
          resolve(null);
          return;
        }
        resolve({
          gpuUtil: values[0],
          vramUsed: values[1],
          vramTotal: values[2]
        });
      });
      child.on('error', () => resolve(null));
    });
  }
}
