import * as os from 'os';
import * as path from 'path';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { getLogger } from '../../core/logging/LogManager';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';

interface CpuTimes {
  idle: number;
  total: number;
}

export interface ProcessingAlertThresholds {
  cpuHighPercent: number;
  mergeSlowSeconds: number;
  screenshotSlowSeconds: number;
  asrSlowSeconds: number;
  streamStartNoFileOpeningSeconds: number;
  streamEndNoSegmentGraceSeconds: number;
  finalizationWatchdogGraceSeconds: number;
}

export interface MissingFileCloseAlertDetails {
  roomId: string;
  roomName?: string;
  title?: string;
  sessionId?: string;
  fileOpenedAt?: string;
  eventTimestamp?: string;
  reason?: string;
}

export interface MikufansLifecycleAlertDetails {
  roomId: string;
  roomName?: string;
  title?: string;
  sessionId?: string;
  streamStartedAt?: string;
  streamEndedAt?: string;
  eventTimestamp?: string;
  elapsedSeconds?: number;
  segmentCount?: number;
  sessionStatus?: string;
  status?: string;
  recording?: boolean;
  streaming?: boolean;
  observedSessionStarted?: boolean;
  observedFileOpening?: boolean;
  cancelledActions?: string[];
  reason?: string;
}

interface AlertRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

const LIFECYCLE_ALERT_RETRY_OPTIONS: AlertRetryOptions = {
  maxAttempts: 2,
  retryDelayMs: 1000
};

export class ProcessingAlertService {
  private static logger = getLogger('ProcessingAlertService');
  private static notifier?: WeChatWorkNotifier;
  private static sentIncidentsAt = new Map<string, number>();
  private static lastSentAt = new Map<string, number>();
  private static inFlightKeys = new Set<string>();

  static getThresholds(): ProcessingAlertThresholds {
    const defaults: ProcessingAlertThresholds = {
      cpuHighPercent: 85,
      mergeSlowSeconds: 480,
      screenshotSlowSeconds: 300,
      asrSlowSeconds: 900,
      streamStartNoFileOpeningSeconds: 300,
      streamEndNoSegmentGraceSeconds: 60,
      finalizationWatchdogGraceSeconds: 60
    };

    try {
      const config = ConfigProvider.getConfig() as any;
      const configured = config.monitoring?.processingAlerts || {};
      return {
        cpuHighPercent: Number(configured.cpuHighPercent) || defaults.cpuHighPercent,
        mergeSlowSeconds: Number(configured.mergeSlowSeconds) || defaults.mergeSlowSeconds,
        screenshotSlowSeconds: Number(configured.screenshotSlowSeconds) || defaults.screenshotSlowSeconds,
        asrSlowSeconds: Number(configured.asrSlowSeconds) || defaults.asrSlowSeconds,
        streamStartNoFileOpeningSeconds: Number(configured.streamStartNoFileOpeningSeconds) || defaults.streamStartNoFileOpeningSeconds,
        streamEndNoSegmentGraceSeconds: Number(configured.streamEndNoSegmentGraceSeconds) || defaults.streamEndNoSegmentGraceSeconds,
        finalizationWatchdogGraceSeconds: Number(configured.finalizationWatchdogGraceSeconds) || defaults.finalizationWatchdogGraceSeconds
      };
    } catch {
      return defaults;
    }
  }

  static isEnabled(): boolean {
    try {
      const config = ConfigProvider.getConfig() as any;
      const alertConfig = config.monitoring?.processingAlerts;
      return alertConfig?.enabled !== false;
    } catch {
      return true;
    }
  }

  static async sampleCpuLoadPercent(sampleMs = 1000): Promise<number | null> {
    const start = this.readCpuTimes();
    await new Promise(resolve => setTimeout(resolve, sampleMs));
    const end = this.readCpuTimes();
    const idle = end.idle - start.idle;
    const total = end.total - start.total;
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, (1 - idle / total) * 100));
  }

  static async notifyHighCpuAtMergeStart(filePath: string, roomId?: string): Promise<void> {
    if (!this.isEnabled()) return;
    const thresholds = this.getThresholds();
    const cpuPercent = await this.sampleCpuLoadPercent();
    if (cpuPercent === null || cpuPercent < thresholds.cpuHighPercent) return;

    await this.notifyOnce(
      `high-cpu:${roomId || 'unknown'}:${path.basename(filePath)}`,
      `处理性能提醒：开始合并时 CPU 较高`,
      [
        `**阶段**: 合并开始`,
        `**文件**: ${path.basename(filePath)}`,
        roomId ? `**房间**: ${roomId}` : undefined,
        `**CPU**: ${cpuPercent.toFixed(1)}%`,
        `**阈值**: ${thresholds.cpuHighPercent}%`,
        `**影响**: 合并、截图、ASR 都可能明显变慢。`
      ]
    );
  }

  static async notifyIfSlowStage(stage: string, elapsedSeconds: number, thresholdSeconds: number, filePath: string, details: Record<string, any> = {}): Promise<void> {
    if (!this.isEnabled() || elapsedSeconds < thresholdSeconds) return;

    await this.notifyOnce(
      `slow:${stage}:${path.basename(filePath)}`,
      `处理性能提醒：${stage}耗时偏长`,
      [
        `**阶段**: ${stage}`,
        `**文件**: ${path.basename(filePath)}`,
        `**耗时**: ${elapsedSeconds.toFixed(1)} 秒`,
        `**阈值**: ${thresholdSeconds} 秒`,
        ...Object.entries(details).map(([key, value]) => `**${key}**: ${String(value)}`)
      ]
    );
  }

  static async notifyMissingFileCloseAfterStreamEnd(details: MissingFileCloseAlertDetails): Promise<void> {
    if (!this.isEnabled()) return;

    const incidentId = details.eventTimestamp || details.sessionId || details.fileOpenedAt || 'unknown';
    await this.notifyOnce(
      `missing-fileclose:${details.roomId}:${incidentId}`,
      'Mikufans StreamEnded without FileClosed',
      [
        `**Room**: ${details.roomName || 'unknown'} (${details.roomId})`,
        details.title ? `**Title**: ${details.title}` : undefined,
        details.sessionId ? `**SessionId**: ${details.sessionId}` : undefined,
        details.fileOpenedAt ? `**FileOpening**: ${details.fileOpenedAt}` : undefined,
        details.eventTimestamp ? `**StreamEnded**: ${details.eventTimestamp}` : undefined,
        details.reason ? `**Reason**: ${details.reason}` : undefined,
        '**Action**: Check recorder status manually. No file recovery was attempted.'
      ],
      `missing-fileclose:${details.roomId}`,
      LIFECYCLE_ALERT_RETRY_OPTIONS
    );
  }

  static async notifyStreamStartedWithoutFileOrSession(details: MikufansLifecycleAlertDetails): Promise<void> {
    if (!this.isEnabled()) return;

    const incidentId = details.streamStartedAt || details.eventTimestamp || details.sessionId || 'unknown';
    await this.notifyOnce(
      `mikufans-start-no-file-session:${details.roomId}:${incidentId}`,
      'Mikufans 开播后未开始录制',
      [
        this.formatRoom(details),
        details.title ? `**标题**: ${details.title}` : undefined,
        details.sessionId ? `**SessionId**: ${details.sessionId}` : undefined,
        details.streamStartedAt ? `**StreamStarted**: ${details.streamStartedAt}` : undefined,
        typeof details.elapsedSeconds === 'number' ? `**已等待**: ${details.elapsedSeconds.toFixed(0)} 秒` : undefined,
        typeof details.observedSessionStarted === 'boolean' ? `**已见 SessionStarted**: ${details.observedSessionStarted ? '是' : '否'}` : undefined,
        typeof details.observedFileOpening === 'boolean' ? `**已见 FileOpening**: ${details.observedFileOpening ? '是' : '否'}` : undefined,
        details.reason ? `**原因**: ${details.reason}` : undefined,
        '**建议**: 检查 Mikufans 房间状态、录制会话和磁盘写入。'
      ],
      `mikufans-start-no-file-session:${details.roomId}`,
      LIFECYCLE_ALERT_RETRY_OPTIONS
    );
  }

  static async notifyStreamStartedWithoutFileOpening(details: MikufansLifecycleAlertDetails): Promise<void> {
    await this.notifyStreamStartedWithoutFileOrSession(details);
  }

  static async notifyStreamEndedWithoutCurrentSegment(details: MikufansLifecycleAlertDetails): Promise<void> {
    if (!this.isEnabled()) return;

    const incidentId = details.streamEndedAt || details.eventTimestamp || details.sessionId || 'unknown';
    await this.notifyOnce(
      `mikufans-end-no-current-segment:${details.roomId}:${incidentId}`,
      'Mikufans 下播后没有本场有效片段',
      [
        this.formatRoom(details),
        details.title ? `**标题**: ${details.title}` : undefined,
        details.sessionId ? `**SessionId**: ${details.sessionId}` : undefined,
        details.streamStartedAt ? `**StreamStarted**: ${details.streamStartedAt}` : undefined,
        details.streamEndedAt ? `**StreamEnded**: ${details.streamEndedAt}` : undefined,
        typeof details.segmentCount === 'number' ? `**当前片段数**: ${details.segmentCount}` : undefined,
        details.sessionStatus || details.status ? `**会话状态**: ${details.sessionStatus || details.status}` : undefined,
        details.reason ? `**原因**: ${details.reason}` : undefined,
        '**建议**: 检查录播文件是否生成，必要时从备用录播源补档。'
      ],
      `mikufans-end-no-current-segment:${details.roomId}`,
      LIFECYCLE_ALERT_RETRY_OPTIONS
    );
  }

  static async notifyFinalizationStuck(details: MikufansLifecycleAlertDetails): Promise<void> {
    if (!this.isEnabled()) return;

    const incidentId = details.streamEndedAt || details.eventTimestamp || details.sessionId || 'unknown';
    await this.notifyOnce(
      `mikufans-finalization-stuck:${details.roomId}:${incidentId}`,
      'Mikufans 收尾流程疑似悬挂',
      [
        this.formatRoom(details),
        details.title ? `**标题**: ${details.title}` : undefined,
        details.sessionId ? `**SessionId**: ${details.sessionId}` : undefined,
        details.streamStartedAt ? `**StreamStarted**: ${details.streamStartedAt}` : undefined,
        details.streamEndedAt ? `**StreamEnded**: ${details.streamEndedAt}` : undefined,
        typeof details.elapsedSeconds === 'number' ? `**已等待**: ${details.elapsedSeconds.toFixed(0)} 秒` : undefined,
        typeof details.segmentCount === 'number' ? `**当前片段数**: ${details.segmentCount}` : undefined,
        details.sessionStatus || details.status ? `**会话状态**: ${details.sessionStatus || details.status}` : undefined,
        typeof details.recording === 'boolean' ? `**Recording**: ${details.recording}` : undefined,
        typeof details.streaming === 'boolean' ? `**Streaming**: ${details.streaming}` : undefined,
        details.cancelledActions?.length ? `**被取消动作**: ${details.cancelledActions.join(', ')}` : undefined,
        details.reason ? `**原因**: ${details.reason}` : undefined,
        '**建议**: 检查该房间是否仍有收尾定时器；确认离线后重新触发处理流程。'
      ],
      `mikufans-finalization-stuck:${details.roomId}`,
      LIFECYCLE_ALERT_RETRY_OPTIONS
    );
  }

  private static readCpuTimes(): CpuTimes {
    return os.cpus().reduce<CpuTimes>((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      acc.idle += cpu.times.idle;
      acc.total += total;
      return acc;
    }, { idle: 0, total: 0 });
  }

  private static getNotifier(): WeChatWorkNotifier | null {
    if (this.notifier) return this.notifier;
    try {
      const config = ConfigProvider.getConfig();
      const webhookUrl = config.wechatWork?.webhookUrl;
      if (!webhookUrl) return null;
      this.notifier = new WeChatWorkNotifier(webhookUrl);
      return this.notifier;
    } catch (error: any) {
      this.logger.warn(`处理性能提醒未发送，读取企微配置失败: ${error.message}`);
      return null;
    }
  }

  private static formatRoom(details: MikufansLifecycleAlertDetails): string {
    return `**房间**: ${details.roomName || 'unknown'} (${details.roomId})`;
  }

  private static async notifyOnce(
    incidentKey: string,
    title: string,
    lines: Array<string | undefined>,
    cooldownKey = incidentKey,
    retryOptions: AlertRetryOptions = {}
  ): Promise<void> {
    const now = Date.now();
    const cooldownMs = this.getCooldownMs();
    this.cleanupAlertState(now, cooldownMs);

    if (this.sentIncidentsAt.has(incidentKey)) return;

    const lastSent = this.lastSentAt.get(cooldownKey) || 0;
    if (now - lastSent < cooldownMs) return;

    const incidentFlightKey = `incident:${incidentKey}`;
    const cooldownFlightKey = `cooldown:${cooldownKey}`;
    if (this.inFlightKeys.has(incidentFlightKey) || this.inFlightKeys.has(cooldownFlightKey)) return;

    const notifier = this.getNotifier();
    if (!notifier) return;

    const content = [
      `### ${title}`,
      ...lines.filter((line): line is string => Boolean(line)),
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    ].join('\n');

    this.inFlightKeys.add(incidentFlightKey);
    this.inFlightKeys.add(cooldownFlightKey);
    try {
      const maxAttempts = Math.max(1, Math.floor(Number(retryOptions.maxAttempts) || 1));
      const retryDelayMs = Math.max(0, Number(retryOptions.retryDelayMs) || 0);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const sent = await notifier.sendMarkdown(content);
          if (sent) {
            const sentAt = Date.now();
            this.sentIncidentsAt.set(incidentKey, sentAt);
            this.lastSentAt.set(cooldownKey, sentAt);
            this.logger.info('处理性能提醒已发送', { title, incidentKey });
            return;
          }
          this.logger.warn(`处理性能提醒发送失败: ${title} (${attempt}/${maxAttempts})`);
        } catch (error: any) {
          this.logger.warn(`处理性能提醒发送失败: ${error?.message || String(error)} (${attempt}/${maxAttempts})`);
        }

        if (attempt < maxAttempts && retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
    } finally {
      this.inFlightKeys.delete(incidentFlightKey);
      this.inFlightKeys.delete(cooldownFlightKey);
    }
  }

  private static cleanupAlertState(now: number, cooldownMs: number): void {
    const incidentRetentionMs = Math.max(24 * 60 * 60 * 1000, cooldownMs * 2);
    for (const [key, sentAt] of this.sentIncidentsAt.entries()) {
      if (now - sentAt > incidentRetentionMs) this.sentIncidentsAt.delete(key);
    }
    for (const [key, sentAt] of this.lastSentAt.entries()) {
      if (now - sentAt > incidentRetentionMs) this.lastSentAt.delete(key);
    }
  }

  private static getCooldownMs(): number {
    try {
      const config = ConfigProvider.getConfig() as any;
      return Number(config.monitoring?.processingAlerts?.cooldownMs) || 30 * 60 * 1000;
    } catch {
      return 30 * 60 * 1000;
    }
  }
}
