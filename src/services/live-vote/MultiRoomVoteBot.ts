import { RelayRoom } from './LocalDanmakuClient';
import { VoteDanmaku, VoteSession } from './VoteSession';
import { LiveQuestionSession } from './questions/LiveQuestionSession';
import { LiveQuestionConfig, QuestionAnswerer, QuestionRecordWriter } from './questions/QuestionPolicy';

export interface MultiRoomVoteConfig {
  globalAdminUids: string[];
  botUid?: string;
  maxMessageChars?: number;
  questions?: LiveQuestionConfig;
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

  constructor(private readonly config: MultiRoomVoteConfig,
    private readonly send: (roomId: string, message: string, isCurrent: () => boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void, answerer?: QuestionAnswerer, record?: QuestionRecordWriter) {
    if (config.questions?.enabled) {
      if (!answerer) throw new Error('Enabled questions require a question answerer');
      this.questions = new LiveQuestionSession(config.questions, answerer,
        (roomId, message, isCurrent) => this.enqueue(roomId, message, isCurrent), config.botUid, config.maxMessageChars,
        (roomId, uid) => this.rooms.get(roomId)?.ownerUid === uid || config.globalAdminUids.includes(uid), record);
    }
  }

  private enqueue(roomId: string, message: string, isCurrent: () => boolean): void {
    this.queue = this.queue.then(() => isCurrent() ? this.send(roomId, message, isCurrent) : undefined).catch(error => {
      this.stop();
      this.onError(error);
    });
  }

  updateRooms(snapshot: RelayRoom[]): void {
    if (this.stopped) return;
    const available = new Map(snapshot.filter(room => room.connected && /^[1-9]\d*$/u.test(room.ownerUid))
      .map(room => [room.roomId, room]));
    for (const [id, current] of this.rooms) {
      if (available.get(id)?.ownerUid !== current.ownerUid) {
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
  }

  ingest(message: VoteDanmaku, now = Date.now()): void {
    const room = message.roomId && this.rooms.get(message.roomId);
    if (!room) return;
    const isCurrent = () => !this.stopped && this.rooms.get(message.roomId!) === room;
    if (!this.questions?.ingest(message, isCurrent, now)) room.session.ingest(message, now);
  }

  tick(now = Date.now()): void {
    for (const room of this.rooms.values()) room.session.tick(now);
  }

  disconnect(): void {
    this.questions?.disconnect();
    for (const room of this.rooms.values()) { room.generation++; room.session.cancel(); }
    this.rooms.clear();
  }

  stop(): void { this.stopped = true; this.questions?.stop(); this.disconnect(); }
  async flush(): Promise<void> { await this.questions?.flush(); await this.queue; }
}
