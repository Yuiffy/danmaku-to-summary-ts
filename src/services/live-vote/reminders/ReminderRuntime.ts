import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { ReminderAdapters } from './LiveReminderSession';
import { initialReminderState, LiveReminderConfig, ReminderRoomStatus, ReminderState, reminderOptions } from './ReminderPolicy';

export function writeReminderState(file: string, state: ReminderState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staging, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(staging, file);
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

export async function readReminderRoomStatus(roomId: string, transport = fetch): Promise<ReminderRoomStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await transport(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `https://live.bilibili.com/${roomId}` },
      signal: controller.signal as any, redirect: 'error', size: 256 * 1024
    });
    if (!response.ok) throw new Error('Room metadata HTTP failure');
    const data = await response.json() as { code?: number; data?: { room_info?: Record<string, unknown> } };
    const room = data.data?.room_info;
    if (data.code !== 0 || !room || String(room.room_id) !== roomId ||
        ![0, 1, 2].includes(Number(room.live_status))) throw new Error('Invalid room metadata');
    const start = Number(room.live_start_time);
    return {
      roomId, live: Number(room.live_status) === 1, startedAt: Number.isFinite(start) ? start * 1000 : 0,
      title: typeof room.title === 'string' ? room.title : '',
      area: typeof room.area_name === 'string' ? room.area_name : '',
      parentArea: typeof room.parent_area_name === 'string' ? room.parent_area_name : ''
    };
  } finally { clearTimeout(timeout); }
}

export function createReminderAdapters(config: LiveReminderConfig | undefined, live: boolean): ReminderAdapters | undefined {
  if (!config) return undefined;
  reminderOptions(config);
  if (!config.enabled) return undefined;
  if (!path.isAbsolute(config.statePath || '') || !path.isAbsolute(config.notificationConfigPath || '')) {
    throw new Error('Enabled reminders require absolute statePath and notificationConfigPath');
  }
  const settings = loadConfigLayers({ configPath: config.notificationConfigPath });
  const url = (settings.wechatWork as { webhookUrl?: string } | undefined)?.webhookUrl;
  if (!url) throw new Error('Live reminders require wechatWork.webhookUrl in the explicit notification config');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'qyapi.weixin.qq.com' || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/cgi-bin/webhook/send' || !endpoint.searchParams.get('key')) {
    throw new Error('Invalid live reminder WeChat Work webhook');
  }
  const notifier = new WeChatWorkNotifier(url);
  // Dry-run never consumes real daily quotas or persists real operator commands.
  const file = live ? config.statePath : `${config.statePath}.dry-run`;
  return {
    load: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')) : initialReminderState(),
    save: state => writeReminderState(file, state),
    status: roomId => readReminderRoomStatus(roomId),
    notify: async record => {
      const time = new Date(record.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const text = `直播提醒记录\n房间：${record.roomId}\n事项：${record.name} (${record.id})\n时间：${time}\n` +
        `结果：${record.status === 'sent' ? '弹幕发送成功' : '发送未确认，不自动重发'}\n弹幕：${record.text}`;
      if (!live) { console.log(`[dry-run reminder record] ${text}`); return true; }
      return notifier.sendText(text);
    },
    onError: error => console.error('Live reminders:', error instanceof Error ? error.message : 'operation failed')
  };
}
