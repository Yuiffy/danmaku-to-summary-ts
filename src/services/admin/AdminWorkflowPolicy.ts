import { AdminError } from './AdminFiles';
import { OperatorCommand } from './AdminCommandPolicy';

export const workflowInputs: [string, string[]][] = [
  ['mediaPath', ['.flv', '.mp4', '.mkv', '.ts', '.webm']], ['srtPath', ['.srt']], ['xmlPath', ['.xml']],
  ['summaryPath', ['.json']], ['fullContextPath', ['.json']], ['transcriptRecordPath', ['.json']],
  ['titleEvidencePath', ['.json']], ['evidenceFrame', ['.jpg', '.jpeg', '.png']]
];
function required(body: any, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) throw new AdminError(`请填写有效的 ${key}`);
  return value;
}
function sourceArgs(body: any): string[] {
  const args = ['--media', required(body, 'mediaPath'), '--srt', required(body, 'srtPath')];
  for (const [key, flag] of [['xmlPath', '--xml'], ['summaryPath', '--summary'], ['fullContextPath', '--full-context']] as const) {
    if (body[key]) args.push(flag, required(body, key));
  }
  return args;
}
/** Fixed commands produce drafts under a command-local manual publication policy. */
export function workflowCommand(body: any): OperatorCommand {
  if (!['activity', 'game'].includes(body.workflow) || !['plan', 'run'].includes(body.action)) throw new AdminError('制作工作流无效');
  const args = [`src/scripts/stream_${body.workflow}_clips.js`, body.action, ...sourceArgs(body)];
  if (body.workflow === 'activity') {
    if (!['songs', 'watch', 'both'].includes(body.kind)) throw new AdminError('请选择歌曲、同步视听或两者');
    if (body.kind !== 'both') args.push('--kind', body.kind);
    args.push('--no-notify', '--reuse-summary-only');
  }
  return { executable: 'node', args, action: `${body.workflow}-${body.action}`, target: body.mediaPath, reviewOnly: true };
}
export function activityRepairCommand(id: string, body: any): OperatorCommand {
  if (!['retry-boundaries', 'repair-timing'].includes(body.action)) throw new AdminError('活动修订操作无效');
  const args = ['src/scripts/stream_activity_clips.js', 'run', ...sourceArgs(body), '--no-notify', '--reuse-summary-only',
    `--${body.action}`, '--revision-note', required(body, 'note')];
  if (body.action === 'retry-boundaries') {
    if (!['songs', 'watch'].includes(body.kind)) throw new AdminError('投稿包类别无效');
    args.push('--kind', body.kind);
    if (body.reviseVerifier === true) args.push('--revise-verifier');
    if (body.reviewPrelude === true) {
      if (body.kind !== 'songs') throw new AdminError('前奏复核仅适用歌切');
      args.push('--review-prelude');
    }
  } else args.push('--transcript-record', required(body, 'transcriptRecordPath'));
  return { executable: 'node', args, action: body.action, target: id, reviewOnly: true };
}
