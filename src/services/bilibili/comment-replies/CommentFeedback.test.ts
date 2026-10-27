import fetch from 'node-fetch';
import { createCommentAnswerer } from './CommentAgent';
import { feedbackEligible, parseFeedbackAnswer } from './CommentFeedback';
import { CommentReplyConfig, CommentEvent, LIMITS } from './CommentPolicy';
import { CommentWorker } from './CommentWorker';
import { newCommentState } from './CommentState';
import { CommentApi } from './CommentApi';

const config: CommentReplyConfig = { botUid: '99', feedbackOwnerUids: ['99'], unlimitedUids: [], credentialConfigPath: 'config/production.json',
  providerConfigPath: 'config/production.json', dailyTokenBudget: 204800, maxQueue: 200, maxUserQueue: 10, pollIntervalMs: 30000 };
const event: CommentEvent = { key: '1:10:5', uid: '1', oid: '10', type: 1, trigger: 'mention', root: '5', parent: '5', text: '这段字幕太小了，建议放大', createdAt: 1000000 };
const video = { ownerUid: '99', title: '我们的切片' };
const note = { category: 'subtitles' as const, quote: '字幕太小了', videoOwnerUid: '99', videoTitle: video.title };
const response = JSON.stringify({ reply: '字幕太小确实影响阅读，尤其手机看时。', feedback: { category: note.category, quote: note.quote } });

test('only authenticated own-video mentions allow literal production feedback', () => {
  expect(feedbackEligible(config, event, video)).toBe(true);
  expect(feedbackEligible(config, { ...event, trigger: 'reply' }, video)).toBe(false);
  expect(feedbackEligible(config, event, { ...video, ownerUid: '2' })).toBe(false);
  expect(feedbackEligible(config, event, { title: '自称我们的视频' })).toBe(false);
  expect(parseFeedbackAnswer(response, event, video, config)?.feedback).toEqual(note);
  expect(parseFeedbackAnswer(response.replace('字幕太小了', '字幕完全错误'), event, video, config)?.feedback).toBeUndefined();
  expect(parseFeedbackAnswer(response.replace('subtitles', '__proto__'), event, video, config)?.feedback).toBeUndefined();
  expect(parseFeedbackAnswer('{bad json', event, video, config)).toBeUndefined();
  expect(parseFeedbackAnswer(`[${response}]`, event, video, config)).toBeUndefined();
  expect(parseFeedbackAnswer('收到这个建议。', event, video, config)).toEqual({ reply: '收到这个建议。' });
  expect(parseFeedbackAnswer(response, event, { ...video, ownerUid: '2' }, config)?.feedback).toBeUndefined();
});

test('one model request returns separate public reply and feedback, reusing verified ownership', async () => {
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: response } }] }) });
  const feedbackVideo = jest.fn(async () => video);
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    async () => ({ anchorDay: '2026-10-25', coverage: 'partial', clues: [], videoOwnerUid: '99' }), { config, feedbackVideo, hotComments: async () => [] });
  expect(await answer(event.text, new AbortController().signal, event)).toMatchObject({ reply: expect.any(String), feedback: { ...note, videoTitle: '' } });
  expect(transport).toHaveBeenCalledTimes(1); expect(feedbackVideo).not.toHaveBeenCalled();
  const messages = JSON.parse(transport.mock.calls[0][1].body).messages;
  expect(messages[1].content).not.toContain('videoOwnerUid');
});

test.each([
  ['这段字幕太小了，建议放大', false],
  ['视频字幕太小了，手机看不清', false],
  ['这段字幕太小了，建议放大；顺便总结一下视频', true],
  ['这段字幕太小了，解释一下结尾的梗', true],
  ['这段字幕太小了，分析一下这段讲的内容', true],
  ['这段字幕太小了，帮我找原话的时间点', true],
  ['这段字幕太小了，核实一下这句台词', true],
  ['这段字幕太小了，结尾是实机吗', true]
])('only standalone validated production feedback omits the missing-video prefix: %s', async (text, disclose) => {
  const reply = '手机看不清字幕这个问题值得关注，字号需要兼顾小屏阅读。';
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content:
    JSON.stringify({ reply, feedback: { category: note.category, quote: note.quote } }) } }] }) });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    undefined, { config, feedbackVideo: async () => video, hotComments: async () => [] });
  const result = await answer(text, new AbortController().signal, { ...event, text });
  expect(result).toEqual({ reply: (disclose ? '没获取到这个视频的字幕，我看不到视频内容。' : '') + reply, feedback: note });
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([null, { category: 'subtitles', quote: '评论没有说过的内容' }])('absent or invalid feedback cannot waive the missing-video prefix', async feedback => {
  const reply = '字号需要兼顾小屏阅读。';
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ reply, feedback }) } }] }) });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    undefined, { config, feedbackVideo: async () => video, hotComments: async () => [] });
  expect(await answer(event.text, new AbortController().signal, event)).toBe('没获取到这个视频的字幕，我看不到视频内容。' + reply);
  expect(transport).toHaveBeenCalledTimes(1);
});

test('ownership metadata verifies the target aid and avoids subtitle requests', async () => {
  const transport = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0,
    data: { aid: 10, cid: 20, title: video.title, desc: '', pubdate: 1, owner: { mid: 99 } } }) }));
  const api = new CommentApi('99', () => 'DedeUserID=99; SESSDATA=secret; bili_jct=csrf', transport as unknown as typeof fetch);
  expect(await api.video('10', new AbortController().signal, false)).toMatchObject(video);
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(api.video('11', new AbortController().signal, false)).rejects.toThrow('unavailable');
});

test.each(['2', undefined])('foreign or unavailable ownership %s preserves ordinary answering without classification', async ownerUid => {
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '可以试试全屏查看字幕。' } }] }) });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    undefined, { config, feedbackVideo: async () => ({ ...video, ownerUid }), hotComments: async () => [] });
  expect(await answer(event.text, new AbortController().signal, event)).toBe('没获取到这个视频的字幕，我看不到视频内容。可以试试全屏查看字幕。');
  expect(JSON.parse(transport.mock.calls[0][1].body).messages[0].content).not.toContain('输出JSON');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('maximum accepted comment remains within the existing model reservation', async () => {
  const text = '哈'.repeat(LIMITS.inputChars);
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"reply":"收到。","feedback":null}' } }] }) });
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'secret' }, transport as unknown as typeof fetch,
    undefined, { config, feedbackVideo: async () => video, hotComments: async () => [] });
  expect(await answer(text, new AbortController().signal, { ...event, text, authorName: '字'.repeat(40) },
    { status: 'available', wearing: { anchorUid: '2', name: '牌'.repeat(40) } })).toBe('收到。');
  const messages = JSON.parse(transport.mock.calls[0][1].body).messages;
  expect(JSON.parse(messages[1].content).untrustedComment).toBe(text);
  expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(LIMITS.tokenReservation);
});

test('unmentioned videos consume no generation or collection; archive failure retries without regeneration or resend', async () => {
  let now = event.createdAt;
  const state = newCommentState('99'), save = jest.fn(async () => {});
  const answer = jest.fn(async () => ({ reply: '字幕太小会影响阅读。', feedback: note })), send = jest.fn(async () => '7');
  const collectFeedback = jest.fn(async () => { expect(state.jobs[0].feedback).toEqual(note); }).mockRejectedValueOnce(new Error('disk'));
  const worker = new CommentWorker(config, state, { save, answer, send, collectFeedback, now: () => now });
  expect(await worker.admit({ ...event, trigger: 'reply' })).toBe('ignored'); await worker.tick();
  expect(answer).not.toHaveBeenCalled(); expect(collectFeedback).not.toHaveBeenCalled();
  await worker.admit(event); await worker.tick();
  expect(state.jobs[0]).toMatchObject({ status: 'sent', feedbackRetryAt: now + 60000 });
  now += 59999; await worker.tick(); expect(collectFeedback).toHaveBeenCalledTimes(1);
  now += LIMITS.retentionMs;
  const restored = new CommentWorker(config, JSON.parse(JSON.stringify(state)), { save, answer, send, collectFeedback, now: () => now });
  await restored.tick(); expect(restored.state.jobs[0].feedbackSaved).toBe(true);
  await restored.tick(); expect(restored.state.jobs).toHaveLength(0);
  expect(answer).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(collectFeedback).toHaveBeenCalledTimes(2);
});
