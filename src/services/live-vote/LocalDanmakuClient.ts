import { VoteDanmaku } from './VoteSession';

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

  constructor(private readonly url: string, private readonly token: string, private readonly roomId: string,
    private readonly onMessage: (message: VoteDanmaku) => void, private readonly onDisconnect: () => void) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
        parsed.pathname !== `/api/local/danmaku/${roomId}` || !/^[a-zA-Z0-9]{16,}$/u.test(token)) {
      throw new Error('Recorder WebSocket must be loopback with matching roomId and a local token');
    }
    if (!SocketConstructor) throw new Error('Node.js 22+ with built-in WebSocket is required');
  }

  start(): void {
    this.open();
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
      try {
        const data = JSON.parse(String(event.data));
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
        console.error('Invalid local danmaku frame:', error);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.loseConnection();
      if (!this.stopped) this.retry = setTimeout(() => this.open(), 3000);
    };
    socket.onerror = () => socket.close();
  }

  private loseConnection(): void {
    if (this.connected) this.onDisconnect();
    this.connected = false;
  }
}
