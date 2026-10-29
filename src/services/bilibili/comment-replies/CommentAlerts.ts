import { CommentState } from './CommentState';
import { CommentFeedDiagnostic } from './CommentPolling';

export interface CommentPauseDiagnostic {
  phase: 'poll' | 'work' | 'startup';
  reason: 'internal' | 'saved_pause' | 'like_unconfirmed' | 'publication_unconfirmed' | 'platform_blocked';
  feedFailure?: CommentFeedDiagnostic;
}

export function commentPauseDiagnostic(state: CommentState, phase: CommentPauseDiagnostic['phase']): CommentPauseDiagnostic {
  const job = [...state.jobs].reverse().find(row => row.likeStatus === 'unknown' || row.status === 'unknown');
  return { phase, reason: state.pauseReason || (job?.likeStatus === 'unknown' ? 'like_unconfirmed' :
    job?.status === 'unknown' ? 'publication_unconfirmed' : 'saved_pause') };
}

/** Persist the attempt before IO; restarting a paused account cannot repeatedly notify or publish. */
export async function alertCommentPause(state: CommentState, diagnostic: CommentPauseDiagnostic, io: {
  now(): number; save(state: CommentState): Promise<void>;
  notify(text: string): Promise<boolean>; report(event: Record<string, unknown>): void;
}): Promise<void> {
  if (!state.paused || state.pauseAlertAt !== undefined) return;
  state.pauseAlertAt = io.now();
  try { await io.save(state); }
  catch { io.report({ event: 'comment_pause_alert_checkpoint_failed' }); }
  const feed = diagnostic.feedFailure;
  const detail = feed ? `通知=${feed.feed}；原因=${feed.reason}；HTTP=${feed.httpStatus ?? '未知'}；平台码=${feed.code ?? '无'}；校验=${feed.payloadStage ?? '无'}；正文类型=${feed.contentType ?? '未知'}/${feed.bodyFormat ?? '未知'}；字节=${feed.bodyBytes ?? '未知'}` : diagnostic.reason;
  const at = new Date(state.pauseAlertAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const message = `鹿饼 B站自动回复已暂停\n账号：${state.botUid}\n时间：${at}（北京时间）\n阶段：${diagnostic.phase}\n诊断：${detail}\n已停止消费通知。请检查本机 comment-replies 日志与账号状态，再显式恢复；未知发布不会自动重发。`;
  try { io.report({ event: await io.notify(message) ? 'comment_pause_alert_sent' : 'comment_pause_alert_failed' }); }
  catch { io.report({ event: 'comment_pause_alert_failed' }); }
}
