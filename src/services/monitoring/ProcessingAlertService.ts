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
}

export class ProcessingAlertService {
  private static logger = getLogger('ProcessingAlertService');
  private static notifier?: WeChatWorkNotifier;
  private static lastSentAt = new Map<string, number>();

  static getThresholds(): ProcessingAlertThresholds {
    const defaults: ProcessingAlertThresholds = {
      cpuHighPercent: 85,
      mergeSlowSeconds: 480,
      screenshotSlowSeconds: 300,
      asrSlowSeconds: 900
    };

    try {
      const config = ConfigProvider.getConfig() as any;
      const configured = config.monitoring?.processingAlerts || {};
      return {
        cpuHighPercent: Number(configured.cpuHighPercent) || defaults.cpuHighPercent,
        mergeSlowSeconds: Number(configured.mergeSlowSeconds) || defaults.mergeSlowSeconds,
        screenshotSlowSeconds: Number(configured.screenshotSlowSeconds) || defaults.screenshotSlowSeconds,
        asrSlowSeconds: Number(configured.asrSlowSeconds) || defaults.asrSlowSeconds
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

  private static async notifyOnce(key: string, title: string, lines: Array<string | undefined>): Promise<void> {
    const now = Date.now();
    const cooldownMs = this.getCooldownMs();
    const lastSent = this.lastSentAt.get(key) || 0;
    if (now - lastSent < cooldownMs) return;

    const notifier = this.getNotifier();
    if (!notifier) return;

    this.lastSentAt.set(key, now);
    const content = [
      `### ${title}`,
      ...lines.filter((line): line is string => Boolean(line)),
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    ].join('\n');

    try {
      await notifier.sendMarkdown(content);
    } catch (error: any) {
      this.logger.warn(`处理性能提醒发送失败: ${error.message}`);
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
