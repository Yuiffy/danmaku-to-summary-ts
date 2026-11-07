import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import type { QQChatMessage } from './QQChatTypes';

export interface QQChatReader {
  recent(conversation: string, before: number, limit?: number): Promise<QQChatMessage[]>;
  range(conversation: string, from: number, to: number, limit?: number): Promise<QQChatMessage[]>;
}

const MAX_TEXT = 2000;
const MAX_CONTEXT = 80;
const safeId = (value: string) => /^[a-f0-9]{64}$/u.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface QQChatInbound {
  kind: string; rawEventType: string; senderId: string; senderName?: string; content: string; messageId: string; timestamp: string; groupOpenid?: string;
  attachments?: Array<{ content_type?: string }>;
}

export class QQChatArchive implements QQChatReader {
  constructor(private readonly root: string, private readonly appId: string, private readonly now = Date.now) {}

  private directory(date: string): string {
    return path.join(this.root, 'data/runtime/qqbot/chat', this.appId, date);
  }

  private file(date: string): string { return path.join(this.directory(date), 'messages.jsonl'); }

  async capture(message: QQChatInbound): Promise<QQChatMessage | undefined> {
    if (message.kind !== 'group' || !message.groupOpenid || typeof message.messageId !== 'string' ||
      !['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(message.rawEventType) ||
      typeof message.content !== 'string') return undefined;
    const createdAt = Date.parse(message.timestamp);
    if (!Number.isFinite(createdAt) || createdAt > this.now() + 60000 || this.now() - createdAt > 7 * 86400000) return undefined;
    const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
    const text = (message.content.trim() || (attachmentCount ? `[${message.attachments!.some(item => item.content_type?.startsWith('image/')) ? '图片' : '附件'}]` : '')).normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!text) return undefined;
    const conversation = digest(JSON.stringify(['group', message.groupOpenid]));
    const user = digest(JSON.stringify(['group', message.senderId]));
    const id = digest(JSON.stringify([this.appId, message.groupOpenid, message.messageId]));
    const record: QQChatMessage = { version: 1, id, appId: this.appId, conversation, user,
      ...(typeof message.senderName === 'string' && message.senderName.trim() ? { senderName: Array.from(message.senderName.trim()).slice(0, 80).join('') } : {}),
      text: Array.from(text).slice(0, MAX_TEXT).join(''), createdAt };
    const file = this.file(shanghaiDay(createdAt));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  async recent(conversation: string, before: number, limit = 24): Promise<QQChatMessage[]> {
    return this.range(conversation, 0, before, Math.min(MAX_CONTEXT, Math.max(1, limit)));
  }

  async range(conversation: string, from: number, to: number, limit = 120): Promise<QQChatMessage[]> {
    if (!safeId(conversation) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return [];
    const days = new Set<string>();
    for (let cursor = Math.max(from, to - 14 * 86400000); cursor <= to; cursor += 86400000) days.add(shanghaiDay(cursor));
    days.add(shanghaiDay(to));
    const found: QQChatMessage[] = [];
    for (const date of days) {
      let text: string;
      try { text = await fs.readFile(this.file(date), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as QQChatMessage;
          if (value.version === 1 && value.appId === this.appId && value.conversation === conversation &&
            value.createdAt >= from && value.createdAt <= to && typeof value.text === 'string') found.push(value);
        } catch { /* ignore a partial/corrupt line; the admin reader reports integrity separately */ }
      }
    }
    const unique = [...new Map(found.map(item => [item.id, item])).values()];
    unique.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return unique.slice(-Math.min(MAX_CONTEXT * 2, Math.max(1, limit)));
  }
}
