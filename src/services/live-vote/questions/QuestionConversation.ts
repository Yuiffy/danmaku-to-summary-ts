import { QuestionAnswer, unsafeQuestionText } from './QuestionPolicy';

const HISTORY = /(?:刚才|刚刚|最近|昨天|以前|上次|说过|玩过|舰礼|提督|总督|统计|平均|多少|多久|开播|开口|黑料|黑点|黑屁|吐槽|查找|找到|根据|结合|基于|按.{0,6}(?:直播|字幕|记录)|发生|经历)/iu;
const SOCIAL = /(?:温情|温暖|暖心|鼓励|安慰|祝福|打.{0,2}招呼|问.{0,2}好|说.{0,3}晚安|道.{0,2}晚安|你好|晚安|加油)/u;
export function isSocialQuestion(question: string): boolean { return SOCIAL.test(question) && !HISTORY.test(question); }
export function isRoastQuestion(question: string): boolean { return /(?:黑料|黑点|黑屁|吐槽)/u.test(question); }

export const PLAYFUL_ROAST_PROMPT = `“找黑料/黑点/黑屁/吐槽”默认是善意调侃：任务是找到可核实的普通趣事，再写成好笑的“小黑料”，不需要证明有真正的丑闻，也不要求原文出现“黑料”。日常小事、无伤大雅的自述也可以作为素材，不必非得翻车出糗；不能由此夸大成长期习惯、人格缺陷或真实恶行。用户明确追问严重指控时仍需直接证据，不能用玩笑暗示指控属实。
先浏览少量highlights/clips抽样找主题，建议3～4份、每份6～8条；sample只取两条会只看到开头和结尾，容易错过中间聊天。找到主题后立即用主题词搜索原录播subtitle并核对上下文和归属；摘要只能提供线索，不能仅凭highlight或观众起哄确认主播做过。联动对话、歌词、播放视频的台词不自动属于主播；归属不清就换更清楚的小事。预览没看到出糗，不等于没有可用趣事；可换普通日常主题继续查，不能只搜“黑料/黑点”。
有一件可核实小事就可以answer，不因不够“黑”或凑不齐数量而insufficient。用户要三个但只核实一个，就明确“先挖到一个小黑料”并回答这个，不拆分同一件事或编造凑数。每件事的事实核心必须有对应引用；幽默只加在评价和比喻上，不能添加没发生的动作、频率、后果或引语。
回答自然接梗，可用“无伤大雅版黑料”“这也算小黑料”等表明玩笑，再把真实小事和一句轻松吐槽写在一起，避免只列事实或只解释不能造谣。shortAnswer也应保留真实核心和包袱。只找到观众说法时不能写成主播实锤；确实无可核实素材才insufficient。answer必须同时输出rankedEvidenceIds和evidenceIds，引用真正支持事实的原文ID。`;

/** Uncited answers are for general conversation only, never claims about a livestream. */
export function generalQuestionAnswer(content: string | null, question: string): QuestionAnswer | undefined {
  const social = isSocialQuestion(question);
  if (!content || content.length > 3000 || HISTORY.test(question) || !social &&
      /(?:今天|本场|这场|直播|主播|岁己|小岁|老岁|SUI)/iu.test(question)) return undefined;
  try {
    const value = JSON.parse(content);
    if (value?.action !== 'general' || Object.keys(value).sort().join(',') !== 'action,answer,shortAnswer' ||
      typeof value.answer !== 'string' || !value.answer.trim() || Array.from(value.answer).length > 300 ||
      typeof value.shortAnswer !== 'string' || !value.shortAnswer.trim() || Array.from(value.shortAnswer).length > 40 ||
      unsafeQuestionText(value.answer) || unsafeQuestionText(value.shortAnswer) ||
      social && [value.answer, value.shortAnswer].some(text => HISTORY.test(text))) return undefined;
    return { answer: value.answer, shortAnswer: value.shortAnswer, basis: 'general' };
  } catch { return undefined; }
}
