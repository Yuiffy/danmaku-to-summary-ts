import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { RecorderLogEvent, RecorderLogSnapshot, recorderLogSource } from '../monitoring/RecorderLogSource';

interface Incident {
  kind: 'api' | 'connection';
  target: string;
  identity: string;
  startedAt: number;
  latestAt: number;
  lastQueuedAt?: number;
}
interface Notice { id: string; content: string; }
interface MonitorState {
  version: 1;
  cursorAt: number;
  cursorIds: string[];
  incidents: Record<string, Incident>;
  outbox: Notice[];
}
interface LogReader { read(): Promise<RecorderLogSnapshot>; }

/** Observe actual recorder activity; never make independent Bilibili requests. */
export class DanmuRiskControlMonitor {
  private logger = getLogger('DanmuRiskControlMonitor');
  private timer: ReturnType<typeof setInterval> | null = null;
  private notifier: WeChatWorkNotifier | null;
  private checking = false;
  private stopped = true;
  private state?: MonitorState;
  private statePath = '';
  private lastSourceError = '';

  constructor(notifier?: WeChatWorkNotifier, private readonly source: LogReader = recorderLogSource) {
    this.notifier = notifier || null;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const config = ConfigProvider.getConfig();
    const options = config.bilibili?.danmuRiskControl;
    if (!options?.enabled || !options.roomIds?.length) return;
    if (!this.notifier && config.wechatWork?.webhookUrl) this.notifier = new WeChatWorkNotifier(config.wechatWork.webhookUrl);
    this.statePath = path.resolve(options.monitorStatePath || 'data/runtime/recorder_log_monitor.json');
    this.stopped = false;
    const interval = Math.max(60000, options.intervalMs || 1800000);
    this.logger.info(`录播姬日志监控启动，读取间隔: ${interval}ms；不主动请求B站接口`);
    await this.check();
    if (!this.stopped) this.timer = setInterval(() => void this.check(), interval);
    this.timer?.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<void> {
    if (this.state) return;
    try {
      const state = JSON.parse((await fs.readFile(this.statePath, 'utf8')).replace(/^\uFEFF/, ''));
      if (state.version !== 1 || !Number.isFinite(state.cursorAt) || !Array.isArray(state.cursorIds) ||
          !state.incidents || !Array.isArray(state.outbox)) throw new Error('invalid state');
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('日志监控状态文件不可用，暂停通知以避免重复告警');
      // Do not replay historical -352/recovery pairs on first installation.
      this.state = { version: 1, cursorAt: Date.now(), cursorIds: [], incidents: {}, outbox: [] };
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, this.statePath);
  }

  private async check(): Promise<void> {
    if (this.checking || this.stopped) return;
    this.checking = true;
    try {
      await this.load();
      const snapshot = await this.source.read();
      if (this.stopped) return;
      this.lastSourceError = '';
      const options = ConfigProvider.getConfig().bilibili?.danmuRiskControl;
      if (!options?.enabled) return;
      const rooms = new Set(options.roomIds.map(String));
      const cooldown = options.notifyCooldownMs || 1800000;
      for (const event of snapshot.events) {
        if (event.at < this.state!.cursorAt || (event.at === this.state!.cursorAt && this.state!.cursorIds.includes(event.id))) continue;
        this.apply(event, snapshot.identity, rooms, cooldown);
        if (event.at > this.state!.cursorAt) { this.state!.cursorAt = event.at; this.state!.cursorIds = []; }
        this.state!.cursorIds.push(event.id);
      }
      for (const incident of Object.values(this.state!.incidents)) {
        if (incident.kind === 'connection' && incident.identity === snapshot.identity && rooms.has(incident.target) &&
            incident.lastQueuedAt === undefined && Date.now() - incident.startedAt >= 60000) {
          this.queueStart(incident, incident.latestAt);
        }
      }
      await this.save();
      await this.flush();
    } catch (error) {
      // Missing logs, dead/stale PIDs and parsing failures never mean recovery.
      const message = error instanceof Error && /^(无法|录播|没有|日志监控)/.test(error.message)
        ? error.message : '读取录播日志或保存监控状态失败，状态未知';
      if (message !== this.lastSourceError) this.logger.warn(message);
      this.lastSourceError = message;
    } finally { this.checking = false; }
  }

  private apply(event: RecorderLogEvent, identity: string, rooms: Set<string>, cooldown: number): void {
    if (event.kind === 'risk' && event.endpoint) {
      const key = `api:${event.endpoint}`;
      let incident = this.state!.incidents[key];
      if (!incident) incident = this.state!.incidents[key] = {
        kind: 'api', target: event.endpoint, identity, startedAt: event.at, latestAt: event.at
      };
      incident.latestAt = event.at;
      if (incident.lastQueuedAt === undefined || event.at - incident.lastQueuedAt >= cooldown) this.queueStart(incident, event.at);
    } else if ((event.kind === 'api-recovered' || event.kind === 'api-success') && event.endpoint) {
      const key = `api:${event.endpoint}`;
      const incident = this.state!.incidents[key];
      // A cached token in the same process does not prove API recovery. A
      // restarted recorder's first successful fetch uses its new empty cache.
      if (incident && (event.kind === 'api-recovered' || event.endpoint !== 'getDanmuInfo' || incident.identity !== identity)) {
        this.queueRecovery(incident, event.at);
        delete this.state!.incidents[key];
      }
    } else if (event.roomId && rooms.has(event.roomId)) {
      const key = `connection:${event.roomId}`;
      let incident = this.state!.incidents[key];
      if (event.kind === 'disconnected') {
        if (!incident) incident = this.state!.incidents[key] = {
          kind: 'connection', target: event.roomId, identity, startedAt: event.at, latestAt: event.at
        };
        incident.latestAt = event.at;
        incident.identity = identity;
      } else if (event.kind === 'connected' && incident) {
        if (incident.lastQueuedAt === undefined && event.at - incident.startedAt >= 60000) this.queueStart(incident, incident.latestAt);
        if (incident.lastQueuedAt !== undefined) this.queueRecovery(incident, event.at);
        delete this.state!.incidents[key];
      }
    }
  }

  private time(at: number): string { return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }

  private queueStart(incident: Incident, at: number): void {
    const api = incident.kind === 'api';
    const title = api ? '⚠️ B站接口风控告警' : '⚠️ 录播姬弹幕连接异常';
    const subject = api ? `接口: ${incident.target}\n返回码: -352` : `房间ID: ${incident.target}`;
    this.state!.outbox.push({ id: `${incident.kind}:${incident.target}:${at}:start`, content:
      `${title}\n\n${subject}\n来源: mikufans 日志\n告警开始时间: ${this.time(incident.startedAt)}\n事件时间: ${this.time(at)}\n\n` +
      (api ? '录播姬实际请求受到限制。已建立的弹幕连接可能仍可正常接收。' : '日志记录弹幕断开或认证失败，至少一分钟未确认恢复。') });
    incident.lastQueuedAt = at;
  }

  private queueRecovery(incident: Incident, at: number): void {
    const api = incident.kind === 'api';
    const seconds = Math.max(0, Math.floor((at - incident.startedAt) / 1000));
    this.state!.outbox.push({ id: `${incident.kind}:${incident.target}:${at}:recovery`, content:
      `${api ? '✅ B站接口风控恢复' : '✅ 录播姬弹幕连接恢复'}\n\n` +
      `${api ? '接口' : '房间ID'}: ${incident.target}\n来源: mikufans 日志\n告警开始时间: ${this.time(incident.startedAt)}\n` +
      `恢复时间: ${this.time(at)}\n持续时间: ${Math.floor(seconds / 60)}分${seconds % 60}秒\n\n` +
      (api ? '录播姬已记录该接口恢复成功；弹幕连接状态单独判断。' : '录播姬已收到弹幕服务器认证成功回应。') });
  }

  private async flush(): Promise<void> {
    if (!this.notifier) return;
    while (this.state!.outbox.length && !this.stopped) {
      const notice = this.state!.outbox[0];
      try { if (!await this.notifier.sendMarkdown(notice.content)) return; }
      catch { this.logger.warn('录播日志通知发送失败，下次读取时重试'); return; }
      this.state!.outbox.shift();
      await this.save();
      this.logger.info('录播日志状态通知已发送', { eventId: notice.id });
    }
  }
}
