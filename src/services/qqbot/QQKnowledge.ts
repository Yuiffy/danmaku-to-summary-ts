import { QuestionRuntime } from '../live-vote/questions/EvidenceQuery';
import { QuestionCorpus } from '../live-vote/questions/QuestionCorpus';
import { QUESTION_TOOLS } from '../live-vote/questions/QuestionAgent';
import { aggregateEvidence } from '../live-vote/questions/QuestionTools';
import { readLiveOverview } from '../live-vote/questions/LiveOverview';
import { configuredQuestionRooms } from '../live-vote/questions/QuestionScope';
import { QQConfig, QQRequest } from './QQPolicy';

export interface QQReadTool {
  name: string; description: string;
  parameters: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: false };
  execute(args: unknown): Promise<unknown>;
}
export interface QQQuestionTools { scope: string; tools: QQReadTool[]; close(): Promise<void> }
export type QQKnowledge = (request: QQRequest, signal: AbortSignal) => QQQuestionTools;

/** Each question owns its IDs and room scope. The agent chooses every retrieval operation. */
export function createQQKnowledge(runtime: QuestionRuntime, config: NonNullable<QQConfig['knowledge']>): QQKnowledge {
  const allowed = new Set([config.roomId, ...config.collaborationRooms]);
  const rooms = configuredQuestionRooms(runtime.questions);
  if (!runtime.questions.lexical?.enabled || [...allowed].some(id => !rooms.some(room => room.roomId === id))) {
    throw new Error('QQ knowledge requires configured rooms and the read-only lexical index');
  }
  const questions = { ...runtime.questions, semantic: undefined, recordingRoots: Object.fromEntries(
    [...allowed].map(id => [id, runtime.questions.recordingRoots[id]])) };
  return (request, signal) => {
    const corpus = new QuestionCorpus(questions, { roomId: config.roomId, question: request.text, askedAt: request.createdAt }, signal, runtime.botUid);
    const tools: QQReadTool[] = QUESTION_TOOLS.map(({ function: definition }) => ({
      name: definition.name, description: definition.description,
      parameters: { type: 'object', additionalProperties: false, required: definition.parameters.required,
        properties: Object.fromEntries(Object.entries(definition.parameters.properties).filter(([, value]) => value !== undefined)) },
      execute: async args => {
        signal.throwIfAborted();
        switch (definition.name) {
          case 'search_recordings': return { ...await corpus.search(args), coverage: [...corpus.coverage].map(([roomId, value]) => ({ roomId, ...value })) };
          case 'read_context': return corpus.context(args);
          case 'read_recent': return corpus.recent(args);
          case 'list_recordings': return corpus.list(args);
          case 'read_recordings': return corpus.read(args);
          case 'aggregate_evidence': return aggregateEvidence(args, id => corpus.citation(id));
          default: throw new Error('Unknown recording tool');
        }
      }
    }));
    let overviewCalls = 0;
    tools.unshift({ name: 'read_live_overview',
      description: '读取所问主播最新可用场次或指定日期的直播梗概、晚安回复、漫画脚本。概括最新/上次直播播了什么优先用它，无需关键词。返回资料日期与最新已见录制日期；晚安/漫画是生成概述，不是逐字原话。date=null取最新，指定日只读当日；不是完整开播历史。',
      parameters: { type: 'object', additionalProperties: false, properties: { date: { type: ['string', 'null'] } }, required: ['date'] },
      execute: async args => {
        const input = args as { date: string | null };
        if (!input || Object.keys(input).join(',') !== 'date' || input.date !== null && typeof input.date !== 'string') throw new Error('Expected date');
        const overviews = [];
        overviewCalls++;
        for (const room of corpus.rooms) {
          const value = await readLiveOverview(questions.recordingRoots[room.roomId], room.roomId, input.date, request.createdAt, signal);
          overviews.push({ room: room.name, roomId: room.roomId, ...value,
            artifacts: value.artifacts.map((artifact, index) => ({ ...artifact, evidenceId: `r${room.roomId}_overview${overviewCalls}_${index + 1}` })) });
        }
        return { overviews };
      }
    });
    return { scope: corpus.scopeDescription, tools, close: () => corpus.close() };
  };
}
