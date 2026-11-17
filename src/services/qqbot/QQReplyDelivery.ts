import { QQ_RECORD_ANSWER_CHARS } from '../../core/admin/qqRecords';
import { QQRequest, QQ_LIMITS } from './QQPolicy';
import { QQState } from './QQState';
import type { QQRecordUpdate } from './QQRecords';
import { qqDiagnostic } from './QQDiagnostics';
import { QQSendRejectedError } from './QQSendReceipt';

/** Reserve one of the five passive replies for progress; the final text uses at most four. */
export function qqReplyParts(text: string): string[] {
  const chars = Array.from(text), size = 1192;
  if (chars.length > QQ_RECORD_ANSWER_CHARS) throw new Error('QQ reply exceeds archive capacity');
  if (chars.length <= 1200) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + size, chars.length);
    if (end < chars.length) {
      for (let index = end - 1; index >= start + Math.floor(size / 2); index--) {
        if (/[\n。！？；]/u.test(chars[index])) { end = index + 1; break; }
      }
    }
    chunks.push(chars.slice(start, end).join('')); start = end;
  }
  // Fall back to equal-sized chunks if many paragraph boundaries would use an extra reply.
  if (chunks.length > 4) {
    chunks.length = 0;
    for (let start = 0; start < chars.length; start += size) chunks.push(chars.slice(start, start + size).join(''));
  }
  return chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）${chunk}`);
}

export interface QQReplyDeliveryIO {
  now(): number; sleep(ms: number): Promise<unknown>; stopping(): boolean;
  save(state: QQState): Promise<void>; record(request: QQRequest, update: QQRecordUpdate): Promise<void>;
}

/** Every additional message shares the worker's durable clock and original reply window. */
export async function waitQQReplySlot(request: QQRequest, state: QQState, io: QQReplyDeliveryIO): Promise<boolean> {
  if (io.stopping() || state.paused || io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) return false;
  const delay = Math.max(0, state.lastSendAt + QQ_LIMITS.sendIntervalMs - io.now());
  if (delay) await io.sleep(delay);
  if (io.stopping() || state.paused || io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) return false;
  state.lastSendAt = io.now();
  await io.save(state);
  return true;
}

/** A progress message has its own durable send intent; it never marks the generation complete. */
export async function sendQQProgress(request: QQRequest, text: string, state: QQState, io: QQReplyDeliveryIO & {
  send(text: string): Promise<{ id?: string }>; report(event: string): void;
}): Promise<boolean> {
  if (!await waitQQReplySlot(request, state, io)) return false;
  if ((state.receipts[request.key].replies || 0) >= 5) return false;
  state.receipts[request.key].replies = (state.receipts[request.key].replies || 0) + 1;
  state.receipts[request.key].status = 'sending';
  await io.save(state); await io.record(request, { status: 'sending' });
  try {
    const result = await io.send(text);
    if (!result?.id) throw new Error('QQ progress receipt missing');
  } catch (error) {
    const rejected = error instanceof QQSendRejectedError;
    state.receipts[request.key].status = rejected ? 'generating' : 'unknown';
    if (!rejected) state.paused = true;
    await io.save(state);
    await io.record(request, { status: state.receipts[request.key].status,
      sendFailure: qqDiagnostic(error, 'send', 'send_failed') });
    io.report(rejected ? 'qq_progress_rejected' : 'qq_progress_unknown');
    if (!rejected) throw error;
    return true;
  }
  state.receipts[request.key].status = 'generating';
  await io.save(state); await io.record(request, { status: 'generating' });
  io.report('qq_progress_sent');
  return true;
}
