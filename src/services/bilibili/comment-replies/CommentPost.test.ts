import fetch from 'node-fetch';
import { CommentApi } from './CommentApi';
import { createCommentAnswerer } from './CommentAgent';
import { CommentEvent, CommentPlatformBlocked, LIMITS } from './CommentPolicy';
import example from '../../../../config/comment-replies.example.json';

const event: CommentEvent = { key: '17:1261933297939775496:317817774385', uid: '14279', oid: '1261933297939775496',
  type: 17, trigger: 'mention', parent: '317817774385', root: '317817774385',
  text: '可爱捏!@鹿饼Shikamochi 帮小岁加油', createdAt: 1792656444000 };
const signal = () => new AbortController().signal;
const response = (body: any, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body), json: async () => body });
const item = (id: string, name: string, text: string, opus = false) => ({ id_str: id,
  modules: { module_author: { name, pub_ts: 1792655142 }, module_dynamic: opus
    ? { major: { opus: { summary: { text } } } } : { desc: { text } } } });
const main = item(event.oid, '岁己SUI', '今晚的安排 期待捏 剑指倒数第三！');
const original = item('1261919356461252610', '犬绒Mofu', '今晚八点！栞栞 弥月 犬绒 岁己一起玩超级鸡马！', true);

test('reads the exact parent dynamic and one forwarded text using Opus features, without following URLs or loading pictures', async () => {
  const transport = jest.fn().mockResolvedValue(response({ code: 0, data: { item: { ...main, orig: { ...original,
    orig: item('123', 'other', '不得递归读取') } } } }));
  const api = new CommentApi('99', () => 'DedeUserID=99; SESSDATA=private; bili_jct=csrf', transport as unknown as typeof fetch);
  const result = await api.dynamic(event.oid, signal());
  expect(result).toMatchObject({ author: '岁己SUI', text: '今晚的安排 期待捏 剑指倒数第三!',
    original: { author: '犬绒Mofu', text: expect.stringContaining('超级鸡马') } });
  expect(JSON.stringify(result)).not.toContain('不得递归读取');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0]).toBe(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${event.oid}&features=itemOpusStyle`);
  expect(transport.mock.calls[0][1]).toMatchObject({ timeout: 3000, size: 1048576, redirect: 'error' });
  transport.mockResolvedValueOnce(response({ code: 0, data: { item: { ...main, id_str: '123' } } }));
  await expect(api.dynamic(event.oid, signal())).rejects.toThrow();
  transport.mockResolvedValueOnce(response({ code: -412 }));
  await expect(api.dynamic(event.oid, signal())).rejects.toBeInstanceOf(CommentPlatformBlocked);
});

test('mention counts use unique platform IDs and are omitted for incomplete text, not inferred from familiar names', async () => {
  const nodes = ['1', '2', '3', '4', '4'].map(rid => ({ type: 'RICH_TEXT_NODE_TYPE_AT', rid, text: '@same-name' }));
  const dynamic = (text: string, rich_text_nodes: any[]) => ({ code: 0, data: { item: { ...main,
    modules: { ...main.modules, module_dynamic: { desc: { text, rich_text_nodes } } } } } });
  const transport = jest.fn().mockResolvedValue(response(dynamic('甲乙丙丁一起玩', nodes)));
  const api = new CommentApi('99', () => 'DedeUserID=99; SESSDATA=private; bili_jct=csrf', transport as unknown as typeof fetch);
  expect((await api.dynamic(event.oid, signal())).mentionedUsers).toBe(4);
  for (const body of [dynamic('甲乙丙丁一起玩', []), dynamic('长'.repeat(401), nodes),
    dynamic('甲乙丙丁一起玩', [...nodes, { type: 'RICH_TEXT_NODE_TYPE_AT', rid: 'invalid' }])]) {
    transport.mockResolvedValueOnce(response(body));
    expect((await api.dynamic(event.oid, signal())).mentionedUsers).toBeUndefined();
  }
});

test('the screenshot request receives parent and forwarded announcements despite being casual encouragement, not a recording question', async () => {
  const dynamic = jest.fn(async () => ({ author: '岁己SUI', publishedAt: 1792655142000,
    text: main.modules.module_dynamic.desc!.text, original: { author: '犬绒Mofu', publishedAt: 1792651896000,
      text: '今晚八点！栞栞、弥月、犬绒、岁己一起玩超级鸡马！' } }));
  const knowledge = jest.fn(async () => undefined), hotComments = jest.fn(async () => []);
  const transport = jest.fn().mockResolvedValue(response({ choices: [{ message: { content: '小岁今晚超级鸡马加油！剑指倒数第三也要冲得有气势，饼干岁给你撑腰！' } }] }));
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'private-key' }, transport as unknown as typeof fetch,
    knowledge, { config: example, hotComments, dynamic });
  await answer(event.text, signal(), event);
  expect(dynamic).toHaveBeenCalledWith(event.oid, expect.any(AbortSignal));
  const messages = JSON.parse(transport.mock.calls[0][1].body).messages;
  const context = JSON.parse(messages[1].content);
  expect(context.untrustedPost).toMatchObject({ author: '岁己SUI', text: main.modules.module_dynamic.desc!.text,
    original: { text: expect.stringContaining('超级鸡马') } });
  expect(messages[0].content).toContain('直接给目标加油');
  expect(messages[0].content).toContain('不替主播感谢留言');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(4096);
  dynamic.mockRejectedValueOnce(new Error('unavailable'));
  await expect(answer(event.text, signal(), event)).resolves.toContain('小岁');
  dynamic.mockRejectedValueOnce(new CommentPlatformBlocked('risk'));
  await expect(answer(event.text, signal(), event)).rejects.toBeInstanceOf(CommentPlatformBlocked);
  const reads = dynamic.mock.calls.length;
  await answer('帮小岁加油', signal(), { ...event, type: 1 });
  expect(dynamic).toHaveBeenCalledTimes(reads);
});

test('large post context cannot displace the accepted comment or break the shared token reservation', async () => {
  const post = { author: '岁己SUI', publishedAt: event.createdAt, text: '一段完整的原帖文字'.repeat(40),
    original: { author: '犬绒Mofu', publishedAt: event.createdAt, text: '一段完整的转发原文'.repeat(40) } };
  const transport = jest.fn().mockResolvedValue(response({ choices: [{ message: { content: '一起加油！' } }] }));
  const answer = createCommentAnswerer({ url: 'https://provider.invalid', apiKey: 'private-key' }, transport as unknown as typeof fetch,
    undefined, { config: example, dynamic: async () => post, hotComments: async () => [{ text: '热评'.repeat(45), likes: 10 }] });
  await answer('哈'.repeat(600), signal(), event);
  const messages = JSON.parse(transport.mock.calls[0][1].body).messages;
  const context = JSON.parse(messages[1].content);
  expect(context.untrustedComment).toBe('哈'.repeat(600));
  expect(context.currentSpeaker.name).toBe('带鱼');
  expect(context.untrustedHotComments).toEqual([]);
  if (context.untrustedPost) {
    expect(context.untrustedPost.partial).toBe(true);
    expect([post.text, '']).toContain(context.untrustedPost.text);
  }
  expect(Buffer.byteLength(JSON.stringify(messages)) + LIMITS.outputTokens + 256).toBeLessThanOrEqual(4096);
  expect(post.original.text).toBe('一段完整的转发原文'.repeat(40));
});
