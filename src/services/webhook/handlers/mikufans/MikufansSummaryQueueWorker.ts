import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { ConfigProvider } from '../../../../core/config/ConfigProvider';
import { getLogger } from '../../../../core/logging/LogManager';
import { ProcessingAlertService } from '../../../monitoring/ProcessingAlertService';
import type { LiveSession } from '../../LiveSessionManager';
import { listRelevantProcesses, terminateProcessTree } from '../../../../utils/processCleanup';
import { applyFfmpegProcessPriority, getFfmpegResourceConfig } from '../../../../utils/ffmpegResource';
import { MikufansAsrResourceController } from './MikufansAsrResourceController';

const ASR_PHASE_DONE_SENTINEL = '[[ASR_PHASE_DONE]]';
const LEGACY_WHISPER_PHASE_DONE_SENTINEL = '[[WHISPER_PHASE_DONE]]';

export interface QueuedSummaryTask {
  id: string;
  mediaPath: string;
  roomId?: string | number | null;
  priority?: number;
  addedTime?: number;
  status: string;
  xmlPath?: string | null;
  screenshotPath?: string | null;
  enableSpeakerRecognition?: boolean;
  speakerRecognitionRequest?: Record<string, unknown> | null;
}

export interface MikufansSummaryQueueManager {
  recoverInterruptedTasks: () => number;
  loadQueue: (options?: { silent?: boolean; cleanupStale?: boolean }) => void;
  hasActiveProcessing: () => boolean;
  getNextPendingTask: (options?: { reload?: boolean }) => QueuedSummaryTask | null;
  addTask: (mediaPath: string, roomId?: string | number | null, options?: Record<string, unknown>) => QueuedSummaryTask;
  setTaskSpeakerRecognition: (taskId: string, request: Record<string, unknown>) => void;
  markFailed: (taskId: string, error: string) => void;
  getTaskById: (taskId: string, options?: { reload?: boolean }) => QueuedSummaryTask | null;
  markCompleted: (taskId: string, options?: Record<string, unknown>) => void;
  requeueAfterWorkerFailure: (taskId: string, error: string) => boolean;
}

export interface MikufansSpeakerOnceRegistry {
  consume: (
    roomId: string,
    context: { taskId: string; mediaPath: string; addedTime?: number }
  ) => Record<string, unknown> | null;
}

function loadQueueManager(): MikufansSummaryQueueManager {
  return require(path.join(process.cwd(), 'src', 'scripts', 'whisper_queue_manager.js')) as MikufansSummaryQueueManager;
}

function loadSpeakerOnceRegistry(): MikufansSpeakerOnceRegistry {
  return require(path.join(process.cwd(), 'src', 'scripts', 'asr', 'speaker_once_registry.js')) as MikufansSpeakerOnceRegistry;
}

export interface MikufansSummaryQueueWorkerCallbacks {
  handleDelayedReplyReadyOutput: (output: string, fallbackMediaPath: string) => Promise<void>;
  checkAndTriggerDelayedReply: (videoPath: string, roomId: string) => Promise<void>;
  findSessionByVideoPath: (videoPath: string) => LiveSession | undefined;
  markSessionCompleted: (roomId: string) => void;
}

function encodeSpeakerRequestEnv(request: Record<string, unknown> | null | undefined): string {
  if (!request || typeof request !== 'object') {
    return '';
  }
  try {
    return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  } catch {
    return '';
  }
}

/** Owns the central summary queue and its Python/Node processing boundary. */
export class MikufansSummaryQueueWorker {
  private readonly logger = getLogger('MikufansSummaryQueueWorker');
  private readonly asrResources: MikufansAsrResourceController;
  private readonly queueManager: MikufansSummaryQueueManager;
  private readonly speakerOnceRegistry: MikufansSpeakerOnceRegistry;
  private queueWorkerPromise: Promise<void> | null = null;
  private queueWorkerProcess: ChildProcess | null = null;
  private queueWorkerShouldStop = false;
  private asrGamePaused = false;

  constructor(
    private readonly callbacks: MikufansSummaryQueueWorkerCallbacks,
    asrResources = new MikufansAsrResourceController(),
    queueManagerDependency?: MikufansSummaryQueueManager,
    speakerOnceRegistryDependency?: MikufansSpeakerOnceRegistry
  ) {
    this.asrResources = asrResources;
    this.queueManager = queueManagerDependency || loadQueueManager();
    this.speakerOnceRegistry = speakerOnceRegistryDependency || loadSpeakerOnceRegistry();
  }

  /** Exposes the admission policy without making the parent handler own it. */
  isAdaptiveGpuProtectionEnabled(config: any): boolean {
    return this.asrResources.isAdaptiveGpuProtectionEnabled(config);
  }

  ensureRunning(): void {
    if (this.queueWorkerPromise) {
      return;
    }

    this.queueWorkerShouldStop = false;
    this.queueWorkerPromise = this.runLoop()
      .catch((error: any) => {
        this.logger.error(`Mikufans队列Worker异常退出: ${error.message}`, { error });
      })
      .finally(async () => {
        const shouldRestart = !this.queueWorkerShouldStop;
        try {
          await this.asrResources.stopPersistentWorker('队列 worker 退出');
        } catch (error: any) {
          this.logger.warn(`清理 ASR 常驻 worker 失败: ${error?.message || String(error)}`);
        }
        this.queueWorkerPromise = null;
        this.queueWorkerProcess = null;
        this.asrGamePaused = false;
        if (!shouldRestart || this.queueWorkerShouldStop) {
          return;
        }
        try {
          const pendingTask = this.queueManager.getNextPendingTask({ reload: true });
          if (pendingTask) {
            this.logger.info('队列 worker 清理期间收到新任务，立即重新唤醒');
            this.ensureRunning();
          }
        } catch (error: any) {
          this.logger.warn(`检查待处理队列失败: ${error?.message || String(error)}`);
        }
      });
  }

  /** Request a graceful stop; the current child is allowed to finish its ASR phase. */
  requestStop(): void {
    this.queueWorkerShouldStop = true;
  }

  isRunning(): boolean {
    return this.queueWorkerPromise !== null;
  }

  /**
   * Add a media artifact to the durable summary queue.
   *
   * Keeping this operation beside the worker means the webhook handler does
   * not need to know which legacy JS module currently persists queue state.
   */
  enqueueTask(
    mediaPath: string,
    roomId?: string | number | null,
    options?: Record<string, unknown>
  ): QueuedSummaryTask {
    return this.queueManager.addTask(mediaPath, roomId, options);
  }

  private async runLoop(): Promise<void> {
    this.logger.info('Mikufans队列Worker已启动');
    const config: any = ConfigProvider.getConfig();
    const idleWaitMs = config.whisper?.gpuDetection?.checkIntervalSeconds
      ? config.whisper.gpuDetection.checkIntervalSeconds * 1000
      : 30000;

    const recoveredCount = this.queueManager.recoverInterruptedTasks();
    if (recoveredCount > 0) {
      this.logger.info(`Mikufans队列Worker已恢复 ${recoveredCount} 个中断任务`);
    }

    while (!this.queueWorkerShouldStop) {
      this.queueManager.loadQueue({ silent: true, cleanupStale: false });

      if (!this.queueWorkerProcess && this.queueManager.hasActiveProcessing()) {
        this.logger.info('检测到已有Whisper任务在处理，队列Worker等待当前任务结束');
        await this.sleep(idleWaitMs);
        continue;
      }

      const nextTask = this.queueManager.getNextPendingTask({ reload: true });
      if (!nextTask) {
        await this.asrResources.stopPersistentWorker('ASR 队列已清空');
        this.logger.info('Mikufans队列Worker空闲，退出等待下次唤醒');
        return;
      }

      const gameStatus = await this.asrResources.isGameRunning();
      if (gameStatus.busy) {
        await this.asrResources.stopPersistentWorker(`游戏运行: ${gameStatus.reason}`);
        if (!this.asrGamePaused) {
          this.logger.info(`检测到游戏运行，ASR 队列暂停: ${gameStatus.reason}`);
          this.asrGamePaused = true;
        }
        await this.sleep(Math.min(idleWaitMs, gameStatus.waitMs));
        continue;
      }
      if (this.asrGamePaused) {
        this.logger.info('游戏已退出，ASR 队列恢复');
        this.asrGamePaused = false;
      }

      // Paraformer owns the adaptive GPU policy in Python. The legacy total
      // GPU gate would stop the persistent worker before it can shrink its
      // batch and yield, so keep it only for non-adaptive backends.
      if (!this.asrResources.isAdaptiveGpuProtectionEnabled(config)) {
        const gpuStatus = await this.asrResources.isLegacyGpuBusy();
        if (gpuStatus.busy) {
          await this.asrResources.stopPersistentWorker(`GPU 繁忙: ${gpuStatus.reason}`);
          this.logger.info(`GPU 当前繁忙，队列Worker继续等待: ${gpuStatus.reason}`);
          await this.sleep(idleWaitMs);
          continue;
        }
      }

      await this.asrResources.ensurePersistentWorker();
      await this.executeTask(nextTask);
    }
  }

  private async executeTask(task: QueuedSummaryTask): Promise<void> {
    if (!task?.mediaPath) {
      return;
    }

    if (!fs.existsSync(task.mediaPath) || !fs.statSync(task.mediaPath).isFile()) {
      this.logger.warn(`队列任务媒体文件不存在，标记失败: ${task.mediaPath}`);
      this.queueManager.markFailed(task.id, `媒体文件不存在: ${task.mediaPath}`);
      return;
    }

    const scriptPath = 'src/scripts/enhanced_auto_summary.js';
    const args = [scriptPath, task.mediaPath];
    let resolvedXmlPath = task.xmlPath;
    if (!resolvedXmlPath) {
      const inferredXmlPath = path.join(
        path.dirname(task.mediaPath),
        `${path.basename(task.mediaPath, path.extname(task.mediaPath))}.xml`
      );
      if (fs.existsSync(inferredXmlPath) && fs.statSync(inferredXmlPath).isFile()) {
        resolvedXmlPath = inferredXmlPath;
        this.queueManager.addTask(task.mediaPath, task.roomId, {
          xmlPath: inferredXmlPath,
          screenshotPath: task.screenshotPath || undefined,
          trackOwnershipWhilePending: false
        });
        this.logger.info(`队列Worker自动补全XML路径: ${path.basename(task.mediaPath)} -> ${path.basename(inferredXmlPath)}`);
      }
    }

    if (resolvedXmlPath && fs.existsSync(resolvedXmlPath) && fs.statSync(resolvedXmlPath).isFile()) {
      args.push(resolvedXmlPath);
    } else {
      this.logger.warn(`队列Worker未找到XML，将仅基于ASR处理: ${path.basename(task.mediaPath)}`);
    }

    const roomId = task.roomId ? String(task.roomId) : 'unknown';
    if (!task.enableSpeakerRecognition && roomId !== 'unknown') {
      const oneShotRequest = this.speakerOnceRegistry.consume(roomId, {
        taskId: task.id,
        mediaPath: task.mediaPath,
        addedTime: task.addedTime
      });
      if (oneShotRequest) {
        this.queueManager.setTaskSpeakerRecognition(task.id, oneShotRequest);
        task.enableSpeakerRecognition = true;
        task.speakerRecognitionRequest = oneShotRequest;
        this.logger.info(
          `本场启用一次性说话人识别: roomId=${roomId}, taskId=${task.id}, requestId=${oneShotRequest.id}`
        );
      }
    }

    const encodedSpeakerRequest = encodeSpeakerRequestEnv(task.speakerRecognitionRequest || null);
    const resourceConfig = getFfmpegResourceConfig();
    const asrWorkerConnection = this.asrResources.getConnection();
    this.logger.info(`Mikufans队列Worker开始执行: ${path.basename(task.mediaPath)} (taskId=${task.id})`);

    const ps: ChildProcess = spawn('node', args, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ROOM_ID: roomId,
        AUTOMATION: 'true',
        BYPASS_WHISPER_QUEUE: 'true',
        SCREENSHOT_PATH: task.screenshotPath || '',
        FFMPEG_THREADS: String(resourceConfig.threads),
        FFMPEG_PRIORITY: resourceConfig.priority,
        ASR_PERSISTENT_WORKER_PORT: asrWorkerConnection.port
          ? String(asrWorkerConnection.port)
          : '',
        ASR_PERSISTENT_WORKER_TOKEN: asrWorkerConnection.token || '',
        ASR_ENABLE_SPEAKER_ONCE: task.enableSpeakerRecognition ? 'true' : '',
        ASR_SPEAKER_REQUEST_JSON: encodedSpeakerRequest
      }
    });
    applyFfmpegProcessPriority(ps.pid, resourceConfig.priority);

    this.queueWorkerProcess = ps;
    this.logger.info(`Mikufans队列Worker子进程已启动: pid=${ps.pid ?? 'unknown'}, file=${path.basename(task.mediaPath)}`);

    const config = ConfigProvider.getConfig();
    const processTimeout = config.webhook.timeouts.processTimeout || 30 * 60 * 1000;
    let timedOut = false;
    let asrStartedAt: number | null = null;
    let asrTimingSummary: Record<string, any> | null = null;
    let stdoutLineBuffer = '';

    const timeoutId = setTimeout(() => {
      void (async () => {
        timedOut = true;
        this.logger.warn(`队列Worker任务超时，强制终止: ${path.basename(task.mediaPath)}`);
        try {
          await terminateProcessTree(ps, {
            gracePeriodMs: 5000,
            label: `Mikufans队列Worker(${path.basename(task.mediaPath)})`,
            logger: this.logger
          });
          const processes = await listRelevantProcesses();
          if (processes.length > 0) {
            this.logger.warn(`队列Worker超时清理后的相关进程快照: ${processes.join(' | ')}`);
          }
        } catch (error: any) {
          this.logger.error(`队列Worker超时清理失败: ${error?.message || String(error)}`);
        }
        try {
          this.queueManager.markFailed(task.id, `队列Worker超时终止: ${path.basename(task.mediaPath)}`);
        } catch (error: any) {
          this.logger.error(`记录队列Worker超时失败状态时出错: ${error?.message || String(error)}`);
        }
      })().catch((error: any) => {
        this.logger.error(`队列Worker超时处理异常: ${error?.message || String(error)}`);
      });
    }, processTimeout);

    await new Promise<void>((resolve) => {
      let workerSlotReleased = false;
      const releaseWorkerSlot = (reason: string) => {
        if (workerSlotReleased) {
          return;
        }

        workerSlotReleased = true;
        if (this.queueWorkerProcess === ps) {
          this.queueWorkerProcess = null;
        }
        this.logger.info(`Mikufans队列Worker释放ASR槽位 (${reason}): ${path.basename(task.mediaPath)}`);
        resolve();
      };

      const handleWorkerOutput = (output: string) => {
        const line = output.trim();
        if (!line) {
          return;
        }
        this.logger.info(`[Mikufans队列Worker] ${line}`);
        if (!asrStartedAt && line.includes('-> [ASR]')) {
          asrStartedAt = Date.now();
        }
        const timingMatch = line.match(/\[\[ASR_TIMING\]\]\s+({[^\r\n]+})/);
        if (timingMatch) {
          try {
            asrTimingSummary = JSON.parse(timingMatch[1]);
          } catch (error: any) {
            this.logger.warn(`解析 ASR 阶段耗时失败: ${error.message}`);
          }
        }
        void this.callbacks.handleDelayedReplyReadyOutput(line, task.mediaPath).catch(error => {
          this.logger.warn('处理延迟回复 ready 输出失败', {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        if (line.includes(ASR_PHASE_DONE_SENTINEL) || line.includes(LEGACY_WHISPER_PHASE_DONE_SENTINEL)) {
          if (asrStartedAt) {
            const asrElapsedSeconds = (Date.now() - asrStartedAt) / 1000;
            const speakerProcessing = asrTimingSummary?.speakerProcessing;
            void ProcessingAlertService.notifyIfSlowStage(
              'ASR',
              asrElapsedSeconds,
              ProcessingAlertService.getThresholds().asrSlowSeconds,
              task.mediaPath,
              {
                taskId: task.id,
                roomId,
                ...(asrTimingSummary ? {
                  模型缓存: asrTimingSummary.cacheHit ? '命中' : '未命中',
                  模型加载秒: asrTimingSummary.modelLoadSeconds,
                  真正转写秒: asrTimingSummary.transcriptionSeconds,
                  真正转写速度: asrTimingSummary.trueAsrSpeed
                    ? `${asrTimingSummary.trueAsrSpeed}x`
                    : 'N/A',
                  VAD秒: asrTimingSummary.vadSeconds,
                  说话人状态: speakerProcessing?.status || '未知',
                  说话人探测秒: (
                    Number(asrTimingSummary.speakerProbeEmbeddingSeconds || 0) +
                    Number(asrTimingSummary.speakerProbeClusteringSeconds || 0)
                  ).toFixed(1),
                  说话人全量秒: Number(asrTimingSummary.speakerFullEmbeddingSeconds || 0).toFixed(1),
                  说话人聚类秒: Number(asrTimingSummary.speakerFullClusteringSeconds || 0).toFixed(1),
                  说话人匹配秒: asrTimingSummary.speakerMatchingSeconds,
                  说话人总计秒: asrTimingSummary.speakerTotalSeconds
                } : {})
              }
            ).catch(error => {
              this.logger.warn('发送 ASR 慢阶段告警失败', {
                taskId: task.id,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
          this.logger.info(`Mikufans队列Worker已完成ASR阶段，释放队列槽位，AI/漫画阶段继续后台执行: ${path.basename(task.mediaPath)}`);
          releaseWorkerSlot('asr-phase-done');
        }
      };

      ps.stdout?.on('data', (data: Buffer) => {
        stdoutLineBuffer += data.toString();
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() || '';
        for (const line of lines) {
          handleWorkerOutput(line);
        }
      });

      ps.stdout?.on('end', () => {
        if (stdoutLineBuffer) {
          handleWorkerOutput(stdoutLineBuffer);
          stdoutLineBuffer = '';
        }
      });

      ps.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.logger.info(`[Mikufans队列Worker stderr] ${output}`);
        }
      });

      ps.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        this.queueWorkerProcess = null;
        this.logger.error(`Mikufans队列Worker子进程错误: ${error.message}`);
        try {
          this.queueManager.markFailed(task.id, `队列Worker启动失败: ${error.message}`);
        } catch (markFailedError: any) {
          this.logger.error(`记录队列Worker启动失败状态时出错: ${markFailedError?.message || String(markFailedError)}`);
        }
        releaseWorkerSlot('spawn-error');
      });

      ps.on('close', async (code: number | null) => {
        try {
          clearTimeout(timeoutId);
          if (this.queueWorkerProcess === ps) {
            this.queueWorkerProcess = null;
          }
          this.logger.info(`Mikufans队列Worker任务结束 (退出码: ${code}, 超时: ${timedOut}): ${path.basename(task.mediaPath)}`);

          if (task.mediaPath.includes('_merged')) {
            const session = this.callbacks.findSessionByVideoPath(task.mediaPath);
            if (session) {
              this.callbacks.markSessionCompleted(session.roomId);
              this.logger.info(`✅ 会话处理完成: ${session.roomId}`);
            }
          }

          if (code === 0) {
            const taskId = task.id;
            if (taskId && this.queueManager.getTaskById(taskId, { reload: true })?.status !== 'completed') {
              this.queueManager.markCompleted(taskId, { exitCode: code, reason: 'success' });
            }
          } else if (!timedOut) {
            const reason = `队列Worker异常退出: exitCode=${code ?? 'null'}, file=${path.basename(task.mediaPath)}`;
            const requeued = this.queueManager.requeueAfterWorkerFailure(task.id, reason);
            this.logger[requeued ? 'warn' : 'error'](
              requeued ? `${reason}，已重新入队` : `${reason}，重试已耗尽`
            );
          }

          try {
            await this.callbacks.checkAndTriggerDelayedReply(task.mediaPath, roomId);
          } catch (error) {
            this.logger.warn('处理延迟回复触发失败', {
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        } catch (error) {
          this.logger.error('处理队列Worker退出结果失败', {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          releaseWorkerSlot('process-close');
        }
      });
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
