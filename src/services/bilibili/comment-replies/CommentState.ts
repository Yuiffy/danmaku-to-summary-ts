import * as fs from 'fs/promises';
import * as path from 'path';
import { CommentAudience, CommentEvent, LIMITS, positiveId, publishableAnswer, QUOTA_NOTICE, SAFETY_NOTICE } from './CommentPolicy';
import { openCommentOwnerLock } from './CommentOwnerLock';
import { CommentFeedbackNote } from '../../../core/admin/commentFeedback';
import { validCommentFeedback } from './CommentFeedback';

export interface CommentJob {
  event: CommentEvent;
  status: 'queued' | 'generating' | 'ready' | 'sending' | 'sent' | 'unknown' | 'failed' | 'expired' | 'skipped';
  answer?: string;
  feedback?: CommentFeedbackNote;
  feedbackSaved?: boolean;
  feedbackRetryAt?: number;
  replyId?: string;
  admittedAt: number;
  notice?: boolean;
  quotaDay?: string;
  quotaAt?: number;
  noticeUntil?: number;
  audience?: CommentAudience;
  processingAt?: number;
  completedAt?: number;
  likeStatus?: 'pending' | 'liked' | 'unknown' | 'skipped';
}
export interface FeedCheckpoint {
  head?: string;
  scan?: { head: string; id: string; time: number };
}
export interface CommentState {
  version: 1;
  botUid: string;
  jobs: CommentJob[];
  feeds: Record<'reply' | 'at', FeedCheckpoint>;
  days: Record<string, { tokens: number; users: Record<string, { count: number; notice: boolean }> }>;
  starts: number[];
  rotation: string[];
  lastSentAt: number;
  paused: boolean;
  pauseAlertAt?: number;
  pauseReason?: 'like_unconfirmed' | 'publication_unconfirmed' | 'platform_blocked';
  userWindows?: Record<string, { starts: number[]; noticeUntil?: number }>;
}
export const newCommentState = (botUid: string): CommentState => ({ version: 1, botUid, jobs: [],
  feeds: { reply: {}, at: {} }, days: {}, starts: [], rotation: [], lastSentAt: 0, paused: false });

function validateState(state: CommentState, botUid: string): void {
  const timestamp = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!state || state.version !== 1 || state.botUid !== botUid || !Array.isArray(state.jobs) || state.jobs.length > LIMITS.maxTracked ||
      !state.feeds?.reply || !state.feeds?.at || !state.days || typeof state.days !== 'object' || Array.isArray(state.days) ||
      !Array.isArray(state.starts) || state.starts.length > LIMITS.startsPerMinute || state.starts.some(at => !timestamp(at)) ||
      !Array.isArray(state.rotation) || state.rotation.some(uid => !positiveId(uid)) || new Set(state.rotation).size !== state.rotation.length ||
      typeof state.paused !== 'boolean' || !timestamp(state.lastSentAt) ||
      state.pauseAlertAt !== undefined && !timestamp(state.pauseAlertAt) ||
      state.pauseReason !== undefined && !['like_unconfirmed', 'publication_unconfirmed', 'platform_blocked'].includes(state.pauseReason)) throw new Error('Invalid comment state schema/account');
  for (const checkpoint of Object.values(state.feeds)) {
    if (typeof checkpoint !== 'object' || checkpoint.head !== undefined && checkpoint.head !== '0' && !positiveId(checkpoint.head) ||
        checkpoint.scan && (!positiveId(checkpoint.scan.head) || !positiveId(checkpoint.scan.id) || !timestamp(checkpoint.scan.time))) throw new Error('Invalid comment feed checkpoint');
  }
  for (const [day, usage] of Object.entries(state.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !usage || !timestamp(usage.tokens) || !usage.users ||
        typeof usage.users !== 'object' || Array.isArray(usage.users)) throw new Error('Invalid comment budget state');
    for (const [uid, user] of Object.entries(usage.users)) {
      if (!positiveId(uid) || !user || !timestamp(user.count) || typeof user.notice !== 'boolean') throw new Error('Invalid comment user quota state');
    }
  }
  if (state.userWindows !== undefined) {
    if (!state.userWindows || typeof state.userWindows !== 'object' || Array.isArray(state.userWindows)) throw new Error('Invalid comment hourly state');
    for (const [uid, window] of Object.entries(state.userWindows)) {
      if (!positiveId(uid) || !window || !Array.isArray(window.starts) || window.starts.length > 1000 ||
        window.starts.some(at => !timestamp(at)) || window.starts.some((at, i) => i > 0 && at < window.starts[i - 1]) ||
        window.noticeUntil !== undefined && !timestamp(window.noticeUntil)) throw new Error('Invalid comment hourly state');
    }
  }
  const keys = new Set<string>();
  for (const job of state.jobs) {
    const event = job?.event;
    if (!event || typeof event.key !== 'string' || !event.key || event.key.length > 120 || keys.has(event.key) ||
        !positiveId(event.uid) || !positiveId(event.oid) || ![1, 11, 12, 17].includes(event.type) ||
        ![event.root, event.parent].every(id => id === '0' || positiveId(id)) || event.parent === '0' && event.root !== '0' ||
        event.parent !== '0' && event.root === '0' || typeof event.text !== 'string' || Array.from(event.text).length > LIMITS.inputChars ||
        !timestamp(event.createdAt) || !timestamp(job.admittedAt) ||
        job.feedback !== undefined && !validCommentFeedback(job.feedback, event) ||
        job.feedbackSaved !== undefined && (typeof job.feedbackSaved !== 'boolean' || !job.feedback) ||
        job.feedbackRetryAt !== undefined && (!timestamp(job.feedbackRetryAt) || !job.feedback) ||
        event.authorName !== undefined && (typeof event.authorName !== 'string' || event.authorName.length > 80) ||
        job.quotaAt !== undefined && !timestamp(job.quotaAt) || job.noticeUntil !== undefined && !timestamp(job.noticeUntil) ||
        job.audience !== undefined && (!['available', 'unavailable'].includes(job.audience.status) ||
          job.audience.wearing !== undefined && (!positiveId(job.audience.wearing.anchorUid) ||
            typeof job.audience.wearing.name !== 'string' || job.audience.wearing.name.length > 40)) ||
        event.trigger !== undefined && !['mention', 'reply'].includes(event.trigger) ||
        job.likeStatus !== undefined && !['pending', 'liked', 'unknown', 'skipped'].includes(job.likeStatus) ||
        job.processingAt !== undefined && !timestamp(job.processingAt) || job.completedAt !== undefined && !timestamp(job.completedAt) ||
        !['queued', 'generating', 'ready', 'sending', 'sent', 'unknown', 'failed', 'expired', 'skipped'].includes(job.status) ||
        job.quotaDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(job.quotaDay) ||
        ['ready', 'sending'].includes(job.status) && job.answer !== QUOTA_NOTICE && job.answer !== SAFETY_NOTICE && !publishableAnswer(job.answer)) {
      throw new Error('Invalid comment job state');
    }
    keys.add(event.key);
    if (['queued', 'ready', 'generating', 'sending'].includes(job.status) && !state.rotation.includes(event.uid)) throw new Error('Missing comment user rotation');
  }
}

/** Exclusive single owner, atomic snapshots. Only demonstrably dead owners can be reclaimed. */
export class CommentStateStore {
  private lock?: fs.FileHandle;
  constructor(readonly file: string, private readonly botUid: string, private readonly isOwnerAlive?: (pid: number) => boolean) {
    if (!path.isAbsolute(file)) throw new Error('Comment state path must be absolute');
  }
  async open(): Promise<CommentState> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.lock = await openCommentOwnerLock(`${this.file}.lock`, this.botUid, this.isOwnerAlive);
    try {
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, botUid: this.botUid }));
      let state: CommentState;
      try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid comment state; refusing to reset');
        state = newCommentState(this.botUid);
      }
      validateState(state, this.botUid);
      if (state.jobs.some(job => job.status === 'generating')) {
        // An interrupted request may have started after its pre-IO timestamp. Cool down all reserved slots.
        state.starts = state.starts.map(() => Date.now());
      }
      for (const job of state.jobs) {
        if (job.likeStatus === 'pending') { job.likeStatus = 'unknown'; state.paused = true; state.pauseReason = 'like_unconfirmed'; }
        if (job.status === 'sending') { job.status = 'unknown'; state.paused = true; state.pauseReason = 'publication_unconfirmed'; }
        if (job.status === 'generating') job.status = 'failed'; // Budget already charged; never repeat uncertain calls.
      }
      await this.save(state);
      return state;
    } catch (error) { await this.close(); throw error; }
  }
  async save(state: CommentState): Promise<void> {
    if (!this.lock) throw new Error('Comment state owner lock is required');
    const temporary = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'w');
    try { await handle.writeFile(JSON.stringify(state), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
  }
  async close(): Promise<void> {
    if (!this.lock) return;
    await this.lock.close(); this.lock = undefined;
    await fs.unlink(`${this.file}.lock`);
  }
}
