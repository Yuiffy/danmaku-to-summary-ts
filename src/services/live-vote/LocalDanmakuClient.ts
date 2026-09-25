import { VoteDanmaku } from './VoteSession';

export interface RelayRoom {
  roomId: string;
  ownerUid: string;
  connected: boolean;
}

interface LocalSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

const SocketConstructor = (globalThis as unknown as {
  WebSocket?: new (url: string, protocols: string[]) => LocalSocket;
}).WebSocket;

export class LocalDanmakuClient {
  private socket: LocalSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private connected = false;
  private rooms = new Map<string, RelayRoom>();

  constructor(private readonly url: string, private readonly token: string, private readonly roomId: string,
    private readonly onMessage: (message: VoteDanmaku) => void, private readonly onDisconnect: () => void,
    private readonly onRooms?: (rooms: RelayRoom[]) => void) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
        parsed.pathname !== (roomId === '*' ? '/api/local/danmaku' : `/api/local/danmaku/${roomId}`) ||
        parsed.username || parsed.password || parsed.search || parsed.hash || !/^[a-zA-Z0-9]{16,}$/u.test(token)) {
      throw new Error('Recorder WebSocket must be loopback with matching roomId and a local token');
    }
    if (!SocketConstructor) throw new Error('Node.js 22+ with built-in WebSocket is required');
  }

  start(): void {
    if (!this.socket && !this.stopped) this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.loseConnection();
  }

  private open(): void {
    if (this.stopped) return;
    const socket = new SocketConstructor!(this.url, [this.token]);
    this.socket = socket;
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const data = JSON.parse(String(event.data));
        if (this.roomId === '*') {
          if (data.type === 'rooms') {
            if (data.version !== 1 || !Array.isArray(data.rooms) || data.rooms.length > 1000) throw new Error('Invalid room snapshot');
            const next = new Map<string, RelayRoom>();
            for (const room of data.rooms) {
              if (!Number.isSafeInteger(room.roomId) || room.roomId <= 0 || typeof room.ownerUid !== 'string' ||
                  !/^\d+$/u.test(room.ownerUid) || typeof room.connected !== 'boolean' || next.has(String(room.roomId))) {
                throw new Error('Invalid room metadata');
              }
              next.set(String(room.roomId), { roomId: String(room.roomId), ownerUid: room.ownerUid, connected: room.connected });
            }
            this.rooms = next;
            this.connected = true;
            this.onRooms?.([...next.values()]);
          } else if (data.type === 'danmaku' && this.connected && this.rooms.get(String(data.roomId))?.connected &&
                     typeof data.uid === 'string' && /^[1-9]\d*$/u.test(data.uid) && typeof data.text === 'string' &&
                     data.text.length <= 300 && typeof data.sentAt === 'number' && Number.isFinite(data.sentAt)) {
            this.onMessage({ roomId: String(data.roomId), uid: data.uid, text: data.text, sentAt: data.sentAt });
          }
          return;
        }
        if (data.roomId !== Number(this.roomId)) return;
        if (data.type === 'status' && typeof data.connected === 'boolean') {
          this.connected = data.connected;
          if (!data.connected) this.onDisconnect();
        } else if (this.connected && data.type === 'danmaku' && /^\d+$/u.test(data.uid) &&
                   typeof data.text === 'string' && data.text.length <= 300 &&
                   typeof data.sentAt === 'number' && Number.isFinite(data.sentAt)) {
          this.onMessage({ uid: data.uid, text: data.text, sentAt: data.sentAt });
        }
      } catch (error) {
        console.error('Invalid local danmaku frame; connection cancelled');
        this.loseConnection();
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.loseConnection();
      if (!this.stopped) this.retry = setTimeout(() => this.open(), 3000);
    };
    socket.onerror = () => socket.close();
  }

  private loseConnection(): void {
    this.rooms.clear();
    if (this.connected) this.onDisconnect();
    this.connected = false;
  }
}
