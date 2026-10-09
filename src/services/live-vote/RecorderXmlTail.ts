import * as fs from 'fs/promises';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { parseString } from 'xml2js';
import { VoteDanmaku } from './VoteSession';

export function parseXmlDanmakuLine(line: string): VoteDanmaku | null {
  if (!/^\s*<d\s/u.test(line)) return null;
  let result: any;
  parseString(`<i>${line}</i>`, { explicitArray: false }, (error, parsed) => {
    if (!error) result = parsed;
  });
  const record = result?.i?.d;
  const parts = record?.$?.p?.split(',');
  const uid = parts?.[6];
  const sentAt = Number(parts?.[4]);
  if (!uid || !/^\d+$/u.test(uid) || !Number.isFinite(sentAt) || sentAt <= 0 || typeof record._ !== 'string') return null;
  return { uid, text: record._, sentAt };
}

export class RecorderXmlTail {
  private currentPath: string | null = null;
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private initialized = false;

  constructor(private readonly root: string, private readonly roomId: string,
    private readonly onMessage: (message: VoteDanmaku) => void) {}

  async poll(): Promise<void> {
    const file = await this.findLatestFile();
    if (!file) return;
    const stat = await fs.stat(file);
    if (file !== this.currentPath || stat.size < this.offset) {
      this.currentPath = file;
      this.offset = this.initialized ? 0 : stat.size;
      this.pending = '';
      this.decoder = new StringDecoder('utf8');
    }
    this.initialized = true;
    if (stat.size === this.offset) return;
    const handle = await fs.open(file, 'r');
    try {
      while (this.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(65536, stat.size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await handle.close();
    }
  }

  private consume(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      const message = parseXmlDanmakuLine(line);
      if (message) this.onMessage(message);
    }
    if (this.pending.length > 131072) throw new Error('Recorder XML line exceeds 128 KiB');
  }

  private async findLatestFile(): Promise<string | null> {
    const rooms = await fs.readdir(this.root, { withFileTypes: true });
    const room = rooms.find(entry => entry.isDirectory() && entry.name.startsWith(`${this.roomId}_`));
    if (!room) return null;
    const roomPath = path.join(this.root, room.name);
    const dates = (await fs.readdir(roomPath, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d{4}_\d{2}_\d{2}$/u.test(entry.name))
      .map(entry => entry.name).sort().slice(-2);
    let latest: { file: string; mtime: number } | null = null;
    for (const date of dates) {
      const folder = path.join(roomPath, date);
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml') || entry.name.includes('_merged')) continue;
        const file = path.join(folder, entry.name);
        const { mtimeMs } = await fs.stat(file);
        if (!latest || mtimeMs > latest.mtime) latest = { file, mtime: mtimeMs };
      }
    }
    return latest?.file ?? null;
  }
}
