import { QuestionAnswer, unsafeQuestionText } from './QuestionPolicy';

/** Uncited answers are for general conversation only, never claims about a livestream. */
export function generalQuestionAnswer(content: string | null, question: string): QuestionAnswer | undefined {
  if (!content || content.length > 3000 || /(?:刚才|刚刚|最近|今天|昨天|本场|这场|直播|主播|岁己|小岁|老岁|SUI|以前|上次|说过|玩过|舰礼|提督|总督)/iu.test(question)) return undefined;
  try {
    const value = JSON.parse(content);
    if (value?.action !== 'general' || Object.keys(value).sort().join(',') !== 'action,answer,shortAnswer' ||
      typeof value.answer !== 'string' || !value.answer.trim() || Array.from(value.answer).length > 300 ||
      typeof value.shortAnswer !== 'string' || !value.shortAnswer.trim() || Array.from(value.shortAnswer).length > 40 ||
      unsafeQuestionText(value.answer) || unsafeQuestionText(value.shortAnswer)) return undefined;
    return { answer: value.answer, shortAnswer: value.shortAnswer, basis: 'general' };
  } catch { return undefined; }
}
