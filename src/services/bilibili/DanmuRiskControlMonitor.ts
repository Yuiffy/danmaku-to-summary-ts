import fetch from 'node-fetch';
import * as crypto from 'crypto';
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

export class DanmuRiskControlMonitor {
  private logger = getLogger('DanmuRiskControlMonitor');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNotifyTime: Map<string, number> = new Map();
  private notifier: WeChatWorkNotifier | null = null;
  private isChecking = false;

  constructor(notifier?: WeChatWorkNotifier) {
    this.notifier = notifier || null;
  }

  start(): void {
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

    this.check();
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

    const wts = Math.floor(Date.now() / 1000);
    const w_rid = crypto.createHash('md5').update(`${wts}`).digest('hex');

    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0&web_location=444.8&w_rid=${w_rid}&wts=${wts}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': cookie,
        'Origin': 'https://live.bilibili.com',
        'Referer': `https://live.bilibili.com/${roomId}?live_from=85001`,
        'Sec-Ch-Ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return {
        roomId,
        code: response.status,
        message: `HTTP ${response.status}`,
        isRiskControl: false,
        timestamp: new Date()
      };
    }

    const data = await response.json() as { code: number; message: string; ttl?: number; data?: any };
    const isRiskControl = data.code === -352;

    return {
      roomId,
      code: data.code,
      message: data.message || '',
      isRiskControl,
      timestamp: new Date()
    };
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
