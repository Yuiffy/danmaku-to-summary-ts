import { NO_EVIDENCE, QuestionAnswer, QuestionClue, unsafeQuestionText } from './QuestionPolicy';
import { QuestionEvidence } from './RecordingEvidence';

export type EvidenceReview =
  | { action: 'answer'; rankedEvidenceIds: string[]; certainty: 'supported' | 'uncertain'; answer: string; shortAnswer: string; evidenceIds: string[] }
  | { action: 'search'; rankedEvidenceIds: string[]; search: unknown }
  | { action: 'context'; rankedEvidenceIds: string[]; evidenceId: string }
  | { action: 'insufficient'; rankedEvidenceIds: string[] };

/** Rank and decide in the same model pass, so an easy question still takes two requests. */
export const REVIEW_PROMPT = `现在对已返回的候选进行语义重排，再决定下一步。关键词命中次数不是答案可信度。
read_recent按当前录像最近5/10分钟抽样，保留字幕延迟、覆盖缺失与limited限制，不能把未转写或抽样未见当成没说过。只总结返回时段，区分音轨字幕与观众弹幕；不能用历史搜索补出的旧事充当“刚才”。
按是否直接回答问题、日期范围、上下文、来源归属排序，rankedEvidenceIds只列最有用的0～8个真实ID，最有用的在前。
同一段重复消息不是多份独立证据。观众的疑问或猜测不算确认；不要把提问本身或机器人的回答作为证据。
核对否定、改口和日期，不要将别的月份的礼物当成所问月份的礼物。ASR可能来自播放音频；没有明确归属时只能说录像提到。
数量问题区分平台下单数、实际消费数和时间范围。保留确实找到的数字及口径，不能因另一年不确定就把所有年份都答成不知道。
短答也保留“平台/账单/约”等口径，不能把完整回答中的限制删掉。若发现对数字的怀疑或改口，扩展争议处的上下文确认后续说法，不能只扩展另一个已经确定的数字。
询问的年份不一定是录像年份：年度账单、次年回顾可能提到上一年。不要把“少几百”推算成精确总数，也不要把平台单量说成全年实际喝掉的杯数。
每个搜索只展示附近5条。如果已命中问题的主题却没有答案，必须先context最相关条目一次再判断，不能仅凭短窗口insufficient。
尤其“我看一下”“稍后说”、句子没说完、只有提问时，答案可能在后文；先context。如果关键词不对、日期不符，换词/同音词或调整范围search。
搜索只是OR召回，相关词已同时命中时不要用大量宽泛同义词重复搜索。不要使用主播名字作搜索词。
舰礼是舰长、提督、总督礼物的统称；泛问舰礼时分别回答三档，未公布/未收录的档位明确说明，不能自动继承其他档礼物。
gift-catalog是按礼物所属月整理的档案，date是依据发布日期、catalogMonth是礼物所属月，条件和官方/录播/仅线索标签必须保留。优先使用明确官方公告；仅线索不能说已确认。不要把未收录说成没有礼物。
跨直播间结论注明主播，引用的roomId/roomName是资料所属直播间，不证明字幕里的每句话都是该主播说的。
最多6次工具操作，不能重复完全相同的搜索或context；次数耗尽时answer或insufficient。
仅输出以下四种JSON之一，不输出工具调用、Markdown、推理过程或额外字段：
{"rankedEvidenceIds":["ev2","ev1"],"action":"answer","certainty":"supported","answer":"与证据相符的完整结论，最多200字","shortAnswer":"保留不确定性的一句答案，最多20字","evidenceIds":["ev2"]}
{"rankedEvidenceIds":["ev2"],"action":"context","evidenceId":"ev2"}
{"rankedEvidenceIds":[],"action":"search","search":{"terms":["具体关键词"],"kind":"all","date":"2026-10"}}
{"rankedEvidenceIds":[],"action":"insufficient"}
answer的evidenceIds必须选自本次rankedEvidenceIds，最多3个，包含支撑答案或冲突的证据；不能选无关ID。
answer和shortAnswer只写问题的结论，不复述证据所在录像的日期、时间戳或ID；这些元数据由应用按引用ID另行附上。问题本身问事件日期时才回答有依据的事件日期，不得混用邻近候选的日期。
可直接确认才用肯定语气；只有观众猜测时，完整答案与短答案都要明确“观众猜测/未确认”。
certainty只能为supported或uncertain：直接回答问题的证据用supported；仅有猜测、未确认、当时不知道或否认曾说明时用uncertain，不能假装问题已得到确定答案。
字幕疑似错字时短答只保留能辨清的核心信息，完整回答说明疑点；不要把疑似错字复读为确定名称，也不要擅自补全专有名词。
搜索的context和扩展context内每条都有自己的ID；引用真正包含答案/改口的那条ID，不能用相邻旧说法的ID替代。
合理补查后仍没有可靠依据时insufficient，不能编造。`;

export function parseEvidenceReview(content: string | null, evidence: QuestionEvidence): EvidenceReview | undefined {
  if (!content || content.length > 5000) return undefined;
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const rank = value.rankedEvidenceIds;
    if (!Array.isArray(rank) || rank.length > 8 || new Set(rank).size !== rank.length ||
        rank.some(id => typeof id !== 'string' || !evidence.citation(id))) return undefined;
    const fields: Record<string, string[]> = {
      answer: ['certainty', 'answer', 'shortAnswer', 'evidenceIds'], search: ['search'], context: ['evidenceId'], insufficient: []
    };
    if (!Object.prototype.hasOwnProperty.call(fields, value.action)) return undefined;
    const allowed = ['action', 'rankedEvidenceIds', ...fields[value.action]];
    if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) return undefined;
    if (value.action === 'context' && (typeof value.evidenceId !== 'string' || !rank.includes(value.evidenceId))) return undefined;
    if (value.action === 'answer') {
      if (!['supported', 'uncertain'].includes(value.certainty) ||
          typeof value.answer !== 'string' || !value.answer.trim() || Array.from(value.answer).length > 300 || unsafeQuestionText(value.answer) ||
          typeof value.shortAnswer !== 'string' || !value.shortAnswer.trim() || Array.from(value.shortAnswer).length > 40 || unsafeQuestionText(value.shortAnswer) ||
          !Array.isArray(value.evidenceIds) || !value.evidenceIds.length || value.evidenceIds.length > 3 ||
          new Set(value.evidenceIds).size !== value.evidenceIds.length || value.evidenceIds.some((id: unknown) => !rank.includes(id))) return undefined;
    }
    return value as EvidenceReview;
  } catch { return undefined; }
}

/** Fixed diagnostic codes only; raw model text and evidence never enter service logs. */
export function reviewValidationIssue(content: string | null, evidence: QuestionEvidence): string {
  if (!content || content.length > 5000) return 'missing_or_oversize';
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid_shape';
    if (Array.isArray(value.rankedEvidenceIds) && value.rankedEvidenceIds.some((id: unknown) => typeof id !== 'string' || !evidence.citation(id))) return 'unknown_evidence';
    if (value.action === 'answer') {
      if ([value.answer, value.shortAnswer].some(text => typeof text === 'string' && unsafeQuestionText(text))) return 'unsafe_answer';
      if (typeof value.answer === 'string' && Array.from(value.answer).length > 300 || typeof value.shortAnswer === 'string' && Array.from(value.shortAnswer).length > 40) return 'answer_too_long';
      if (Array.isArray(value.evidenceIds) && Array.isArray(value.rankedEvidenceIds) && value.evidenceIds.some((id: unknown) => !value.rankedEvidenceIds.includes(id))) return 'unranked_evidence';
    }
    return 'invalid_schema';
  } catch { return 'invalid_json'; }
}

export function reviewedAnswer(review: EvidenceReview, evidence: QuestionEvidence): QuestionAnswer {
  if (review.action !== 'answer') return { answer: NO_EVIDENCE };
  return {
    answer: review.answer, shortAnswer: review.shortAnswer,
    source: evidence.citation(review.evidenceIds[0]),
    clues: review.evidenceIds.map(id => evidence.clue(id)).filter((clue): clue is QuestionClue => clue !== undefined)
  };
}
