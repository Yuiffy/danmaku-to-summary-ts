describe('recorder relay vote source', () => {
  it('requires loopback authentication and accepts only connected matching-room UID frames', () => {
    const previous = globalThis.WebSocket;
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = jest.fn();
      constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this); }
      receive(data: object): void { this.onmessage?.({ data: JSON.stringify(data) }); }
    }
    globalThis.WebSocket = FakeSocket as any;
    jest.useFakeTimers();
    try {
      jest.isolateModules(() => {
        const { LocalDanmakuClient } = require('./LocalDanmakuClient') as typeof import('./LocalDanmakuClient');
        const token = 'a1b2c3d4e5f6g7h8';
        expect(() => new LocalDanmakuClient('ws://example.com/api/local/danmaku/628684', token,
          '628684', jest.fn(), jest.fn())).toThrow();
        const received = jest.fn();
        const disconnected = jest.fn();
        const client = new LocalDanmakuClient('ws://127.0.0.1:17896/api/local/danmaku/628684', token,
          '628684', received, disconnected);
        client.start();
        expect(sockets[0].protocols).toEqual([token]);
        sockets[0].receive({ type: 'danmaku', roomId: 628684, uid: '42', text: '1', sentAt: 123 });
        sockets[0].receive({ type: 'status', roomId: 628684, connected: true });
        sockets[0].receive({ type: 'danmaku', roomId: 628685, uid: '42', text: '1', sentAt: 123 });
        sockets[0].receive({ type: 'danmaku', roomId: 628684, uid: 'anonymous', text: '1', sentAt: 123 });
        sockets[0].receive({ type: 'danmaku', roomId: 628684, uid: '42', text: '111', sentAt: 124 });
        expect(received).toHaveBeenCalledTimes(1);
        expect(received).toHaveBeenCalledWith({ uid: '42', text: '111', sentAt: 124 });
        sockets[0].receive({ type: 'status', roomId: 628684, connected: false });
        sockets[0].onclose?.();
        expect(disconnected).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(3000);
        expect(sockets).toHaveLength(2);
        client.stop();
      });
    } finally {
      globalThis.WebSocket = previous;
      jest.useRealTimers();
    }
  });
});
