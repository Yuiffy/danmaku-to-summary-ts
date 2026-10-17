import { ClipDetail } from '../../core/admin/contracts';
import { feedbackPrompt, parseFeedbackPlan } from './AdminFeedbackPolicy';

const subtitles = [
  '你自己说石手心汤每天都准备礼物',
  '石手心汤给他准备礼物干什么',
  '咋这样啊这石手心肠啊',
  '这个石手先生',
  '石头先生和石手，其他人名不改'
].map((text, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index + 1},000\n${text}\n`).join('\n');
const detail = { category: 'clip', clip: {}, source: { subtitles: subtitles.replaceAll('石手', '源外') },
  subtitles, evidence: {} } as ClipDetail;
const note = '里面的“石手xx”都是时守星沙。';
const corrections = ['石手心汤', '石手心肠', '石手先生'].map(from => ({ from, to: '时守星沙' }));

it('expands a confirmed name pattern into all distinct literal names in the current clip', () => {
  expect(parseFeedbackPlan(JSON.stringify({ corrections: [corrections[0]] }), detail, note).corrections).toEqual(corrections);
  expect(parseFeedbackPlan('{}', detail, note).corrections).toEqual(corrections);
  expect(feedbackPrompt(detail, note, {})).toContain(JSON.stringify(corrections));
});

it.each([
  '里面的“石手xx”可能是时守星沙。',
  '不要把“石手xx”都改成时守星沙。',
  '“石手xx”都是时守星沙吗？',
  '如果“石手xx”都是时守星沙。',
  '第2条里的“石手xx”都是时守星沙。',
  '里面的“xx”都是时守星沙。',
  '里面的“石.*”都是时守星沙。'
])('does not turn uncertain, scoped or broad feedback into a clip-wide substitution: %s', text => {
  expect(parseFeedbackPlan('{}', detail, text).corrections).toBeUndefined();
  expect(() => parseFeedbackPlan(JSON.stringify({ corrections }), detail, text)).toThrow('明确确认');
});

it('rejects names outside the current subtitles, changed targets and narrowed pattern corrections', () => {
  for (const edit of [
    { from: '石手别名', to: '时守星沙' },
    { from: '源外心汤', to: '时守星沙' },
    { from: '石手心汤', to: '另一个人' },
    { from: '石手心汤', to: '时守星沙', cue: 1 }
  ]) expect(() => parseFeedbackPlan(JSON.stringify({ corrections: [edit] }), detail, note)).toThrow('明确确认');
  expect(() => parseFeedbackPlan('{"corrections":[{"from":"石手xx","to":"时守星沙"}]}', detail, note)).toThrow('具体原词');
});

it.each(['把“石手XX”都改成“时守星沙”。', '字幕里的“石手xx”统一改为「时守星沙」。'])(
  'uses only the explicit confirmed target for supported bulk feedback: %s', text => {
    expect(parseFeedbackPlan('{}', detail, text).corrections).toEqual(corrections);
  });

it('reports an unmatched pattern without taking names from nearby source evidence', () => {
  const absent = { ...detail, subtitles: '', source: { ...detail.source, subtitles } };
  expect(() => parseFeedbackPlan('{}', absent, note)).toThrow('没有匹配');
  expect(parseFeedbackPlan('{}', { ...detail, subtitles: subtitles.replace(/石手(?:心汤|心肠|先生)/gu, '时守星沙') }, note)).toEqual({});
});

it('rejects conflicting bulk targets and preserves the existing correction budget', () => {
  expect(() => parseFeedbackPlan('{}', detail, `${note}“石手xx”都是另一个人。`)).toThrow('冲突');
  const manyNames = Array.from({ length: 31 }, (_, index) => `石手名${String.fromCodePoint(0x4e00 + index)}`).join(' ');
  expect(() => parseFeedbackPlan('{}', { ...detail, subtitles: `1\n00:00:00,000 --> 00:00:01,000\n${manyNames}` }, note)).toThrow('30');
});

it('keeps exact user-confirmed corrections and unsupported-operation blocks intact', () => {
  expect(parseFeedbackPlan('{"corrections":[{"from":"石手先生","to":"时守星沙","cue":4}]}', detail,
    '第4条“石手先生”改成“时守星沙”').corrections).toEqual([{ from: '石手先生', to: '时守星沙', cue: 4 }]);
  expect(parseFeedbackPlan('{"blockedReason":"还需要调整音量"}', detail, note)).toEqual({ blockedReason: '还需要调整音量' });
});
