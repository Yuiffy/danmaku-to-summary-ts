import { Embedder } from './EmbeddingClient';
import { readGiftCatalog } from './GiftCatalog';
import { LiveQuestionConfig, QuestionClue, QuestionRequest } from './QuestionPolicy';
import { embeddingQuestion, isGiftQuestion, QuestionRoom, questionScope } from './QuestionScope';
import { EvidenceHit, EvidenceSearchHit, QuestionEvidence, RecordingEvidence, StoredEvidence, parseRecordingSearch } from './RecordingEvidence';
import { loadManifest, searchSubtitleIndex, SemanticMatch, SemanticFocus } from './SubtitleIndex';
import { SubtitleLexicalReader } from './SubtitleLexicalIndex';
import { recordingSessionKey } from './SubtitleCorpus';
import { createFtsSearch } from './RecordingFtsIndex';
import { BrowseResult, parseListRecordings, parseReadRecordings } from './RecordingBrowser';

interface RoomCorpus { room: QuestionRoom; recordings: RecordingEvidence; gifts?: Promise<EvidenceSearchHit[]> }
interface Origin { corpus: RoomCorpus; localId: string; gift?: EvidenceSearchHit }

/** One bounded question, sequential room searches, cached query embeddings, room-qualified evidence IDs. */
export class QuestionCorpus implements QuestionEvidence {
  readonly scopeDescription: string;
  readonly rooms: QuestionRoom[];
  readonly coverage = new Map<string, { indexedFiles: number; indexComplete: boolean; catalogStatus: 'disabled' | 'ready' | 'unavailable'; lexicalStatus: 'disabled' | 'ready' | 'partial' }>();
  embeddingStatus: 'disabled' | 'ready' | 'unavailable';
  private readonly corpora: RoomCorpus[];
  private readonly origins = new Map<string, Origin>();
  private readonly recordingOrigins = new Map<string, { corpus: RoomCorpus; localId: string }>();
  private readonly semanticCache = new Map<string, Promise<SemanticMatch[]>>();
  private embedder?: Embedder;
  private readonly vectors = new Map<string, Promise<Float32Array | undefined>>();
  private readonly lexicalReader = new SubtitleLexicalReader();

  constructor(private readonly config: LiveQuestionConfig, private readonly request: Pick<QuestionRequest, 'roomId' | 'question' | 'askedAt'>,
    private readonly signal: AbortSignal, botUid?: string, private readonly makeEmbedder?: () => Embedder) {
    this.rooms = questionScope(config, request.roomId, request.question);
    this.scopeDescription = `本次查询资料范围：${JSON.stringify(this.rooms.map(({ roomId, name }) => ({ roomId, name })))}。回答与引用必须分清来源。`;
    this.embeddingStatus = config.semantic?.enabled ? 'unavailable' : 'disabled';
    this.corpora = this.rooms.map(room => {
      this.coverage.set(room.roomId, { indexedFiles: 0, indexComplete: false, catalogStatus: config.giftCatalogs?.[room.roomId] ? 'unavailable' : 'disabled', lexicalStatus: config.lexical?.enabled || config.semantic?.enabled ? 'partial' : 'disabled' });
      const fts = config.lexical?.enabled ? createFtsSearch(config.lexical, room.roomId, config.recordingRoots[room.roomId], signal, botUid) : undefined;
      return { room, recordings: new RecordingEvidence(config.recordingRoots[room.roomId], signal, { botUid, question: request.question, roomId: room.roomId, askedAt: request.askedAt,
        ...(fts ? { ftsSearch: async (date, terms, focus) => {
          const result = await fts(date, terms, focus);
          Object.assign(this.coverage.get(room.roomId)!, { indexedFiles: result.indexedFiles, indexComplete: result.complete,
            lexicalStatus: result.available && result.complete ? 'ready' : 'partial' });
          return result;
        } } : {}),
        ...(config.semantic?.enabled ? { indexedSearch: (date, terms, focus) => this.lexical(room.roomId, date, terms, focus) } : {}),
        ...(config.semantic?.enabled && makeEmbedder ? { semanticSearch: (date, _terms, focus) => this.semantic(room.roomId, date, focus) } : {}) }) };
    });
  }

  private async lexical(roomId: string, date: string | null, terms: string[], focus?: SemanticFocus): Promise<SemanticMatch[]> {
    const config = this.config.semantic!, roots = this.config.recordingRoots[roomId];
    const manifest = await loadManifest(config, roomId, roots);
    if (!this.config.lexical?.enabled) Object.assign(this.coverage.get(roomId)!, { indexedFiles: manifest?.sources.length || 0, indexComplete: !!manifest && !manifest.incomplete });
    if (!manifest) return [];
    let question = this.request.question.normalize('NFKC').toLowerCase();
    for (const alias of this.rooms.flatMap(room => room.aliases).sort((a, b) => b.length - a.length)) {
      question = question.split(alias.normalize('NFKC').toLowerCase()).join(' ');
    }
    const result = await this.lexicalReader.search(config.directory, manifest.sources, terms,
      question, this.signal, date, focus?.session ? new Set(manifest.sources.filter(source =>
        recordingSessionKey(source) === recordingSessionKey(focus.session!)).map(source => source.file)) : focus?.files);
    if (!this.config.lexical?.enabled) this.coverage.get(roomId)!.lexicalStatus = result.complete && !manifest.incomplete ? 'ready' : 'partial';
    return result.matches;
  }

  private async semantic(roomId: string, date: string | null, focus?: SemanticFocus): Promise<SemanticMatch[]> {
    const query = embeddingQuestion(focus?.query || this.request.question);
    const key = JSON.stringify([roomId, date, query, focus?.files ? [...focus.files].sort() : null, focus?.session ? recordingSessionKey(focus.session) : null]);
    let operation = this.semanticCache.get(key);
    if (!operation) {
      operation = (async () => {
        const config = this.config.semantic!, roots = this.config.recordingRoots[roomId];
        const manifest = await loadManifest(config, roomId, roots);
        if (!this.config.lexical?.enabled) Object.assign(this.coverage.get(roomId)!, { indexedFiles: manifest?.sources.length || 0, indexComplete: !!manifest && !manifest.incomplete });
        if (!manifest?.sources.length) return [];
        if (!this.vectors.has(query) && this.vectors.size < 6) this.vectors.set(query, (async () => {
          try {
            this.embedder ??= this.makeEmbedder!();
            const [vector] = await this.embedder.embed([query], this.signal, true);
            this.embeddingStatus = 'ready'; return vector;
          } catch { this.signal.throwIfAborted(); return undefined; }
        })());
        const vector = await this.vectors.get(query);
        const files = focus?.session ? new Set(manifest.sources.filter(source =>
          recordingSessionKey(source) === recordingSessionKey(focus.session!)).map(source => source.file)) : focus?.files;
        return vector ? searchSubtitleIndex(config, roomId, roots, vector, date, this.signal, files) : [];
      })();
      this.semanticCache.set(key, operation);
    }
    return operation;
  }

  private qualify(corpus: RoomCorpus, hit: EvidenceHit, gift?: EvidenceSearchHit): EvidenceHit {
    const evidenceId = `r${corpus.room.roomId}_${hit.evidenceId}`;
    this.origins.set(evidenceId, { corpus, localId: hit.evidenceId, gift });
    return { ...hit, evidenceId, roomId: corpus.room.roomId, roomName: corpus.room.name };
  }
  private qualifyBrowse(corpus: RoomCorpus, result: BrowseResult): BrowseResult {
    return { ...result, recordings: result.recordings.map(entry => {
      const recordingId = `r${corpus.room.roomId}_${entry.recordingId}`;
      this.recordingOrigins.set(recordingId, { corpus, localId: entry.recordingId });
      return { ...entry, recordingId, sessionId: `r${corpus.room.roomId}_${entry.sessionId}`,
        roomId: corpus.room.roomId, roomName: corpus.room.name,
        preview: entry.preview.map(hit => ({ ...hit, ...this.qualify(corpus, hit), context: this.qualifyContext(corpus, hit.context) })) };
    }) };
  }
  async list(args: unknown): Promise<BrowseResult> {
    const input = parseListRecordings(args);
    const limit = Math.max(1, Math.floor(input.limit / this.corpora.length));
    const result: BrowseResult = { recordings: [], total: 0, nextOffset: null, limited: false };
    for (const corpus of this.corpora) {
      this.signal.throwIfAborted();
      const page = this.qualifyBrowse(corpus, await corpus.recordings.list({ ...input, limit }));
      result.recordings.push(...page.recordings);
      result.total += page.total; result.limited ||= page.limited;
      if (page.nextOffset !== null) result.nextOffset = input.offset + limit;
    }
    return result;
  }
  async read(args: unknown): Promise<BrowseResult> {
    const input = parseReadRecordings(args);
    const groups = new Map<RoomCorpus, string[]>();
    for (const id of input.recordingIds) {
      const origin = this.recordingOrigins.get(id) || this.origins.get(id);
      if (!origin || 'gift' in origin && origin.gift) throw new Error('Unknown recording ID');
      const ids = groups.get(origin.corpus) || []; ids.push(origin.localId); groups.set(origin.corpus, ids);
    }
    const result: BrowseResult = { recordings: [], total: input.recordingIds.length, nextOffset: null, limited: false };
    for (const [corpus, recordingIds] of groups) {
      this.signal.throwIfAborted();
      const page = this.qualifyBrowse(corpus, await corpus.recordings.read({ ...input, recordingIds }));
      result.recordings.push(...page.recordings); result.limited ||= page.limited;
    }
    return result;
  }
  async recent(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean; [key: string]: unknown }> {
    const hits: EvidenceSearchHit[] = [], coverage: unknown[] = [];
    let limited = false;
    for (const corpus of this.corpora) {
      const result = await corpus.recordings.recent(args);
      const { hits: roomHits, ...metadata } = result;
      coverage.push({ roomId: corpus.room.roomId, ...metadata });
      limited ||= result.limited;
      hits.push(...roomHits.map(hit => ({ ...this.qualify(corpus, hit), context: this.qualifyContext(corpus, hit.context) })));
    }
    return { hits, limited, coverage };
  }
  private qualifyContext(corpus: RoomCorpus, cues: EvidenceSearchHit['context'], gift?: EvidenceSearchHit): EvidenceSearchHit['context'] {
    return cues.map(cue => {
      if (!cue.evidenceId) return { ...cue };
      const clue = gift || corpus.recordings.clue(cue.evidenceId);
      return { ...cue, ...(clue ? { evidenceId: this.qualify(corpus, { ...clue, evidenceId: cue.evidenceId }, gift).evidenceId } : {}) };
    });
  }

  async search(args: unknown): Promise<{ hits: EvidenceSearchHit[]; limited: boolean }> {
    const input = parseRecordingSearch(args);
    this.signal.throwIfAborted();
    const anchor = input.withinEvidenceId ? this.origins.get(input.withinEvidenceId) : undefined;
    if (input.withinEvidenceId && (!anchor || anchor.gift)) throw new Error('Unknown recording session evidence ID');
    const lists: EvidenceSearchHit[][] = [];
    let limited = false;
    for (const corpus of this.corpora) {
      if (anchor && anchor.corpus !== corpus) continue;
      this.signal.throwIfAborted();
      const gifts: EvidenceSearchHit[] = [];
      const catalog = this.config.giftCatalogs?.[corpus.room.roomId];
      if ((!input.collection || input.collection === 'recordings') && !anchor && catalog && input.kind !== 'danmaku' && isGiftQuestion(this.request.question + input.terms.join(' '))) {
        corpus.gifts ??= readGiftCatalog(catalog, this.signal).then(hits => {
          this.coverage.get(corpus.room.roomId)!.catalogStatus = 'ready'; return hits;
        }).catch(() => { this.signal.throwIfAborted(); return []; });
        const entries = (await corpus.gifts).filter(hit => !input.date || hit.catalogMonth!.startsWith(input.date.slice(0, 7)));
        limited ||= entries.length > 4 || this.coverage.get(corpus.room.roomId)!.catalogStatus !== 'ready';
        for (const hit of entries.slice(0, 4)) gifts.push({ ...this.qualify(corpus, hit, hit), context: this.qualifyContext(corpus, hit.context, hit) });
      }
      const recordings = await corpus.recordings.search({ ...input, withinEvidenceId: anchor?.localId || null });
      limited ||= recordings.limited || (!input.collection || input.collection === 'recordings') && input.kind !== 'danmaku' && !!this.config.semantic?.enabled && !this.coverage.get(corpus.room.roomId)!.indexComplete;
      lists.push([...gifts, ...recordings.hits.map(hit => ({ ...this.qualify(corpus, hit), context: this.qualifyContext(corpus, hit.context) }))]);
    }
    const hits: EvidenceSearchHit[] = [];
    // Round-robin keeps a busy room from crowding out another room in comparisons.
    for (let i = 0; i < 16 && hits.length < 16; i++) for (const list of lists) if (list[i] && hits.length < 16) hits.push(list[i]);
    return { hits, limited: limited || lists.reduce((sum, list) => sum + list.length, 0) > hits.length };
  }

  context(args: unknown): StoredEvidence | { error: string } {
    this.signal.throwIfAborted();
    const input = args as { evidenceId?: unknown };
    if (!input || Object.keys(input).length !== 1 || typeof input.evidenceId !== 'string') return { error: 'Invalid evidence ID' };
    const origin = this.origins.get(input.evidenceId);
    if (!origin) return { error: 'Unknown evidence ID' };
    const { corpus, gift } = origin;
    const result = gift ? { hit: gift, context: gift.context } : corpus.recordings.context({ evidenceId: origin.localId });
    return 'error' in result ? result : { hit: this.qualify(corpus, result.hit, gift), context: this.qualifyContext(corpus, result.context, gift) };
  }
  clue(id: string): QuestionClue | undefined {
    const origin = this.origins.get(id);
    if (!origin) return undefined;
    const { corpus, gift } = origin;
    const clue = gift || corpus.recordings.clue(origin.localId);
    if (!clue) return undefined;
    return { ...clue, roomId: corpus.room.roomId, roomName: corpus.room.name,
      ...(clue.catalogMonth ? { catalogMonth: clue.catalogMonth } : {}) };
  }
  citation(id: string): Omit<QuestionClue, 'excerpt'> | undefined {
    const clue = this.clue(id);
    if (!clue) return undefined;
    const { excerpt, ...source } = clue; void excerpt; return source;
  }
  async close(): Promise<void> { const embedder = this.embedder; this.embedder = undefined; await embedder?.close?.(); }
}
