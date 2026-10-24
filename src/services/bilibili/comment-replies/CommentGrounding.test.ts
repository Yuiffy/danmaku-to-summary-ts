import fetch from 'node-fetch';
import { createCommentAnswerer } from './CommentAgent';
import { CommentContext } from './CommentContext';
import { CommentEvent } from './CommentPolicy';
import { newCommentState } from './CommentState';
import { CommentWorker } from './CommentWorker';

const event: CommentEvent = { key: '1:123:5', uid: '10', oid: '123', type: 1, trigger: 'mention', root: '5', parent: '5',
  text: '@鹿饼Shikamochi 视频说猫转氨酶高,是啥问题', createdAt: Date.parse('2026-10-24T20:48:00+08:00') };
const evidence: CommentContext = { anchorDay: '2026-10-24', coverage: 'available', clues: [], video: {
  title: '【栞栞Shiori】娜娜血检出来转氨酶有点高，这下真是猫随主人了', description: '栞栞Shiori直播间',
  content: 'subtitles', scope: 'first-page', excerpts: [{ at: 1, text: '医生说他转氨酶有一点点偏高一点点' }]
} };
const wrong = '转氨酶高一般说明肝细胞指标异常，但光凭这一项不能确定具体问题；视频里医生也说原因不好排查，还是得按医嘱复查。希望娜娜没事呀，小岁别太担心。';
const signal = () => new AbortController().signal;
function fixture(candidate: string, context = evidence) {
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [
    { finish_reason: 'stop', message: { content: candidate } }
  ] }) });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    async () => context, { config: { botUid: '99', speakerNames: { '10': '岁己SUI' } } as any,
      hotComments: async () => [{ text: '小岁别担心', likes: 5 }] });
  return { answer, transport };
}

test.each([wrong, '岁己别担心。', 'SUI别担心。'])('rejects unsupported persona names in the cat video answer: %s', async candidate => {
  const { answer, transport } = fixture(candidate);
  await expect(answer(event.text, signal(), event)).rejects.toThrow('Comment generation failed');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('rejecting a wrong subject leaves the worker failed without a public send or regeneration', async () => {
  const { answer, transport } = fixture(wrong), state = newCommentState('99'), send = jest.fn();
  const worker = new CommentWorker({ botUid: '99', unlimitedUids: [], credentialConfigPath: 'unused', providerConfigPath: 'unused',
    maxQueue: 20, maxUserQueue: 10, pollIntervalMs: 30000, dailyTokenBudget: 4096000 }, state,
  { answer, send, save: async () => {}, now: () => event.createdAt });
  await worker.admit(event); await worker.tick(); await worker.tick();
  expect(state.jobs[0].status).toBe('failed');
  expect(send).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
});

test('allows support for the evidenced cat owner without substituting the bot persona', async () => {
  const candidate = '希望娜娜复查顺利，栞栞也能放心些。';
  const { answer } = fixture(candidate);
  await expect(answer(event.text, signal(), event)).resolves.toBe(candidate);
});

test('a viewer guessing 小岁是吧 cannot establish the speaker on 栞栞的猫 video', async () => {
  const { answer } = fixture('对呀，是小岁～你认出来啦！');
  const request = { ...event, text: '@鹿饼Shikamochi 小岁是吧' };
  await expect(answer(request.text, signal(), request)).rejects.toThrow('Comment generation failed');
});

test.each(['comment', 'title', 'excerpt'] as const)('allows Sui when the actual %s supplies that identity', async source => {
  const context = structuredClone(evidence), request = { ...event };
  if (source === 'comment') request.text = '视频里提到小岁什么';
  if (source === 'title') context.video!.title = '【岁己SUI】谈养猫';
  if (source === 'excerpt') context.video!.excerpts = [{ at: 1, text: '小岁也说过这件事' }];
  const { answer } = fixture('小岁也提到了养猫。', context);
  await expect(answer(request.text, signal(), request)).resolves.toBe('小岁也提到了养猫。');
});

test('unrelated room clues and evidence removed by the prompt budget do not establish a video participant', async () => {
  const context = structuredClone(evidence);
  context.clues.push({ room: '岁己SUI', date: '2026-10-23', time: '00:01', quote: '小岁聊养猫' });
  context.video!.description = '字'.repeat(4000) + '小岁';
  context.video!.excerpts!.push({ at: 2, text: '字'.repeat(4000) + '岁己' });
  const { answer, transport } = fixture(wrong, context);
  await expect(answer(event.text, signal(), event)).rejects.toThrow('Comment generation failed');
  const sent = JSON.parse(JSON.parse(transport.mock.calls[0][1].body).messages[1].content);
  expect(sent.untrustedEvidence.video.description).toBe('');
  expect(sent.untrustedEvidence.video.excerpts).not.toEqual(expect.arrayContaining([expect.objectContaining({ at: 2 })]));
});
