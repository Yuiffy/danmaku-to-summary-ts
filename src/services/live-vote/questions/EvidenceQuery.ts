import * as fs from 'fs/promises';
import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { getProjectRoot } from '../../../core/config/ProjectPaths';
import { createRemoteEmbedder, Embedder } from './EmbeddingClient';
import { createLocalEmbedder } from './LocalEmbedding';
import { questionProviderSettings } from './DaiyuQuestionClient';
import { LiveQuestionConfig, unsafeQuestionText, validateQuestionConfig } from './QuestionPolicy';
import { EvidenceHit, EvidenceSearchHit } from './RecordingEvidence';
import { QuestionCorpus } from './QuestionCorpus';
import { configuredQuestionRooms, questionScope } from './QuestionScope';

export interface QuestionRuntime { questions: LiveQuestionConfig; botUid?: string }
export interface EvidenceQueryInput {
  roomId: string; question: string; terms: string[]; kind: 'all' | 'subtitle' | 'danmaku'; date: string | null; expandTop: number;
}
export interface EvidenceQueryResult {
  roomId: string; question: string; elapsedMs: number;
  embeddingStatus: 'disabled' | 'ready' | 'unavailable'; indexedFiles: number; indexComplete: boolean; limited: boolean;
  hits: Array<EvidenceSearchHit & { expanded?: { hit: EvidenceHit; context: EvidenceSearchHit['context'] } | { error: string } }>;
  searchedRooms?: Array<{ roomId: string; name: string }>;
}
export async function readQuestionRuntime(file: string): Promise<QuestionRuntime> {
  const runtime = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, '')) as QuestionRuntime;
  validateQuestionConfig(runtime.questions);
  if (!runtime.questions.enabled) throw new Error('Recording questions disabled');
  return runtime;
}
export function questionRooms(runtime: QuestionRuntime): Array<{ roomId: string; name: string }> {
  return configuredQuestionRooms(runtime.questions).map(({ roomId, name }) => ({ roomId, name }));
}
export function validateLabQuestion(value: unknown, config: LiveQuestionConfig): { roomId: string; question: string } {
  const input = value as { roomId?: unknown; question?: unknown };
  if (!input || typeof input.roomId !== 'string' || !Object.prototype.hasOwnProperty.call(config.recordingRoots, input.roomId) ||
    typeof input.question !== 'string' || !input.question.trim() || Array.from(input.question).length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(input.question) || unsafeQuestionText(input.question)) throw new Error('Invalid recording question');
  questionScope(config, input.roomId, input.question);
  return { roomId: input.roomId, question: input.question.trim() };
}
export function parseEvidenceQuery(value: unknown, config: LiveQuestionConfig): EvidenceQueryInput {
  const question = validateLabQuestion(value, config);
  const input = value as Partial<EvidenceQueryInput>;
  if (Object.keys(input).some(key => !['roomId', 'question', 'terms', 'kind', 'date', 'expandTop'].includes(key))) throw new Error('Unknown search field');
  const terms = input.terms ?? [question.question.slice(0, 40)];
  const kind = input.kind ?? 'all', date = input.date ?? null, expandTop = input.expandTop ?? 2;
  if (!Array.isArray(terms) || !terms.length || terms.length > 5 || terms.some(term => typeof term !== 'string' || !term.trim() ||
    Array.from(term).length > 40 || /[\p{Cc}\p{Cf}]/u.test(term)) || !['all', 'subtitle', 'danmaku'].includes(kind) ||
    date !== null && (typeof date !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(date)) ||
    !Number.isInteger(expandTop) || expandTop < 0 || expandTop > 4) throw new Error('Invalid evidence search options');
  return { ...question, terms, kind, date, expandTop };
}

/** Retrieval only: no completion model, sender, publication adapter or persistent conversation. */
export async function queryRecordingEvidence(runtime: QuestionRuntime, input: EvidenceQueryInput, signal: AbortSignal,
  createEmbedder?: () => Embedder): Promise<EvidenceQueryResult> {
  const { roomId, question } = validateLabQuestion(input, runtime.questions);
  const config = runtime.questions, started = Date.now();
  const semantic = config.semantic?.enabled && input.kind !== 'danmaku' ? config.semantic : undefined;
  const evidence = new QuestionCorpus(config, { roomId, question }, signal, runtime.botUid, semantic ? createEmbedder || (() =>
    semantic.backend === 'local' ? createLocalEmbedder(semantic, getProjectRoot()) :
      createRemoteEmbedder(semantic, questionProviderSettings(loadConfigLayers({ configPath: config.providerConfigPath })))) : undefined);
  try {
    const result = await evidence.search({ terms: input.terms, kind: input.kind, date: input.date });
    const coverage = [...evidence.coverage.values()];
    return {
      roomId, question, elapsedMs: Date.now() - started, embeddingStatus: evidence.embeddingStatus,
      indexedFiles: coverage.reduce((sum, room) => sum + room.indexedFiles, 0), indexComplete: coverage.every(room => room.indexComplete),
      searchedRooms: evidence.rooms.map(({ roomId, name }) => ({ roomId, name })), limited: result.limited,
      hits: result.hits.map((hit, index) => ({ ...hit,
        ...(index < input.expandTop ? { expanded: evidence.context({ evidenceId: hit.evidenceId }) } : {}) }))
    };
  } finally { await evidence.close(); }
}
