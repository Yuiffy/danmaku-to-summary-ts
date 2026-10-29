export interface CommentFeedDiagnostic {
  feed: 'reply' | 'at';
  reason: 'network' | 'http' | 'platform' | 'payload';
  httpStatus?: number;
  code?: number;
  transportCode?: string;
  contentType?: 'json' | 'html' | 'text' | 'other' | 'missing';
  bodyBytes?: number;
  bodySha256?: string;
  payloadStage?: 'json' | 'items' | 'cursor' | 'pagination';
  bodyFormat?: 'json' | 'html' | 'text';
  itemsType?: string;
  itemCount?: number;
  cursorType?: string;
  endType?: string;
  idType?: string;
  timeType?: string;
}

/** Contains only allowlisted diagnostics, never transport messages, response text or credentials. */
export class CommentFeedError extends Error {
  constructor(readonly retryable: boolean, readonly diagnostic: CommentFeedDiagnostic) {
    super('Comment notification read failed');
  }
}

interface PollAdapters {
  now(): number;
  poll(): Promise<void>;
  report(event: Record<string, unknown>): void;
}

/** Only failed, explicitly transient GETs back off. Publication and storage failures never enter this retry path. */
export class CommentPoller {
  private nextAt = 0;
  private failures = 0;
  constructor(private readonly intervalMs: number, private readonly adapters: PollAdapters) {}

  async tick(): Promise<void> {
    if (this.adapters.now() < this.nextAt) return;
    try { await this.adapters.poll(); }
    catch (error) {
      if (!(error instanceof CommentFeedError) || !error.retryable) throw error;
      this.failures++;
      const retryInMs = Math.max(this.intervalMs, Math.min(300000, 30000 * 2 ** Math.min(this.failures - 1, 4)));
      this.nextAt = this.adapters.now() + retryInMs;
      this.adapters.report({ event: 'comment_poll_retry', ...error.diagnostic, failures: this.failures, retryInMs });
      return;
    }
    if (this.failures) this.adapters.report({ event: 'comment_poll_recovered', failures: this.failures });
    this.failures = 0;
    this.nextAt = this.adapters.now() + this.intervalMs;
  }
}
