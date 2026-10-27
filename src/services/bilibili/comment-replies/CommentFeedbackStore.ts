import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { CommentFeedbackNote, CommentFeedbackRecord } from '../../../core/admin/commentFeedback';
import { CommentEvent, positiveId } from './CommentPolicy';
import { validCommentFeedback } from './CommentFeedback';

/** Immutable, independently retained records. Called only by the locked comment consumer. */
export class CommentFeedbackStore {
  constructor(private readonly directory: string, private readonly now = Date.now) {}
  async collect(event: CommentEvent, note: CommentFeedbackNote): Promise<void> {
    if (!validCommentFeedback(note, event) || ![event.oid, event.parent, event.root, event.uid].every(positiveId)) throw new Error('Invalid video feedback');
    const id = createHash('sha256').update(event.key).digest('hex');
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${id}.json`);
    const record: CommentFeedbackRecord = { version: 1, id, source: 'bilibili-mention', eventKey: event.key,
      videoAid: event.oid, commentId: event.parent, rootId: event.root, authorUid: event.uid,
      authorName: event.authorName || '', comment: event.text, commentCreatedAt: event.createdAt, collectedAt: this.now(), ...note };
    const temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Atomic no-overwrite publication: a replay can neither duplicate nor replace the first record.
      try { await fs.link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = JSON.parse(await fs.readFile(target, 'utf8')) as CommentFeedbackRecord;
        if (existing.id !== id || existing.eventKey !== event.key || existing.version !== 1) throw new Error('Invalid existing video feedback');
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
