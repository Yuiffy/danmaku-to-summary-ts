import * as fs from 'fs/promises';
import * as path from 'path';
import { QuestionAnswer, QuestionClue, QuestionSource } from './QuestionPolicy';
import { expandGiftTerms } from './QuestionScope';
import { evidenceScorer } from './EvidenceRanking';
import { SemanticSearch } from './SubtitleIndex';
import { parseSubtitle, readSubtitle, recordingFolderDate, recordingSessionKey } from './SubtitleCorpus';
import { activeRecording, recentMinutes } from './RecentRecording';
import { DanmakuAttribution, hasDanmakuText, parseDanmaku } from './DanmakuEvidence';
import { FtsMatch, FtsSearch } from './RecordingFtsIndex';
import { BrowseResult, BrowseSource, RecordingBrowser, RecordingCollection } from './RecordingBrowser';
import { curatedSources, parseHighlight } from './CuratedRecordingSources';

type EvidenceKind = BrowseSource['kind'];
interface Cue extends DanmakuAttribution { seconds: number; text: string }
export interface EvidenceHit extends QuestionSource {
  evidenceId: string;
  excerpt: string;
}
export interface EvidenceSearchHit extends EvidenceHit {
  /** Short context returned with the hit to avoid a model round trip for routine checks. */
  context: Array<DanmakuAttribution & { evidenceId?: string; time: string; text: string }>;
}
export interface StoredEvidence { hit: EvidenceHit; context: EvidenceSearchHit['context'] }
export interface QuestionEvidence {
  scopeDescription?: string;
  search(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }>;
  recent?(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean; [key: string]: unknown }>;
  list?(args: unknown): Promise<BrowseResult>;
  read?(args: unknown): Promise<BrowseResult>;
  context(args: unknown): StoredEvidence | { error: string };
  citation(id: string): QuestionAnswer['source'] | undefined;
  clue(id: string): QuestionClue | undefined;
}
interface RecordingFile { file: string; root: string; date: string | null; kind: EvidenceKind }

export interface RecordingSearch {
  terms: string[]; kind: 'all' | 'subtitle' | 'danmaku'; date: string | null;
  query?: string | null; withinEvidenceId?: string | null;
  collection?: RecordingCollection;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 250;
const MAX_DIRECTORY_ENTRIES = 10000;
const MAX_HITS = 16;
const MAX_EVIDENCE = 512;

export function parseRecordingSearch(args: unknown): RecordingSearch {
  const input = args as Partial<RecordingSearch>;
  if (!input || Object.keys(input).some(key => !['terms', 'kind', 'date', 'query', 'withinEvidenceId', 'collection'].includes(key)) ||
      input.collection !== undefined && !['recordings', 'highlights', 'clips'].includes(input.collection) ||
      !Array.isArray(input.terms) || !input.terms.length || input.terms.length > 5 ||
      input.terms.some(term => typeof term !== 'string' || !term.trim() || Array.from(term).length > 40 || /[\p{Cc}\p{Cf}]/u.test(term)) ||
      !['all', 'subtitle', 'danmaku'].includes(input.kind as string) ||
      input.date !== null && (typeof input.date !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(input.date)) ||
      input.query != null && (typeof input.query !== 'string' || !input.query.trim() || Array.from(input.query).length > 120 || /[\p{Cc}\p{Cf}]/u.test(input.query)) ||
      input.withinEvidenceId != null && (typeof input.withinEvidenceId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(input.withinEvidenceId))) {
    throw new Error('Invalid recording search arguments');
  }
  return input as RecordingSearch;
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

/** Per-question bounded, read-only corpus. Tool arguments never become filesystem paths. */
export class RecordingEvidence {
  private bytesScanned = 0;
  private directoryEntries = 0;
  private enumerationLimited = false;
  private retainedBytes = 0;
  private readonly evidence = new Map<string, StoredEvidence>();
  private readonly directoryCache = new Map<string, import('fs').Dirent[]>();
  private readonly cueCache = new Map<string, Cue[]>();
  private readonly sourceHashes = new Map<string, string>();
  private readonly origins = new Map<string, { file: RecordingFile; index: number }>();
  private readonly ids = new Map<string, string>();
  private readonly browser = new RecordingBrowser({
    files: (date, kind, collection) => collection === 'recordings' ? this.files(date, kind) : curatedSources(this.roots, date, collection,
      folder => this.entries(folder), this.signal, () => { this.enumerationLimited = true; }),
    cues: file => this.browseCues(file), register: (file, index) => this.register(file, index),
    limited: () => this.enumerationLimited || this.directoryEntries >= MAX_DIRECTORY_ENTRIES, checkAbort: () => this.checkAbort()
  });

  constructor(private readonly roots: string[], private readonly signal: AbortSignal,
    private readonly options: { botUid?: string; semanticSearch?: SemanticSearch; indexedSearch?: SemanticSearch; ftsSearch?: FtsSearch; question?: string; roomId?: string; askedAt?: number } = {}) {}

  list(args: unknown): Promise<BrowseResult> { return this.browser.list(args); }
  read(args: unknown): Promise<BrowseResult> {
    // A cited cue also grants access to its known source, never an arbitrary path.
    const input = args as { recordingIds?: unknown };
    if (Array.isArray(input?.recordingIds)) args = { ...input, recordingIds: input.recordingIds.map(id => {
      const origin = typeof id === 'string' ? this.origins.get(id) : undefined;
      return origin ? this.browser.idFor(origin.file) : id;
    }) };
    return this.browser.read(args);
  }
  private async browseCues(file: RecordingFile): Promise<Cue[]> {
    this.checkAbort();
    const cached = this.cueCache.get(file.file);
    if (cached) return cached;
    const size = (await fs.lstat(file.file)).size;
    if (size > MAX_FILE_BYTES || this.bytesScanned + size > MAX_SCAN_BYTES || this.retainedBytes + size > MAX_SCAN_BYTES) throw new Error('Recording read budget exceeded');
    const snapshot = await readSubtitle(file, this.signal);
    const bytes = Buffer.byteLength(snapshot.content, 'utf8');
    this.bytesScanned += bytes; this.retainedBytes += bytes;
    const cues = file.kind === 'danmaku' ? parseDanmaku(snapshot.content, this.options.botUid) : file.kind === 'highlight' ? parseHighlight(snapshot.content) : parseSubtitle(snapshot.content);
    this.sourceHashes.set(file.file, snapshot.hash);
    this.cueCache.set(file.file, cues);
    return cues;
  }

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
        if (!this.cueCache.has(file.file)) this.retainedBytes += stat.size;
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
    const { seconds: _seconds, text: _text, ...attribution } = cue;
    void _seconds; void _text;
    const evidenceId = `ev${this.evidence.size + 1}`;
    const stored = {
      hit: { evidenceId, kind: file.kind, date: file.date, time: timestamp(cue.seconds), excerpt: cue.text.slice(0, 400), ...attribution },
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
      catch { this.enumerationLimited = true; continue; } // Keep searching online roots.
      const folders = [{ folder: root, date: null as string | null }];
      let rootEntries: import('fs').Dirent[];
      try { rootEntries = await this.entries(root); } catch { this.checkAbort(); this.enumerationLimited = true; continue; }
      for (const entry of rootEntries) {
        const folderDate = recordingFolderDate(entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && folderDate &&
            (!date || folderDate.startsWith(date))) folders.push({ folder: path.join(root, entry.name), date: folderDate });
      }
      for (const folder of folders.sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
        let entries: import('fs').Dirent[];
        try { entries = folder.folder === root ? rootEntries : await this.entries(folder.folder); }
        catch { this.checkAbort(); this.enumerationLimited = true; continue; }
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

  private async searchCurated(input: RecordingSearch): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }> {
    if (input.withinEvidenceId || input.kind === 'danmaku') throw new Error('Invalid derived collection search');
    const files = await curatedSources(this.roots, input.date, input.collection!, folder => this.entries(folder), this.signal,
      () => { this.enumerationLimited = true; });
    const score = evidenceScorer(input.terms, input.query || this.options.question);
    const matches: Array<{ file: RecordingFile; index: number; score: number }> = [];
    let limited = this.enumerationLimited || this.directoryEntries >= MAX_DIRECTORY_ENTRIES || files.length > MAX_FILES;
    const deadline = Date.now() + 30000;
    for (const file of files.slice(0, MAX_FILES)) {
      this.checkAbort();
      if (Date.now() >= deadline) { limited = true; break; }
      try {
        const cues = await this.browseCues(file);
        const hits = cues.map((cue, index) => ({ file, index, score: score(cue.text) })).filter(hit => hit.score > 0)
          .sort((a, b) => b.score - a.score).slice(0, 4);
        matches.push(...hits); matches.sort((a, b) => b.score - a.score); matches.splice(32);
      } catch { this.checkAbort(); limited = true; }
    }
    const hits: EvidenceSearchHit[] = [];
    for (const match of matches.slice(0, MAX_HITS)) {
      const stored = this.register(match.file, match.index);
      if (stored) hits.push({ ...stored.hit, context: stored.context }); else limited = true;
    }
    return { hits, limited: limited || matches.length > MAX_HITS };
  }

  async search(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }> {
    const input = parseRecordingSearch(args);
    this.checkAbort();
    if (input.collection && input.collection !== 'recordings') return this.searchCurated(input);
    const terms = expandGiftTerms(input.terms as string[]);
    const scoreText = evidenceScorer(terms, input.query || this.options.question);
    const earliest = /最早|首次|第一次.{0,8}(?:发|出现)/u.test(this.options.question || input.query || '');
    const chronology = (a: { file: RecordingFile; seconds: number; sentAt?: string }, b: { file: RecordingFile; seconds: number; sentAt?: string }) =>
      a.sentAt && b.sentAt ? a.sentAt.localeCompare(b.sentAt) : (a.file.date || '9999').localeCompare(b.file.date || '9999') || a.seconds - b.seconds;
    const anchor = input.withinEvidenceId ? this.origins.get(input.withinEvidenceId) : undefined;
    if (input.withinEvidenceId && !anchor) throw new Error('Unknown session evidence ID');
    if (anchor && anchor.file.kind !== 'subtitle' && anchor.file.kind !== 'danmaku') throw new Error('Derived artifacts require an original recording lookup');
    const fast = await this.options.ftsSearch?.(input.date, terms, { query: input.query || undefined,
      session: anchor?.file, kind: input.kind, earliest });
    let invalidIndexedSource = false;
    const known = anchor ? [...this.origins.values()].map(origin => origin.file) : [];
    const files = fast?.available ? [] : [...new Map([...(await this.files(anchor?.file.date || input.date, input.kind)), ...known].filter(file =>
      (!anchor || recordingSessionKey(file) === recordingSessionKey(anchor.file)) &&
      (input.kind === 'all' || input.kind === file.kind) && (!input.date || file.date?.startsWith(input.date))).map(file => [file.file, file])).values()];
    if (earliest) files.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.file.localeCompare(b.file));
    const semanticMatches: Array<{ file: RecordingFile; index: number }> = [];
    const indexedMatches: Array<{ file: RecordingFile; index: number }> = [];
    for (const { search, recalled, isFts } of [{ search: fast?.available ? async () => fast.matches : this.options.indexedSearch, recalled: indexedMatches, isFts: !!fast?.available },
      { search: this.options.semanticSearch, recalled: semanticMatches, isFts: false }]) {
      if (!search || input.kind === 'danmaku' && !isFts || !isFts && fast?.available && indexedMatches.length) continue;
      try {
        const candidates = await search(input.date, terms, { query: input.query || undefined, session: anchor?.file });
        const roots = new Set<string>();
        for (const root of this.roots) { try { roots.add(await fs.realpath(root)); } catch { /* Offline archive. */ } }
        const snapshots = new Map<string, string>();
        for (const candidate of candidates.slice(0, 32)) {
          this.checkAbort();
          if (anchor && recordingSessionKey(candidate) !== recordingSessionKey(anchor.file) || !roots.has(candidate.root) || !inside(candidate.root, candidate.file) ||
            input.date && !candidate.date?.startsWith(input.date as string)) { invalidIndexedSource = true; continue; }
          const parts = path.relative(candidate.root, candidate.file).split(path.sep);
          const kind = isFts ? (candidate as FtsMatch).kind : 'subtitle';
          if (parts.length > 2 || !(kind === 'subtitle' ? /\.srt$/iu : /\.xml$/iu).test(candidate.file) ||
              input.kind !== 'all' && kind !== input.kind) continue;
          if (parts.length === 2) {
            if (!recordingFolderDate(parts[0]) ||
              (await fs.lstat(path.dirname(candidate.file))).isSymbolicLink()) continue;
          }
          try {
            if (!snapshots.has(candidate.file)) {
              if (this.sourceHashes.get(candidate.file) === candidate.hash && this.cueCache.has(candidate.file)) snapshots.set(candidate.file, candidate.hash);
            }
            if (!snapshots.has(candidate.file)) {
              const size = (await fs.stat(candidate.file)).size;
              if (this.bytesScanned + size > MAX_SCAN_BYTES) { invalidIndexedSource = true; continue; }
              const snapshot = await readSubtitle(candidate, this.signal);
              this.bytesScanned += size;
              snapshots.set(candidate.file, snapshot.hash);
              if (snapshot.hash === candidate.hash) {
                if (!this.cueCache.has(candidate.file)) this.retainedBytes += size;
                this.cueCache.set(candidate.file, kind === 'subtitle' ? parseSubtitle(snapshot.content) : parseDanmaku(snapshot.content, this.options.botUid));
                this.sourceHashes.set(candidate.file, snapshot.hash);
              }
            }
            if (snapshots.get(candidate.file) !== candidate.hash) { invalidIndexedSource = true; continue; }
            const cues = this.cueCache.get(candidate.file)!;
            if (!cues[candidate.cue]) { invalidIndexedSource = true; continue; }
            // Locate a lexical anchor inside the recalled block when available, reducing context round trips.
            let anchor = candidate.cue, best = scoreText(cues[candidate.cue].text);
            for (let i = Math.max(0, candidate.cue - (isFts ? 0 : 7)); i <= Math.min(cues.length - 1, isFts ? (candidate as FtsMatch).endCue - 1 : candidate.cue + 7); i++) {
              if (!isFts && Math.abs(cues[i].seconds - cues[candidate.cue].seconds) > 90) continue;
              const score = scoreText(cues[i].text);
              if (score > best || isFts && earliest && score === best && chronology({ file: { ...candidate, kind }, ...cues[i] },
                { file: { ...candidate, kind }, ...cues[anchor] }) < 0) { best = score; anchor = i; }
            }
            if (recalled.some(hit => hit.file.file === candidate.file && Math.abs(cues[hit.index].seconds - cues[anchor].seconds) <= 20)) continue;
            recalled.push({ file: { ...candidate, kind }, index: anchor });
            if (recalled.length === (isFts ? 32 : 8)) break;
          } catch { this.checkAbort(); invalidIndexedSource = true; }
        }
      } catch { this.checkAbort(); } // Lexical retrieval remains available when embedding/index is unavailable.
    }
    const matches: Array<{ file: RecordingFile; index: number; seconds: number; text: string; score: number; sentAt?: string }> = [];
    if (earliest && fast?.available) indexedMatches.sort((a, b) => chronology({ file: a.file, ...this.cueCache.get(a.file.file)![a.index] },
      { file: b.file, ...this.cueCache.get(b.file.file)![b.index] }));
    // BM25 favors short keyword-only messages. Rank verified anchors by the requested detail
    // before truncation, retaining BM25 order for ties within the same source kind.
    if (!earliest) indexedMatches.sort((a, b) =>
      scoreText(this.cueCache.get(b.file.file)![b.index].text) - scoreText(this.cueCache.get(a.file.file)![a.index].text) ||
      Number(b.file.kind === 'subtitle') - Number(a.file.kind === 'subtitle'));
    let limited = fast?.available ? !fast.complete || !!fast.limited || invalidIndexedSource : input.kind !== 'danmaku' && (!!this.options.semanticSearch || !!this.options.indexedSearch) ||
      !earliest && files.length > MAX_FILES || earliest && files.some(file => !file.date) ||
      this.enumerationLimited || this.directoryEntries >= MAX_DIRECTORY_ENTRIES;
    const deadline = Date.now() + 30000;
    const concepts = terms.filter(term => !terms.some(other => other !== term && term.includes(other)));
    let stopAfter: string | undefined;
    scan: for (const file of earliest ? files : files.slice(0, MAX_FILES)) {
      this.checkAbort();
      // Complete every root/session on the matching day, including the actual day after midnight.
      if (earliest && (Date.now() >= deadline || stopAfter && file.date && file.date > stopAfter)) { limited = true; break; }
      try {
        let cues = this.cueCache.get(file.file);
        if (cues === undefined) {
          const stat = await fs.lstat(file.file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) { limited = true; continue; }
          if (!earliest && this.bytesScanned + stat.size > MAX_SCAN_BYTES) { limited = true; continue; }
          const resolved = await fs.realpath(file.file);
          if (!inside(file.root, resolved)) { limited = true; continue; }
          const handle = await fs.open(resolved, 'r');
          try {
            const opened = await handle.stat();
            if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_FILE_BYTES) { limited = true; continue; }
            if (!earliest && this.bytesScanned + opened.size > MAX_SCAN_BYTES) { limited = true; continue; }
            // Read at most the checked size, including when a recorder is still appending.
            const bytes = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < bytes.length) {
              this.checkAbort();
              if (earliest && Date.now() >= deadline) { limited = true; break scan; }
              const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            this.bytesScanned += offset;
            const content = bytes.subarray(0, offset).toString('utf8');
            if (offset !== bytes.length) limited = true;
            // Chronological lookup discards nonmatching files instead of retaining the whole archive.
            if (earliest && file.kind === 'danmaku' && !hasDanmakuText(content, scoreText)) continue;
            cues = file.kind === 'subtitle' ? parseSrt(content) : parseDanmaku(content, this.options.botUid);
            if (earliest && !cues.some(cue => scoreText(cue.text))) continue;
            if (this.retainedBytes + opened.size > MAX_SCAN_BYTES) { limited = true; continue; }
            this.retainedBytes += opened.size;
            this.cueCache.set(file.file, cues);
          } finally { await handle.close(); }
        }
        if (!cues) continue;
        for (const [index, cue] of cues.entries()) {
          const text = cue.text.toLowerCase();
          const score = scoreText(text);
          if (!score) continue;
          if (earliest && file.date && concepts.join('').length >= 6 && concepts.every(term => text.includes(term))) {
            const through = cue.sentAt?.slice(0, 10) || file.date;
            const day = through > file.date ? through : file.date;
            if (!stopAfter || day < stopAfter) stopAfter = day;
          }
          const duplicate = matches.findIndex(match => match.file.kind === file.kind && (match.text === text ||
            match.file.file === file.file && Math.abs(match.seconds - cue.seconds) <= 20));
          if (duplicate >= 0) {
            const previous = matches[duplicate];
            if (previous.score > score || previous.score === score && (!earliest || chronology(previous, { file, seconds: cue.seconds, sentAt: cue.sentAt }) <= 0)) continue;
            matches.splice(duplicate, 1);
          }
          matches.push({ file, index, seconds: cue.seconds, text, score, sentAt: cue.sentAt });
          // Maintain a small ranked buffer even for a file full of matching spam.
          matches.sort((a, b) => b.score - a.score || (earliest ? chronology(a, b) : 0) || Number(b.file.kind === 'subtitle') - Number(a.file.kind === 'subtitle'));
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
      for (const match of earliest ? [matches[i], indexedMatches[i], semanticMatches[i]] : [indexedMatches[i], matches[i], semanticMatches[i]]) {
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
        const { seconds: _seconds, text: _text, ...attribution } = cues[i];
        void _seconds; void _text;
        hit.context.push({ evidenceId: item.hit.evidenceId, time: item.hit.time, text: cues[i].text.slice(0, 160), ...attribution });
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
      const { seconds: _seconds, text: _text, ...attribution } = cues[i];
      void _seconds; void _text;
      context.push({ evidenceId: stored.hit.evidenceId, time: stored.hit.time, text: cues[i].text.slice(0, 300), ...attribution });
    }
    return { hit: this.evidence.get(input.evidenceId)!.hit, context };
  }

  citation(id: string): QuestionAnswer['source'] | undefined {
    const hit = this.evidence.get(id)?.hit;
    if (!hit) return undefined;
    const { evidenceId, excerpt, ...source } = hit; void evidenceId; void excerpt;
    return source;
  }

  clue(id: string): QuestionClue | undefined {
    const hit = this.evidence.get(id)?.hit;
    if (!hit) return undefined;
    const { evidenceId, ...clue } = hit; void evidenceId;
    return clue;
  }
}
