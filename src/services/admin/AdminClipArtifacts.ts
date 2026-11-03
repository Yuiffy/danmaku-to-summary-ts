import * as path from 'path';
import * as fs from 'fs';
import { ClipProgressItem } from '../../core/admin/clipProgress';
import { digest, readText } from './AdminFiles';

function read(file: string): any {
  try { return JSON.parse(readText(file, 4 * 1024 * 1024)); } catch { return undefined; }
}
const sameFile = (a: unknown, b: string) => typeof a === 'string' && path.resolve(a) === path.resolve(b);
function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function preview(directory: string, metadata: any): { file: string; key: string } | undefined {
  const file = metadata.output?.mediaPath;
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.mp4' || metadata.output.mediaError
    || metadata.output.burnedSubtitles !== true || !inside(directory, path.resolve(file))) return undefined;
  try {
    const real = fs.realpathSync(file), stat = fs.statSync(real);
    if (!inside(fs.realpathSync(directory), real) || !stat.isFile() || stat.size < 1) return undefined;
    return { file: real, key: digest(JSON.stringify([real, stat.size, stat.mtimeMs])) };
  } catch { return undefined; }
}
function reviewStatus(value: unknown): 'passed' | 'failed' | 'pending' | undefined {
  return value === 'passed' || value === 'approved' ? 'passed'
    : ['failed', 'needs_review', 'rejected', 'unavailable'].includes(String(value)) ? 'failed' : value === 'pending' ? 'pending' : undefined;
}

/** Existing incremental-render receipts only; never loads the media workflow or probes video. */
function readArtifacts(payload: any, config: any, since: string | undefined, now: number) {
  const media = payload?.originalMediaPath;
  if (typeof media !== 'string' || !since) return undefined;
  const settings = config.ownStreamClips || {};
  let parent = path.dirname(path.resolve(media));
  if (settings.archiveSourceRoot && settings.activeOutputRoot) {
    const relative = path.relative(path.resolve(settings.archiveSourceRoot), parent);
    if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
      parent = path.resolve(settings.activeOutputRoot, relative);
    }
  }
  const directory = path.join(parent, settings.outputDirName || 'own_stream_fun_clips');
  const progress = read(path.join(directory, 'PLAN_PROGRESS.json'));
  const at = Date.parse(progress?.updatedAt), start = Date.parse(progress?.startedAt);
  if (!sameFile(progress?.source?.media, media) || !Number.isFinite(at) || !Number.isFinite(start)
    || start < Date.parse(since) || at < start || at > now || !Array.isArray(progress.entries)
    || !Number.isSafeInteger(progress.total) || progress.total < 1 || progress.total > 200
    || progress.entries.length !== progress.total) return undefined;
  const states: Record<string, 'waiting' | 'rendering' | 'rendered' | 'needs_review' | 'failed'> = {
    awaiting_review: 'waiting', reviewed: 'waiting', rendering: 'rendering', rendered_for_review: 'rendered', needs_review: 'needs_review', failed: 'failed'
  };
  const indices = new Set<number>();
  // Final review can move a revision into its own child directory (for example a front-loaded edit).
  const revisions = new Map<number, string>(), state = read(path.join(directory, 'REVIEW_STATE.json'));
  const reviewedStart = Date.parse(state?.metadata?.processingStats?.startedAt);
  if (state?.type === 'own_stream_review_state' && sameFile(state.metadata?.source?.mediaPath, media)
    && reviewedStart >= Date.parse(since) && Math.abs(reviewedStart - start) <= 1000 && reviewedStart <= now
    && Array.isArray(state.entries) && state.entries.length <= 2000) {
    for (const row of state.entries) {
      if (Number.isSafeInteger(row.reviewIndex) && row.reviewIndex >= 1 && row.reviewIndex <= progress.total
        && typeof row.metadataPath === 'string' && inside(directory, path.resolve(row.metadataPath))) {
        if (revisions.has(row.reviewIndex)) { revisions.clear(); break; }
        revisions.set(row.reviewIndex, row.metadataPath);
      }
    }
  }
  let readBudget = 16 * 1024 * 1024;
  const mediaFiles = new Map<number, { file: string; key: string }>();
  let refined = 0;
  const items: NonNullable<ClipProgressItem['videos']>['items'] = [];
  for (const entry of progress.entries) {
    if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= progress.total || indices.has(entry.index)
      || !Object.hasOwn(states, entry.status)) return undefined;
    indices.add(entry.index);
    const item: typeof items[number] = { index: entry.index + 1, state: states[entry.status] };
    // Metadata may change during final review; only read source-bound siblings within a bounded budget.
    const revision = revisions.get(item.index), metadataPath = revision || entry.metadataPath;
    if (typeof metadataPath === 'string' && (revision || path.dirname(path.resolve(metadataPath)) === directory) && readBudget > 0) {
      try {
        if (!inside(fs.realpathSync(directory), fs.realpathSync(metadataPath))) throw new Error('Outside metadata');
        const text = readText(metadataPath, Math.min(readBudget, 4 * 1024 * 1024));
        readBudget -= Buffer.byteLength(text);
        const metadata = JSON.parse(text);
        if (sameFile(metadata.source?.mediaPath, media) && metadata.window?.index === item.index) {
          item.review = metadata.qaRequired ? reviewStatus(metadata.qaResult?.status) : undefined;
          item.finalReview = reviewStatus(metadata.publicationReview?.status);
          if (typeof metadata.copy?.title === 'string') item.title = metadata.copy.title.slice(0, 300);
          if (['rendered', 'needs_review', 'failed'].includes(item.state)) {
            const style = metadata.editorialStyle;
            const finished = style?.status === 'completed' || style?.status === 'kept_original';
            if (finished) refined++;
            item.edition = metadata.creativeResult?.status === 'edited' ? 'precision'
              : metadata.editorialTimeline ? 'highlight_first' : finished ? 'ordinary' : 'initial';
            const asset = preview(directory, metadata);
            if (asset) { item.previewKey = asset.key; mediaFiles.set(item.index, asset); }
          }
          if (metadata.output?.mediaError) item.issue = /Cannot determine clip-local video resolution/u.test(metadata.output.mediaError)
            ? '源视频局部画面探测失败' : '视频制作失败，请检查运行记录';
        }
      } catch { /* An unreadable metadata file does not invalidate the initial production receipt. */ }
    }
    items.push(item);
  }
  const videos: NonNullable<ClipProgressItem['videos']> = { total: progress.total, processed: items.filter(item => ['rendered', 'needs_review', 'failed'].includes(item.state)).length,
    rendered: items.filter(item => item.state === 'rendered').length, needsReview: items.filter(item => item.state === 'needs_review').length,
    failed: items.filter(item => item.state === 'failed').length, refined, updatedAt: new Date(at).toISOString(),
    phase: progress.status === 'complete' ? 'final_review' : 'production', items };
  return { videos, mediaFiles };
}
export function readClipVideos(payload: any, config: any, since: string | undefined, now: number): ClipProgressItem['videos'] {
  return readArtifacts(payload, config, since, now)?.videos;
}
export function readClipVideoMedia(payload: any, config: any, since: string | undefined, now: number, index: number, key: string): string | undefined {
  const asset = readArtifacts(payload, config, since, now)?.mediaFiles.get(index);
  return asset?.key === key ? asset.file : undefined;
}
