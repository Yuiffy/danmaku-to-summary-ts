import { VoteDanmaku } from '../VoteSession';
import { applyReminderEdit, ReminderOperatorCommand, validateReminderEdit } from './ReminderCommands';
import {
  LiveReminderConfig, ReminderReceipt, ReminderRecord, ReminderRoomStatus, ReminderState, isReminderChat,
  parseReminderCommand, quietReminderWindow, reminderOptions, REMINDER_POLL_MS,
  REMINDER_STATUS_TTL_MS, REMINDER_WINDOW_MS, shanghaiDay, validateReminderState
} from './ReminderPolicy';

export interface ReminderAdapters {
  load(): ReminderState;
  save(state: ReminderState): void;
  status(roomId: string): Promise<ReminderRoomStatus>;
  notify(record: ReminderRecord): Promise<boolean>;
  onError(error: unknown): void;
  clock?: () => number;
  commands?: () => ReminderOperatorCommand[];
  completeCommand?: (id: string, error?: string) => void;
}
export type ReminderSend = (roomId: string, message: string, isCurrent: () => boolean,
  beforeSend?: () => void) => Promise<boolean>;

/** One target room; decisions and durable intent are independent of provider/process IO. */
export class LiveReminderSession {
  private readonly options: Required<LiveReminderConfig>;
  private readonly state: ReminderState;
  private readonly clock: () => number;
  private available = false;
  private stopped = false;
  private generation = 0;
  private observedSince = 0;
  private samples: number[] = [];
  private room?: ReminderRoomStatus;
  private statusAt = 0;
  private nextPoll = 0;
  private polling?: Promise<void>;
  private pending?: Promise<void>;

  constructor(config: LiveReminderConfig, private readonly adminUids: string[], private readonly botUid: string | undefined,
    private readonly maxChars: number, private readonly send: ReminderSend, private readonly adapters: ReminderAdapters) {
    this.options = reminderOptions(config);
    this.state = adapters.load();
    validateReminderState(this.state, maxChars);
    this.clock = adapters.clock || Date.now;
  }

  setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    this.generation++;
    this.samples = [];
    this.observedSince = this.clock();
    this.room = undefined;
    this.statusAt = 0;
    this.nextPoll = 0;
  }

  ingest(message: VoteDanmaku, now = this.clock()): boolean {
    if (this.stopped || !this.available || message.roomId !== this.options.roomId || message.uid === this.botUid ||
        !Number.isFinite(message.sentAt) || Math.abs(message.sentAt - now) > 10000) return false;
    this.samples.push(now);
    this.prune(now);
    const command = parseReminderCommand(message.text);
    if (!command || !/^[1-9]\d*$/u.test(message.uid) || !this.adminUids.includes(message.uid)) return false;
    try {
      const { action, argument } = command;
      const target = this.state.items.find(item => item.id === (argument || this.state.lastReminderId) || item.name === argument);
      let notice = '';
      if (action === '新增提醒') {
        const text = `岁岁，记得${argument}哦～`;
        if (!argument || Array.from(text).length > this.maxChars || this.state.items.length >= 10) {
          notice = `用#新增提醒 事项，成句限${this.maxChars}字，最多10项`;
        } else if (this.state.items.some(item => item.name === argument)) {
          notice = '该提醒已存在，可用#开启提醒 事项';
        } else {
          const id = `custom-${this.state.nextId++}`;
          this.state.items.push({ id, name: argument, enabled: true, templates: [text] });
          notice = `已新增提醒：${id}`;
        }
      } else if (action === '关闭提醒' || action === '开启提醒') {
        const enabled = action === '开启提醒';
        if (argument === '全部') {
          this.state.enabled = enabled;
          notice = enabled ? '全部提醒总开关已开启' : '全部提醒已关闭';
        } else if (target) {
          target.enabled = enabled;
          notice = `${enabled ? '已开启' : '已关闭'}提醒：${target.id}`;
        } else notice = '请指定提醒ID；不带参数操作上一项';
      } else if (action === '停止提醒') {
        if (!argument && this.room?.live) {
          this.state.pausedSession = this.room.startedAt;
          notice = '本场提醒已停止，下次开播自动恢复';
        } else notice = '用#停止提醒 暂停本场；当前需有开播信息';
      } else {
        notice = `提醒${this.state.enabled ? '开' : '关'}：` + this.state.items.map(item => `${item.id}(${item.name})${item.enabled ? '开' : '关'}`).join(' ');
      }
      this.adapters.save(this.state);
      const generation = this.generation;
      // Only command acknowledgements may be split. Each automatic reminder is one item/one message.
      const chars = Array.from(notice);
      for (let i = 0; i < chars.length; i += this.maxChars) {
        void this.send(this.options.roomId, chars.slice(i, i + this.maxChars).join(''),
          () => !this.stopped && this.available && generation === this.generation).catch(error => this.fail(error));
      }
    } catch (error) { this.fail(error); }
    return true;
  }

  tick(now = this.clock()): void {
    if (this.stopped) return;
    this.consumeCommands();
    if (this.stopped || !this.available) return;
    this.prune(now);
    if (!this.polling && now >= this.nextPoll) {
      this.nextPoll = now + REMINDER_POLL_MS;
      const generation = this.generation;
      this.polling = this.adapters.status(this.options.roomId).then(room => {
        if (this.stopped || !this.available || generation !== this.generation) return;
        this.room = room.roomId === this.options.roomId ? room : undefined;
        this.statusAt = now;
      }).catch(() => {
        if (generation === this.generation) { this.room = undefined; this.statusAt = 0; }
        this.adapters.onError(new Error('Live reminder room status unavailable; waiting for next poll'));
      }).finally(() => { this.polling = undefined; });
    }
    if (this.pending || !this.eligible(now)) return;
    const day = shanghaiDay(now);
    const item = this.state.items.find(candidate => candidate.enabled &&
      !this.state.receipts.some(receipt => receipt.day === day && receipt.id === candidate.id));
    if (!item) return;
    const session = this.room!.startedAt;
    const generation = this.generation;
    const text = item.templates[Math.floor(now / 86400000) % item.templates.length];
    const isCurrent = () => !this.stopped && generation === this.generation && item.enabled &&
      this.room?.startedAt === session && shanghaiDay(this.clock()) === day && this.eligible(this.clock());
    const receipt: ReminderReceipt = { day, id: item.id, at: now, text, status: 'attempted', notified: false };
    this.pending = this.send(this.options.roomId, text, isCurrent, () => {
      receipt.at = this.clock();
      this.state.receipts = this.state.receipts.filter(previous => previous.at > receipt.at - 32 * 86400000);
      this.state.receipts.push(receipt);
      this.state.lastReminderId = item.id;
      // Save before the HTTP request: an uncertain outcome must never cause automatic duplicate medication reminders.
      this.adapters.save(this.state);
    }).then(async sent => {
      if (!this.state.receipts.includes(receipt)) return;
      if (sent) { receipt.status = 'sent'; this.adapters.save(this.state); }
      await this.record({ ...receipt, roomId: this.options.roomId, name: item.name });
    }).catch(async error => {
      if (this.state.receipts.includes(receipt)) await this.record({ ...receipt, roomId: this.options.roomId, name: item.name });
      this.fail(error);
    }).finally(() => { this.pending = undefined; });
  }

  private eligible(now: number): boolean {
    const room = this.room;
    if (!this.available || !this.state.enabled || !room || !isReminderChat(room) || now - this.statusAt > REMINDER_STATUS_TTL_MS ||
        this.state.pausedSession === room.startedAt) return false;
    const elapsed = now - room.startedAt;
    if (elapsed < this.options.startMinutes * 60000 || elapsed >= this.options.endMinutes * 60000) return false;
    const lastAt = this.state.receipts.at(-1)?.at;
    return (lastAt === undefined || now - lastAt >= this.options.minGapMinutes * 60000) &&
      quietReminderWindow(this.samples, this.observedSince, now, this.options);
  }

  private consumeCommands(): void {
    try {
      for (const command of this.adapters.commands?.() || []) {
        if (this.state.appliedCommandIds?.includes(command.id)) { this.adapters.completeCommand?.(command.id); continue; }
        const next = structuredClone(this.state);
        try {
          validateReminderEdit(command.edit, this.maxChars);
          applyReminderEdit(next, command.edit, this.room?.live ? this.room.startedAt : undefined);
          next.appliedCommandIds = [...(next.appliedCommandIds || []), command.id].slice(-200);
          validateReminderState(next, this.maxChars);
        } catch (error) {
          this.adapters.completeCommand?.(command.id, error instanceof Error ? error.message : '无效操作');
          continue;
        }
        // Retain receipt object identity while a send/notification is in flight.
        next.receipts = this.state.receipts;
        this.adapters.save(next);
        Object.assign(this.state, next);
        if (!Object.hasOwn(next, 'pausedSession')) delete this.state.pausedSession;
        this.generation++;
        this.adapters.completeCommand?.(command.id);
      }
    } catch (error) { this.fail(error); }
  }

  private async record(record: ReminderRecord): Promise<void> {
    try {
      const notified = await this.adapters.notify(record);
      const receipt = this.state.receipts.find(previous => previous.day === record.day && previous.id === record.id);
      if (receipt) { receipt.notified = notified; this.adapters.save(this.state); }
      if (!notified) this.adapters.onError(new Error('Live reminder WeChat Work record failed; danmaku will not be resent'));
    } catch { this.adapters.onError(new Error('Live reminder WeChat Work record failed; danmaku will not be resent')); }
  }

  private prune(now: number): void { this.samples = this.samples.filter(at => at > now - 5 * REMINDER_WINDOW_MS).slice(-20000); }
  private fail(error: unknown): void { this.stopped = true; this.generation++; this.adapters.onError(error); }
  stop(): void { this.stopped = true; this.setAvailable(false); }
  async flush(): Promise<void> { await this.polling; await this.pending; }
}
