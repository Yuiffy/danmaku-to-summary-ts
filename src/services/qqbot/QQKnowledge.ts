import { QuestionRuntime } from '../live-vote/questions/EvidenceQuery';
import { QuestionCorpus } from '../live-vote/questions/QuestionCorpus';
import { QUESTION_TOOLS } from '../live-vote/questions/QuestionAgent';
import { aggregateEvidence } from '../live-vote/questions/QuestionTools';
import { readLiveOverview } from '../live-vote/questions/LiveOverview';
import { configuredQuestionRooms, questionScope } from '../live-vote/questions/QuestionScope';
import { QQConfig, QQRequest } from './QQPolicy';

export interface QQReadTool {
  name: string; description: string;
  parameters: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: false };
  execute(args: unknown): Promise<unknown>;
}
export interface QQQuestionTools { scope: string; tools: QQReadTool[]; close(): Promise<void> }
export type QQKnowledge = (request: QQRequest, signal: AbortSignal) => QQQuestionTools;
export const QQ_QUESTION_ROOM_LIMIT = 8;

// QQ resends tool schemas on every turn; keep channel descriptions concise without changing shared contracts.
const descriptions: Record<string, string> = {
  search_recordings: '按主题词查原录播recordings、摘要highlights或切片clips；date为年/月/日或null查历史。query传null；withinEvidenceId锁定已有原录播及分段，跨场查找传null。结果limited表示覆盖受限。',
  read_context: '展开已有evidenceId前后90秒、最多21条原文，核对细节与归属。',
  read_recent: '读取当前仍录制场次的最近5/10分钟，返回字幕延迟和覆盖限制；不查历史。',
  list_recordings: '按日期分页浏览资料。preview=none列目录、head读开头、sample均匀抽样；不是全文检索。用小页找候选，再read_recordings精读。',
  read_recordings: '按本题recordingId/evidenceId批量分页读正文；startSeconds/endSeconds为资料内秒数，offset为行偏移；保留日期、分段、时间基准。',
  aggregate_evidence: '对已返回证据的时间偏移计算数量、总和、均值、中位数、最值，可按房间/日期分组；仅代表所选样本。'
};

/** Each question owns its IDs and room scope. The agent chooses every retrieval operation. */
export function createQQKnowledge(runtime: QuestionRuntime, config: NonNullable<QQConfig['knowledge']>): QQKnowledge {
  const rooms = configuredQuestionRooms(runtime.questions);
  const allowed = new Set([config.roomId, ...config.collaborationRooms,
    ...(config.allConfiguredRooms ? rooms.map(room => room.roomId) : [])]);
  if (!runtime.questions.lexical?.enabled || [...allowed].some(id => !rooms.some(room => room.roomId === id))) {
    throw new Error('QQ knowledge requires configured rooms and the read-only lexical index');
  }
  const questions = { ...runtime.questions, semantic: undefined, recordingRoots: Object.fromEntries(
    [...allowed].map(id => [id, runtime.questions.recordingRoots[id]])) };
  return (request, signal) => {
    let corpus: QuestionCorpus | undefined;
    const getCorpus = () => {
      signal.throwIfAborted();
      return corpus ||= new QuestionCorpus(questions, { roomId: config.roomId, question: request.text, askedAt: request.createdAt },
        signal, runtime.botUid, undefined, QQ_QUESTION_ROOM_LIMIT);
    };
    // Scope is a pure hint. Corpus admission belongs to an actual recording tool, never image/chat admission.
    let scope: string;
    try {
      const selected = questionScope(questions, config.roomId, request.text, QQ_QUESTION_ROOM_LIMIT);
      scope = `本次查询资料范围：${JSON.stringify(selected.map(({ roomId, name }) => ({ roomId, name })))}。回答与引用必须分清来源。`;
    } catch {
      scope = `本题提及的直播资料范围过多；单次直播检索最多${QQ_QUESTION_ROOM_LIMIT}位主播，请缩小检索范围。此限制不阻止聊天、看图和绘图工具。`;
    }
    const tools: QQReadTool[] = QUESTION_TOOLS.map(({ function: definition }) => ({
      name: definition.name, description: descriptions[definition.name] || definition.description,
      parameters: { type: 'object', additionalProperties: false, required: definition.parameters.required,
        properties: Object.fromEntries(Object.entries(definition.parameters.properties).filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, name === 'date' ? { ...value, description: 'YYYY / YYYY-MM / YYYY-MM-DD / null；不接受区间或数组。' } : value])) },
      execute: async args => {
        signal.throwIfAborted();
        const corpus = getCorpus();
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
      description: '读取最新可用或指定日的直播概述、晚安、漫画叙事。date=null取最新；返回概述日期和最新已见录制日期。仅用于概括，不能证明原话或完整历史；缺概述可继续查正文。',
      parameters: { type: 'object', additionalProperties: false, properties: { date: { type: ['string', 'null'] } }, required: ['date'] },
      execute: async args => {
        const input = args as { date: string | null };
        if (!input || Object.keys(input).join(',') !== 'date' || input.date !== null && typeof input.date !== 'string') throw new Error('Expected date');
        const overviews = [];
        overviewCalls++;
        for (const room of getCorpus().rooms) {
          const value = await readLiveOverview(questions.recordingRoots[room.roomId], room.roomId, input.date, request.createdAt, signal);
          overviews.push({ room: room.name, roomId: room.roomId, ...value,
            artifacts: value.artifacts.map((artifact, index) => ({ ...artifact, evidenceId: `r${room.roomId}_overview${overviewCalls}_${index + 1}` })) });
        }
        return { overviews };
      }
    });
    return { scope: scope + '姓名指配置主播；泛问近况先查最新概述，缺概述仍可查该主播ASR/弹幕。',
      tools, close: async () => { await corpus?.close(); } };
  };
}
