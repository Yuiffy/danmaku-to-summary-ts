import { alertCommentPause, commentPauseDiagnostic } from './CommentAlerts';
import { newCommentState } from './CommentState';

test('a feed payload pause is checkpointed before notifying and contains actionable but private-data-free diagnostics', async () => {
  const state = newCommentState('99'); state.paused = true;
  const order: string[] = [], report = jest.fn();
  const save = jest.fn(async () => { order.push('save'); });
  const notify = jest.fn(async () => { order.push('notify'); return true; });
  const diagnostic = { phase: 'poll' as const, reason: 'internal' as const,
    feedFailure: { feed: 'reply' as const, reason: 'payload' as const, payloadStage: 'json' as const,
      httpStatus: 200, bodyBytes: 100, contentType: 'html' as const, bodyFormat: 'html' as const } };
  const io = { now: () => 1234, save, notify, report };
  await alertCommentPause(state, diagnostic, io);
  expect(order).toEqual(['save', 'notify']); expect(state.pauseAlertAt).toBe(1234);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('HTTP=200'));
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('html/html'));
  expect(report).toHaveBeenCalledWith({ event: 'comment_pause_alert_sent' });
  await alertCommentPause(JSON.parse(JSON.stringify(state)), diagnostic, io);
  expect(notify).toHaveBeenCalledTimes(1);
  state.paused = false; delete state.pauseAlertAt;
  await alertCommentPause(state, diagnostic, io); expect(notify).toHaveBeenCalledTimes(1);
});

test.each([false, 'throw'])('notification failure %s does not unpause, resend jobs or replace primary failure', async mode => {
  const state = newCommentState('99'); state.paused = true; state.pauseReason = 'publication_unconfirmed';
  const notify = jest.fn(async () => { if (mode === 'throw') throw new Error('secret webhook'); return false; }), report = jest.fn();
  await expect(alertCommentPause(state, commentPauseDiagnostic(state, 'work'), {
    now: () => 1, save: async () => {}, notify, report
  })).resolves.toBeUndefined();
  expect(state.paused).toBe(true); expect(report).toHaveBeenCalledWith({ event: 'comment_pause_alert_failed' });
  expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
});

test.each(['like_unconfirmed', 'publication_unconfirmed', 'platform_blocked'] as const)('worker pause %s preserves its exact reason', reason => {
  const state = newCommentState('99'); state.paused = true; state.pauseReason = reason;
  expect(commentPauseDiagnostic(state, 'work')).toEqual({ phase: 'work', reason });
});

test('a failed checkpoint still attempts to report the stoppage without restarting any work', async () => {
  const state = newCommentState('99'); state.paused = true;
  const notify = jest.fn(async () => true), report = jest.fn();
  await alertCommentPause(state, commentPauseDiagnostic(state, 'work'), {
    now: () => 1, save: async () => { throw new Error('disk full'); }, notify, report
  });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith({ event: 'comment_pause_alert_checkpoint_failed' });
});
