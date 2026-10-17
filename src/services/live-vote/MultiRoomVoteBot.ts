import { RelayRoom } from './LocalDanmakuClient';
import { VoteDanmaku, VoteSession } from './VoteSession';
import { LiveQuestionSession } from './questions/LiveQuestionSession';
import { LiveQuestionConfig, QuestionAnswerer, QuestionRecordWriter } from './questions/QuestionPolicy';
import { LiveReminderSession, ReminderAdapters } from './reminders/LiveReminderSession';
import { LiveReminderConfig } from './reminders/ReminderPolicy';
import { parseClipIntentCommand } from '../../core/clipping/ClipIntent';

export interface MultiRoomVoteConfig {
  globalAdminUids: string[];
  botUid?: string;
  maxMessageChars?: number;
  questions?: LiveQuestionConfig;
  reminders?: LiveReminderConfig;
}

interface RoomVote {
  ownerUid: string;
  generation: number;
  session: VoteSession;
}

export class MultiRoomVoteBot {
  private readonly rooms = new Map<string, RoomVote>();
  private queue = Promise.resolve();
  private stopped = false;
  private readonly questions?: LiveQuestionSession;
  private readonly reminders?: LiveReminderSession;
  private readonly lastClipNotice = new Map<string, number>();

  constructor(private readonly config: MultiRoomVoteConfig,
    private readonly send: (roomId: string, message: string, isCurrent: () => boolean, beforeSend?: () => void) => Promise<void | boolean>,
    private readonly onError: (error: unknown) => void, answerer?: QuestionAnswerer, record?: QuestionRecordWriter,
    reminderAdapters?: ReminderAdapters) {
    if (config.reminders?.enabled) {
      if (!reminderAdapters) throw new Error('Enabled reminders require runtime adapters');
      this.reminders = new LiveReminderSession(config.reminders, config.globalAdminUids, config.botUid,
        config.maxMessageChars ?? 40, (roomId, message, isCurrent, beforeSend) =>
          this.enqueue(roomId, message, isCurrent, beforeSend), reminderAdapters);
    }
    if (config.questions?.enabled) {
      if (!answerer) throw new Error('Enabled questions require a question answerer');
      this.questions = new LiveQuestionSession(config.questions, answerer,
        (roomId, message, isCurrent) => this.enqueue(roomId, message, isCurrent), config.botUid, config.maxMessageChars,
        (roomId, uid) => this.rooms.get(roomId)?.ownerUid === uid || config.globalAdminUids.includes(uid), record);
    }
  }

  private enqueue(roomId: string, message: string, isCurrent: () => boolean, beforeSend?: () => void): Promise<boolean> {
    const pending = this.queue.then(async () => {
      if (!isCurrent()) return false;
      return (await (beforeSend ? this.send(roomId, message, isCurrent, beforeSend) : this.send(roomId, message, isCurrent))) !== false;
    });
    this.queue = pending.then(() => {}).catch(error => {
      this.stop();
      this.onError(error);
    });
    return pending;
  }

  updateRooms(snapshot: RelayRoom[]): void {
    if (this.stopped) return;
    const available = new Map(snapshot.filter(room => room.connected && /^[1-9]\d*$/u.test(room.ownerUid))
      .map(room => [room.roomId, room]));
    for (const [id, current] of this.rooms) {
      if (available.get(id)?.ownerUid !== current.ownerUid) {
        if (id === this.config.reminders?.roomId) this.reminders?.setAvailable(false);
        this.questions?.cancelRoom(id);
        current.generation++;
        current.session.cancel();
        this.rooms.delete(id);
      }
    }
    for (const [id, room] of available) {
      if (this.rooms.has(id)) continue;
      const current = { ownerUid: room.ownerUid, generation: 0 } as RoomVote;
      current.session = new VoteSession({
        authorizedUids: [room.ownerUid, ...this.config.globalAdminUids],
        botUid: this.config.botUid, maxMessageChars: this.config.maxMessageChars
      }, message => {
        const generation = current.generation;
        const isCurrent = () => !this.stopped && this.rooms.get(id) === current && generation === current.generation;
        this.enqueue(id, message, isCurrent);
      }, () => { current.generation++; });
      this.rooms.set(id, current);
    }
    this.reminders?.setAvailable(this.rooms.has(this.config.reminders!.roomId));
  }

  ingest(message: VoteDanmaku, now = Date.now()): void {
    const room = message.roomId && this.rooms.get(message.roomId);
    if (!room) return;
    const isCurrent = () => !this.stopped && this.rooms.get(message.roomId!) === room;
    const intent = parseClipIntentCommand(message.text);
    if (intent && !this.stopped && /^[1-9]\d*$/u.test(message.uid) && message.uid !== this.config.botUid
        && Number.isFinite(message.sentAt) && Math.abs(now - message.sentAt) <= 10000) {
      if (now - (this.lastClipNotice.get(message.roomId!) ?? -Infinity) >= 10000) {
        this.lastClipNotice.set(message.roomId!, now);
        this.enqueue(message.roomId!, intent === 'hold' ? '收到别切意向，录播后需人工核对再决定。' : '收到选段意向，录播后按弹幕选材，不自动投稿。', isCurrent);
      }
      return;
    }
    if (this.reminders?.ingest(message, now)) return;
    if (!this.questions?.ingest(message, isCurrent, now)) room.session.ingest(message, now);
  }

  tick(now = Date.now()): void {
    this.reminders?.tick(now);
    for (const room of this.rooms.values()) room.session.tick(now);
  }

  disconnect(): void {
    this.reminders?.setAvailable(false);
    this.questions?.disconnect();
    for (const room of this.rooms.values()) { room.generation++; room.session.cancel(); }
    this.rooms.clear();
  }

  stop(): void { this.stopped = true; this.questions?.stop(); this.reminders?.stop(); this.disconnect(); }
  async flush(): Promise<void> { await this.questions?.flush(); await this.reminders?.flush(); await this.queue; }
}
