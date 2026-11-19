export interface QQVideoSpan { startMs: number; endMs: number }
export type QQVideoSelection =
  | { kind: 'keep' | 'remove'; spans: QQVideoSpan[] }
  | { kind: 'head' | 'tail'; durationMs: number };

export const QQ_VIDEO_CUT_HELP = '请附上或引用一段MP4并写明时间，例如“截取5到12秒”，或“保留00:02-00:06和00:18-00:24，拼起来发我”。';
export const QQ_VIDEO_REFERENCE_MAX_MS = 15400;
export const QQ_VIDEO_REFERENCE_DEFAULT_MS = 15000;
export class QQVideoSelectionError extends Error {}
const MAX_SPANS = 8;
const cutVerb = /剪辑|剪切|剪掉|剪下|剪视频|截取|裁剪|裁掉|截掉|截一段|裁一段|剪一段|保留|只要|拼接|拼起来|(?:截|取|剪|用)\s*(?:前|后|最后|开头|结尾)|(?:用|选|取|截|参考)(?:这段)?(?:原片|原视频|视频)(?:的)?|(?:帮我|把|给我)剪|(?:剪|截|取)\s*(?=第?\d)/u;
const removeVerb = /去掉|删掉|删除|剪掉|裁掉|截掉|剪去/u;
const editQuestion = /怎么|如何|教程|用法|举例|例如|比如|示例|(?:请问|想问).{0,6}(?:能不能|可不可以)/u;
export const qqVideoCutNegated = (text: string) => /(?:不要|不用|别|无需)\s*(?:剪|截|裁|拼|保留|删|去掉)/u.test(text);
const time = String.raw`(?:\d{1,3}:\d{2}:\d{2}|\d{1,4}:\d{2}|\d{1,5})(?:\.\d{1,3})?`;
const range = String.raw`(?<![\d.:])第?\s*(${time})\s*(?:秒|s\b)?\s*(?:到|至|[-–—~～])\s*第?\s*(${time})(?![\d.:])\s*(?:秒|s\b)?`;
const relative = String.raw`(最前|开头|前|最后|末尾|结尾|尾部|后)\s*(${time})(?![\d.:])\s*(?:秒|s\b)`;

export function qqVideoCutRequested(text: string, hasVideo = false): boolean {
  if (editQuestion.test(text) || qqVideoCutNegated(text)) return false;
  const hasTime = new RegExp(`${range}|${relative}`, 'u').test(text);
  return (hasTime && (cutVerb.test(text) || removeVerb.test(text))) ||
    /剪切|截取|截一段|剪一段|截.{0,8}(?:片段|那段)|(?:剪辑|裁剪).{0,6}(?:这个|这段|原片|原视频|一下)/u.test(text) ||
    /^(?:(?:请|麻烦|帮我|给我|把)?\s*)?(?:剪辑|裁剪)(?!风格|软件|教程|技巧)/u.test(text) ||
    ((hasVideo || /视频|原片/u.test(text)) && /(?:保留|去掉|删掉|删除|剪掉).{0,24}(?:片段|那段|这一段)/u.test(text));
}

function timestampMs(value: string): number {
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) throw new QQVideoSelectionError('时间码的分和秒请小于60。');
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
}

/** Parse only times attached to an edit request. Mask those times before reading generation settings. */
export function qqVideoSelection(text: string): { selection?: QQVideoSelection; generationText: string } {
  const value = text.normalize('NFKC');
  const action = [cutVerb.exec(value), removeVerb.exec(value)].filter(match => match !== null)
    .sort((a, b) => a.index - b.index)[0];
  if (!action || qqVideoCutNegated(value)) return { generationText: value };
  const start = action.index;
  const source = value.slice(start);
  // A following generation instruction may specify its own output duration and aspect ratio.
  const boundary = /[，,。；;]\s*(?:(?:再|然后|接着|用于|拿来|用它|用这个|用来)\s*)?(?:直接\s*)?(?:生成|生视频|制作|做成|出片|输出|成片)/u.exec(source);
  const clause = source.slice(0, boundary?.index);
  const ranges = [...clause.matchAll(new RegExp(range, 'gu'))];
  const relatives = [...clause.matchAll(new RegExp(relative, 'gu'))];
  const removing = removeVerb.test(clause);
  if (ranges.length > MAX_SPANS) throw new QQVideoSelectionError(`一次最多指定${MAX_SPANS}个时间段。`);
  if ((ranges.length && relatives.length) || relatives.length > 1 ||
    (removing && /保留/u.test(clause)) || (removing && relatives.length)) throw new QQVideoSelectionError('请分开说明要保留或删除的区间，并用起止时间表示。');
  const generationText = value.slice(0, start) +
    clause.replace(new RegExp(`${range}|${relative}`, 'gu'), ' ') + source.slice(clause.length);
  if (ranges.length) return { generationText, selection: { kind: removing ? 'remove' : 'keep', spans:
    ranges.map(match => ({ startMs: timestampMs(match[1]), endMs: timestampMs(match[2]) })) } };
  const edge = relatives[0];
  if (edge) return { generationText, selection: { kind: /后|尾/u.test(edge[1]) ? 'tail' : 'head', durationMs: timestampMs(edge[2]) } };
  return { generationText };
}

export function qqVideoSpans(selection: QQVideoSelection, durationMs: number): QQVideoSpan[] {
  if (selection.kind === 'head' || selection.kind === 'tail') {
    const { durationMs: length } = selection;
    if (length <= 0 || length > durationMs) throw new QQVideoSelectionError(`原视频长${durationMs / 1000}秒，请调整截取时长。`);
    return selection.kind === 'head' ? [{ startMs: 0, endMs: length }] :
      [{ startMs: durationMs - length, endMs: durationMs }];
  }
  const spans = 'spans' in selection ? selection.spans : [];
  if (spans.some(span => span.endMs <= span.startMs || span.endMs > durationMs)) {
    throw new QQVideoSelectionError(`原视频长${durationMs / 1000}秒，请检查每段起止时间和先后顺序。`);
  }
  if (selection.kind === 'keep') return spans;
  const result: QQVideoSpan[] = [];
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    if (span.startMs > cursor) result.push({ startMs: cursor, endMs: span.startMs });
    cursor = Math.max(cursor, span.endMs);
  }
  if (cursor < durationMs) result.push({ startMs: cursor, endMs: durationMs });
  if (!result.length) throw new QQVideoSelectionError('这些区间会删掉整个视频，请至少留下一段。');
  return result;
}

export const qqVideoSpanDuration = (spans: QQVideoSpan[]) => spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0);
