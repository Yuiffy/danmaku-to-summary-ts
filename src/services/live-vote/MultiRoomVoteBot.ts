import { RelayRoom } from './LocalDanmakuClient';
import { VoteDanmaku, VoteSession } from './VoteSession';

export interface MultiRoomVoteConfig {
  globalAdminUids: string[];
  botUid?: string;
  maxMessageChars?: number;
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

  constructor(private readonly config: MultiRoomVoteConfig,
    private readonly send: (roomId: string, message: string, isCurrent: () => boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void) {}

  updateRooms(snapshot: RelayRoom[]): void {
    if (this.stopped) return;
    const available = new Map(snapshot.filter(room => room.connected && /^[1-9]\d*$/u.test(room.ownerUid))
      .map(room => [room.roomId, room]));
    for (const [id, current] of this.rooms) {
      if (available.get(id)?.ownerUid !== current.ownerUid) {
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
        this.queue = this.queue.then(() => isCurrent() ? this.send(id, message, isCurrent) : undefined).catch(error => {
          this.stop();
          this.onError(error);
        });
      }, () => { current.generation++; });
      this.rooms.set(id, current);
    }
  }

  ingest(message: VoteDanmaku, now = Date.now()): void {
    if (message.roomId) this.rooms.get(message.roomId)?.session.ingest(message, now);
  }

  tick(now = Date.now()): void {
    for (const room of this.rooms.values()) room.session.tick(now);
  }

  disconnect(): void {
    for (const room of this.rooms.values()) { room.generation++; room.session.cancel(); }
    this.rooms.clear();
  }

  stop(): void { this.stopped = true; this.disconnect(); }
  flush(): Promise<void> { return this.queue; }
}
