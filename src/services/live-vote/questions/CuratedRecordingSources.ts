import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { BrowseSource, RecordingCollection } from './RecordingBrowser';
import { recordingFolderDate } from './SubtitleCorpus';

const CLIP_FOLDERS = new Set(['own_stream_fun_clips', 'manual_requested_clips', 'topic_clips']);

/** Only maintained text artifacts under configured room roots; never general recursive access. */
export async function curatedSources(roots: string[], date: string | null, collection: RecordingCollection,
  entries: (folder: string) => Promise<Dirent[]>, signal: AbortSignal, unavailable: () => void): Promise<BrowseSource[]> {
  const result: BrowseSource[] = [];
  for (const configured of roots) {
    signal.throwIfAborted();
    let root: string;
    try { root = await fs.realpath(configured); } catch { unavailable(); continue; }
    const folders: Array<{ folder: string; date: string | null; clips: boolean; depth: number }> = [{ folder: root, date: null, clips: false, depth: 0 }];
    for (let i = 0; i < folders.length; i++) {
      signal.throwIfAborted();
      const current = folders[i];
      let children: Dirent[];
      try { children = await entries(current.folder); } catch { signal.throwIfAborted(); unavailable(); continue; }
      const names = new Set(children.map(entry => entry.name.toLowerCase()));
      for (const entry of children) {
        if (entry.isSymbolicLink()) continue;
        const folderDate = recordingFolderDate(entry.name);
        if (entry.isDirectory()) {
          if (current.depth === 0 && folderDate && (!date || folderDate.startsWith(date))) {
            folders.push({ folder: path.join(current.folder, entry.name), date: folderDate, clips: false, depth: 1 });
          } else if (collection === 'clips' && !current.clips && CLIP_FOLDERS.has(entry.name) ||
              collection === 'clips' && current.clips && current.depth < 3 && !/^(?:temp|bak|rejected_candidates|\.)/iu.test(entry.name)) {
            folders.push({ folder: path.join(current.folder, entry.name), date: current.date, clips: true, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const kind = collection === 'highlights' && /_AI_HIGHLIGHT\.txt$/iu.test(entry.name) ? 'highlight' :
          collection === 'clips' && current.clips && /\.srt$/iu.test(entry.name) && !/\.live\.srt$/iu.test(entry.name) ? 'clip-subtitle' : null;
        if (!kind || /\.speaker\.srt$/iu.test(entry.name) && names.has(entry.name.toLowerCase().replace(/\.speaker\.srt$/u, '.srt'))) continue;
        const compact = /(?:^|-)(\d{4})(\d{2})(\d{2})-/u.exec(entry.name);
        const fileDate = current.date || /\d{4}[-_]\d{2}[-_]\d{2}/u.exec(entry.name)?.[0].replace(/_/gu, '-') ||
          (compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null);
        if (date && !fileDate?.startsWith(date)) continue;
        result.push({ file: path.join(current.folder, entry.name), root, date: fileDate, kind });
      }
    }
  }
  return result.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file));
}

/** Highlight times are coarse leads; preserve the mixed ASR/danmaku text and its provenance. */
export function parseHighlight(content: string): Array<{ seconds: number; text: string }> {
  return content.split(/\r?\n/u).flatMap(line => {
    const match = /^\[(?:(\d+)h)?(\d+)m(?:(\d+)s)?\]\s*(.+)$/u.exec(line.trim());
    if (!match) return [];
    return [{ seconds: Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0),
      text: match[4].normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000) }];
  }).sort((a, b) => a.seconds - b.seconds);
}
