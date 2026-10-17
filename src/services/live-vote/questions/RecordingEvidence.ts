import * as fs from 'fs/promises';
import * as path from 'path';
import { QuestionAnswer, QuestionClue, QuestionSource } from './QuestionPolicy';
import { expandGiftTerms } from './QuestionScope';
import { evidenceScorer } from './EvidenceRanking';
import { SemanticSearch } from './SubtitleIndex';
import { parseSubtitle, readSubtitle } from './SubtitleCorpus';
import { activeRecording, recentMinutes } from './RecentRecording';

type EvidenceKind = 'subtitle' | 'danmaku';
interface Cue { seconds: number; text: string }
export interface EvidenceHit extends QuestionSource {
  evidenceId: string;
  excerpt: string;
}
export interface EvidenceSearchHit extends EvidenceHit {
  /** Short context returned with the hit to avoid a model round trip for routine checks. */
  context: Array<{ evidenceId?: string; time: string; text: string }>;
}
export interface StoredEvidence { hit: EvidenceHit; context: Array<{ evidenceId?: string; time: string; text: string }> }
export interface QuestionEvidence {
  scopeDescription?: string;
  search(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }>;
  recent?(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean; [key: string]: unknown }>;
  context(args: unknown): StoredEvidence | { error: string };
  citation(id: string): QuestionAnswer['source'] | undefined;
  clue(id: string): QuestionClue | undefined;
}
interface RecordingFile { file: string; root: string; date: string | null; kind: EvidenceKind }

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 250;
const MAX_DIRECTORY_ENTRIES = 10000;
const MAX_HITS = 16;
const MAX_EVIDENCE = 512;

export function parseRecordingSearch(args: unknown): { terms: string[]; kind: 'all' | 'subtitle' | 'danmaku'; date: string | null } {
  const input = args as { terms?: unknown; kind?: unknown; date?: unknown };
  if (!input || Object.keys(input).some(key => !['terms', 'kind', 'date'].includes(key)) ||
      !Array.isArray(input.terms) || !input.terms.length || input.terms.length > 5 ||
      input.terms.some(term => typeof term !== 'string' || !term.trim() || Array.from(term).length > 40 || /[\p{Cc}\p{Cf}]/u.test(term)) ||
      !['all', 'subtitle', 'danmaku'].includes(input.kind as string) ||
      input.date !== null && (typeof input.date !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(input.date))) {
    throw new Error('Invalid recording search arguments');
  }
  return input as { terms: string[]; kind: 'all' | 'subtitle' | 'danmaku'; date: string | null };
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function timestamp(seconds: number): string {
  const value = Math.floor(Math.max(0, seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
}

function plainText(text: string): string {
  return text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000);
}

function parseSrt(content: string): Cue[] {
  const result: Cue[] = [];
  for (const block of content.replace(/^\uFEFF/u, '').split(/\r?\n\s*\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const index = lines.findIndex(line => /^\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*-->/u.test(line));
    if (index < 0) continue;
    const parts = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})/u.exec(lines[index])!;
    const text = plainText(lines.slice(index + 1).join(' ').replace(/<[^>]*>/gu, ''));
    if (text) result.push({ seconds: Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 1000, text });
  }
  return result;
}

/** No XML parser/entity resolver: only literal recorded <d> text and its relative time. */
function parseDanmaku(content: string, botUid?: string): Cue[] {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const result: Cue[] = [];
  for (const match of content.matchAll(/<d\s+[^>]*\bp=["']([^"']+)["'][^>]*>([^<]*)<\/d>/gu)) {
    const fields = match[1].split(',');
    const seconds = Number(fields[0]);
    if (botUid && fields[6] === botUid) continue;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const text = plainText(match[2].replace(/&(amp|lt|gt|quot|apos);/gu, (_entity, name: string) => entities[name])
      .replace(/&#(x[0-9a-f]+|\d+);/giu, (_entity, number: string) => {
        const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }));
    if (text && !/^@鹿饼/u.test(text) && !/^鹿饼(?:收到|答[:：])/u.test(text)) result.push({ seconds, text });
  }
  return result;
}

/** Per-question bounded, read-only corpus. Tool arguments never become filesystem paths. */
export class RecordingEvidence {
  private bytesScanned = 0;
  private directoryEntries = 0;
  private readonly evidence = new Map<string, StoredEvidence>();
  private readonly directoryCache = new Map<string, import('fs').Dirent[]>();
  private readonly cueCache = new Map<string, Cue[]>();
  private readonly origins = new Map<string, { file: RecordingFile; index: number }>();
  private readonly ids = new Map<string, string>();

  constructor(private readonly roots: string[], private readonly signal: AbortSignal,
    private readonly options: { botUid?: string; semanticSearch?: SemanticSearch; question?: string; roomId?: string; askedAt?: number } = {}) {}

  async recent(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean; [key: string]: unknown }> {
    const minutes = recentMinutes(args);
    this.checkAbort();
    const files = await this.files(null, 'all');
    const active = await activeRecording(files.map(file => file.file), this.options.roomId || '', this.options.askedAt ?? Date.now());
    this.checkAbort();
    if (!active) return { hits: [], limited: true, status: 'no_active_recording' };
    const from = Math.max(0, active.end - minutes * 60);
    const selected = files.filter(file => file.file.replace(/(?:\.live)?\.(?:srt|xml)$/iu, '') === active.base);
    const hits: EvidenceSearchHit[] = [];
    let limited = false, subtitleThrough = 0;
    for (const file of selected) {
      this.checkAbort();
      try {
        const stat = await fs.lstat(file.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || this.bytesScanned + stat.size > MAX_SCAN_BYTES) { limited = true; continue; }
        const real = await fs.realpath(file.file);
        if (!inside(file.root, real) || real !== file.file) { limited = true; continue; }
        const handle = await fs.open(file.file, 'r');
        let content: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > MAX_FILE_BYTES || this.bytesScanned + opened.size > MAX_SCAN_BYTES) { limited = true; continue; }
          const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, stat.size + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          content = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
        this.bytesScanned += stat.size;
        this.checkAbort();
        const cues = file.kind === 'subtitle' ? parseSrt(content) : parseDanmaku(content, this.options.botUid);
        this.cueCache.set(file.file, cues);
        if (file.kind === 'subtitle') subtitleThrough = Math.max(subtitleThrough, cues.at(-1)?.seconds || 0);
        const indices = cues.flatMap((cue, index) => cue.seconds >= from && cue.seconds <= active.end ? [index] : []);
        limited ||= indices.length > 48;
        // Even sampling bounds context while covering the whole requested interval.
        for (let n = 0; n < Math.min(48, indices.length); n++) {
          const index = indices[Math.floor(n * indices.length / Math.min(48, indices.length))];
          const stored = this.register(file, index);
          if (stored) hits.push({ ...stored.hit, context: [{ evidenceId: stored.hit.evidenceId, time: stored.hit.time, text: stored.hit.excerpt }] });
          else limited = true;
        }
      } catch { this.checkAbort(); limited = true; }
    }
    return { hits, limited, window: { from, to: active.end, minutes, clock: 'recorder_filename_estimate' },
      subtitleThrough, subtitleLagS: Math.max(0, active.end - subtitleThrough),
      notice: '字幕和弹幕是两个来源；未转写尾部、静音及抽样不能用于推断没说过。' };
  }

  private register(file: RecordingFile, index: number): StoredEvidence | undefined {
    const key = `${file.file}\0${index}`;
    const existing = this.ids.get(key);
    if (existing) return this.evidence.get(existing);
    if (this.evidence.size >= MAX_EVIDENCE) return undefined;
    const cues = this.cueCache.get(file.file)!;
    const cue = cues[index];
    const evidenceId = `ev${this.evidence.size + 1}`;
    const stored = {
      hit: { evidenceId, kind: file.kind, date: file.date, time: timestamp(cue.seconds), excerpt: cue.text.slice(0, 400) },
      context: cues.slice(Math.max(0, index - 2), index + 3).map(item => ({ time: timestamp(item.seconds), text: item.text.slice(0, 300) }))
    };
    this.evidence.set(evidenceId, stored);
    this.origins.set(evidenceId, { file, index });
    this.ids.set(key, evidenceId);
    return stored;
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw new Error('Recording search cancelled');
  }

  private async entries(folder: string): Promise<import('fs').Dirent[]> {
    this.checkAbort();
    const cached = this.directoryCache.get(folder);
    if (cached) return cached;
    if (this.directoryEntries >= MAX_DIRECTORY_ENTRIES) return [];
    const results: import('fs').Dirent[] = [];
    const directory = await fs.opendir(folder);
    try {
      for await (const entry of directory) {
        this.checkAbort();
        if (++this.directoryEntries > MAX_DIRECTORY_ENTRIES) break;
        results.push(entry);
      }
    } catch (error) {
      this.checkAbort();
      throw error;
    }
    this.directoryCache.set(folder, results);
    return results;
  }

  private async files(date: string | null, kind: string): Promise<RecordingFile[]> {
    const files: RecordingFile[] = [];
    for (const configuredRoot of this.roots) {
      this.checkAbort();
      let root: string;
      try { root = await fs.realpath(configuredRoot); }
      catch { continue; } // An offline archive must not prevent searching the active root.
      const folders = [{ folder: root, date: null as string | null }];
      let rootEntries: import('fs').Dirent[];
      try { rootEntries = await this.entries(root); } catch { this.checkAbort(); continue; }
      for (const entry of rootEntries) {
        const folderDate = entry.name.replace(/_/gu, '-');
        if (entry.isDirectory() && !entry.isSymbolicLink() && /^\d{4}-\d{2}-\d{2}$/u.test(folderDate) &&
            (!date || folderDate.startsWith(date))) folders.push({ folder: path.join(root, entry.name), date: folderDate });
      }
      for (const folder of folders.sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
        let entries: import('fs').Dirent[];
        try { entries = folder.folder === root ? rootEntries : await this.entries(folder.folder); }
        catch { this.checkAbort(); continue; }
        const names = new Set(entries.map(entry => entry.name.toLowerCase()));
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          const extension = path.extname(entry.name).toLowerCase();
          if (!['.srt', '.xml'].includes(extension)) continue;
          if (/\.live\.srt$/iu.test(entry.name) && names.has(entry.name.toLowerCase().replace(/\.live\.srt$/u, '.srt'))) continue;
          if (/\.speaker\.srt$/iu.test(entry.name) && names.has(entry.name.toLowerCase().replace(/\.speaker\.srt$/u, '.srt'))) continue;
          const fileDate = folder.date || /\d{4}[-_]\d{2}[-_]\d{2}/u.exec(entry.name)?.[0].replace(/_/gu, '-') || null;
          const fileKind: EvidenceKind = extension === '.srt' ? 'subtitle' : 'danmaku';
          if (date && !fileDate?.startsWith(date) || kind !== 'all' && kind !== fileKind) continue;
          files.push({ file: path.join(folder.folder, entry.name), root, date: fileDate, kind: fileKind });
        }
      }
    }
    return files.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file));
  }

  async search(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }> {
    const input = parseRecordingSearch(args);
    this.checkAbort();
    const terms = expandGiftTerms(input.terms as string[]);
    const scoreText = evidenceScorer(terms, this.options.question);
    const files = await this.files(input.date as string | null, input.kind as string);
    const semanticMatches: Array<{ file: RecordingFile; index: number }> = [];
    if (this.options.semanticSearch && input.kind !== 'danmaku') {
      try {
        const candidates = await this.options.semanticSearch(input.date as string | null, terms);
        const roots = new Set<string>();
        for (const root of this.roots) { try { roots.add(await fs.realpath(root)); } catch { /* Offline archive. */ } }
        const snapshots = new Map<string, string>();
        for (const candidate of candidates.slice(0, 32)) {
          this.checkAbort();
          if (!roots.has(candidate.root) || !inside(candidate.root, candidate.file) ||
            input.date && !candidate.date?.startsWith(input.date as string)) continue;
          const parts = path.relative(candidate.root, candidate.file).split(path.sep);
          if (parts.length > 2 || !/\.srt$/iu.test(candidate.file)) continue;
          if (parts.length === 2) {
            if (!/^\d{4}[-_]\d{2}[-_]\d{2}$/u.test(parts[0]) ||
              (await fs.lstat(path.dirname(candidate.file))).isSymbolicLink()) continue;
          }
          try {
            if (!snapshots.has(candidate.file)) {
              const size = (await fs.stat(candidate.file)).size;
              if (this.bytesScanned + size > MAX_SCAN_BYTES) continue;
              const snapshot = await readSubtitle(candidate, this.signal);
              this.bytesScanned += size;
              snapshots.set(candidate.file, snapshot.hash);
              if (snapshot.hash === candidate.hash) this.cueCache.set(candidate.file, parseSubtitle(snapshot.content));
            }
            if (snapshots.get(candidate.file) !== candidate.hash) continue;
            const cues = this.cueCache.get(candidate.file)!;
            if (!cues[candidate.cue]) continue;
            // Locate a lexical anchor inside the recalled block when available, reducing context round trips.
            let anchor = candidate.cue, best = 0;
            for (let i = Math.max(0, candidate.cue - 7); i <= Math.min(cues.length - 1, candidate.cue + 7); i++) {
              if (Math.abs(cues[i].seconds - cues[candidate.cue].seconds) > 90) continue;
              const score = scoreText(cues[i].text);
              if (score > best) { best = score; anchor = i; }
            }
            if (semanticMatches.some(hit => hit.file.file === candidate.file && Math.abs(cues[hit.index].seconds - cues[anchor].seconds) <= 20)) continue;
            semanticMatches.push({ file: { ...candidate, kind: 'subtitle' }, index: anchor });
            if (semanticMatches.length === 8) break;
          } catch { this.checkAbort(); }
        }
      } catch { this.checkAbort(); } // Lexical retrieval remains available when embedding/index is unavailable.
    }
    const matches: Array<{ file: RecordingFile; index: number; seconds: number; text: string; score: number }> = [];
    let limited = !!this.options.semanticSearch || files.length > MAX_FILES || this.directoryEntries >= MAX_DIRECTORY_ENTRIES;
    for (const file of files.slice(0, MAX_FILES)) {
      this.checkAbort();
      try {
        let cues = this.cueCache.get(file.file);
        if (cues === undefined) {
          const stat = await fs.lstat(file.file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) { limited = true; continue; }
          if (this.bytesScanned + stat.size > MAX_SCAN_BYTES) { limited = true; continue; }
          const resolved = await fs.realpath(file.file);
          if (!inside(file.root, resolved)) continue;
          const handle = await fs.open(resolved, 'r');
          try {
            const opened = await handle.stat();
            if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_FILE_BYTES) { limited = true; continue; }
            if (this.bytesScanned + opened.size > MAX_SCAN_BYTES) { limited = true; continue; }
            // Read at most the checked size, including when a recorder is still appending.
            const bytes = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < bytes.length) {
              this.checkAbort();
              const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            this.bytesScanned += offset;
            const content = bytes.subarray(0, offset).toString('utf8');
            // A question reuses its bounded snapshot when the agent tries another keyword.
            cues = file.kind === 'subtitle' ? parseSrt(content) : parseDanmaku(content, this.options.botUid);
            this.cueCache.set(file.file, cues);
          } finally { await handle.close(); }
        }
        if (!cues) continue;
        for (const [index, cue] of cues.entries()) {
          const text = cue.text.toLowerCase();
          const score = scoreText(text);
          if (!score) continue;
          const duplicate = matches.findIndex(match => match.file.kind === file.kind && (match.text === text ||
            match.file.file === file.file && Math.abs(match.seconds - cue.seconds) <= 20));
          if (duplicate >= 0) {
            if (matches[duplicate].score >= score) continue;
            matches.splice(duplicate, 1);
          }
          matches.push({ file, index, seconds: cue.seconds, text, score });
          // Maintain a small ranked buffer even for a file full of matching spam.
          matches.sort((a, b) => b.score - a.score || Number(b.file.kind === 'subtitle') - Number(a.file.kind === 'subtitle'));
          // A long, repetitive recording cannot occupy the entire candidate pool.
          const fromFile = matches.filter(match => match.file.file === file.file);
          if (fromFile.length > 4) matches.splice(matches.indexOf(fromFile.at(-1)!), 1);
          if (matches.length > 64) matches.pop();
        }
      } catch { this.checkAbort(); limited = true; }
    }
    const hits: EvidenceSearchHit[] = [];
    const combined: Array<{ file: RecordingFile; index: number }> = [];
    // Alternate independent recall lists; neither common keywords nor approximate similarity can monopolize evidence.
    for (let i = 0; i < MAX_HITS; i++) {
      for (const match of [matches[i], semanticMatches[i]]) {
        if (match && !combined.some(item => item.file.file === match.file.file && item.index === match.index)) combined.push(match);
      }
    }
    for (const match of combined.slice(0, MAX_HITS)) {
      const stored = this.register(match.file, match.index);
      if (!stored) { limited = true; break; }
      hits.push({ ...stored.hit, context: stored.context.map(cue => ({ ...cue, text: cue.text.slice(0, 160) })) });
    }
    // Give contextual claims their own citations, not the neighboring keyword's excerpt.
    for (const hit of hits) {
      const { file, index } = this.origins.get(hit.evidenceId)!;
      const cues = this.cueCache.get(file.file)!;
      hit.context = [];
      for (let i = Math.max(0, index - 2); i <= Math.min(cues.length - 1, index + 2); i++) {
        const item = this.register(file, i);
        if (!item) { limited = true; break; }
        hit.context.push({ evidenceId: item.hit.evidenceId, time: item.hit.time, text: cues[i].text.slice(0, 160) });
      }
    }
    return { hits, limited };
  }

  context(args: unknown): StoredEvidence | { error: string } {
    this.checkAbort();
    const input = args as { evidenceId?: string };
    if (!input || Object.keys(input).length !== 1 || typeof input.evidenceId !== 'string') return { error: 'Invalid evidence ID' };
    const origin = this.origins.get(input.evidenceId);
    if (!origin) return { error: 'Unknown evidence ID' };
    const { file, index } = origin;
    const cues = this.cueCache.get(file.file)!;
    const context: StoredEvidence['context'] = [];
    for (let i = Math.max(0, index - 10); i <= Math.min(cues.length - 1, index + 10); i++) {
      if (Math.abs(cues[i].seconds - cues[index].seconds) > 90) continue;
      const stored = this.register(file, i);
      if (!stored) break;
      context.push({ evidenceId: stored.hit.evidenceId, time: stored.hit.time, text: cues[i].text.slice(0, 300) });
    }
    return { hit: this.evidence.get(input.evidenceId)!.hit, context };
  }

  citation(id: string): QuestionAnswer['source'] | undefined {
    const hit = this.evidence.get(id)?.hit;
    return hit ? { kind: hit.kind, date: hit.date, time: hit.time } : undefined;
  }

  clue(id: string): QuestionClue | undefined {
    const hit = this.evidence.get(id)?.hit;
    return hit ? { kind: hit.kind, date: hit.date, time: hit.time, excerpt: hit.excerpt } : undefined;
  }
}
