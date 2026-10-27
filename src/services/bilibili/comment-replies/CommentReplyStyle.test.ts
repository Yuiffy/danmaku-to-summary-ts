import fetch from 'node-fetch';
import { createCommentAnswerer } from './CommentAgent';
import { CommentContext, commentSearchTerms, fitCommentContext, needsCommentEvidence, videoExcerpts, videoOnlyQuestion } from './CommentContext';
import { commentReplyMode, commentReplySystem } from './CommentReplyStyle';
import { CommentEvent, LIMITS } from './CommentPolicy';

const event: CommentEvent = { key: '1:123:5', uid: '10', oid: '123', type: 1, trigger: 'mention', root: '5', parent: '5',
  text: '视频里“冰上”这句是啥时间点', createdAt: Date.parse('2026-10-25T12:00:00+08:00') };

test.each([
  ['鹿饼你好呀', 'chat'], ['你能帮我做什么', 'help'], ['回复 @鹿饼Shikamochi : 鹿饼有点...', 'repair'],
  ['你答非所问，我问的是原话在哪', 'repair'], ['根据视频，夸夸小岁安慰一下', 'support'],
  ['栞栞在四人联动说“冰上”是啥时间点', 'locate'], ['小岁之前几次联动是什么内容', 'history'],
  ['这套方式我们能用不', 'project'], ['总结这个视频，解释为什么要这么做', 'explain'],
  ['如何评价这个视频剧情', 'react'], ['你虽然不是大肥鱼，你也过来', 'chat'],
  ['总结这段加油演讲', 'explain'], ['之前联动说“冰上”是啥时间点', 'locate']
])('routes the actual task instead of applying banter to %s', (text, mode) => {
  expect(commentReplyMode(text)).toBe(mode);
});

test('help offers only configured abilities and does not trigger unrelated evidence searches', () => {
  const text = '你能帮我做什么';
  expect(needsCommentEvidence(text)).toBe(false);
  const disabled = commentReplySystem(text, 1);
  expect(disabled).toContain('未启用资料检索');
  expect(disabled).not.toContain('按公开项目资料比较');
  const enabled = commentReplySystem(text, 1, { knowledge: true, projects: true });
  expect(enabled).toContain('可用字幕'); expect(enabled).toContain('找原话'); expect(enabled).toContain('公开项目资料');
  expect(commentReplyMode('你能帮我总结这个视频吗')).toBe('explain');
  expect(needsCommentEvidence('总结视频里介绍的使用方法')).toBe(true);
});

test.each(['你好', '你能帮我做什么', '鹿饼有点...', '根据视频夸夸小岁', '视频里“冰上”是啥时间点',
  '之前几次联动是什么内容', '这套方式我们能用不', '总结这个视频', '如何评价这个视频', '联动“冰上”是哪句'])(
  'the full accepted input still fits the single-call reservation for %s', async prefix => {
    const text = prefix + '哈'.repeat(LIMITS.inputChars - Array.from(prefix).length);
    const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '收到。' } }] }) });
    const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch);
    await answer(text, new AbortController().signal, { ...event, text, authorName: '字'.repeat(40) });
    const messages = JSON.parse(transport.mock.calls[0][1].body).messages;
    expect(JSON.parse(messages[1].content).untrustedComment).toBe(text);
    expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(LIMITS.tokenReservation);
  });

test('factual replies have room for reasons and source locations without irrelevant encouragement/rank instructions', () => {
  const system = commentReplySystem(event.text, event.type);
  expect(system).toContain('excerpts.at'); expect(system).toContain('资料日期和房间');
  expect(system).not.toContain('倒数名次'); expect(system).not.toContain('1至3句≤150字');
  expect(commentReplySystem('这套方式我们能用不', 1)).toContain('验证建议');
  expect(commentReplySystem('你答非所问', 17)).toContain('不假装记得');
});

test('quoted location terms survive collaboration routing, while explicit video scope stays on the target', () => {
  expect(commentSearchTerms('栞栞在4人超级鸡马联动中说了一句“冰上”是啥时间点')).toEqual(['冰上']);
  expect(videoOnlyQuestion('视频里的联动说“冰上”是几分')).toBe(true);
  expect(videoOnlyQuestion('分析一下这个联动视频')).toBe(true);
  expect(videoOnlyQuestion('明天8点的联动有哪些人')).toBe(false);
  expect(videoOnlyQuestion('来看看岁己以前几次联动')).toBe(false);
});

test.each(['@鹿饼Shikamochi', '@鹿饼Shikamochi 来看看', '@鹿饼Shikamochi 你虽然不是大肥鱼,你也过来'])(
  'a simple video summons receives content-aware commentary without requiring special commands: %s', text => {
    expect(commentReplyMode(text, 1)).toBe('react');
    expect(needsCommentEvidence(text, 1)).toBe(true);
    expect(videoOnlyQuestion(text)).toBe(true);
    expect(needsCommentEvidence(text, 17)).toBe(false);
    expect(commentReplySystem(text, 1)).toContain('视频据excerpts');
  });

test('a late answer and its explanation survive the 700-character selection limit and prompt trimming', () => {
  const cues = Array.from({ length: 100 }, (_, i) => ({ at: i * 10, text: `第${i}句。${'无关闲聊'.repeat(22)}` }));
  cues[91] = { at: 910, text: '这一句说的是冰上。' };
  cues[92] = { at: 920, text: '前面的角色滑了一下,所以才接这个梗。' };
  const excerpts = videoExcerpts(cues, event.text);
  expect(excerpts).toEqual(expect.arrayContaining([cues[91], cues[92]]));
  expect(excerpts.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(700);
  const evidence: CommentContext = { anchorDay: '2026-10-25', coverage: 'partial', clues: [], video: {
    title: '四人游戏片段', description: '', content: 'subtitles', sampled: true, excerpts
  } };
  const original = structuredClone(evidence);
  const messages = fitCommentContext(event.text, commentReplySystem(event.text, 1), evidence);
  const fitted = JSON.parse(messages[1].content).untrustedEvidence;
  expect(fitted.video.excerpts).toEqual(expect.arrayContaining([cues[91], cues[92]]));
  expect(fitted.video.excerpts.length).toBeLessThan(excerpts.length);
  expect(fitted.video.sampled).toBe(true);
  for (const cue of fitted.video.excerpts) expect(cues).toContainEqual(cue);
  expect(evidence).toEqual(original);
  expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(LIMITS.tokenReservation);
});

test('oversized original cues are omitted rather than turned into invented partial quotes', () => {
  const cues = [{ at: 0, text: '原句'.repeat(100) }, { at: 1, text: '可以保留的完整原句' }];
  expect(videoExcerpts(cues, '原句')).toEqual([cues[1]]);
});

test('a recording question under a video keeps its historical answer ahead of unrelated target captions', () => {
  const text = '栞栞在联动里说“冰上”是啥时间点';
  const clue = { room: '栞栞', date: '2026-09-03', time: '00:10:05', kind: 'subtitle', quote: '冰上,这里滑下去了' };
  const evidence: CommentContext = { anchorDay: '2026-10-25', coverage: 'partial', clues: [clue], video: {
    title: '另一段游戏', description: '', content: 'subtitles', sampled: true,
    excerpts: Array.from({ length: 8 }, (_, i) => ({ at: i * 10, text: `第${i}句${'闲聊'.repeat(45)}` }))
  } };
  const messages = fitCommentContext(text, commentReplySystem(text, 1), evidence);
  const fitted = JSON.parse(messages[1].content).untrustedEvidence;
  expect(fitted.clues).toEqual([clue]);
  expect(fitted.video.excerpts.length).toBeLessThan(8);
  expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(LIMITS.tokenReservation);
});

test('the final single provider request retains the answer-bearing cue and permits a substantive reply', async () => {
  const text = '总结这个视频并解释去噪的局限';
  const reply = '能提升清晰度，但去噪过强会损失纹理。' + '建议先选一小段比较边缘和纹理，再决定强度。'.repeat(7);
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }) });
  const cues = Array.from({ length: 90 }, (_, i) => ({ at: i, text: `第${i}句${'普通闲聊'.repeat(15)}` }));
  cues[77] = { at: 77, text: '去噪太强会抹掉皮肤纹理,需要保守比较。' };
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    async () => ({ anchorDay: '2026-10-25', coverage: 'partial', clues: [], video: { title: '视频处理', description: '',
      content: 'subtitles', sampled: true, excerpts: videoExcerpts(cues, text) } }));
  await expect(answer(text, new AbortController().signal, { ...event, text })).resolves.toBe(reply);
  expect(transport).toHaveBeenCalledTimes(1);
  const body = JSON.parse(transport.mock.calls[0][1].body);
  expect(body.messages[1].content).toContain(cues[77].text);
  expect(body.messages[0].content).toContain('2至3个关键依据');
  expect(body.max_tokens).toBe(LIMITS.outputTokens); expect(body.tools).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(body.messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(LIMITS.tokenReservation);
});
