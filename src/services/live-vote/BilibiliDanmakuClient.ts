import { startListen, MessageListener, MsgHandler } from 'blive-message-listener';
import { VoteDanmaku } from './VoteSession';

type ListenerFactory = typeof startListen;

export const BILIBILI_LISTEN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
  Referer: 'https://live.bilibili.com/',
  Origin: 'https://live.bilibili.com',
  Accept: 'application/json, text/javascript, */*; q=0.01'
};

export class BilibiliDanmakuClient {
  private readonly connectionOptions: NonNullable<Parameters<ListenerFactory>[2]>;
  private listener: MessageListener | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private connected = false;
  private hasConnected = false;

  constructor(private readonly roomId: number, private readonly onMessage: (message: VoteDanmaku) => void,
    private readonly onDisconnect: () => void, private readonly factory: ListenerFactory = startListen,
    private readonly onUnavailable: () => void = () => {}, cookie = '') {
    if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new Error('Bilibili source needs a numeric long room ID');
    this.connectionOptions = { ws: { keepalive: false, headers: { ...BILIBILI_LISTEN_HEADERS } } };
    if (cookie) {
      const fields = Object.fromEntries(cookie.split(';').filter(part => part.includes('=')).map(part => {
        const index = part.indexOf('=');
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
      }));
      const uid = Number(fields.DedeUserID);
      if (!fields.SESSDATA || !fields.buvid3 || !/^\d+$/u.test(fields.DedeUserID || '') ||
          !Number.isSafeInteger(uid) || uid <= 0) {
        throw new Error('Listener Cookie needs SESSDATA, numeric DedeUserID and buvid3');
      }
      this.connectionOptions = {
        ws: { keepalive: false, headers: { ...BILIBILI_LISTEN_HEADERS, Cookie: cookie }, uid, buvid: fields.buvid3 }
      };
    }
  }

  start(): void {
    if (this.stopped || this.listener) return;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.listener?.close();
    this.listener = null;
    this.disconnect();
  }

  private open(): void {
    if (this.stopped) return;
    try {
      let listener: MessageListener;
      const handler: MsgHandler = {
        onStartListen: () => {
          if (this.stopped || this.listener !== listener) return;
          this.connected = true;
          this.hasConnected = true;
          this.attempt = 0;
          console.log(`Bilibili danmaku connected to room ${this.roomId}`);
        },
        onClose: () => {
          if (this.stopped || this.listener !== listener) return;
          this.disconnect();
          this.scheduleRetry(listener);
        },
        onIncomeDanmu: msg => {
          if (!this.connected || this.listener !== listener) return;
          const uid = msg.body?.user?.uid;
          if (!Number.isSafeInteger(uid) || uid <= 0 || typeof msg.body.content !== 'string') return;
          this.onMessage({ uid: String(uid), text: msg.body.content, sentAt: msg.timestamp });
        }
      };
      // Disable the library's fixed-interval reconnect so this client can back off on failures.
      // tiny-bilibili-ws 1.1.0 overwrites its default User-Agent when headers is undefined.
      listener = this.factory(this.roomId, handler, this.connectionOptions);
      this.listener = listener;
      listener.live.on('error', (error: unknown) => {
        if (this.stopped || this.listener !== listener) return;
        console.error('Bilibili danmaku connection error:', error);
        this.disconnect();
        this.scheduleRetry(listener);
      });
    } catch (error) {
      console.error('Bilibili danmaku startup error:', error);
      this.disconnect();
      this.scheduleRetry();
    }
  }

  private scheduleRetry(listener?: MessageListener): void {
    if (this.stopped || this.retry) return;
    if (listener && this.listener === listener) {
      this.listener = null;
      listener.close();
    }
    if (!this.hasConnected) {
      this.stopped = true;
      console.error('Initial Bilibili danmaku connection failed; automatic retries disabled. Check for API -352 and use the recorder source if available.');
      this.onUnavailable();
      return;
    }
    const wait = Math.min(60000, 5000 * 2 ** Math.min(this.attempt++, 4));
    console.log(`Bilibili danmaku disconnected; retrying in ${wait / 1000}s`);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, wait);
  }

  private disconnect(): void {
    if (this.connected) this.onDisconnect();
    this.connected = false;
  }
}
