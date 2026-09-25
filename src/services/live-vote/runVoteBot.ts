import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { RecorderXmlTail } from './RecorderXmlTail';
import { VoteConfig, VoteSession } from './VoteSession';
import { LocalDanmakuClient } from './LocalDanmakuClient';
import { BilibiliDanmakuClient } from './BilibiliDanmakuClient';
import { MultiRoomVoteBot } from './MultiRoomVoteBot';

interface RuntimeConfig extends Omit<VoteConfig, 'authorizedUids'> {
  roomId?: string;
  authorizedUids?: string[];
  rooms?: 'auto-record';
  globalAdminUids?: string[];
  recorderSettingsFile?: string;
  credentialConfigPath?: string;
  statePath?: string;
  recorderRoot?: string;
  recorderSocketUrl?: string;
  source?: 'bilibili' | 'recorder' | 'xml';
}

export class VoteSender {
  constructor(private readonly roomId: string, private readonly botUid: string, private readonly live: boolean,
    private readonly cookie = process.env.BILIBILI_VOTE_COOKIE || '',
    private readonly rateLimit = { lastSentAt: 0 }) {
    if (live) {
      const uid = /(?:^|;\s*)DedeUserID=(\d+)/u.exec(cookie)?.[1];
      if (!uid || uid !== botUid || !/(?:^|;\s*)SESSDATA=/u.test(cookie) || !/(?:^|;\s*)bili_jct=/u.test(cookie)) {
        throw new Error('BILIBILI_VOTE_COOKIE must contain SESSDATA, bili_jct and matching DedeUserID');
      }
    }
  }

  async send(message: string, isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return;
    if (!this.live) {
      console.log(`[dry-run room ${this.roomId}] ${message}`);
      return;
    }
    const delay = Math.max(0, 3000 - (Date.now() - this.rateLimit.lastSentAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (!isCurrent()) return;
    const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(this.cookie)![1];
    const body = new URLSearchParams({
      roomid: this.roomId, msg: message, csrf, csrf_token: csrf,
      rnd: String(Math.floor(Date.now() / 1000)), color: '16777215', fontsize: '25', mode: '1'
    });
    this.rateLimit.lastSentAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://api.live.bilibili.com/msg/send', {
        method: 'POST', body, signal: controller.signal as any,
        headers: { Cookie: this.cookie, Referer: `https://live.bilibili.com/${this.roomId}` }
      });
      const data = await response.json() as { code?: number; message?: string };
      if (!response.ok || data.code !== 0) throw new Error(`send failed: HTTP ${response.status}, code ${data.code}, ${data.message || ''}`);
      console.log(`[sent room ${this.roomId}] ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readLocalSettings(file: string): any {
  if (!path.isAbsolute(file)) throw new Error('Credential/settings file paths must be absolute');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Could not read local credential/settings file'); }
}

function relayToken(config: RuntimeConfig): string {
  return process.env.BILILIVE_LOCAL_DANMAKU_TOKEN ||
    (config.recorderSettingsFile ? readLocalSettings(config.recorderSettingsFile).token : '') || '';
}

function runAllRecorderRooms(config: RuntimeConfig, live: boolean, cookie: string): void {
  if (!config.recorderSocketUrl || !Array.isArray(config.globalAdminUids) ||
      config.globalAdminUids.some(uid => typeof uid !== 'string' || !/^[1-9]\d*$/u.test(uid)) ||
      (config.statePath && !path.isAbsolute(config.statePath))) {
    throw new Error('Configure recorderSocketUrl, globalAdminUids and an optional absolute statePath');
  }
  const rateLimit = { lastSentAt: 0 };
  const senders = new Map<string, VoteSender>();
  // Validate credentials before starting the source; no messages are sent at startup.
  new VoteSender('1', config.botUid || '', live, cookie, rateLimit);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let source: LocalDanmakuClient;
  const saveState = (connected: boolean, rooms: Array<{ roomId: string; ownerUid: string; connected: boolean }> = []) => {
    const state = { at: new Date().toISOString(), source: 'recorder', liveSend: live, connected,
      roomCount: rooms.length, readyRooms: rooms.filter(room => room.connected && room.ownerUid !== '0').length,
      rooms };
    if (config.statePath) {
      fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
      fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));
    }
    console.log(`Recorder vote rooms: ${state.roomCount}, ready: ${state.readyRooms}, local connection: ${connected}`);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    bot.stop();
    source?.stop();
  };
  const bot = new MultiRoomVoteBot({ ...config, globalAdminUids: config.globalAdminUids }, async (roomId, message, isCurrent) => {
    let sender = senders.get(roomId);
    if (!sender) { sender = new VoteSender(roomId, config.botUid || '', live, cookie, rateLimit); senders.set(roomId, sender); }
    await sender.send(message, isCurrent);
  }, error => {
    console.error('Multi-room vote sending stopped:', error);
    stop();
    process.exitCode = 1;
  });
  source = new LocalDanmakuClient(config.recorderSocketUrl, relayToken(config), '*', message => bot.ingest(message),
    () => { bot.disconnect(); saveState(false); }, rooms => { bot.updateRooms(rooms); saveState(true, rooms); });
  source.start();
  timer = setInterval(() => bot.tick(), 1000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`Vote bot using one local recorder connection for all auto-record rooms (${live ? 'LIVE SEND' : 'dry-run'}).`);
}

export async function runVoteBot(configPath: string, live = false): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RuntimeConfig;
  if (config.maxMessageChars !== undefined && (!Number.isInteger(config.maxMessageChars) || config.maxMessageChars < 20 || config.maxMessageChars > 40)) {
    throw new Error('maxMessageChars must be between 20 and 40');
  }
  const cookie = process.env.BILIBILI_VOTE_COOKIE ||
    (live && config.credentialConfigPath ? readLocalSettings(config.credentialConfigPath).bilibili?.cookie : '') || '';
  if (config.rooms !== undefined) {
    if (config.rooms !== 'auto-record' || config.source !== 'recorder') throw new Error('Multi-room mode requires the recorder source');
    runAllRecorderRooms(config, live, cookie);
    return;
  }
  if (typeof config.roomId !== 'string' || !/^\d+$/u.test(config.roomId) ||
      !Number.isSafeInteger(Number(config.roomId)) || Number(config.roomId) <= 0 ||
      !Array.isArray(config.authorizedUids) || !config.authorizedUids.length ||
      config.authorizedUids.some(uid => typeof uid !== 'string' || !/^\d+$/u.test(uid)) ||
      !['bilibili', 'recorder', 'xml'].includes(config.source || 'bilibili') ||
      (live && (typeof config.botUid !== 'string' || !/^\d+$/u.test(config.botUid)))) {
    throw new Error('Configure a numeric roomId, authorizedUids and botUid');
  }
  const sender = new VoteSender(config.roomId, config.botUid || '', live, cookie);
  let queue = Promise.resolve();
  let source: { start(): void; stop(): void } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;
  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    generation++;
    if (timer) clearInterval(timer);
    source?.stop();
    session.cancel();
  };
  const session = new VoteSession({ ...config, authorizedUids: config.authorizedUids! }, message => {
    const current = generation;
    queue = queue.then(() => sender.send(message, () => !closed && current === generation)).catch(error => {
      console.error('Sending stopped:', error);
      stop();
      process.exitCode = 1;
    });
  }, () => { generation++; });
  let tail: RecorderXmlTail | null = null;
  const disconnect = (): void => { generation++; session.cancel(); };
  if (config.source === 'xml') {
    if (!config.recorderRoot || !path.isAbsolute(config.recorderRoot)) throw new Error('recorderRoot must be absolute for XML source');
    tail = new RecorderXmlTail(config.recorderRoot, config.roomId, message => session.ingest(message));
    await tail.poll();
  } else if (config.source === 'recorder') {
    if (!config.recorderSocketUrl) throw new Error('recorderSocketUrl is required');
    source = new LocalDanmakuClient(config.recorderSocketUrl, relayToken(config),
      config.roomId, message => session.ingest(message), disconnect);
  } else {
    const listenCookie = process.env.BILIBILI_VOTE_LISTEN_COOKIE || process.env.BILIBILI_VOTE_COOKIE || '';
    if (!listenCookie) {
      throw new Error('Direct UID-based voting requires BILIBILI_VOTE_LISTEN_COOKIE or BILIBILI_VOTE_COOKIE; anonymous messages may have UID 0. Dry-run does not send messages.');
    }
    source = new BilibiliDanmakuClient(Number(config.roomId), message => session.ingest(message), disconnect,
      undefined, () => { stop(); process.exitCode = 1; }, listenCookie);
  }
  console.log(`Vote bot watching room ${config.roomId} via ${config.source || 'bilibili'} (${live ? 'LIVE SEND' : 'dry-run'}).`);
  source?.start();
  if (closed) return;
  let polling = false;
  timer = setInterval(async () => {
    if (closed || polling) return;
    polling = true;
    try {
      if (tail) await tail.poll();
      session.tick();
    } catch (error) {
      console.error('Vote source unavailable; vote cancelled:', error);
      stop();
      process.exitCode = 1;
    } finally {
      polling = false;
    }
  }, 1000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) {
    console.error('Usage: node dist/services/live-vote/runVoteBot.js --config <path> [--send]');
    process.exitCode = 1;
  } else {
    runVoteBot(process.argv[index + 1], process.argv.includes('--send')).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
