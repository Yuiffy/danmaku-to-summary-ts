import * as path from 'path';
import { QuestionClue } from './QuestionPolicy';
import { recordingSessionKey, SubtitleSource } from './SubtitleCorpus';

export type RecordingCollection = 'recordings' | 'highlights' | 'clips';
export interface BrowseSource extends SubtitleSource { kind: 'subtitle' | 'danmaku' | 'highlight' | 'clip-subtitle' }
export interface BrowseHit extends QuestionClue { evidenceId: string; context: Array<{ evidenceId?: string; time: string; text: string }> }
export interface BrowseEntry {
  recordingId: string; sessionId: string; date: string | null; kind: BrowseSource['kind'];
  roomId?: string; roomName?: string;
  label: string; part: number | null; timeBasis: 'recording_offset' | 'clip_offset' | 'highlight_approximate';
  totalCues: number | null; sampled: boolean;
  preview: BrowseHit[]; nextCueOffset: number | null;
}
export interface BrowseResult { recordings: BrowseEntry[]; total: number; nextOffset: number | null; limited: boolean }
export interface ListRecordings {
  collection: RecordingCollection; kind: 'all' | 'subtitle' | 'danmaku'; date: string | null;
  offset: number; limit: number; preview: 'none' | 'head' | 'sample'; cuesPerRecording: number;
}
export interface ReadRecordings {
  recordingIds: string[]; startSeconds: number; endSeconds: number | null; offset: number; limitPerRecording: number;
}
export interface BrowseAdapters {
  files(date: string | null, kind: string, collection: RecordingCollection): Promise<BrowseSource[]>;
  cues(file: BrowseSource): Promise<Array<{ seconds: number; text: string }>>;
  register(file: BrowseSource, index: number): { hit: Omit<BrowseHit, 'context'>; context: BrowseHit['context'] } | undefined;
  limited(): boolean;
  checkAbort(): void;
}

export function parseListRecordings(args: unknown): ListRecordings {
  const v = args as ListRecordings;
  if (!v || Object.keys(v).sort().join(',') !== 'collection,cuesPerRecording,date,kind,limit,offset,preview' ||
      !['recordings', 'highlights', 'clips'].includes(v.collection) || !['all', 'subtitle', 'danmaku'].includes(v.kind) ||
      v.collection !== 'recordings' && v.kind === 'danmaku' ||
      v.date !== null && (typeof v.date !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(v.date)) ||
      !Number.isInteger(v.offset) || v.offset < 0 || v.offset > 10000 || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 32 ||
      !['none', 'head', 'sample'].includes(v.preview) || !Number.isInteger(v.cuesPerRecording) || v.cuesPerRecording < 1 || v.cuesPerRecording > 12) {
    throw new Error('Invalid recording listing');
  }
  return v;
}
export function parseReadRecordings(args: unknown): ReadRecordings {
  const v = args as ReadRecordings;
  if (!v || Object.keys(v).sort().join(',') !== 'endSeconds,limitPerRecording,offset,recordingIds,startSeconds' ||
      !Array.isArray(v.recordingIds) || !v.recordingIds.length || v.recordingIds.length > 32 || new Set(v.recordingIds).size !== v.recordingIds.length ||
      v.recordingIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) ||
      !Number.isFinite(v.startSeconds) || v.startSeconds < 0 || v.startSeconds > 604800 ||
      v.endSeconds !== null && (!Number.isFinite(v.endSeconds) || v.endSeconds < v.startSeconds || v.endSeconds > 604800) ||
      !Number.isInteger(v.offset) || v.offset < 0 || v.offset > 100000 || !Number.isInteger(v.limitPerRecording) ||
      v.limitPerRecording < 1 || v.limitPerRecording > 80 || v.limitPerRecording * v.recordingIds.length > 384) throw new Error('Invalid recording read');
  return v;
}

/** Per-question opaque IDs; generic listing, chronological reads and representative previews. */
export class RecordingBrowser {
  private readonly sources = new Map<string, BrowseSource>();
  private readonly ids = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  constructor(private readonly io: BrowseAdapters) {}

  idFor(file: BrowseSource): string {
    let id = this.ids.get(file.file);
    if (!id) { id = `rec${this.sources.size + 1}`; this.ids.set(file.file, id); this.sources.set(id, file); }
    return id;
  }
  source(id: string): BrowseSource | undefined { return this.sources.get(id); }
  private entry(file: BrowseSource): BrowseEntry {
    const name = path.basename(file.file);
    const clock = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_/u.exec(name) ||
      /^录制-\d+-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/u.exec(name);
    // Recognized recorder clocks link archive copies and derived artifacts without exposing paths.
    const key = clock ? clock.slice(1, 7).join('-') : recordingSessionKey(file);
    if (!this.sessions.has(key)) this.sessions.set(key, `session${this.sessions.size + 1}`);
    const part = /_(\d+)_fix(?:\.speaker)?\.srt$/iu.exec(file.file);
    return { recordingId: this.idFor(file), sessionId: this.sessions.get(key)!, date: file.date, kind: file.kind,
      label: path.basename(file.file).slice(0, 160), part: part ? Number(part[1]) : null,
      timeBasis: file.kind === 'highlight' ? 'highlight_approximate' : file.kind === 'clip-subtitle' ? 'clip_offset' : 'recording_offset',
      preview: [], nextCueOffset: null, totalCues: null, sampled: false };
  }
  async list(args: unknown): Promise<BrowseResult> {
    const input = parseListRecordings(args);
    this.io.checkAbort();
    const files = await this.io.files(input.date, input.kind, input.collection);
    const result: BrowseResult = { recordings: [], total: files.length, nextOffset: input.offset + input.limit < files.length ? input.offset + input.limit : null, limited: this.io.limited() };
    // Keep evidence capacity for focused reads after a broad overview.
    const previewLimit = Math.min(input.cuesPerRecording, Math.max(1, Math.floor(128 / input.limit)));
    const deadline = Date.now() + 30000;
    for (const file of files.slice(input.offset, input.offset + input.limit)) {
      this.io.checkAbort();
      if (Date.now() >= deadline) { result.limited = true; result.nextOffset = input.offset + result.recordings.length; break; }
      const entry = this.entry(file);
      if (input.preview !== 'none') {
        try {
          const cues = await this.io.cues(file), count = Math.min(cues.length, previewLimit);
          entry.totalCues = cues.length;
          entry.sampled = input.preview === 'sample' && count < cues.length;
          for (let i = 0; i < count; i++) {
            const index = input.preview === 'sample' && count > 1 ? Math.floor(i * (cues.length - 1) / (count - 1)) : i;
            const stored = this.io.register(file, index);
            if (stored) entry.preview.push({ ...stored.hit, excerpt: stored.hit.excerpt.slice(0, 160), context: [] }); else result.limited = true;
          }
          entry.nextCueOffset = input.preview === 'head' && count < cues.length ? count : null;
          result.limited ||= count < cues.length;
        } catch { this.io.checkAbort(); result.limited = true; }
      }
      result.recordings.push(entry);
    }
    return { ...result, limited: result.limited || result.nextOffset !== null };
  }
  async read(args: unknown): Promise<BrowseResult> {
    const input = parseReadRecordings(args);
    // Validate the entire batch before reading anything.
    const files = input.recordingIds.map(id => this.sources.get(id));
    if (files.some(file => !file)) throw new Error('Unknown recording ID');
    const result: BrowseResult = { recordings: [], total: files.length, nextOffset: null, limited: this.io.limited() };
    const deadline = Date.now() + 30000;
    for (const file of files) {
      this.io.checkAbort();
      if (Date.now() >= deadline) { result.limited = true; break; }
      const entry = this.entry(file!);
      try {
        const cues = await this.io.cues(file!);
        entry.totalCues = cues.length;
        const indices = cues.flatMap((cue, index) => cue.seconds >= input.startSeconds && (input.endSeconds === null || cue.seconds <= input.endSeconds) ? [index] : []);
        for (const index of indices.slice(input.offset, input.offset + input.limitPerRecording)) {
          const stored = this.io.register(file!, index);
          if (stored) entry.preview.push({ ...stored.hit, excerpt: stored.hit.excerpt.slice(0, 160), context: [] }); else result.limited = true;
        }
        entry.nextCueOffset = input.offset + input.limitPerRecording < indices.length ? input.offset + input.limitPerRecording : null;
        result.limited ||= entry.nextCueOffset !== null;
      } catch { this.io.checkAbort(); result.limited = true; }
      result.recordings.push(entry);
    }
    return result;
  }
}

/** One bounded refinement of an incomplete overview before accepting an absence verdict. */
export function browseRefinement(result: BrowseResult): ReadRecordings | undefined {
  const candidates = result.recordings.filter(entry => entry.totalCues === null || entry.sampled || entry.nextCueOffset !== null).slice(0, 4);
  if (!candidates.length) return undefined;
  return { recordingIds: candidates.map(entry => entry.recordingId), startSeconds: 0, endSeconds: null,
    offset: 0, limitPerRecording: Math.min(80, Math.floor(384 / candidates.length)) };
}
