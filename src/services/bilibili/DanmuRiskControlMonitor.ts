import { spawn } from 'child_process';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';

interface DanmuCheckResult {
  roomId: string;
  code: number;
  message: string;
  isRiskControl: boolean;
  timestamp: Date;
}

interface PythonResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export class DanmuRiskControlMonitor {
  private logger = getLogger('DanmuRiskControlMonitor');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNotifyTime: Map<string, number> = new Map();
  private notifier: WeChatWorkNotifier | null = null;
  private isChecking = false;

  constructor(notifier?: WeChatWorkNotifier) {
    this.notifier = notifier || null;
  }

  async start(): Promise<void> {
    const config = ConfigProvider.getConfig();
    const rkcConfig = config.bilibili?.danmuRiskControl;

    if (!rkcConfig || !rkcConfig.enabled) {
      this.logger.info('弹幕风控监控未启用，跳过启动');
      return;
    }

    if (!rkcConfig.roomIds || rkcConfig.roomIds.length === 0) {
      this.logger.warn('弹幕风控监控: 未配置监控房间ID列表');
      return;
    }

    if (!this.notifier) {
      const webhookUrl = config.wechatWork?.webhookUrl;
      if (webhookUrl) {
        this.notifier = new WeChatWorkNotifier(webhookUrl);
      } else {
        this.logger.warn('弹幕风控监控: 未配置企业微信webhook，无法发送通知');
      }
    }

    const intervalMs = rkcConfig.intervalMs || 300000;
    this.logger.info(`弹幕风控监控启动，检查间隔: ${intervalMs}ms，监控房间: ${rkcConfig.roomIds.join(', ')}`);

    // 启动后立即执行一次检查，避免等待第一个轮询周期
    await this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('弹幕风控监控已停止');
    }
  }

  private async check(): Promise<void> {
    if (this.isChecking) {
      this.logger.debug('弹幕风控检查正在进行中，跳过本次检查');
      return;
    }

    this.isChecking = true;
    const config = ConfigProvider.getConfig();
    const rkcConfig = config.bilibili?.danmuRiskControl;
    if (!rkcConfig) {
      this.isChecking = false;
      return;
    }

    const cooldownMs = rkcConfig.notifyCooldownMs || 1800000;

    for (const roomId of rkcConfig.roomIds) {
      try {
        const result = await this.checkRoom(roomId);
        if (result.isRiskControl) {
          this.logger.warn(`房间 ${roomId} 弹幕API触发风控 (code: ${result.code})`);

          const now = Date.now();
          const lastTime = this.lastNotifyTime.get(roomId) || 0;
          if (now - lastTime > cooldownMs) {
            await this.notify(result);
            this.lastNotifyTime.set(roomId, now);
          } else {
            this.logger.info(`房间 ${roomId} 风控通知冷却中，跳过通知（上次通知: ${new Date(lastTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
          }
        } else {
          this.logger.debug(`房间 ${roomId} 弹幕API正常 (code: ${result.code})`);
        }
      } catch (error) {
        this.logger.error(`检查房间 ${roomId} 弹幕风控失败`, undefined, error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.isChecking = false;
  }

  private async checkRoom(roomId: string): Promise<DanmuCheckResult> {
    const config = ConfigProvider.getConfig();
    const cookie = (config.bilibili as any)?.cookie;
    if (!cookie) {
      throw new Error('未配置B站Cookie');
    }

    const pythonScript = path.join(process.cwd(), 'src', 'scripts', 'bilibili_danmu_info.py');
    const pythonResult = await this.runPythonScript(pythonScript, roomId, cookie);

    if (pythonResult.success) {
      return {
        roomId,
        code: 0,
        message: 'OK',
        isRiskControl: false,
        timestamp: new Date()
      };
    }

    const errorMessage = pythonResult.error || '未知错误';
    const isRiskControl = this.isRiskControlError(errorMessage);

    return {
      roomId,
      code: isRiskControl ? -352 : -1,
      message: errorMessage,
      isRiskControl,
      timestamp: new Date()
    };
  }

  private async runPythonScript(scriptPath: string, roomId: string, cookie: string): Promise<PythonResult> {
    const sessdata = this.extractCookieValue(cookie, 'SESSDATA');
    const biliJct = this.extractCookieValue(cookie, 'bili_jct');
    const dedeUserId = this.extractCookieValue(cookie, 'DedeUserID');

    if (!sessdata || !biliJct || !dedeUserId) {
      throw new Error('Cookie中缺少必要的参数 (SESSDATA, bili_jct, DedeUserID)');
    }

    const args = [scriptPath, roomId, sessdata, biliJct, dedeUserId];

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const pythonProcess = spawn('python', args, {
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (stderr) {
          const logLines = stderr.trim().split('\n');
          for (const line of logLines) {
            if (line.includes('[ERROR]')) {
              this.logger.error(`Python: ${line}`);
            } else if (line.includes('[WARNING]')) {
              this.logger.warn(`Python: ${line}`);
            } else if (line.includes('[OK]') || line.includes('[INFO]')) {
              this.logger.info(`Python: ${line}`);
            } else if (line.trim()) {
              this.logger.debug(`Python: ${line}`);
            }
          }
        }

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        if (stdout.trim()) {
          this.logger.error(`Python stdout: ${stdout.trim()}`);
        }
        reject(new Error(`Python脚本退出码: ${code}`));
      });

      pythonProcess.on('error', (err) => {
        reject(err);
      });
    });

    const jsonResult = JSON.parse(result.stdout) as PythonResult;
    return jsonResult;
  }

  private isRiskControlError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('-352') ||
      normalized.includes('风控') ||
      normalized.includes('captcha') ||
      normalized.includes('risk control') ||
      normalized.includes('too many requests') ||
      normalized.includes('request blocked') ||
      normalized.includes('访问频繁')
    );
  }

  private extractCookieValue(cookie: string, name: string): string | null {
    const match = cookie.match(new RegExp(`${name}=([^;]+)`));
    return match ? match[1] : null;
  }

  private async notify(result: DanmuCheckResult): Promise<void> {
    if (!this.notifier) {
      this.logger.warn('无法发送风控通知: 企业微信通知服务未初始化');
      return;
    }

    const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const content = `⚠️ B站弹幕API风控告警\n\n` +
      `房间ID: ${result.roomId}\n` +
      `返回码: ${result.code}\n` +
      `消息: ${result.message}\n` +
      `检测时间: ${timeStr}\n\n` +
      `录播软件可能无法获取弹幕信息，请检查账号状态`;

    const success = await this.notifier.sendMarkdown(content);
    if (success) {
      this.logger.info(`风控通知已发送: 房间 ${result.roomId}`);
    } else {
      this.logger.error(`风控通知发送失败: 房间 ${result.roomId}`);
    }
  }
}
