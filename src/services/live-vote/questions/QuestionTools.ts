import { QuestionSource } from './QuestionPolicy';

export const QUESTION_TOOL_NAMES = ['search_recordings', 'read_context', 'read_recent', 'list_recordings', 'read_recordings', 'aggregate_evidence'] as const;
export type QuestionToolName = typeof QUESTION_TOOL_NAMES[number];
export function isQuestionToolName(name: unknown): name is QuestionToolName {
  return typeof name === 'string' && (QUESTION_TOOL_NAMES as readonly string[]).includes(name);
}
export const BROWSE_TOOLS = [
  { type: 'function', function: { name: 'list_recordings', strict: true,
    description: '按日期分页列出资料，附录制/场次ID与少量字幕。collection选择原录播、精选摘要、切片；preview=head读开头，sample均匀抽样全文，none只列目录。适合探索近期内容、多场比较、寻找趣事；最多32份、每份12条。只返回目录可见资料，不证明完整开播历史。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      collection: { type: 'string', enum: ['recordings', 'highlights', 'clips'] }, kind: { type: 'string', enum: ['all', 'subtitle', 'danmaku'] },
      date: { type: ['string', 'null'], description: '仅YYYY、YYYY-MM、YYYY-MM-DD或null，不接受日期区间或数组。近N天可按月份列目录并筛选返回日期，跨月时分别列出。' }, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 32 },
      preview: { type: 'string', enum: ['none', 'head', 'sample'] }, cuesPerRecording: { type: 'integer', minimum: 1, maximum: 12 }
    }, required: ['collection', 'kind', 'date', 'offset', 'limit', 'preview', 'cuesPerRecording'] } } },
  { type: 'function', function: { name: 'read_recordings', strict: true,
    description: '批量顺序读取已列出的recordingId或已引用evidenceId所属资料。按资料内秒数范围、行偏移、条数分页，可读开头、任意中段或续读。保持日期、场次/分段和时间基准；最多32份且总条数不超过384。只接受本问题已返回的ID。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      recordingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
      startSeconds: { type: 'number', minimum: 0, maximum: 604800 }, endSeconds: { type: ['number', 'null'] },
      offset: { type: 'integer', minimum: 0, maximum: 100000 }, limitPerRecording: { type: 'integer', minimum: 1, maximum: 80 }
    }, required: ['recordingIds', 'startSeconds', 'endSeconds', 'offset', 'limitPerRecording'] } } },
  { type: 'function', function: { name: 'aggregate_evidence', strict: true,
    description: '对已返回证据的时间偏移做确定性统计：数量、总和、均值、中位数、最小/最大值，可按房间或日期分组。只计算所选样本；不能证明字幕说话者、实际开播起点或未读取资料。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
      groupBy: { type: 'string', enum: ['all', 'room', 'date'] }
    }, required: ['evidenceIds', 'groupBy'] } } }
];

export function aggregateEvidence(args: unknown, citation: (id: string) => QuestionSource | undefined): unknown {
  const input = args as { evidenceIds: string[]; groupBy: string };
  if (!input || Object.keys(input).sort().join(',') !== 'evidenceIds,groupBy' ||
      !['all', 'room', 'date'].includes(input.groupBy) || !Array.isArray(input.evidenceIds) || !input.evidenceIds.length ||
      input.evidenceIds.length > 64 || new Set(input.evidenceIds).size !== input.evidenceIds.length) throw new Error('Invalid evidence aggregation');
  const groups = new Map<string, Array<{ id: string; seconds: number }>>();
  const kinds = new Set<string>();
  for (const id of input.evidenceIds) {
    const source = typeof id === 'string' ? citation(id) : undefined;
    const match = source && source.kind !== 'gift-catalog' && /^(\d{2,}):(\d{2}):(\d{2})$/u.exec(source.time);
    if (!source || !match) throw new Error('Unknown timed evidence');
    kinds.add(source.kind);
    const key = input.groupBy === 'room' ? source.roomId || 'current' : input.groupBy === 'date' ? source.date || 'unknown' : 'all';
    const values = groups.get(key) || [];
    values.push({ id, seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) }); groups.set(key, values);
  }
  if (kinds.size > 1) throw new Error('Incompatible evidence time bases');
  return { groups: [...groups].map(([key, values]) => {
    const sorted = values.map(item => item.seconds).sort((a, b) => a - b), sumSeconds = sorted.reduce((sum, value) => sum + value, 0);
    return { key, evidenceIds: values.map(item => item.id), count: values.length, sumSeconds, meanSeconds: sumSeconds / values.length,
      medianSeconds: (sorted[Math.floor((values.length - 1) / 2)] + sorted[Math.floor(values.length / 2)]) / 2,
      minSeconds: sorted[0], maxSeconds: sorted.at(-1) };
  }), notice: '仅统计选定证据的资料内时间偏移；样本数不等于直播总场次，不同时间基准不可混合。' };
}
