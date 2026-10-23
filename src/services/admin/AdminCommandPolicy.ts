import { AdminError } from './AdminFiles';
import { coverSelection } from '../../core/admin/cover';

export interface OperatorCommand { executable: 'python' | 'node'; args: string[]; action: string; target: string; reviewOnly?: boolean }
function text(body: any, key: string, max = 4000, required = true): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw new AdminError(`请填写有效的 ${key}`);
  return value;
}
function numberId(value: unknown): string {
  const id = String(value);
  if (!/^[1-9]\d{0,8}$/u.test(id)) throw new AdminError('视频 ID 无效');
  return id;
}
function publication(body: any): void {
  if (body.publishApproved !== true) throw new AdminError('请明确确认投稿授权');
}
export function clipCommand(idValue: unknown, body: any): OperatorCommand {
  const id = numberId(idValue), action = text(body, 'action', 40), args = ['src/scripts/clip_upload_registry.py'];
  if (action === 'cover') {
    let selection;
    try { selection = coverSelection(body.selection); } catch (error) { throw new AdminError((error as Error).message); }
    return { executable: 'python', args: [...args, 'cover', '--id', id, '--selection', JSON.stringify(selection),
      '--note', text(body, 'note', 1000)], action, target: id };
  }
  if (['subtitles', 'preview', 'correct', 'cut', 'approve-review', 'rebuild', 'enqueue', 'exclude', 'precision'].includes(action) === false) throw new AdminError('不支持的视频操作');
  args.push(action, ['preview', 'cut', 'enqueue', 'exclude'].includes(action) ? '--ids' : '--id', id);
  if (['cut', 'approve-review', 'rebuild'].includes(action)) args.push('--review-note', text(body, 'note', 1000));
  if (['correct', 'exclude', 'precision', 'enqueue'].includes(action)) args.push('--note', text(body, 'note', 1000));
  if (action === 'correct') {
    args.push('--from', text(body, 'from', 2000), '--to', text(body, 'to', 2000, false));
    if (body.cue !== undefined && body.cue !== '') {
      if (!Number.isInteger(Number(body.cue)) || Number(body.cue) < 1) throw new AdminError('字幕行号无效');
      args.push('--cue', String(body.cue));
    }
    if (body.enqueue === true) { publication(body); args.push('--enqueue'); }
  }
  if (['cut', 'approve-review', 'rebuild'].includes(action)) {
    for (const [key, flag] of [['title', '--title'], ['description', '--description'], ['coverText', '--cover-text']] as const) {
      if (body[key] !== undefined) args.push(flag, text(body, key, key === 'description' ? 10000 : 300, false));
    }
    if (body.sourceKind) {
      if (!['live_speech', 'recount', 'playback', 'audience'].includes(body.sourceKind) || action === 'cut') throw new AdminError('归属类型无效');
      args.push('--source-kind', body.sourceKind);
    }
  }
  if (action === 'rebuild') {
    for (const key of ['start', 'end']) if (body[key] !== undefined && body[key] !== '') {
      if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0) throw new AdminError('源时间无效');
      args.push(`--${key}`, String(body[key]));
    }
    if (body.allowLong === true) args.push('--allow-long', '--duration-note', text(body, 'durationNote', 1000));
  }
  if (action === 'enqueue') publication(body);
  if (action === 'precision' && body.style === 'compact') args.push('--style', 'compact');
  return { executable: 'python', args, action, target: id };
}
export function queueCommand(body: any): OperatorCommand {
  const action = text(body, 'action', 40), id = text(body, 'id', 100);
  if (action === 'cancel-upload') return { executable: 'python', args: ['src/scripts/clip_upload_registry.py', 'cancel', '--job', id, '--note', text(body, 'note', 1000)], action, target: id };
  if (['approve-manual', 'cancel-manual'].includes(action) && /^mcq-\d+$/u.test(id)) {
    if (action === 'approve-manual') publication(body);
    return { executable: 'node', args: ['src/scripts/manual_clip_queue.js', action === 'approve-manual' ? 'approve' : 'cancel', id,
      ...(action === 'cancel-manual' ? ['--note', text(body, 'note', 1000)] : [])], action, target: id };
  }
  throw new AdminError('队列操作无效');
}
export function manualCommand(body: any): OperatorCommand {
  const action = text(body, 'action', 40), args = ['src/scripts/manual_clip_queue.js'];
  if (action === 'cut-manual') return { executable: 'node', args: [...args, 'worker'], action, target: 'next' };
  if (action !== 'add-manual') throw new AdminError('手工切片操作无效');
  const start = Number(body.start), end = Number(body.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new AdminError('请提供有效的源时间范围');
  if (!['small_sui', 'old_sui'].includes(body.profile)) throw new AdminError('请选择小岁或老岁片配置');
  args.push('add', '--media', text(body, 'mediaPath'), '--srt', text(body, 'srtPath'), '--start', String(start), '--end', String(end),
    '--title', text(body, 'title', 200), '--description', text(body, 'description', 10000), '--cover-text', text(body, 'coverText', 300), '--profile', body.profile);
  return { executable: 'node', args, action, target: body.title };
}
export function bundleCommand(id: string, body: any, category: 'activity' | 'game', metadataPath: string): OperatorCommand {
  const action = text(body, 'action', 40);
  if (action === 'automatic-review' && category === 'activity') return { executable: 'node',
    args: ['src/scripts/stream_activity_clips.js', 'review', '--metadata', metadataPath, '--note', text(body, 'note', 1000)], action, target: id };
  if (action === 'identify-songs' && category === 'activity') {
    const args = ['src/scripts/stream_activity_clips.js', 'identify-songs', '--metadata', metadataPath];
    if (body.activityId) args.push('--activity-id', text(body, 'activityId', 100));
    if (body.hint) args.push('--hint', text(body, 'hint', 1000));
    return { executable: 'node', args, action, target: id };
  }
  if (action === 'enqueue') {
    const command = clipCommand(id, body); command.args.push('--timeout-seconds', '14400', '--batch-size', '1'); return command;
  }
  if (action === 'approve-review' || action === 'restyle' && category === 'activity') {
    const args = [`src/scripts/stream_${category}_clips.js`, action === 'restyle' ? 'restyle' : 'approve', '--metadata', metadataPath];
    if (action === 'approve-review') args.push('--note', text(body, 'note', 1000));
    else {
      if (body.titleEvidencePath) args.push('--title-evidence', text(body, 'titleEvidencePath'));
      if (body.contentName) args.push('--content-name', text(body, 'contentName', 300), '--evidence-frame', text(body, 'evidenceFrame'), '--evidence-note', text(body, 'note', 1000));
    }
    if (action === 'approve-review' && category === 'activity' && body.feedbackAuthorized === true) args.push('--feedback-authorized');
    return { executable: 'node', args, action, target: id };
  }
  throw new AdminError('完整投稿包使用专用审核流程；普通改词和精剪不适用');
}
