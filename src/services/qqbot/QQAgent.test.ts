import { createQQAnswerer } from './QQAgent';
import { QQRequest } from './QQPolicy';
import { QQQuestionTools } from './QQKnowledge';

const request: QQRequest = { key: 'receipt', user: 'user-hash', scope: 'group', targetId: 'secret-group-openid',
  msgId: 'secret-message-id', text: '你好', createdAt: Date.parse('2026-10-28T02:00:00Z') };
const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'dedicated-qq-secret' };
const signal = () => new AbortController().signal;
const final = (answer: string, basis = 'general', evidenceIds: string[] = []) => ({ content: JSON.stringify({ answer, basis, evidenceIds }) });
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true,
  json: async () => ({ choices: [{ message, finish_reason }] }) });

test('uses the fixed small model, dedicated credential and no arbitrary tools or QQ identity in context', async () => {
  const transport = jest.fn(async () => response(final('你好呀！')));
  const answer = createQQAnswerer(settings, undefined, transport as any);
  expect(await answer(request, signal())).toBe('你好呀！');
  const call = (transport.mock.calls as any)[0];
  expect(call[1].headers.Authorization).toBe('Bearer dedicated-qq-secret');
  const body = JSON.parse(call[1].body);
  expect(body.model).toBe('gpt-6-luna'); expect(body.tools).toBeUndefined(); expect(body.max_tokens).toBe(768);
  expect(body.response_format.type).toBe('json_schema');
  expect(call[1].body).not.toMatch(/secret-group-openid|secret-message-id|dedicated-qq-secret/u);
});
test('help is an agent decision and can answer without unnecessary tool execution', async () => {
  const transport = jest.fn(async () => response(final('在群里艾特我，可以查最新直播梗概，也可以聊天。')));
  const knowledge = jest.fn(() => ({ scope: '仅岁己', tools: [], close: async () => {} }));
  const reply = await createQQAnswerer(settings, knowledge, transport as any)({ ...request, text: '你能做什么' }, signal());
  expect(reply).toContain('群里艾特'); expect(reply).toContain('最新直播梗概');
  expect(reply).not.toMatch(/当前视频|生图/u); expect(knowledge).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
  const system = JSON.parse((transport.mock.calls as any)[0][1].body).messages[0].content;
  expect(system).not.toMatch(/未启用资料检索|可读当前视频|无工具/u);
});
test('keeps evidence as untrusted data and honors cancellation before network IO', async () => {
  const read = jest.fn(async () => ({ evidenceId: 'ev1', date: '2026-10-27', time: '00:12:34', text: '明天继续玩' }));
  const close = jest.fn(async () => {});
  const knowledge = jest.fn((): QQQuestionTools => ({ scope: '岁己', close,
    tools: [{ name: 'read_context', description: '读取已返回的原话', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: read }] }));
  const transport = jest.fn().mockResolvedValueOnce(response({ tool_calls: [{ id: 'call1', type: 'function',
    function: { name: 'read_context', arguments: '{}' } }] }, 'tool_calls'))
    .mockResolvedValueOnce(response(final('原话出现在十月二十七日的录播里。', 'evidence', ['ev1'])));
  await createQQAnswerer(settings, knowledge, transport as any)({ ...request, text: '找小岁的原话' }, signal());
  const body = JSON.parse((transport.mock.calls as any)[1][1].body);
  const toolMessage = body.messages.find((message: any) => message.role === 'tool');
  expect(JSON.parse(toolMessage.content).untrustedEvidence.text).toBe('明天继续玩');
  expect(read).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  await expect(createQQAnswerer(settings, undefined, transport as any)(request, controller.signal)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2);
});
test('rejects private model use, leaked secrets, tool calls, truncated and unsafe responses', async () => {
  const transport = jest.fn();
  await expect(createQQAnswerer(settings, undefined, transport as any)({ ...request, scope: 'c2c' }, signal())).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  for (const [message, finish] of [[final(settings.apiKey), 'stop'], [{ content: '你好', tool_calls: [] }, 'stop'],
    [final('还没说完'), 'length'], [final('@所有人'), 'stop'], [final('查到了', 'evidence', ['invented']), 'stop']]) {
    const send = jest.fn(async () => response(message, finish as string));
    await expect(createQQAnswerer(settings, undefined, send as any)(request, signal())).rejects.toThrow('QQ generation failed');
  }
});
