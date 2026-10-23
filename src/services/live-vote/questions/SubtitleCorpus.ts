import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface SubtitleCue { seconds: number; text: string }
export interface SubtitleSource { file: string; root: string; date: string | null }
/** Recognized timestamped multipart exports share a session; unknown names stay source-bound. */
export function recordingSessionKey(source: SubtitleSource): string {
  const stem = path.basename(source.file).replace(/\.(?:srt|xml)$/iu, '').replace(/\.(?:live|speaker)$/iu, '');
  const session = /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_.+/u.test(stem) ? stem.replace(/_\d+_fix$/u, '') : stem;
  return `${source.root}\0${path.dirname(source.file)}\0${session}`;
}
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
/** Historical YY date folders use 20YY; retain the session-folder date over export filenames. */
export function recordingFolderDate(name: string): string | null {
  const date = name.replace(/_/gu, '-');
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  return /^\d{2}-\d{2}-\d{2}$/u.test(date) ? `20${date}` : null;
}
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
export function parseSubtitle(content: string): SubtitleCue[] {
  const result: SubtitleCue[] = [];
  for (const block of content.replace(/^\uFEFF/u, '').split(/\r?\n\s*\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const index = lines.findIndex(line => /^\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*-->/u.test(line));
    if (index < 0) continue;
    const parts = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})/u.exec(lines[index])!;
    const text = lines.slice(index + 1).join(' ').replace(/<[^>]*>/gu, '').normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000);
    if (text) result.push({ seconds: Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 1000, text });
  }
  return result;
}

/** A stable, bounded snapshot. Reject archive links and files changed during the read. */
export async function readSubtitle(source: SubtitleSource, signal: AbortSignal): Promise<{ content: string; hash: string }> {
  signal.throwIfAborted();
  const resolved = await fs.realpath(source.file);
  if (!within(source.root, resolved)) throw new Error('Subtitle outside root');
  const stat = await fs.lstat(source.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SUBTITLE_BYTES) throw new Error('Invalid subtitle');
  const handle = await fs.open(resolved, 'r');
  try {
    const before = await handle.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw new Error('Subtitle changed');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) throw new Error('Incomplete subtitle');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Subtitle changed');
    return { content: bytes.toString('utf8'), hash: digest(bytes) };
  } finally { await handle.close(); }
}

/** Same top-level/date-folder contract as recording questions; no recursive media traversal. */
export async function listSubtitles(configuredRoot: string, signal: AbortSignal): Promise<SubtitleSource[]> {
  signal.throwIfAborted();
  const root = await fs.realpath(configuredRoot);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = [{ folder: root, date: null as string | null }];
  for (const entry of entries) {
    const date = recordingFolderDate(entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && date) folders.push({ folder: path.join(root, entry.name), date });
  }
  const results: SubtitleSource[] = [];
  for (const folder of folders) {
    signal.throwIfAborted();
    const children = folder.folder === root ? entries : await fs.readdir(folder.folder, { withFileTypes: true });
    const names = new Set(children.map(entry => entry.name.toLowerCase()));
    for (const entry of children) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.srt$/iu.test(entry.name) || /\.live\.srt$/iu.test(entry.name) ||
          /\.speaker\.srt$/iu.test(entry.name) && names.has(entry.name.toLowerCase().replace(/\.speaker\.srt$/u, '.srt'))) continue;
      results.push({ root, file: path.join(folder.folder, entry.name),
        date: folder.date || /\d{4}[-_]\d{2}[-_]\d{2}/u.exec(entry.name)?.[0].replace(/_/gu, '-') || null });
    }
  }
  return results.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file));
}

export interface SubtitleChunk { cue: number; text: string }
/** Adjacent speech, bounded to ~400 characters/90 seconds, with one-cue overlap. */
export function chunkSubtitles(cues: SubtitleCue[]): SubtitleChunk[] {
  const chunks: SubtitleChunk[] = [];
  for (let start = 0; start < cues.length;) {
    let end = start, text = '';
    while (end < cues.length && end - start < 15 && (end === start || text.length + cues[end].text.length <= 400 &&
      Math.abs(cues[end].seconds - cues[start].seconds) <= 90)) {
      text += (text ? ' ' : '') + cues[end].text;
      end++;
    }
    chunks.push({ cue: Math.floor((start + end - 1) / 2), text });
    if (end === cues.length) break;
    start = end > start + 1 ? end - 1 : end;
  }
  return chunks;
}
