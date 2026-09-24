import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { RecorderXmlTail } from './RecorderXmlTail';
import { VoteConfig, VoteSession } from './VoteSession';
import { LocalDanmakuClient } from './LocalDanmakuClient';
import { BilibiliDanmakuClient } from './BilibiliDanmakuClient';

interface RuntimeConfig extends VoteConfig {
  roomId: string;
  recorderRoot?: string;
  recorderSocketUrl?: string;
  source?: 'bilibili' | 'recorder' | 'xml';
}

export class VoteSender {
  private lastSentAt = 0;
  constructor(private readonly roomId: string, private readonly botUid: string, private readonly live: boolean,
    private readonly cookie = process.env.BILIBILI_VOTE_COOKIE || '') {
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
      console.log(`[dry-run] ${message}`);
      return;
    }
    const delay = Math.max(0, 3000 - (Date.now() - this.lastSentAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (!isCurrent()) return;
    const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(this.cookie)![1];
    const body = new URLSearchParams({
      roomid: this.roomId, msg: message, csrf, csrf_token: csrf,
      rnd: String(Math.floor(Date.now() / 1000)), color: '16777215', fontsize: '25', mode: '1'
    });
    this.lastSentAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://api.live.bilibili.com/msg/send', {
        method: 'POST', body, signal: controller.signal as any,
        headers: { Cookie: this.cookie, Referer: `https://live.bilibili.com/${this.roomId}` }
      });
      const data = await response.json() as { code?: number; message?: string };
      if (!response.ok || data.code !== 0) throw new Error(`send failed: HTTP ${response.status}, code ${data.code}, ${data.message || ''}`);
      console.log(`[sent] ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function runVoteBot(configPath: string, live = false): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RuntimeConfig;
  if (typeof config.roomId !== 'string' || !/^\d+$/u.test(config.roomId) ||
      !Number.isSafeInteger(Number(config.roomId)) || Number(config.roomId) <= 0 ||
      !Array.isArray(config.authorizedUids) || !config.authorizedUids.length ||
      config.authorizedUids.some(uid => typeof uid !== 'string' || !/^\d+$/u.test(uid)) ||
      !['bilibili', 'recorder', 'xml'].includes(config.source || 'bilibili') ||
      (live && (typeof config.botUid !== 'string' || !/^\d+$/u.test(config.botUid)))) {
    throw new Error('Configure a numeric roomId, authorizedUids and botUid');
  }
  const sender = new VoteSender(config.roomId, config.botUid || '', live);
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
  const session = new VoteSession(config, message => {
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
    source = new LocalDanmakuClient(config.recorderSocketUrl, process.env.BILILIVE_LOCAL_DANMAKU_TOKEN || '',
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
