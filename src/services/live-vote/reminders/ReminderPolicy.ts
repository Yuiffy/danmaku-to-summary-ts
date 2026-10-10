export interface LiveReminderConfig {
  enabled: boolean;
  roomId: string;
  statePath: string;
  notificationConfigPath: string;
  startMinutes?: number;
  endMinutes?: number;
  minGapMinutes?: number;
  quietMaxPerMinute?: number;
  quietRatio?: number;
}

export interface ReminderItem { id: string; name: string; enabled: boolean; templates: string[] }
export interface ReminderReceipt {
  day: string;
  id: string;
  at: number;
  text: string;
  status: 'attempted' | 'sent';
  notified: boolean;
}
export interface ReminderState {
  version: 1;
  enabled: boolean;
  items: ReminderItem[];
  receipts: ReminderReceipt[];
  lastReminderId?: string;
  pausedSession?: number;
  nextId: number;
}
export interface ReminderRoomStatus {
  roomId: string;
  live: boolean;
  startedAt: number;
  title: string;
  area: string;
  parentArea: string;
}
export interface ReminderRecord extends ReminderReceipt { roomId: string; name: string }

export const REMINDER_POLL_MS = 30000;
export const REMINDER_STATUS_TTL_MS = 45000;
export const REMINDER_WINDOW_MS = 60000;

export function initialReminderState(): ReminderState {
  return {
    version: 1, enabled: true, nextId: 1, receipts: [],
    items: [
      { id: 'medicine', name: '吃药', enabled: true, templates: [
        '岁岁，反流的药记得按医嘱吃呀～',
        '小岁，别忘了按医嘱吃反流的药哦～',
        '岁岁，记得按医嘱吃反流的药呀～'
      ] },
      { id: 'lotion', name: '身体乳', enabled: true, templates: [
        '岁岁，记得抹身体乳，照顾好皮肤呀～',
        '小岁，身体乳别忘了抹哦～',
        '岁岁，今天也记得抹身体乳呀～'
      ] }
    ]
  };
}

export function reminderOptions(config: LiveReminderConfig): Required<LiveReminderConfig> {
  const options = { startMinutes: 15, endMinutes: 60, minGapMinutes: 10,
    quietMaxPerMinute: 12, quietRatio: 0.5, ...config };
  if (typeof config.enabled !== 'boolean' || !/^[1-9]\d*$/u.test(config.roomId) ||
      !Number.isInteger(options.startMinutes) || options.startMinutes < 15 ||
      !Number.isInteger(options.endMinutes) || options.endMinutes > 60 || options.endMinutes <= options.startMinutes ||
      !Number.isInteger(options.minGapMinutes) || options.minGapMinutes < 5 || options.minGapMinutes > 45 ||
      !Number.isInteger(options.quietMaxPerMinute) || options.quietMaxPerMinute < 0 || options.quietMaxPerMinute > 300 ||
      !Number.isFinite(options.quietRatio) || options.quietRatio <= 0 || options.quietRatio > 1) {
    throw new Error('Invalid live reminders configuration');
  }
  return options;
}

export function shanghaiDay(at: number): string {
  return new Date(at + 8 * 3600000).toISOString().slice(0, 10);
}

/** Compatibility predicate: only live status and a valid start time gate reminders. */
export function isReminderChat(status: ReminderRoomStatus): boolean {
  return status.live && Number.isFinite(status.startedAt) && status.startedAt > 0;
}

export function quietReminderWindow(samples: number[], since: number, now: number,
  config: Required<LiveReminderConfig>): boolean {
  if (now - since < REMINDER_WINDOW_MS) return false;
  const recent = samples.filter(at => at > now - REMINDER_WINDOW_MS && at <= now).length;
  const historyMs = Math.min(4 * REMINDER_WINDOW_MS, now - since - REMINDER_WINDOW_MS);
  const previous = samples.filter(at => at > now - REMINDER_WINDOW_MS - historyMs && at <= now - REMINDER_WINDOW_MS).length;
  const baseline = historyMs > 0 ? previous * REMINDER_WINDOW_MS / historyMs : 0;
  return recent <= config.quietMaxPerMinute || historyMs >= REMINDER_WINDOW_MS && baseline > 0 && recent <= baseline * config.quietRatio;
}

export type ReminderCommand = { action: '关闭提醒' | '开启提醒' | '新增提醒' | '停止提醒' | '提醒列表'; argument: string };
export function parseReminderCommand(text: string): ReminderCommand | undefined {
  const normalized = text.normalize('NFKC').trim();
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  const match = /^#(关闭提醒|开启提醒|新增提醒|停止提醒|提醒列表)(?:\s+(.+))?$/u.exec(normalized);
  return match ? { action: match[1] as ReminderCommand['action'], argument: match[2]?.trim() || '' } : undefined;
}

export function validateReminderState(value: unknown, maxChars: number): asserts value is ReminderState {
  const state = value as ReminderState;
  const validText = (text: unknown, limit: number) => typeof text === 'string' && !!text.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(text) && Array.from(text).length <= limit;
  if (!state || state.version !== 1 || typeof state.enabled !== 'boolean' || !Array.isArray(state.items) ||
      state.items.length > 10 || !Array.isArray(state.receipts) || state.receipts.length > 1000 ||
      !Number.isSafeInteger(state.nextId) || state.nextId < 1 ||
      state.pausedSession !== undefined && (!Number.isFinite(state.pausedSession) || state.pausedSession <= 0) ||
      state.items.some(item => !item || !/^[a-z0-9-]{1,40}$/u.test(item.id) || !validText(item.name, 40) ||
        typeof item.enabled !== 'boolean' || !Array.isArray(item.templates) || !item.templates.length ||
        item.templates.some(text => !validText(text, maxChars))) ||
      new Set(state.items.map(item => item.id)).size !== state.items.length ||
      state.lastReminderId !== undefined && !state.items.some(item => item.id === state.lastReminderId) ||
      state.receipts.some(receipt => !receipt || !/^\d{4}-\d{2}-\d{2}$/u.test(receipt.day) ||
        !state.items.some(item => item.id === receipt.id) || !Number.isFinite(receipt.at) || receipt.at <= 0 ||
        !validText(receipt.text, 40) || !['attempted', 'sent'].includes(receipt.status) || typeof receipt.notified !== 'boolean')) {
    throw new Error('Invalid live reminder state; refusing to reset send history');
  }
}
