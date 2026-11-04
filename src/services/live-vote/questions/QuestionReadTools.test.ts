import * as path from 'path';
import { createQuestionReadFactory } from './QuestionReadTools';
import { PublicSearchEvidence, PUBLIC_TOOL_NAMES } from './PublicSearchTools';
import { QuestionRuntime } from './EvidenceQuery';
import { createQQKnowledge } from '../../qqbot/QQKnowledge';
import { createQQAnswerer } from '../../qqbot/QQAgent';
import { createCommentAnswerer } from '../../bilibili/comment-replies/CommentAgent';

const runtime: QuestionRuntime = { questions: { enabled: true, providerConfigPath: path.resolve('unused.json'),
  lexical: { enabled: true, directory: path.resolve('unused-index') }, recordingRoots: { '100': [path.resolve('100_主播')] } } };
const config = { roomId: '100', collaborationRooms: [] };
const request = { key: 'private-test', user: 'user', scope: 'group' as const, targetId: 'group', msgId: 'message', text: '最新的公开公告是什么', createdAt: Date.now() };
const settings = { url: 'https://provider.invalid', apiKey: 'private-model-key' };
const web = { search: jest.fn(async () => [{ title: '官方公告', url: 'https://example.com/notice', snippet: '公开公告内容：已发布新功能', summary: '详情见https://example.com/notice', siteName: '官方', publishedAt: null }]),
  read: jest.fn(async () => ({ title: '公告正文', content: '功能已开放。' })) };
const publicSearch = () => new PublicSearchEvidence(jest.fn(), undefined, web);
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = (name: string, args: unknown) => ({ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('QQ and comment sessions expose the shared read-only inventory and isolate public evidence between questions', async () => {
  const qq = createQQKnowledge(runtime, config, publicSearch)(request, new AbortController().signal);
  const comment = createQuestionReadFactory(runtime, config, publicSearch)(request, new AbortController().signal);
  expect(qq.tools.map(tool => tool.name)).toEqual(comment.tools.map(tool => tool.name));
  expect(qq.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...PUBLIC_TOOL_NAMES, 'read_live_overview', 'search_recordings']));
  expect(qq.tools.some(tool => /send|publish|shell/u.test(tool.name))).toBe(false);
  const result = await qq.tools.find(tool => tool.name === 'search_web')!.execute({ query: '官方公告' });
  expect(result).toMatchObject({ hits: [{ evidenceId: 'pub1' }] });
  await expect(comment.tools.find(tool => tool.name === 'read_web_page')!.execute({ evidenceId: 'pub1' })).rejects.toThrow('Unknown');
  await qq.close(); await comment.close();
});

test('QQ answers public facts with valid shared citations instead of stripping web evidence', async () => {
  const knowledge = createQQKnowledge(runtime, config, publicSearch);
  const transport = jest.fn().mockResolvedValueOnce(response({ tool_calls: [call('search_web', { query: '官方公告' })] }, 'tool_calls'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '据官方公告，新功能已经开放，发布日期未标明。', basis: 'evidence', evidenceIds: ['pub1'] }) }));
  await expect(createQQAnswerer(settings, knowledge, transport as any)(request, new AbortController().signal)).resolves.toContain('新功能');
  expect(transport.mock.calls[1][1].body).toContain('公开公告内容');
});

test('comment model can search public facts through the same tools and closes the per-question session', async () => {
  const factory = createQuestionReadFactory(runtime, config, publicSearch), session = factory(request, new AbortController().signal);
  const close = jest.spyOn(session, 'close');
  const transport = jest.fn().mockResolvedValueOnce(response({ tool_calls: [call('search_web', { query: '官方公告' })] }, 'tool_calls'))
    .mockResolvedValueOnce(response({ content: '据官方公告，新功能已开放，发布日期未标明。' }));
  const event = { key: '1:2:3', uid: '123', oid: '2', type: 1, root: '3', parent: '3', text: request.text, createdAt: request.createdAt };
  const answerer = createCommentAnswerer(settings, transport as any, undefined, undefined, undefined, () => ({ questions: session }));
  await expect(answerer(event.text, new AbortController().signal, event)).resolves.toMatchObject({ reply: expect.stringContaining('新功能') });
  expect(close).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[1][1].body).toContain('公开公告内容');
});
