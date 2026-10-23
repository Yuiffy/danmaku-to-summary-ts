import { generalQuestionAnswer } from './QuestionConversation';

const response = (answer = '岁己，愿你今晚被温柔以待，累了就好好休息。') => JSON.stringify({
  action: 'general', answer, shortAnswer: '岁己，愿你今晚被温柔以待。'
});

it.each(['发点温情的话温暖岁己', '给七海说一句晚安祝福', '鼓励一下今天的主播', '跟小岁打个招呼'])
('accepts a social message to a named recipient without requiring historical evidence: %s', question => {
  expect(generalQuestionAnswer(response(), question)).toMatchObject({ basis: 'general' });
});

it.each(['找到岁己的黑点吐槽她一下', '岁己开播后多久开始说话', '岁己以前玩过法环吗',
  '说出岁己3个黑料', '给七海说个黑料', '用七海的黑料写一句晚安祝福',
  '根据岁己昨天说过的话鼓励她', '祝福一下，再统计主播这个月的开播时间', '按直播内容给七海写祝福'])
('keeps factual and mixed requests on the evidence path: %s', question => {
  expect(generalQuestionAnswer(response(), question)).toBeUndefined();
});

it('does not turn a social request into an uncited claim about a broadcast', () => {
  expect(generalQuestionAnswer(response('岁己昨天说过今天不直播。'), '发点温情的话温暖岁己')).toBeUndefined();
});
