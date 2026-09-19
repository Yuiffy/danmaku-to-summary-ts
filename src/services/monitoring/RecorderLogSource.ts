import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { RoomLiveStatus } from '../bilibili/interfaces/types';

export type RecorderLogEventKind = 'risk' | 'api-recovered' | 'api-success' | 'connected' | 'disconnected';
export interface RecorderLogEvent {
  id: string;
  at: number;
  kind: RecorderLogEventKind;
  roomId?: string;
  endpoint?: string;
}
export interface RecorderLogSnapshot {
  identity: string;
  events: RecorderLogEvent[];
  rooms: Map<string, RoomLiveStatus & { observedAt: number }>;
}
interface Cursor { offset: number; signature: string; }
interface SourceOptions {
  logDirectory?: string;
  recorderStatePath?: string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

const API_ENDPOINTS = new Set(['getDanmuInfo', 'getInfoByRoom', 'getRoomPlayInfo']);
const DAY = 24 * 60 * 60 * 1000;
const CHUNK = 1024 * 1024;

/** Shared, incremental JSONL reader. It never queries Bilibili or starts a process. */
export class RecorderLogSource {
  private identity = '';
  private cursors = new Map<string, Cursor>();
  private events: RecorderLogEvent[] = [];
  private rooms = new Map<string, RoomLiveStatus & { observedAt: number }>();
  private reading?: Promise<RecorderLogSnapshot>;
  private lastReadAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: SourceOptions = {}) {
    this.now = options.now || Date.now;
  }

  private configured(): SourceOptions {
    if (this.options.recorderStatePath) return this.options;
    const config = ConfigProvider.getConfig().bilibili?.danmuRiskControl;
    return { logDirectory: config?.logDirectory, recorderStatePath: config?.recorderStatePath };
  }

  async read(): Promise<RecorderLogSnapshot> {
    if (this.reading) return this.reading;
    this.reading = this.readCore();
    try { return await this.reading; } finally { this.reading = undefined; }
  }

  private async readCore(): Promise<RecorderLogSnapshot> {
    const options = this.configured();
    let state: any;
    try {
      state = JSON.parse((await fs.readFile(options.recorderStatePath || path.resolve('data/runtime/recorder_watchdog.state.json'), 'utf8')).replace(/^\uFEFF/, ''));
    } catch { throw new Error('无法读取录播姬进程状态，日志监控状态未知'); }
    const current = state.lastSeen;
    const now = this.now();
    const startedAt = Date.parse(current?.startedAt);
    const heartbeat = Number(state.heartbeatAt);
    const observed = Number(current?.observedAt);
    if (!Number.isInteger(current?.pid) || current.pid <= 0 || !Number.isFinite(startedAt) ||
        !current.executablePath || !['healthy', 'confirming_recovery'].includes(state.phase) ||
        !Number.isFinite(heartbeat) || !Number.isFinite(observed) ||
        now - heartbeat > 120000 || now - observed > 120000 || heartbeat > now + 60000 ||
        !this.alive(current.pid)) {
      throw new Error('录播姬进程身份不可确认或守护状态已过期，日志监控状态未知');
    }
    const logDirectory = options.logDirectory || path.join(path.dirname(current.executablePath), 'logs');
    const identity = `${current.pid}:${current.startedAt}:${path.resolve(logDirectory)}`;
    if (identity !== this.identity) {
      this.identity = identity;
      this.cursors.clear();
      this.events = [];
      this.rooms.clear();
      this.lastReadAt = 0;
    }
    // All fallback rooms share one read. Process identity is still checked on
    // every call, so this cache cannot claim an old PID is healthy.
    if (this.lastReadAt && now - this.lastReadAt < 1000) return this.snapshot();
    let names: string[];
    try { names = await fs.readdir(logDirectory); }
    catch { throw new Error('无法读取录播姬日志目录，日志监控状态未知'); }
    const files = names.filter(name => /^bilirec\d{8}(?:_\d+)?\.(?:txt|jsonl|log)$/i.test(name)).sort();
    let found = false;
    for (const name of files) {
      const filename = path.join(logDirectory, name);
      let stat;
      try { stat = await fs.stat(filename); } catch { continue; }
      // Startup replay is bounded to recent logs. Older records cannot be used
      // to manufacture recovery; fresh room information arrives by normal polls.
      if (!stat.isFile() || stat.mtimeMs < Math.max(startedAt - 1000, now - DAY)) continue;
      found = true;
      const signature = `${stat.ino}:${stat.birthtimeMs}`;
      let cursor = this.cursors.get(filename);
      if (!cursor || cursor.signature !== signature || stat.size < cursor.offset) cursor = { offset: 0, signature };
      const handle = await fs.open(filename, 'r');
      try {
        while (cursor.offset < stat.size) {
          const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - cursor.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
          if (!bytesRead) break;
          const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
          if (end < 0) {
            if (bytesRead < CHUNK) break; // A partial write is retried next poll.
            // Oversized records (e.g. config dumps) are irrelevant. Advance to
            // the next newline without retaining credential-bearing content.
            const skipped = await this.skipLine(handle, cursor.offset, stat.size);
            if (skipped === cursor.offset) break;
            cursor.offset = skipped;
            continue;
          }
          let offset = 0;
          while (offset <= end) {
            const newline = buffer.indexOf(10, offset);
            if (newline < 0 || newline > end) break;
            const text = buffer.subarray(offset, newline).toString('utf8').replace(/^\uFEFF/, '');
            this.accept(text, `${name}:${signature}:${cursor.offset + offset}`, current.pid, startedAt, now);
            offset = newline + 1;
          }
          cursor.offset += end + 1;
        }
      } finally { await handle.close(); }
      this.cursors.set(filename, cursor);
    }
    if (!found) throw new Error('没有找到当前录播姬的日志，监控状态未知');
    this.events = this.events.filter(event => event.at >= now - DAY).slice(-10000);
    this.lastReadAt = now;
    return this.snapshot();
  }

  private async skipLine(handle: fs.FileHandle, offset: number, size: number): Promise<number> {
    let position = offset;
    while (position < size) {
      const bytes = Buffer.alloc(Math.min(CHUNK, size - position));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (!bytesRead) break;
      const end = bytes.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) return position + end + 1;
      position += bytesRead;
    }
    return offset;
  }

  private alive(pid: number): boolean {
    if (this.options.isAlive) return this.options.isAlive(pid);
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private snapshot(): RecorderLogSnapshot {
    return { identity: this.identity, events: [...this.events].sort((a, b) => a.at - b.at), rooms: new Map(this.rooms) };
  }

  private accept(line: string, id: string, pid: number, startedAt: number, now: number): void {
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    const at = Date.parse(row['@t']);
    if (row.ProcessId !== pid || !Number.isFinite(at) || at < startedAt - 1000 || at < now - DAY || at > now + 60000) return;
    const message = String(row['@mt'] || '');
    const roomId = /^\d+$/.test(String(row.RoomId)) ? String(row.RoomId) : undefined;
    const endpoint = API_ENDPOINTS.has(row.Endpoint) ? row.Endpoint : undefined;
    // Content identity survives an external rotate/copy of the same JSONL
    // record. Preserve the original sub-millisecond timestamp in the digest.
    const eventId = createHash('sha256').update(JSON.stringify([pid, row['@t'], message, roomId, endpoint])).digest('hex');
    const emit = (kind: RecorderLogEventKind, api?: string) => this.events.push({ id: `${eventId}:${kind}`, at, kind, roomId, endpoint: api });
    if (message === 'Bilibili API -352 cooldown: {Endpoint}, RetryAt={RetryAt}' && endpoint) emit('risk', endpoint);
    else if (message === 'Bilibili API risk-control recovered: {Endpoint}' && endpoint) emit('api-recovered', endpoint);
    else if (message === '弹幕认证成功: 房间 {RoomId}' && roomId) emit('connected');
    else if ((message.startsWith('与弹幕服务器的连接被断开') || message.startsWith('连接弹幕服务器时出错')) && roomId) {
      // A locally rejected cooldown is already represented by its shared API
      // incident. Do not call it a new network disconnection.
      if (!/BrokenCircuit|ExecutionRejected|BulkheadRejected/.test(row.ExceptionDetail?.Type || '')) emit('disconnected');
    } else if (message.startsWith('连接弹幕服务器 {Mode}')) emit('api-success', 'getDanmuInfo');
    else if (message.startsWith('连接直播服务器 {Host}')) emit('api-success', 'getRoomPlayInfo');
    else if (message === '拉取房间信息成功: {@room}' && roomId) {
      const room = row.room?.Room;
      if (!room || ![0, 1, 2].includes(room.LiveStatus)) return;
      const previous = this.rooms.get(roomId);
      if (!previous || at > previous.observedAt) this.rooms.set(roomId, {
        roomId, uid: String(room.Uid), liveStatus: room.LiveStatus,
        isLive: room.LiveStatus === 1, title: String(room.Title || ''), observedAt: at
      });
      emit('api-success', 'getInfoByRoom');
    }
  }

  async getRoomLiveStatus(roomId: string): Promise<RoomLiveStatus & { observedAt: number }> {
    const snapshot = await this.read();
    const room = snapshot.rooms.get(String(roomId));
    // Other rooms poll every six minutes. Missing/stale data remains unknown,
    // never an implicit offline result and never a fallback network request.
    if (!room || this.now() - room.observedAt > 10 * 60 * 1000) throw new Error('录播日志没有新鲜的房间状态');
    return room;
  }
}

export const recorderLogSource = new RecorderLogSource();
