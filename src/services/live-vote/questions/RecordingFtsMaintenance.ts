import * as fs from 'fs/promises';
import * as path from 'path';
import { setImmediate as yieldTurn } from 'timers/promises';
import { parseDanmaku, DanmakuCue } from './DanmakuEvidence';
import { FtsChunk, FtsSource, RecordingFtsConfig, RecordingFtsWriter, ftsRootsKey } from './RecordingFtsIndex';
import { MAX_SUBTITLE_BYTES, parseSubtitle, readSubtitle, recordingFolderDate, SubtitleCue, SubtitleSource } from './SubtitleCorpus';

interface Source extends SubtitleSource { kind: 'subtitle' | 'danmaku' }
/** Same trusted top-level/date-folder contract, without the interactive directory-entry cap. */
export async function listRecordingSources(configuredRoot: string, signal: AbortSignal): Promise<Source[]> {
  const root = await fs.realpath(configuredRoot), entries = await fs.readdir(root, { withFileTypes: true });
  const folders = [{ folder: root, date: null as string | null }, ...entries.filter(entry => entry.isDirectory() &&
    !entry.isSymbolicLink() && recordingFolderDate(entry.name)).map(entry => ({ folder: path.join(root, entry.name), date: recordingFolderDate(entry.name) }))];
  const sources: Source[] = [];
  for (const folder of folders) {
    signal.throwIfAborted();
    const children = folder.folder === root ? entries : await fs.readdir(folder.folder, { withFileTypes: true });
    const names = new Set(children.map(entry => entry.name.toLowerCase()));
    for (const entry of children) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.(srt|xml)$/iu.test(entry.name) || /\.live\.srt$/iu.test(entry.name) ||
        /\.speaker\.srt$/iu.test(entry.name) && names.has(entry.name.toLowerCase().replace(/\.speaker\.srt$/u, '.srt'))) continue;
      sources.push({ file: path.join(folder.folder, entry.name), root, date: folder.date ||
        /\d{4}[-_]\d{2}[-_]\d{2}/u.exec(entry.name)?.[0].replace(/_/gu, '-') || null,
      kind: /\.srt$/iu.test(entry.name) ? 'subtitle' : 'danmaku' });
    }
  }
  return sources;
}

export function ftsChunks(cues: Array<SubtitleCue | DanmakuCue>, date: string | null): FtsChunk[] {
  const chunks: FtsChunk[] = [];
  const clock = (cue: SubtitleCue | DanmakuCue): string => (cue as DanmakuCue).sentAt || `${date || '9999-12-31'}T${String(Math.floor(cue.seconds / 3600)).padStart(2, '0')}:${String(Math.floor(cue.seconds / 60) % 60).padStart(2, '0')}:${String(Math.floor(cue.seconds) % 60).padStart(2, '0')}`;
  for (let start = 0; start < cues.length;) {
    let end = start, body = '', earliest = clock(cues[start]);
    while (end < cues.length && end - start < 200 && (end === start || body.length + cues[end].text.length < 1400 &&
      Math.abs(cues[end].seconds - cues[start].seconds) <= 90)) {
      body += cues[end].text + '\n'; if (clock(cues[end]) < earliest) earliest = clock(cues[end]); end++;
    }
    const first = cues[start] as DanmakuCue;
    chunks.push({ cue: start, endCue: end, seconds: first.seconds,
      clock: earliest, body });
    start = end;
  }
  return chunks;
}

export interface FtsUpdate { files: number; updated: number; deleted: number; skipped: number; complete: boolean }
/** Polling catches late ASR, corrections and external recovery files, independently of embedding jobs. */
export async function updateRecordingFts(config: RecordingFtsConfig, roomId: string, roots: string[], signal: AbortSignal,
  botUid?: string, progress: (value: FtsUpdate) => void | Promise<void> = () => {}, now = Date.now()): Promise<FtsUpdate> {
  signal.throwIfAborted();
  await fs.mkdir(config.directory, { recursive: true });
  const writer = new RecordingFtsWriter(config);
  const result: FtsUpdate = { files: 0, updated: 0, deleted: 0, skipped: 0, complete: true };
  try {
    const previous = writer.sources(roomId), old = new Map(previous.map(source => [source.file, source]));
    const parserKey = ftsRootsKey([], botUid);
    writer.status(roomId, roots, false, botUid);
    for (const configuredRoot of roots) {
      signal.throwIfAborted();
      let sources: Source[];
      try { sources = await listRecordingSources(configuredRoot, signal); }
      catch { signal.throwIfAborted(); result.complete = false; result.skipped++; continue; }
      const present = new Set(sources.map(source => source.file));
      for (const source of sources) {
        signal.throwIfAborted(); result.files++;
        try {
          const stat = await fs.lstat(source.file), before = old.get(source.file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SUBTITLE_BYTES || now - stat.mtimeMs < 30000) {
            result.skipped++; result.complete = false; continue;
          }
          if (before && before.parserKey === parserKey && before.size === stat.size && before.mtime === stat.mtimeMs && before.root === source.root) continue;
          const snapshot = await readSubtitle(source, signal);
          const after = await fs.stat(source.file);
          if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Recording changed during import');
          const cues = source.kind === 'subtitle' ? parseSubtitle(snapshot.content) : parseDanmaku(snapshot.content, botUid);
          const row: FtsSource = { ...source, roomId, configuredRoot, hash: snapshot.hash, size: stat.size, mtime: stat.mtimeMs, parserKey };
          writer.replace(row, ftsChunks(cues, source.date)); result.updated++;
        } catch { signal.throwIfAborted(); result.skipped++; result.complete = false; }
        if (result.files % 20 === 0) { writer.status(roomId, roots, false, botUid); await progress({ ...result }); }
        await yieldTurn();
      }
      for (const source of previous) if (source.configuredRoot === configuredRoot && !present.has(source.file)) {
        writer.deleteSource(source.id); result.deleted++;
      }
    }
    for (const source of previous) if (!roots.includes(source.configuredRoot)) { writer.deleteSource(source.id); result.deleted++; }
    writer.status(roomId, roots, result.complete, botUid); await progress({ ...result });
    return result;
  } finally { writer.close(); }
}
