describe('recorder relay vote source', () => {
  it('routes only snapshot-listed connected rooms and clears membership on socket loss', () => {
    const previous = globalThis.WebSocket;
    const sockets: any[] = [];
    class Socket {
      onmessage: any;
      onclose: any;
      onerror: any;
      close = jest.fn();
      constructor() { sockets.push(this); }
      frame(value: object) { this.onmessage({ data: JSON.stringify(value) }); }
    }
    globalThis.WebSocket = Socket as any;
    jest.useFakeTimers();
    try {
      jest.isolateModules(() => {
        const { LocalDanmakuClient } = require('./LocalDanmakuClient');
        const receive = jest.fn();
        const disconnect = jest.fn();
        const rooms = jest.fn();
        const client = new LocalDanmakuClient('ws://127.0.0.1:17896/api/local/danmaku', '0123456789abcdef', '*', receive, disconnect, rooms);
        client.start();
        const message = { type: 'danmaku', roomId: 100, uid: '10', text: '1', sentAt: 123 };
        sockets[0].frame(message);
        expect(receive).not.toHaveBeenCalled();
        sockets[0].frame({ type: 'rooms', version: 1, rooms: [{ roomId: 100, ownerUid: '10', connected: true }, { roomId: 200, ownerUid: '20', connected: false }] });
        expect(rooms).toHaveBeenCalledWith([{ roomId: '100', ownerUid: '10', connected: true }, { roomId: '200', ownerUid: '20', connected: false }]);
        sockets[0].frame({ ...message, roomId: 200 });
        sockets[0].frame({ ...message, roomId: 300 });
        sockets[0].frame(message);
        expect(receive).toHaveBeenCalledTimes(1);
        expect(receive).toHaveBeenCalledWith({ roomId: '100', uid: '10', text: '1', sentAt: 123 });
        sockets[0].frame({ type: 'rooms', version: 1, rooms: [] });
        sockets[0].frame(message);
        sockets[0].onclose();
        expect(disconnect).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(3000);
        sockets[0].frame(message);
        sockets[1].frame(message);
        expect(receive).toHaveBeenCalledTimes(1);
        client.stop();
      });
    } finally { globalThis.WebSocket = previous; jest.useRealTimers(); }
  });
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
