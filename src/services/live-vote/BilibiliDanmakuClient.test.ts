import { EventEmitter } from 'events';
import type { MessageListener, MsgHandler } from 'blive-message-listener';
import { BilibiliDanmakuClient } from './BilibiliDanmakuClient';

describe('direct Bilibili vote source', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('accepts valid UID danmaku, cancels on disconnect, and backs off without duplicate connections', () => {
    const handlers: MsgHandler[] = [];
    const listeners: Array<{ emitter: EventEmitter; close: jest.Mock }> = [];
    const factory = jest.fn((_roomId: number, handler: MsgHandler): MessageListener => {
      handlers.push(handler);
      const emitter = new EventEmitter();
      const close = jest.fn();
      listeners.push({ emitter, close });
      return { live: emitter, close } as unknown as MessageListener;
    });
    const received = jest.fn();
    const disconnected = jest.fn();
    const client = new BilibiliDanmakuClient(628684, received, disconnected, factory);
    client.start();
    expect(factory).toHaveBeenCalledWith(628684, expect.any(Object), {
      ws: {
        keepalive: false,
        headers: {
          'User-Agent': expect.stringContaining('Mozilla/5.0'),
          Referer: 'https://live.bilibili.com/',
          Origin: 'https://live.bilibili.com',
          Accept: expect.stringContaining('application/json')
        }
      }
    });
    handlers[0].onIncomeDanmu?.({ timestamp: 123, body: { user: { uid: 42 }, content: '1' } } as any);
    expect(received).not.toHaveBeenCalled();
    handlers[0].onStartListen?.();
    handlers[0].onIncomeDanmu?.({ timestamp: 124, body: { user: { uid: 42 }, content: '111' } } as any);
    handlers[0].onIncomeDanmu?.({ timestamp: 125, body: { user: { uid: 0 }, content: '2' } } as any);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ uid: '42', text: '111', sentAt: 124 });
    handlers[0].onClose?.();
    handlers[0].onClose?.();
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(listeners[0].close).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(4999);
    expect(factory).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(factory).toHaveBeenCalledTimes(2);
    handlers[1].onStartListen?.();
    listeners[1].emitter.emit('error', new Error('lost'));
    expect(disconnected).toHaveBeenCalledTimes(2);
    client.stop();
    jest.advanceTimersByTime(60000);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed initial handshake automatically', () => {
    const handlers: MsgHandler[] = [];
    const factory = jest.fn((_roomId: number, handler: MsgHandler) => {
      handlers.push(handler);
      return { live: new EventEmitter(), close: jest.fn() } as unknown as MessageListener;
    });
    const unavailable = jest.fn();
    const client = new BilibiliDanmakuClient(628684, jest.fn(), jest.fn(), factory, unavailable);
    client.start();
    handlers[0].onClose?.();
    jest.advanceTimersByTime(120000);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('uses the same login and device identity for API requests and the danmaku handshake', () => {
    const cookie = 'SESSDATA=test=session; DedeUserID=42; buvid3=existing-device';
    const factory = jest.fn(() => ({ live: new EventEmitter(), close: jest.fn() } as unknown as MessageListener));
    const client = new BilibiliDanmakuClient(628684, jest.fn(), jest.fn(), factory, jest.fn(), cookie);
    client.start();
    expect(factory).toHaveBeenCalledWith(628684, expect.any(Object), {
      ws: {
        keepalive: false, uid: 42, buvid: 'existing-device',
        headers: expect.objectContaining({ Cookie: cookie, 'User-Agent': expect.stringContaining('Mozilla/5.0') })
      }
    });
    client.stop();
  });

  it.each([
    'SESSDATA=test; DedeUserID=42',
    'SESSDATA=test; DedeUserID=0; buvid3=existing-device',
    'DedeUserID=42; buvid3=existing-device'
  ])('rejects incomplete listener identity before connecting: %s', cookie => {
    const factory = jest.fn();
    expect(() => new BilibiliDanmakuClient(628684, jest.fn(), jest.fn(), factory, jest.fn(), cookie))
      .toThrow('Listener Cookie needs');
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('Bilibili listener HTTP request headers', () => {
  it('preserves the explicit headers through the real library request builder without sending credentials', async () => {
    const net = require('node:net') as typeof import('node:net');
    const requests: Array<{ url: string; headers: Headers }> = [];
    let resolveSocket: () => void;
    const socketCreated = new Promise<void>(resolve => { resolveSocket = resolve; });
    const socket = Object.assign(new EventEmitter(), { end: jest.fn() });
    const connect = jest.spyOn(net, 'connect').mockImplementation(() => {
      resolveSocket();
      return socket as any;
    });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      let data: object;
      if (url.includes('/nav')) {
        data = { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png'
        } };
      } else if (url.includes('/mobileRoomInit')) {
        data = { room_id: 628684 };
      } else if (url.includes('/getDanmuInfo')) {
        data = { token: 'test-token', host_list: [{ host: 'localhost', port: 1 }] };
      } else if (url.includes('/spi')) {
        data = { b_3: 'test-buvid' };
      } else {
        throw new Error('Unexpected listener endpoint');
      }
      return { ok: true, json: async () => ({ code: 0, data }) } as Response;
    });
    let client: BilibiliDanmakuClient;
    try {
      jest.isolateModules(() => {
        const { BilibiliDanmakuClient: Client } = require('./BilibiliDanmakuClient') as typeof import('./BilibiliDanmakuClient');
        client = new Client(628684, jest.fn(), jest.fn());
        client.start();
      });
      await socketCreated;
      const request = requests.find(item => item.url.includes('/getDanmuInfo'));
      expect(request).toBeDefined();
      expect(request!.headers.get('User-Agent')).toContain('Mozilla/5.0');
      expect(request!.headers.get('Referer')).toBe('https://live.bilibili.com/');
      expect(request!.headers.get('Origin')).toBe('https://live.bilibili.com');
      expect(request!.headers.has('Cookie')).toBe(false);
      expect(requests.filter(item => item.url.includes('/getDanmuInfo'))).toHaveLength(1);
    } finally {
      client?.stop();
      connect.mockRestore();
      fetch.mockRestore();
    }
  }, 3000);
});
