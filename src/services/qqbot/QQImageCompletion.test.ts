import sharp from 'sharp';
import { createQQAgentModel } from './QQAgentModel';
import { createQQAnswerer } from './QQAgent';
import { createQQImageTools } from './QQImageTools';
import { createQQKnowledge } from './QQKnowledge';
import { QQ_LIMITS, qqRequest } from './QQPolicy';

const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'test-only' };
const signal = () => new AbortController().signal;
const text = '生图，黄头发变栞栞，粉头发变岁己，兔子玩偶变獭獭栞玩偶';
const req = () => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'user',
  groupOpenid: 'group', messageId: 'message', timestamp: '2026-11-18T09:32:00+08:00', content: text,
  attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/source' }] }, Date.parse('2026-11-18T09:32:00+08:00'))!;
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true,
  json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = () => response({ tool_calls: [{ id: 'generate', type: 'function', function: {
  name: 'generate_image', arguments: JSON.stringify({ mode: 'edit', instruction: text, characters: [] }) } }] }, 'tool_calls');
const definitions = [
  { type: 'function', name: 'read_context', description: 'x'.repeat(10000), parameters: {} },
  { type: 'function', name: 'generate_image', description: '按用户要求编辑原图', parameters: {} }
];

test('the reported remaining budget keeps image submission available instead of forcing a text-only answer', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#aabbcc' } }).jpeg().toBuffer();
  const budget = { reserved: 180392, turns: 4 }, calls: any[] = [];
  const transport = jest.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools.map((entry: any) => entry.function.name)).toEqual(['generate_image']);
    return call();
  });
  const model = createQQAgentModel(settings, signal(), transport as any, undefined,
    entry => { calls.push(entry); }, undefined, () => [png], budget, ['generate_image']);
  const result = await model.getResponse({ input: text, systemInstructions: 'x'.repeat(24000), outputType: 'text', tools: definitions } as any);
  expect(result.output[0]).toMatchObject({ type: 'function_call', name: 'generate_image' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(budget.reserved).toBeLessThanOrEqual(QQ_LIMITS.reservation);
  expect(calls.at(-1).status).toBe('ok');
});

test.each(['pending', 'generated', 'failed', 'blocked'] as const)('a concrete image %s receipt completes the agent without another model turn', async status => {
  const request = req(), message = status === 'pending' ? '图片任务已接收。' : status === 'generated' ? '原图编辑完成。' : '原图读取失败，本次没有提交生成。';
  const render = jest.fn(async () => ({ status, message }));
  const options = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high' as const,
    dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: [] };
  const transport = jest.fn().mockResolvedValueOnce(call()).mockImplementation(() => { throw Error('No receipt can be rewritten by another model call'); });
  const tools = createQQImageTools(request, options, async () => [Buffer.from('source')], render);
  expect(await createQQAnswerer(settings, undefined, transport as any, undefined, tools)(request, signal())).toBe(message);
  expect(render).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each(['怎么生图，举两个例子', '只看图，说说画面，不要生成', '生图，是哪位角色还没确定'])('completion allows a direct answer without forcing generation: %s', async question => {
  const transport = jest.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('auto');
    return response({ content: '请说明具体要求。' });
  });
  const model = createQQAgentModel(settings, signal(), transport as any, undefined, undefined, undefined, undefined,
    { reserved: 220000, turns: 4 }, ['generate_image']);
  const result = await model.getResponse({ input: question, systemInstructions: 'x'.repeat(24000), outputType: 'text', tools: definitions } as any);
  expect(result.output[0]).toMatchObject({ type: 'message' });
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each(['terminal', 'unoffered'] as const)('the last model turn accepts only an offered terminal tool: %s', async choice => {
  const terminal = call();
  const transport = jest.fn(async () => choice === 'terminal' ? terminal : response({ tool_calls: [{ id: 'lookup', type: 'function',
    function: { name: 'read_context', arguments: '{}' } }] }, 'tool_calls'));
  const budget = { reserved: 1000, turns: QQ_LIMITS.agentTurns - 1 };
  const model = createQQAgentModel(settings, signal(), transport as any, undefined, undefined, undefined, undefined, budget, ['generate_image']);
  const result = model.getResponse({ input: text, outputType: 'text', tools: definitions } as any);
  if (choice === 'terminal') await expect(result).resolves.toMatchObject({ output: [{ type: 'function_call', name: 'generate_image' }] });
  else await expect(result).rejects.toMatchObject({ diagnostic: { code: 'invalid_tool' } });
  expect(budget.turns).toBe(QQ_LIMITS.agentTurns);
});

test('submission completion cannot exceed the original total budget', async () => {
  const transport = jest.fn();
  const model = createQQAgentModel(settings, signal(), transport as any, undefined, undefined, undefined, undefined,
    { reserved: QQ_LIMITS.reservation - 100, turns: 4 }, ['generate_image']);
  await expect(model.getResponse({ input: text, outputType: 'text', tools: definitions } as any))
    .rejects.toMatchObject({ diagnostic: { code: 'budget_exceeded' } });
  expect(transport).not.toHaveBeenCalled();
});

test('the final turn preserves the existing eight-tool ceiling when every prior turn used a tool', async () => {
  const transport = jest.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('none'); expect(body.tools).toBeUndefined();
    return response({ content: '已达到本次查询上限，请缩小要求。' });
  });
  const input = Array.from({ length: QQ_LIMITS.agentTurns - 1 }, (_, index) => [
    { type: 'function_call', callId: `prior-${index}`, name: 'read_context', arguments: '{}' },
    { type: 'function_call_result', callId: `prior-${index}`, name: 'read_context', output: '{}' }
  ]).flat();
  const model = createQQAgentModel(settings, signal(), transport as any, undefined, undefined, undefined, undefined,
    { reserved: 1000, turns: QQ_LIMITS.agentTurns - 1 }, ['generate_image']);
  await expect(model.getResponse({ input, outputType: 'text', tools: definitions } as any)).resolves.toMatchObject({ output: [{ type: 'message' }] });
});

test('image receipt checkpoint failure stops completion before another model call', async () => {
  const request = req(), tools = { instructions: '', tools: [{ name: 'generate_image', description: '生图',
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
    execute: async () => ({ status: 'pending', message: '图片任务已接收。' }) }] };
  const transport = jest.fn(async () => response({ tool_calls: [{ id: 'submit', type: 'function',
    function: { name: 'generate_image', arguments: '{}' } }] }, 'tool_calls'));
  await expect(createQQAnswerer(settings, undefined, transport as any, async (_request, trace) => {
    if (trace.tools.some(step => step.status === 'ok')) throw Error('checkpoint failed');
  }, tools)(request, signal())).rejects.toMatchObject({ diagnostic: { code: 'record_failed' } });
  expect(transport).toHaveBeenCalledTimes(1);
});

test('intent, source reading and two separate character searches still submit once and return the original receipt', async () => {
  const request = req();
  request.chatContext = Array.from({ length: 4 }, (_, i) => ({ version: 1, id: `context-${i}`, appId: '900000001',
    conversation: 'c'.repeat(64), user: request.user, text: '保留原图画风和构图。'.repeat(30), createdAt: request.createdAt - i - 1 }));
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  const options = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high' as const,
    dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: ['栞栞', '岁己'].map(name => ({
      name, aliases: [], description: name, referenceImage: `public/reference_images/${name}.png` })) };
  const render = jest.fn(async () => ({ status: 'pending' as const, message: '图片任务已接收。' }));
  const lookup = (query: string) => response({ tool_calls: [{ id: query === '岁己' ? 'lookup-sui' : 'lookup-kan', type: 'function',
    function: { name: 'find_image_characters', arguments: JSON.stringify({ query }) } }] }, 'tool_calls');
  const transport = jest.fn().mockResolvedValueOnce(response({ content: JSON.stringify({ relatedMessageIds: ['context-0'],
    relatedContext: ['保留原图画风和构图'], subject: '角色替换', requestedChanges: [text], preserve: ['画风', '构图'],
    excludedOtherSpeakerRequirements: [], needsClarification: false, clarifiedInstruction: text }) }))
    .mockResolvedValueOnce(response({ tool_calls: [{ id: 'sources', type: 'function',
      function: { name: 'read_image_sources', arguments: '{}' } }] }, 'tool_calls'))
    .mockResolvedValueOnce(lookup('栞栞')).mockResolvedValueOnce(lookup('岁己')).mockResolvedValueOnce(call());
  const knowledge = createQQKnowledge({ questions: { enabled: true, providerConfigPath: 'unused',
    lexical: { enabled: true, directory: 'unused-index' }, recordingRoots: { '25788785': ['unused-root'] } } },
  { runtimeConfigPath: 'unused', roomId: '25788785', collaborationRooms: [] });
  const traces: any[] = [];
  expect(await createQQAnswerer(settings, knowledge, transport as any, async (_request, trace) => { traces.push(structuredClone(trace)); },
    createQQImageTools(request, options, async () => [png], render))(request, signal())).toBe('图片任务已接收。');
  expect(render).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(5);
  expect(traces.at(-1).tools.map((step: any) => step.name)).toEqual([
    'read_image_sources', 'find_image_characters', 'find_image_characters', 'generate_image']);
  expect(traces.at(-1).calls.reduce((sum: number, call: any) => sum + call.charge, 0)).toBeLessThanOrEqual(QQ_LIMITS.reservation);
});
