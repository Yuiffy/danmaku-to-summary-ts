import * as fs from 'fs';
import * as path from 'path';
import { ClipDetail, ClipSummary } from '../../core/admin/contracts';
import { AdminError, atomicJson, digest, readJson, readText, redact } from './AdminFiles';
import { sourceWindowSubtitles, subtitleRows, timeSeconds, formatSubtitleTime } from '../../core/admin/subtitles';
import { collectClipIntentSignals, clipIntentForWindow, clipIntentReasons, ClipIntent } from '../../core/clipping/ClipIntent';

export type AssetKind = 'media' | 'preview' | 'cover' | 'subtitles' | 'preview-subtitles' | 'media-subtitles' | 'source';
export class AdminClipStore {
  constructor(private readonly root: string, private readonly allowedRoots: () => string[]) {}
  records(): Record<string, any> { return readJson(path.join(this.root, 'data/runtime/clip_upload_registry.json'), { clips: {} }).clips; }
  record(id: string): any {
    if (!/^[1-9]\d{0,8}$/u.test(id)) throw new AdminError('视频 ID 无效');
    const clip = this.records()[id];
    if (!clip) throw new AdminError('视频不存在', 404);
    return clip;
  }
  summary(clip: any): ClipSummary {
    return {
      id: Number(clip.id), title: `${clip.prefix || ''}${clip.title || ''}`, status: clip.status || 'review',
      roomId: String(clip.roomId || ''), streamerName: clip.streamerName || '', start: String(clip.start || ''),
      duration: String(clip.duration || ''), pendingCut: !!clip.pendingCut,
      issues: [...(clip.reviewIssues || []), ...(clip.failureReason ? [String(clip.failureReason).split('\n').filter(Boolean).slice(-1).join('').slice(0, 500)] : [])], updatedAt: clip.updatedAt || clip.createdAt || ''
    };
  }
  list(query: { search?: string; status?: string; room?: string; page?: string }): any {
    const records = this.records();
    const all = Object.values(records).map(clip => this.summary(clip));
    const counts: Record<string, number> = {};
    for (const clip of all) counts[clip.status] = (counts[clip.status] || 0) + 1;
    const filtered = all.filter(clip => (!query.status || clip.status === query.status) && (!query.room || clip.roomId === query.room) &&
      (!query.search || `${clip.id} ${clip.title} ${clip.streamerName}`.toLowerCase().includes(query.search.toLowerCase()))).sort((a, b) => b.id - a.id);
    const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
    return { clips: filtered.slice((page - 1) * 40, page * 40).map(summary => {
      // Only load evidence for the visible page, never every recording in the registry.
      try { const clip = records[String(summary.id)]; return this.presentation(clip, this.metadata(clip)); }
      catch { return summary; }
    }), total: filtered.length, page, counts,
      rooms: [...new Set(all.map(clip => clip.roomId).filter(Boolean))] };
  }
  private checkedPath(file: unknown): string | undefined {
    if (typeof file !== 'string' || !file || !fs.existsSync(file)) return undefined;
    const real = fs.realpathSync(file);
    const allowed = this.allowedRoots().some(root => {
      if (!fs.existsSync(root)) return false;
      const relative = path.relative(fs.realpathSync(root), real);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!allowed) throw new AdminError('素材不在配置的录播目录内', 403);
    return real;
  }
  metadata(clip: any): any {
    const file = this.checkedPath(clip.metadataPath);
    return file ? readJson(file) : {};
  }
  sourceWindow(clip: any, metadata: any): { start: number; end: number } | undefined {
    const start = timeSeconds(metadata.window?.start ?? clip.start);
    const end = timeSeconds(metadata.window?.end) ?? (start === undefined ? undefined : start + (timeSeconds(clip.duration) || 0));
    return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
  }
  private sourceSubtitles(clip: any, metadata: any, context = 0): string {
    const recalled = context > 0 ? metadata.reviewPresentation?.window : undefined;
    const window = this.sourceWindow(clip, metadata) || (Number.isFinite(recalled?.start)
      && Number.isFinite(recalled?.end) && recalled.start >= 0 && recalled.end > recalled.start ? recalled : undefined);
    const file = this.checkedPath(metadata.source?.srtPath || clip.sourceSrtPath);
    return window && file && path.extname(file).toLowerCase() === '.srt'
      ? sourceWindowSubtitles(readText(file), Math.max(0, window.start - context), window.end + context) : '';
  }
  private presentation(clip: any, metadata: any): ClipSummary {
    const summary = this.summary(clip);
    if (metadata.ownStreamHumanReview?.status !== 'approved' && !['uploaded', 'queued', 'uploading', 'cancelled'].includes(clip.status)) {
      summary.issues = [...clipIntentReasons(this.intent(clip, metadata)), ...summary.issues];
    }
    if (clip.publicCopyPending || !clip.title || /^(?:待复核候选|被剔除候选|初选话题)\s*[\d?]+$/u.test(clip.title)) {
      summary.reviewTitle = String(metadata.reviewPresentation?.title || '').trim();
      const file = this.resolveAsset(clip, metadata, 'subtitles');
      const text = file ? readText(file, 2 * 1024 * 1024) : this.sourceSubtitles(clip, metadata);
      summary.subtitleExcerpt = subtitleRows(text).map(row => row.text).join(' ').replace(/\s+/gu, ' ').slice(0, 240)
        || (metadata.reviewPresentation?.recallSubtitles || metadata.grounding?.subtitles || []).map((cue: any) => cue.text || '').join(' ').slice(0, 240);
    }
    return summary;
  }
  private intent(clip: any, metadata: any): ClipIntent | undefined {
    if (metadata.clipIntent?.signals?.length) return metadata.clipIntent;
    if (['stream_activity_submission', 'stream_game_submission'].includes(metadata.type) || metadata.output?.parts?.length) return undefined;
    const window = this.sourceWindow(clip, metadata);
    if (!window) return undefined;
    const rows = subtitleRows(this.sourceSubtitles(clip, metadata, 30)).map(row => ({ ...row, start: row.at }));
    return clipIntentForWindow(collectClipIntentSignals(rows, []), window);
  }
  asset(id: string, kind: AssetKind, part = 1): string | undefined {
    const clip = this.record(id), metadata = this.metadata(clip);
    return this.resolveAsset(clip, metadata, kind, part);
  }
  private resolveAsset(clip: any, metadata: any, kind: AssetKind, part = 1): string | undefined {
    const parts = metadata.output?.parts || clip.parts || [];
    if (!Number.isInteger(part) || part < 1 || part > Math.max(1, parts.length)) throw new AdminError('分 P 编号无效');
    const files = {
      source: metadata.source?.mediaPath || clip.sourceMediaPath,
      media: parts[part - 1]?.mediaPath || clip.mediaPath || metadata.output?.mediaPath,
      preview: metadata.reviewPreview?.mediaPath || clip.reviewPreview?.mediaPath,
      cover: clip.coverPath || metadata.output?.coverPath,
      subtitles: metadata.renderedSubtitles?.path || metadata.candidateSubtitles?.path || clip.candidateSrtPath || clip.srtPath || metadata.output?.srtPath,
      'media-subtitles': parts.length ? parts[part - 1]?.srtPath : metadata.output?.srtPath || clip.srtPath,
      'preview-subtitles': metadata.reviewPreview?.srtPath || clip.reviewPreview?.srtPath
    };
    const file = this.checkedPath(files[kind]);
    const allowed = { source: ['.flv', '.mp4', '.mkv', '.ts', '.webm'], media: ['.mp4', '.webm'], preview: ['.mp4', '.webm'], cover: ['.jpg', '.jpeg', '.png', '.webp'], subtitles: ['.srt'], 'preview-subtitles': ['.srt'], 'media-subtitles': ['.srt'] };
    if (file && !allowed[kind].includes(path.extname(file).toLowerCase())) throw new AdminError('素材类型无效');
    return file;
  }
  detail(id: string, part = 1): ClipDetail {
    const clip = this.record(id), metadata = this.metadata(clip);
    const subtitlesPath = this.resolveAsset(clip, metadata, 'subtitles'), previewPath = this.resolveAsset(clip, metadata, 'preview-subtitles');
    const subtitles = subtitlesPath ? readText(subtitlesPath, 2 * 1024 * 1024) : '';
    const previewSubtitles = previewPath ? readText(previewPath, 2 * 1024 * 1024) : '';
    const copy = { ...metadata.upload, ...metadata.candidate, ...metadata.copy };
    const parts = metadata.output?.parts || clip.parts || [];
    const partSubtitlesPath = this.resolveAsset(clip, metadata, 'media-subtitles', part);
    const partSubtitles = partSubtitlesPath ? readText(partSubtitlesPath, 2 * 1024 * 1024) : '';
    const window = this.sourceWindow(clip, metadata);
    const source = { available: !!window && !!this.resolveAsset(clip, metadata, 'source'), start: window?.start || 0, end: window?.end || 0,
      subtitles: this.sourceSubtitles(clip, metadata) };
    const subtitleFingerprints = [metadata.output?.srtPath, clip.srtPath, ...parts.map((next: any) => next.srtPath)].filter(Boolean)
      .map(file => { const checked = this.checkedPath(file); return { file, digest: checked ? digest(readText(checked, 2 * 1024 * 1024)) : undefined }; });
    const fingerprints = [clip.mediaPath, metadata.output?.mediaPath, clip.coverPath, metadata.source?.mediaPath || clip.sourceMediaPath, ...parts.map((part: any) => part.mediaPath)]
      .filter(Boolean).map(file => { const checked = this.checkedPath(file); const stat = checked ? fs.statSync(checked) : undefined; return { file, size: stat?.size, mtime: stat?.mtimeMs }; });
    return {
      clip: this.presentation(clip, metadata), revision: digest(JSON.stringify({ clip, metadata, subtitles, source, fingerprints, subtitleFingerprints })),
      mediaRevision: digest(JSON.stringify({ media: fingerprints.filter(entry => [clip.mediaPath, metadata.output?.mediaPath,
        ...parts.map((part: any) => part.mediaPath)].includes(entry.file)), subtitleFingerprints })),
      sourceRevision: digest(JSON.stringify({ source, media: fingerprints.filter(entry => entry.file === (metadata.source?.mediaPath || clip.sourceMediaPath)) })),
      title: clip.title || copy.title || '', description: clip.description || copy.description || '', coverText: copy.coverText || metadata.clip?.coverText || '',
      coverSelection: metadata.coverSelection,
      tags: Array.isArray(clip.tags) ? clip.tags : [], subtitles, previewSubtitles, partSubtitles, source,
      pendingRebuild: !!(clip.pendingRebuild || metadata.rebuildRequired), mediaSubtitles: !!this.resolveAsset(clip, metadata, 'media-subtitles'),
      category: metadata.type === 'stream_activity_submission' ? 'activity' : metadata.type === 'stream_game_submission' ? 'game' : 'clip',
      parts: parts.map((part: any) => ({ title: part.title || '', duration: part.duration || part.actualDuration || 0, subtitles: !!part.srtPath })),
      media: !!this.resolveAsset(clip, metadata, 'media'), preview: !!this.resolveAsset(clip, metadata, 'preview'), cover: !!this.resolveAsset(clip, metadata, 'cover'),
      evidence: redact({ speakerCues: (metadata.window?.contextSegments || []).filter((cue: any) =>
        window && cue.start >= window.start - .001 && cue.end <= window.end + .001).map((cue: any) => ({
          start: cue.start, end: cue.end, text: cue.text, speakerEvidence: cue.speakerEvidence ? {
            status: cue.speakerEvidence.status, label: cue.speakerEvidence.label, identityVerified: cue.speakerEvidence.identityVerified
          } : undefined })), aiReview: metadata.aiReview, attributionReview: metadata.attributionReview, grounding: metadata.grounding,
        publicationReview: metadata.publicationReview, clipIntent: this.intent(clip, metadata), candidate: metadata.candidate, subtitleProofreading: metadata.subtitleProofreading,
        humanReview: metadata.humanReview, corrections: metadata.candidateSubtitles?.corrections || metadata.renderedSubtitles?.corrections,
        reviewPreview: metadata.reviewPreview, editorial: metadata.editorial, diagnostics: clip.failureReason,
        activityReview: metadata.activityReview, gameReview: metadata.gameReview, source: metadata.source, kind: metadata.kind, parts })
    };
  }
  feedbackDetail(id: string): ClipDetail {
    const detail = this.detail(id), clip = this.record(id), metadata = this.metadata(clip);
    detail.source.subtitles = this.sourceSubtitles(clip, metadata, 180);
    detail.evidence.sourceKind = metadata.renderedSubtitles?.review?.sourceKind || metadata.grounding?.sourceKind
      || metadata.editorial?.copyGrounding?.sourceKind;
    detail.evidence.selectionRejection = metadata.selectionRejection;
    detail.evidence.recallWindow = metadata.reviewPresentation?.window;
    detail.evidence.candidateRecovery = metadata.candidateRecovery ? {
      status: metadata.candidateRecovery.status, error: metadata.candidateRecovery.error } : undefined;
    if (detail.category === 'activity') {
      const transcript = this.checkedPath(metadata.transcript?.path || metadata.source?.srtPath);
      const rows = transcript && path.extname(transcript).toLowerCase() === '.srt'
        ? subtitleRows(readText(transcript)).map((row, index) => ({ ...row, index: index + 1 })) : [];
      // Multipart activities may be hours apart; the enclosing window includes unrelated stream text.
      detail.source.subtitles = rows.filter(row => (metadata.activities || []).some((event: any) =>
        row.end > event.start - 180 && row.at < event.end + 180))
        .map(row => `${row.id}\n${row.time} --> ${formatSubtitleTime(row.end)}\n${row.text}\n`).join('\n');
      detail.evidence.activities = (metadata.activities || []).map((event: any) => ({ id: event.id, kind: event.kind,
        name: event.name, start: event.start, end: event.end, reviewIssues: event.reviewIssues,
        verification: { decision: event.verification?.decision, reason: event.verification?.reason,
          hasNativeListening: !!event.verification?.nativeListening } }));
      detail.evidence.existingActivityTitles = (metadata.presentation?.titleEvidence?.items || []).map((item: any) => ({
        activityId: item.activityId, name: item.name, sourceAlias: item.sourceAlias,
        segmentIndices: (item.segments || []).map((row: any) => row.index), note: item.note,
        transcriptSha256: item.transcriptSha256 }));
      detail.evidence.titleContext = rows.filter(row => (metadata.activities || []).some((event: any) => row.end >= event.start - 300 && row.at <= event.end + 60));
    }
    return detail;
  }
  feedbackTitleInput(id: string, items: unknown[]): string {
    const data = { items }, file = path.join(this.root, 'data/runtime/admin/feedback-inputs', `${id}-${digest(JSON.stringify(data))}.json`);
    atomicJson(file, data); return file;
  }
  hasActiveUpload(id: string): boolean {
    const queue = readJson(path.join(this.root, 'data/runtime/clip_upload_queue.json'), { jobs: [] });
    return queue.jobs.some((job: any) => ['pending', 'queued', 'running', 'uploading', 'processing'].includes(job.status)
      && job.clipIds?.includes(Number(id)));
  }
  queues(): any {
    const uploads = readJson(path.join(this.root, 'data/runtime/clip_upload_queue.json'), { jobs: [] });
    const manual = readJson(path.join(this.root, 'data/runtime/manual_clip_queue.json'), { tasks: [] });
    return redact({ uploads: uploads.jobs.slice(-200).reverse(), manual: manual.tasks.slice(-200).reverse(),
      accountRollingUploadGuard: uploads.accountRollingUploadGuard, submissionRateLimit: uploads.submissionRateLimit });
  }
  checkedInput(file: string, extensions: string[]): string {
    const checked = this.checkedPath(file);
    if (!checked || !extensions.includes(path.extname(checked).toLowerCase())) throw new AdminError('源文件不存在或格式不支持');
    return checked;
  }
  manualRecord(id: string): any {
    if (!/^mcq-\d+$/u.test(id)) throw new AdminError('手工任务 ID 无效');
    const task = readJson(path.join(this.root, 'data/runtime/manual_clip_queue.json'), { tasks: [] }).tasks.find((item: any) => item.id === id);
    if (!task) throw new AdminError('手工任务不存在', 404);
    return task;
  }
  manualDetail(id: string): any {
    const task = this.manualRecord(id), media = this.checkedPath(task.outputVideo), cover = this.checkedPath(task.coverPath);
    return { task, media: !!media, cover: !!cover, revision: digest(JSON.stringify({ task, size: media ? fs.statSync(media).size : 0, mtime: media ? fs.statSync(media).mtimeMs : 0 })) };
  }
  manualAsset(id: string, kind: string): string | undefined {
    const task = this.manualRecord(id);
    return this.checkedInput(kind === 'cover' ? task.coverPath : task.outputVideo, kind === 'cover' ? ['.jpg', '.png', '.webp'] : ['.mp4']);
  }
}
