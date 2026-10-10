import * as fs from 'fs';
import * as path from 'path';
import { ClipDetail, ClipSummary } from '../../core/admin/contracts';
import { AdminError, digest, readJson, readText, redact } from './AdminFiles';

export type AssetKind = 'media' | 'preview' | 'cover' | 'subtitles' | 'preview-subtitles' | 'media-subtitles';
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
    const all = Object.values(this.records()).map(clip => this.summary(clip));
    const counts: Record<string, number> = {};
    for (const clip of all) counts[clip.status] = (counts[clip.status] || 0) + 1;
    const filtered = all.filter(clip => (!query.status || clip.status === query.status) && (!query.room || clip.roomId === query.room) &&
      (!query.search || `${clip.id} ${clip.title} ${clip.streamerName}`.toLowerCase().includes(query.search.toLowerCase()))).sort((a, b) => b.id - a.id);
    const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
    return { clips: filtered.slice((page - 1) * 40, page * 40), total: filtered.length, page, counts,
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
  asset(id: string, kind: AssetKind, part = 1): string | undefined {
    const clip = this.record(id), metadata = this.metadata(clip);
    return this.resolveAsset(clip, metadata, kind, part);
  }
  private resolveAsset(clip: any, metadata: any, kind: AssetKind, part = 1): string | undefined {
    const parts = metadata.output?.parts || clip.parts || [];
    if (!Number.isInteger(part) || part < 1 || part > Math.max(1, parts.length)) throw new AdminError('分 P 编号无效');
    const files = {
      media: parts[part - 1]?.mediaPath || clip.mediaPath || metadata.output?.mediaPath,
      preview: metadata.reviewPreview?.mediaPath || clip.reviewPreview?.mediaPath,
      cover: clip.coverPath || metadata.output?.coverPath,
      subtitles: metadata.renderedSubtitles?.path || metadata.candidateSubtitles?.path || clip.candidateSrtPath || clip.srtPath || metadata.output?.srtPath,
      'media-subtitles': parts.length ? parts[part - 1]?.srtPath : metadata.output?.srtPath || clip.srtPath,
      'preview-subtitles': metadata.reviewPreview?.srtPath || clip.reviewPreview?.srtPath
    };
    const file = this.checkedPath(files[kind]);
    const allowed = { media: ['.mp4', '.webm'], preview: ['.mp4', '.webm'], cover: ['.jpg', '.jpeg', '.png', '.webp'], subtitles: ['.srt'], 'preview-subtitles': ['.srt'], 'media-subtitles': ['.srt'] };
    if (file && !allowed[kind].includes(path.extname(file).toLowerCase())) throw new AdminError('素材类型无效');
    return file;
  }
  detail(id: string, part = 1): ClipDetail {
    const clip = this.record(id), metadata = this.metadata(clip);
    const subtitlesPath = this.resolveAsset(clip, metadata, 'subtitles'), previewPath = this.resolveAsset(clip, metadata, 'preview-subtitles');
    const subtitles = subtitlesPath ? readText(subtitlesPath, 2 * 1024 * 1024) : '';
    const previewSubtitles = previewPath ? readText(previewPath, 2 * 1024 * 1024) : '';
    const copy = metadata.upload || metadata.candidate || {};
    const parts = metadata.output?.parts || clip.parts || [];
    const partSubtitlesPath = this.resolveAsset(clip, metadata, 'media-subtitles', part);
    const partSubtitles = partSubtitlesPath ? readText(partSubtitlesPath, 2 * 1024 * 1024) : '';
    const subtitleFingerprints = [metadata.output?.srtPath, clip.srtPath, ...parts.map((next: any) => next.srtPath)].filter(Boolean)
      .map(file => { const checked = this.checkedPath(file); return { file, digest: checked ? digest(readText(checked, 2 * 1024 * 1024)) : undefined }; });
    const fingerprints = [clip.mediaPath, metadata.output?.mediaPath, clip.coverPath, ...parts.map((part: any) => part.mediaPath)]
      .filter(Boolean).map(file => { const checked = this.checkedPath(file); const stat = checked ? fs.statSync(checked) : undefined; return { file, size: stat?.size, mtime: stat?.mtimeMs }; });
    return {
      clip: this.summary(clip), revision: digest(JSON.stringify({ clip, metadata, subtitles, fingerprints, subtitleFingerprints })),
      title: clip.title || copy.title || '', description: clip.description || copy.description || '', coverText: metadata.candidate?.coverText || metadata.clip?.coverText || copy.coverText || '',
      tags: Array.isArray(clip.tags) ? clip.tags : [], subtitles, previewSubtitles, partSubtitles,
      pendingRebuild: !!(clip.pendingRebuild || metadata.rebuildRequired), mediaSubtitles: !!this.resolveAsset(clip, metadata, 'media-subtitles'),
      category: metadata.type === 'stream_activity_submission' ? 'activity' : metadata.type === 'stream_game_submission' ? 'game' : 'clip',
      parts: parts.map((part: any) => ({ title: part.title || '', duration: part.duration || part.actualDuration || 0, subtitles: !!part.srtPath })),
      media: !!this.resolveAsset(clip, metadata, 'media'), preview: !!this.resolveAsset(clip, metadata, 'preview'), cover: !!this.resolveAsset(clip, metadata, 'cover'),
      evidence: redact({ aiReview: metadata.aiReview, attributionReview: metadata.attributionReview,
        publicationReview: metadata.publicationReview, candidate: metadata.candidate, subtitleProofreading: metadata.subtitleProofreading,
        humanReview: metadata.humanReview, corrections: metadata.candidateSubtitles?.corrections || metadata.renderedSubtitles?.corrections,
        reviewPreview: metadata.reviewPreview, editorial: metadata.editorial, diagnostics: clip.failureReason,
        activityReview: metadata.activityReview, gameReview: metadata.gameReview, source: metadata.source, kind: metadata.kind, parts })
    };
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
