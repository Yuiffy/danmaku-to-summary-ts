import * as fs from 'fs/promises';
import * as path from 'path';
import { QQRecord, validQQRecord } from '../../core/admin/qqRecords';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQRequest, qqDigest } from './QQPolicy';

export type QQRecordUpdate = Pick<QQRecord, 'status'> & Partial<Pick<QQRecord, 'answer' | 'model' | 'error' | 'image' | 'agent'>>;

/** Independent long-lived transcripts; atomic checkpoints precede provider and QQ IO. */
export class QQRecords {
  constructor(private readonly root: string, private readonly appId: string, private readonly now = Date.now) {}
  async write(request: QQRequest, update: QQRecordUpdate): Promise<void> {
    const directory = path.join(this.root, 'data/runtime/qqbot/records', this.appId, shanghaiDay(request.createdAt));
    const file = path.join(directory, `${request.key}.json`);
    await fs.mkdir(directory, { recursive: true });
    let previous: Partial<QQRecord> = {};
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const record: QQRecord = { version: 1, id: request.key, appId: this.appId, scope: request.scope, user: request.user,
      conversation: qqDigest(JSON.stringify([request.scope, request.targetId])), question: request.text, answer: '', model: '',
      requestedAt: request.createdAt, ...(request.senderName ? { senderName: request.senderName } : {}),
      ...previous, ...update, updatedAt: Math.max(this.now(), request.createdAt) };
    if (!validQQRecord(record)) throw new Error('Invalid QQ transcript');
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  }
}
