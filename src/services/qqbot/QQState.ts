import * as fs from 'fs/promises';
import * as path from 'path';
import { openCommentOwnerLock } from '../bilibili/comment-replies/CommentOwnerLock';
import { QQ_LIMITS } from './QQPolicy';

export interface QQReceipt { at: number; status: 'accepted' | 'generating' | 'sending' | 'sent' | 'unknown' | 'skipped' }
export interface QQState {
  version: 1; appId: string; paused: boolean; day: string; tokens: number; lastSendAt: number; starts: number[];
  images?: number; lastImageAt?: number;
  users: Record<string, { count: number; starts: number[]; privateAt?: number; noticeUntil?: number; images?: number }>;
  receipts: Record<string, QQReceipt>;
}
export const newQQState = (appId: string): QQState => ({ version: 1, appId, paused: false, day: '', tokens: 0,
  lastSendAt: 0, starts: [], users: {}, receipts: {} });
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: string) => /^[a-f0-9]{64}$/u.test(value);
const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateQQState(value: QQState, appId: string): void {
  if (!value || value.version !== 1 || value.appId !== appId || typeof value.paused !== 'boolean' ||
    typeof value.day !== 'string' || value.day !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(value.day) ||
    !time(value.tokens) || !time(value.lastSendAt) || value.images !== undefined && !time(value.images) ||
    value.lastImageAt !== undefined && !time(value.lastImageAt) || !Array.isArray(value.starts) || value.starts.length > QQ_LIMITS.startsPerMinute ||
    value.starts.some(at => !time(at)) || !record(value.users) || Object.keys(value.users).length > QQ_LIMITS.maxReceipts ||
    !record(value.receipts) || Object.keys(value.receipts).length > QQ_LIMITS.maxReceipts) throw new Error('Invalid QQ state');
  for (const [key, user] of Object.entries(value.users)) if (!digest(key) || !user || !time(user.count) ||
    !Array.isArray(user.starts) || user.starts.length > QQ_LIMITS.hourlyUserReplies || user.starts.some(at => !time(at)) ||
    user.privateAt !== undefined && !time(user.privateAt) || user.images !== undefined && !time(user.images) ||
    user.noticeUntil !== undefined && !time(user.noticeUntil)) throw new Error('Invalid QQ user state');
  for (const [key, receipt] of Object.entries(value.receipts)) if (!digest(key) || !receipt || !time(receipt.at) ||
    !['accepted', 'generating', 'sending', 'sent', 'unknown', 'skipped'].includes(receipt.status)) throw new Error('Invalid QQ receipt');
}

/** One owner and atomic receipts, with no message text, openids, model output or credentials. */
export class QQStateStore {
  private lock?: fs.FileHandle;
  constructor(readonly file: string, private readonly appId: string) {}
  async open(): Promise<QQState> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.lock = await openCommentOwnerLock(`${this.file}.lock`, this.appId);
    try {
      await this.lock.writeFile(JSON.stringify({ botUid: this.appId, pid: process.pid }));
      let state = newQQState(this.appId);
      try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      validateQQState(state, this.appId);
      for (const receipt of Object.values(state.receipts)) {
        if (receipt.status === 'sending') { receipt.status = 'unknown'; state.paused = true; }
        else if (receipt.status === 'generating' || receipt.status === 'accepted') receipt.status = 'skipped';
      }
      // Conservative cooldown for any provider request interrupted before its completion checkpoint.
      state.starts = state.starts.map(() => Date.now());
      await this.save(state);
      return state;
    } catch (error) { await this.close(); throw error; }
  }
  async save(state: QQState): Promise<void> {
    if (!this.lock) throw new Error('QQ state lock required');
    validateQQState(state, this.appId);
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
