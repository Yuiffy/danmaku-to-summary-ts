import { QuestionRuntime } from './EvidenceQuery';
import { QuestionCorpus } from './QuestionCorpus';
import { RECORDING_QUESTION_TOOLS } from './QuestionAgent';
import { aggregateEvidence } from './QuestionTools';
import { configuredQuestionRooms, questionScope } from './QuestionScope';
import { streamerKnowledge } from './StreamerKnowledge';
import { PublicSearchFactory } from './PublicSearchRuntime';
import { isPublicToolName, PUBLIC_SEARCH_TOOLS, PUBLIC_QUERY_GUIDANCE } from './PublicSearchTools';

export interface QuestionReadTool {
  name: string; description: string;
  parameters: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: false };
  execute(args: unknown): Promise<unknown>;
}
export interface QuestionReadSession { scope: string; tools: QuestionReadTool[]; close(): Promise<void> }
export type QuestionReadFactory = (request: { text: string; createdAt: number }, signal: AbortSignal) => QuestionReadSession;
export interface QuestionReadConfig { roomId: string; collaborationRooms: string[]; allConfiguredRooms?: boolean }
const DEFAULT_QUESTION_ROOM_LIMIT = 3;

// Channels resend tool schemas on every turn; keep channel descriptions concise without changing shared contracts.
const descriptions: Record<string, string> = {
  search_recordings: '按主题词查原录播recordings、摘要highlights或切片clips；date为年/月/日或null查历史。query传null；withinEvidenceId锁定已有原录播及分段，跨场查找传null。结果limited表示覆盖受限。',
  read_context: '展开已有evidenceId前后90秒、最多21条原文，核对细节与归属。',
  read_recent: '读取当前仍录制场次的最近5/10分钟，返回字幕延迟和覆盖限制；不查历史。',
  read_recording_openings: '按fromDate/toDate批量读多天开场字幕和录像时间点；最多8份、总384条，按录制时钟去重。nextOffset翻页，nextCueOffset在相同范围续读；录制起点不等于开播。',
  read_recording_calendar: '按fromDate/toDate查看最多31天录制分布与星期。dayBoundaryHour=6可把凌晨续录归前一天；无资料不证明休息。按常识周期结合近期锚点推算，保留预计与调休限制。',
  list_recordings: '按日期分页浏览资料。preview=none列目录、head读开头、sample均匀抽样；不是全文检索。用小页找候选，再read_recordings精读。',
  read_recordings: '按本题recordingId/evidenceId批量分页读正文；startSeconds/endSeconds为资料内秒数，offset为行偏移；保留日期、分段、时间基准。',
  aggregate_evidence: '对已返回证据的时间偏移计算数量、总和、均值、中位数、最值，可按房间/日期分组；仅代表所选样本。'
};

/** Each question owns its IDs and room scope. The agent chooses every retrieval operation. */
export function createQuestionReadFactory(runtime: QuestionRuntime, config: QuestionReadConfig, publicSearch?: PublicSearchFactory, maxRooms = DEFAULT_QUESTION_ROOM_LIMIT): QuestionReadFactory {
  const rooms = configuredQuestionRooms(runtime.questions);
  const allowed = new Set([config.roomId, ...config.collaborationRooms,
    ...(config.allConfiguredRooms ? rooms.map(room => room.roomId) : [])]);
  if (!runtime.questions.lexical?.enabled || [...allowed].some(id => !rooms.some(room => room.roomId === id))) {
    throw new Error('Question tools require configured rooms and the read-only lexical index');
  }
  const questions = { ...runtime.questions, semantic: undefined, recordingRoots: Object.fromEntries(
    [...allowed].map(id => [id, runtime.questions.recordingRoots[id]])) };
  return (request, signal) => {
    let corpus: QuestionCorpus | undefined;
    const getCorpus = () => {
      signal.throwIfAborted();
      return corpus ||= new QuestionCorpus(questions, { roomId: config.roomId, question: request.text, askedAt: request.createdAt },
        signal, runtime.botUid, undefined, maxRooms);
    };
    // Scope is a pure hint. Corpus admission belongs to an actual recording tool, never image/chat admission.
    let scope: string;
    try {
      const selected = questionScope(questions, config.roomId, request.text, maxRooms);
      scope = `本次查询资料范围：${JSON.stringify(selected.map(({ roomId, name }) => ({ roomId, name })))}。回答与引用必须分清来源。`
        + streamerKnowledge(selected.map(room => room.roomId));
    } catch {
      scope = `本题提及的直播资料范围过多；单次直播检索最多${maxRooms}位主播，请缩小检索范围。此限制不阻止聊天、看图和绘图工具。`;
    }
    const publicEvidence = publicSearch?.(signal);
    const tools: QuestionReadTool[] = [...RECORDING_QUESTION_TOOLS, ...(publicEvidence ? PUBLIC_SEARCH_TOOLS : [])].map(({ function: definition }) => ({
      name: definition.name, description: descriptions[definition.name] || definition.description,
      parameters: { type: 'object', additionalProperties: false, required: definition.parameters.required,
        properties: Object.fromEntries(Object.entries(definition.parameters.properties).filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, name === 'date' ? { ...(value as Record<string, unknown>), description: 'YYYY / YYYY-MM / YYYY-MM-DD / null；不接受区间或数组。' } : value as Record<string, unknown>])) },
      execute: async args => {
        signal.throwIfAborted();
        if (isPublicToolName(definition.name)) return publicEvidence!.run(definition.name, args);
        if (definition.name === 'read_context' && publicEvidence?.citation((args as { evidenceId: string })?.evidenceId)) return publicEvidence.context(args);
        const corpus = getCorpus();
        switch (definition.name) {
          case 'read_live_overview': return corpus.overview(args);
          case 'search_recordings': return { ...await corpus.search(args), coverage: [...corpus.coverage].map(([roomId, value]) => ({ roomId, ...value })) };
          case 'read_context': return corpus.context(args);
          case 'read_recent': return corpus.recent(args);
          case 'read_recording_openings': return corpus.openings(args);
          case 'read_recording_calendar': return corpus.calendar(args);
          case 'list_recordings': return corpus.list(args);
          case 'read_recordings': return corpus.read(args);
          case 'aggregate_evidence': return aggregateEvidence(args, id => corpus.citation(id));
          default: throw new Error('Unknown recording tool');
        }
      }
    }));
    return { scope: scope + '姓名指配置主播；泛问近况先查最新概述，缺概述仍可查该主播ASR/弹幕。' + (publicEvidence ? PUBLIC_QUERY_GUIDANCE : ''),
      tools, close: async () => { await corpus?.close(); } };
  };
}
