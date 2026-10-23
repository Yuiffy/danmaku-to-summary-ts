import { FeedPage } from './CommentApi';
import { CommentEvent, notificationEvent, positiveId } from './CommentPolicy';
import { CommentState } from './CommentState';

interface InboxAdapters {
  feed(kind: 'reply' | 'at', cursor?: { id: string; time: number }): Promise<FeedPage>;
  admit(event: CommentEvent): Promise<'accepted' | 'duplicate' | 'ignored' | 'full'>;
  save(state: CommentState): Promise<void>;
}

/** Persist page checkpoints only after admission. Full queues keep their page for the next poll. */
export async function pollCommentInbox(state: CommentState, adapters: InboxAdapters): Promise<void> {
  for (const kind of ['reply', 'at'] as const) {
    const checkpoint = state.feeds[kind];
    for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
      const page = await adapters.feed(kind, checkpoint.scan);
      const newest = positiveId(page.items[0]?.id) || '0';
      if (page.items.some(row => !positiveId(row?.id))) throw new Error('Invalid notification identity');
      if (checkpoint.head === undefined) {
        // First start establishes a baseline: never greet years of historical comments.
        checkpoint.head = newest;
        await adapters.save(state); break;
      }
      const candidateHead = checkpoint.scan?.head || newest;
      const head = BigInt(candidateHead) > BigInt(checkpoint.head) ? candidateHead : checkpoint.head;
      let reachedHead = false, full = false;
      for (const row of page.items) {
        // Notification IDs are ordered; a deleted high-water row must not trigger historical replay.
        if (BigInt(row.id) <= BigInt(checkpoint.head)) { reachedHead = true; break; }
        const event = notificationEvent(kind, row, state.botUid);
        // Still examine other UIDs on the page, so one user's backlog cannot hide everybody else.
        if (event && await adapters.admit(event) === 'full') full = true;
      }
      if (full) break;
      if (reachedHead || page.cursor.is_end || !page.items.length) {
        checkpoint.head = head; delete checkpoint.scan;
        await adapters.save(state); break;
      }
      if (!page.cursor.id || checkpoint.scan?.id === page.cursor.id) throw new Error('Notification cursor made no progress');
      checkpoint.scan = { head, id: page.cursor.id, time: page.cursor.time! };
      await adapters.save(state);
    }
  }
}
