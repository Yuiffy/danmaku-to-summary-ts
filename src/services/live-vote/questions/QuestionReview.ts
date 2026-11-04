import { NO_EVIDENCE, QuestionAnswer, QuestionClue, unsafeQuestionText } from './QuestionPolicy';
import { QuestionEvidence } from './RecordingEvidence';
import { isQuestionToolName, QuestionToolName } from './QuestionTools';
import { PLAYFUL_ROAST_PROMPT } from './QuestionConversation';
import { PUBLIC_QUERY_GUIDANCE } from './PublicSearchTools';
import { StockQuote } from './StockSearch';

export type EvidenceReview =
  | { action: 'answer'; rankedEvidenceIds: string[]; certainty: 'supported' | 'uncertain'; answer: string; shortAnswer: string; evidenceIds: string[] }
  | { action: 'search'; rankedEvidenceIds: string[]; search: unknown }
  | { action: 'context'; rankedEvidenceIds: string[]; evidenceId: string }
  | { action: 'tool'; rankedEvidenceIds: string[]; tool: { name: QuestionToolName; arguments: unknown } }
  | { action: 'insufficient'; rankedEvidenceIds: string[] };

/** Rank and decide in the same model pass, so an easy question still takes two requests. */
export const REVIEW_PROMPT = `现在对已返回的候选进行语义重排，再决定下一步。关键词命中次数不是答案可信度。
${PUBLIC_QUERY_GUIDANCE}
短答shortAnswer至多40个字符（英文、数字、空格、标点均计数）。多项行情的短答可以概括整体方向，但完整answer必须逐项保留代码、价格、涨跌幅、币种/点和参考/延迟性质；应用会从已引用的结构化报价为弹幕压成一条代码与涨跌幅汇总，不能只留下“涨跌不一”。
公开查询可用tool动作继续search_stocks/get_stock_quotes/search_places/get_weather/search_encyclopedia。public-search必须按工具数据作答并引用真实evidenceId，不要求有直播记录；不得用来证明主播经历。行情完整回答保留证券代码、币种、上游报价时间和延迟/参考性质，短答也保留币种及参考性质；天气保留所选地点、当地时间、单位和预报性质。查询时间不是报价/天气发生时间。无工具结果不能报行情或天气数字。百科仅搜索摘录，不能当最新新闻；工具不可用时修正参数或换工具，不能说查无结果。
工具返回error表示操作失败，不能当成空结果或insufficient；按expectedArguments修正参数或换只读工具继续查询。date只接受年份、年月、单日或null，日期区间需浏览月份后筛选日期；不要把区间字符串塞入date。
如果原始需求只是祝福、温情话、安慰、鼓励或打招呼，即使先前多余地搜索过、没有命中，也应直接返回general JSON回答，不需要引用，不编造直播事实。涉及事实、统计或基于历史的混合请求不能general。
需要浏览、读取或计算时用tool动作选择应用提供的只读工具。多天开场/OP统计优先read_recording_openings按日期范围批量读开场字幕和时间点，目录nextOffset可继续调用该工具，字幕nextCueOffset则用read_recordings在相同时间范围续读；不能因歌词、断线续录或真实开播起点未核实就丢弃其他已核实的录制偏移样本。list_recordings可按日期/资料来源浏览、读开头或抽样，read_recordings按ID批量续读或读任意时间段。aggregate_evidence对已返回时间偏移做算术，不生成新事实。多场比较和统计必须读取多个独立样本，保留样本数与覆盖范围；一条自述不是统计。sessionId相同和part分段不能重复当成多场。
highlights是混合音轨和观众弹幕的精选摘要，只作粗略线索；clips字幕只支持片内事实，切片内时间不能当原录播偏移，剪辑可能省略改口。按需回到原录播和上下文核实，不把摘要标签或剪辑标题当成主播原话。
${PLAYFUL_ROAST_PROMPT}
read_recent按当前录像最近5/10分钟抽样，保留字幕延迟、覆盖缺失与limited限制，不能把未转写或抽样未见当成没说过。只总结返回时段，区分音轨字幕与观众弹幕；不能用历史搜索补出的旧事充当“刚才”。
轮休问题结合维护的主播常识、read_recording_calendar的多日分布与近期休息/调休原文来推算，不能把六天一轮当成每周固定星期几。已知常规节奏且有近期锚点或重复周期时，可回答“按惯例预计某月某日（周几）”，长短答都注明推算；无资料不等于未开播或休息，凌晨续录不能独立算下一天工作，临时调整以较新安排为准。观众弹幕只是线索，不能伪称主播公告。
旧资料的今天/明天/后天/下周相对资料语境，不相对查询日期；旧“明天休息”不得直接回答为现在的明天。跨午夜核对录制时点与上下文；不能确定语境时，用日历交叉核对或保留锚点不确定，不能偷换日期。
按是否直接回答问题、日期范围、上下文、来源归属排序，rankedEvidenceIds只列最有用的0～8个真实ID，最有用的在前。
同一段重复消息不是多份独立证据。观众的疑问或猜测不算确认；不要把提问本身或机器人的回答作为证据。
核对否定、改口和日期，不要将别的月份的礼物当成所问月份的礼物。ASR可能来自播放音频；没有明确归属时只能说录像提到。
事件细节必须与所问经历关联：仅有身高数字不证明来自那次体检；学校旧事、玩笑、假设或观众数字不能替代本次测量。若只命中属性，search时query聚焦事件、terms用事件词，先定位经历。找到事件后，用其真实录播ID作为withinEvidenceId，query切换为细节、terms用细节词，搜索整场及已识别分段；不能只按同一天混入其他场次，也不能只展开90秒就断言整场没说。若所选场次不符，可将withinEvidenceId设null重新定位；同场命中仍需核对是否属于同一次事件。query最多120字，省略/null沿用原问题。
区分“有没有测/有没有提到”和“测得多少”：提到测量项目可以回答前者，但没有测量数值就说明未找到该次的具体数值，不得移用另一段数字。已知部分可作答，未知部分保留限制。
date是资料场次日期，不一定是事件发生日或实际说话时刻；“昨天”等需有对应场次和原话才可推断，跨午夜或时间依据冲突时保留日期不确定性。未命中、有限上下文都不能证明从没说过或没做过。
“什么时候开始/改成/不再”允许用明确的前后状态推定区间：较早日期仍为旧状态、较晚日期已为新状态，且指向同一主体、同一变化时，可答“据前后自述推定，在A至B之间”，引用两端证据；无需因缺少确切一天而insufficient。先核对否定、引述他人、改口及习惯反复；不能把两次同状态、假设、观众猜测或某日未检索到当成两端。只有一端时只答有依据的“至迟B已…”或“A时尚未…”，不编造另一端。模糊的事后回忆不能抹去带日期的明确自述；冲突确实影响界限时说明限制，不宣称历史首次或永久持续。索引覆盖不足不否定已取得的正面区间证据，但不能据此声称穷尽历史。
danmaku包含普通弹幕和SC，messageType=superchat表示SC。问是谁发的时，先搜正文定位，再用read_context展开该条核对senderName/senderUid；没有记录的字段不能编造。sentAt是北京时间，sentAtBasis=recording_start表示按录制起点推算；time仅为录像偏移，不能冒充实际发送时间。问最早时必须区分“本次找到的较早记录”和“历史首次”，limited=true或没有完整覆盖时不能确认历史首次，应在完整回答和短答中保留“已查到/目前找到”等限制，不能只用单场偏移宣布最早。
数量问题区分平台下单数、实际消费数和时间范围。保留确实找到的数字及口径，不能因另一年不确定就把所有年份都答成不知道。
短答也保留“平台/账单/约”等口径，不能把完整回答中的限制删掉。若发现对数字的怀疑或改口，扩展争议处的上下文确认后续说法，不能只扩展另一个已经确定的数字。
询问的年份不一定是录像年份：年度账单、次年回顾可能提到上一年。不要把“少几百”推算成精确总数，也不要把平台单量说成全年实际喝掉的杯数。
每个搜索只展示附近5条。如果已命中问题的主题却没有答案，必须先context最相关条目一次再判断，不能仅凭短窗口insufficient。
尤其“我看一下”“稍后说”、句子没说完、只有提问时，答案可能在后文；先context。如果关键词不对、日期不符，换词/同音词或调整范围search。
搜索只是OR召回，相关词已同时命中时不要用大量宽泛同义词重复搜索。不要使用主播名字作搜索词。
问店名、品牌等具体名称时，优先检查主题对应的音轨字幕并展开命中上下文；不要只看短弹幕，也不要因同行昵称ASR不清就丢弃直接说出的店名。名称有依据、同行身份未核实时，可以只回答名称并说明关联限制，不能自行把同音昵称认成某人。limited且空排名时应先换具体词或资料类型补查，不要立即insufficient。
舰礼是舰长、提督、总督礼物的统称；泛问舰礼时分别回答三档，未公布/未收录的档位明确说明，不能自动继承其他档礼物。
gift-catalog是按礼物所属月整理的档案，date是依据发布日期、catalogMonth是礼物所属月，条件和官方/录播/仅线索标签必须保留。优先使用明确官方公告；仅线索不能说已确认。不要把未收录说成没有礼物。
跨直播间结论注明主播，引用的roomId/roomName是资料所属直播间，不证明字幕里的每句话都是该主播说的。
最多6次工具操作，不能重复完全相同的搜索或context；次数耗尽时answer或insufficient。
仅输出以下JSON动作之一，不输出工具调用、Markdown、推理过程或额外字段：
{"rankedEvidenceIds":["ev2","ev1"],"action":"answer","certainty":"supported","answer":"与证据相符的完整结论，最多200字","shortAnswer":"保留不确定性的一句答案，最多40字","evidenceIds":["ev2"]}
{"rankedEvidenceIds":["ev2"],"action":"context","evidenceId":"ev2"}
{"rankedEvidenceIds":[],"action":"search","search":{"terms":["具体关键词"],"kind":"all","date":"2026-10"}}
{"rankedEvidenceIds":["ev2"],"action":"search","search":{"terms":["身高","体重"],"kind":"subtitle","date":null,"query":"体检有没有测身高体重","withinEvidenceId":"ev2"}}
{"rankedEvidenceIds":[],"action":"insufficient"}
{"rankedEvidenceIds":[],"action":"tool","tool":{"name":"list_recordings","arguments":{"collection":"highlights","kind":"all","date":null,"offset":0,"limit":5,"preview":"sample","cuesPerRecording":8}}}
{"action":"general","answer":"愿你今晚被温柔以待，累了就好好休息。","shortAnswer":"愿你今晚被温柔以待。"}
{"rankedEvidenceIds":["ev2"],"action":"tool","tool":{"name":"read_recordings","arguments":{"recordingIds":["ev2"],"startSeconds":0,"endSeconds":null,"offset":0,"limitPerRecording":20}}}
answer的evidenceIds必须选自本次rankedEvidenceIds，最多5个，包含支撑答案或冲突的证据；多证券行情每项引用对应报价，不能选无关ID。最多300字。
answer和shortAnswer只写问题的结论，不复述证据所在录像的日期、时间戳或ID；这些元数据由应用按引用ID另行附上。问题本身问事件日期时才回答有依据的事件日期，不得混用邻近候选的日期。
可直接确认才用肯定语气；只有观众猜测时，完整答案与短答案都要明确“观众猜测/未确认”。
certainty只能为supported或uncertain：直接回答问题的证据、明确前后状态支持的推定区间用supported；区间回答的完整答案和短答都保留“据记录/推定”等措辞及年份、日期边界，不把区间改成确切一天。仅有猜测、未确认、当时不知道或否认曾说明时用uncertain，不能假装问题已得到确定答案。
字幕疑似错字时短答只保留能辨清的核心信息，完整回答说明疑点；不要把疑似错字复读为确定名称，也不要擅自补全专有名词。
店名、品牌名以引用原文为准，不添加资料中未出现的中文别名、品牌归属或全称；同名饮品与餐饮品牌不能混为一谈。能用原文名称回答就直接回答，不必额外规范化品牌名。
搜索的context和扩展context内每条都有自己的ID；引用真正包含答案/改口的那条ID，不能用相邻旧说法的ID替代。
合理补查后仍没有可靠依据时insufficient，不能编造。`;

export function parseEvidenceReview(content: string | null, evidence: Pick<QuestionEvidence, 'citation'>): EvidenceReview | undefined {
  if (!content || content.length > 5000) return undefined;
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const rank = value.rankedEvidenceIds;
    if (!Array.isArray(rank) || rank.length > 8 || new Set(rank).size !== rank.length ||
        rank.some(id => typeof id !== 'string' || !evidence.citation(id))) return undefined;
    const fields: Record<string, string[]> = {
      answer: ['certainty', 'answer', 'shortAnswer', 'evidenceIds'], search: ['search'], context: ['evidenceId'], insufficient: [],
      tool: ['tool']
    };
    if (!Object.prototype.hasOwnProperty.call(fields, value.action)) return undefined;
    const allowed = ['action', 'rankedEvidenceIds', ...fields[value.action]];
    if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) return undefined;
    if (value.action === 'context' && (typeof value.evidenceId !== 'string' || !rank.includes(value.evidenceId))) return undefined;
    if (value.action === 'tool' && (!value.tool || typeof value.tool !== 'object' ||
        Object.keys(value.tool).sort().join(',') !== 'arguments,name' || !isQuestionToolName(value.tool.name))) return undefined;
    if (value.action === 'answer') {
      if (!['supported', 'uncertain'].includes(value.certainty) ||
          typeof value.answer !== 'string' || !value.answer.trim() || Array.from(value.answer).length > 300 || unsafeQuestionText(value.answer) ||
          typeof value.shortAnswer !== 'string' || !value.shortAnswer.trim() || Array.from(value.shortAnswer).length > 40 || unsafeQuestionText(value.shortAnswer) ||
          !Array.isArray(value.evidenceIds) || !value.evidenceIds.length || value.evidenceIds.length > 5 ||
          new Set(value.evidenceIds).size !== value.evidenceIds.length || value.evidenceIds.some((id: unknown) => !rank.includes(id))) return undefined;
    }
    return value as EvidenceReview;
  } catch { return undefined; }
}

/** Fixed diagnostic codes only; raw model text and evidence never enter service logs. */
export function reviewValidationIssue(content: string | null, evidence: Pick<QuestionEvidence, 'citation'>): string {
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

export function reviewedAnswer(review: EvidenceReview, evidence: Pick<QuestionEvidence, 'citation' | 'clue'> & {
  quote?: (id: string) => StockQuote | undefined;
}): QuestionAnswer {
  if (review.action !== 'answer') return { answer: NO_EVIDENCE };
  const publicQuotes = review.evidenceIds.map(id => evidence.quote?.(id)).filter((quote): quote is StockQuote => quote !== undefined);
  return {
    ...(review.evidenceIds.every(id => evidence.citation(id)?.kind === 'public-search') ? { basis: 'public' as const } : {}),
    answer: review.answer, shortAnswer: review.shortAnswer,
    source: evidence.citation(review.evidenceIds[0]),
    clues: review.evidenceIds.map(id => evidence.clue(id)).filter((clue): clue is QuestionClue => clue !== undefined),
    ...(publicQuotes.length ? { publicQuotes } : {})
  };
}
