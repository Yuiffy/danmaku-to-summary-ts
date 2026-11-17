import * as fs from 'fs/promises';
import * as path from 'path';
import { QQInbound, QQRequest, qqDigest } from './QQPolicy';
import { QQImageInput, qqImageInput } from './QQImageInputPolicy';
import { QQImageInputs } from './QQImageInputs';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { qqImagePreviews } from './QQImageVision';

export const QQ_RECENT_IMAGE_WINDOW_MS = 30 * 60000;
const LIMIT = 3;
const HASH = /^[a-f0-9]{64}$/u;
const caption = (text: string) => text.normalize('NFKC').replace(/<@!?[\w.-]+>/gu, ' ')
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
interface Entry {
  version: 1; id: string; conversation: string; user: string; createdAt: number;
  speaker: 'member' | 'bot'; text: string; input: QQImageInput;
}
export interface QQRecentImagePreview {
  id: string; speaker: 'current_user' | 'other_user' | 'bot'; text: string; createdAt: number;
  available: boolean; imageCount?: number; preview?: Buffer;
}
export interface QQRecentImageSession {
  read(): Promise<{ images: QQRecentImagePreview[]; limited: boolean }>;
  select(id: string): Promise<void>;
}

/** Private attachment sidecars stay out of chat/model JSON; only authenticated events supply URLs. */
export class QQRecentImages {
  constructor(private readonly root: string, private readonly appId: string, private readonly inputs: QQImageInputs,
    private readonly now = Date.now) {}

  private file(at: number): string {
    return path.join(this.root, 'data/runtime/qqbot/chat', this.appId, shanghaiDay(at), 'images.jsonl');
  }

  private async append(entry: Entry): Promise<void> {
    const file = this.file(entry.createdAt);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async capture(message: QQInbound): Promise<void> {
    if (message?.kind !== 'group' || !message.groupOpenid || typeof message.messageId !== 'string' ||
      !['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(message.rawEventType)) return;
    const createdAt = Date.parse(message.timestamp);
    if (!Number.isSafeInteger(createdAt) || createdAt > this.now() + 60000 || this.now() - createdAt > QQ_RECENT_IMAGE_WINDOW_MS) return;
    // Quotes are not new images. Save only actual top-level image attachments.
    const input = qqImageInput({ attachments: message.attachments });
    if (!input?.urls.length || input.invalid) return;
    await this.append({ version: 1, id: qqDigest(JSON.stringify([this.appId, message.groupOpenid, message.messageId])),
      conversation: qqDigest(JSON.stringify(['group', message.groupOpenid])), user: qqDigest(JSON.stringify(['group', message.senderId])),
      createdAt, speaker: 'member', text: caption(String(message.content || '')), input });
  }

  async remember(request: QQRequest, text: string, reference: string): Promise<void> {
    if (request.scope !== 'group') return;
    await this.append({ version: 1, id: qqDigest(JSON.stringify([this.appId, request.targetId, reference])),
      conversation: qqDigest(JSON.stringify(['group', request.targetId])), user: request.user, createdAt: this.now(),
      speaker: 'bot', text: text.slice(0, 500), input: { urls: [], reply: reference } });
  }

  private async entries(request: QQRequest): Promise<Entry[]> {
    if (request.scope !== 'group') return [];
    const conversation = qqDigest(JSON.stringify(['group', request.targetId]));
    const from = request.createdAt - QQ_RECENT_IMAGE_WINDOW_MS;
    const files = [...new Set([this.file(from), this.file(request.createdAt)])];
    const entries: Entry[] = [];
    for (const file of files) {
      let text: string;
      try {
        if ((await fs.stat(file)).size > 16 * 1024 * 1024) continue;
        text = await fs.readFile(file, 'utf8');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as Entry;
          if (entry.version === 1 && HASH.test(entry.id) && HASH.test(entry.user) && entry.conversation === conversation &&
            Number.isSafeInteger(entry.createdAt) && entry.createdAt >= from && entry.createdAt <= request.createdAt &&
            ['member', 'bot'].includes(entry.speaker) && typeof entry.text === 'string' && entry.text.length <= 500 &&
            entry.input && Array.isArray(entry.input.urls)) entries.push(entry);
        } catch { /* Ignore partial lines; never widen the group/time boundary. */ }
      }
    }
    return [...new Map(entries.map(entry => [entry.id, entry])).values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  forRequest(request: QQRequest, signal: AbortSignal): QQRecentImageSession {
    const sources = new Map<string, QQRequest>();
    let reading: Promise<{ images: QQRecentImagePreview[]; limited: boolean }> | undefined;
    let selected: string | undefined;
    const read = () => reading ||= (async () => {
      const entries = await this.entries(request);
      const images: QQRecentImagePreview[] = [];
      for (const [index, entry] of entries.slice(0, LIMIT).entries()) {
        signal.throwIfAborted();
        const id = `recent_${index + 1}`;
        const item: QQRecentImagePreview = { id, speaker: entry.speaker === 'bot' ? 'bot' : entry.user === request.user ? 'current_user' : 'other_user',
          text: entry.text, createdAt: entry.createdAt, available: false };
        const source = { ...request, imageInput: entry.input };
        try {
          const buffers = await this.inputs.load(source, signal);
          item.preview = (await qqImagePreviews(buffers.slice(0, 1)))[0];
          item.imageCount = buffers.length;
          item.available = true;
          sources.set(id, source);
        } catch { signal.throwIfAborted(); }
        images.push(item);
      }
      return { images, limited: entries.length > LIMIT };
    })();
    return { read, select: async id => {
      if (selected === id) return;
      const source = sources.get(id);
      if (selected || !source) throw new Error('QQ recent image unavailable or already selected');
      await this.inputs.select(request, source, signal);
      selected = id;
    } };
  }
}
