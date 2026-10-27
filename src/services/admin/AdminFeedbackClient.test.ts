import { createFeedbackCompletion } from './AdminFeedbackClient';
import { FEEDBACK_TOOLS } from './AdminFeedbackAgent';

const retryConfig = { ai: { text: { retry: { baseDelayMs: 0, jitterRatio: 0 }, daiYu: {
  apiKey: 'primary-secret', baseUrl: 'https://primary.example', apiMode: 'responses',
  fallbackProvider: 'tuZi', fallbackProviderModel: 'fallback-model', fallbackProviderApiMode: 'chatCompletions'
}, tuZi: { apiKey: 'fallback-secret', baseUrl: 'https://fallback.example' } } } };
const rejected = (status: number) => ({ ok: false, status, headers: { get: () => null } });
const completed = () => ({ ok: true, json: async () => ({ status: 'completed', output: [
  { type: 'function_call', call_id: 'next', name: 'inspect_clip', arguments: '{}' }
] }) });

test('retries a transient HTTP failure before continuing the same completion', async () => {
  const transport = jest.fn().mockResolvedValueOnce(rejected(502)).mockResolvedValueOnce(completed());
  const complete = createFeedbackCompletion(retryConfig, transport as any);
  await expect(complete([{ role: 'user', content: '投' }], FEEDBACK_TOOLS)).resolves.toMatchObject({ tool_calls: [{ id: 'next' }] });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][0]).toBe(transport.mock.calls[1][0]);
  expect(transport.mock.calls[0][1].body).toBe(transport.mock.calls[1][1].body);
});

test('falls back using the full tool history, configured model and API format', async () => {
  const calls = [{ id: 'done', type: 'function' as const, function: { name: 'revise_and_review', arguments: '{}' } }];
  const messages = [{ role: 'assistant' as const, content: null, tool_calls: calls },
    { role: 'tool' as const, tool_call_id: 'done', content: '{"ready":true}' }];
  const transport = jest.fn().mockResolvedValueOnce(rejected(502)).mockResolvedValueOnce(rejected(503))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: calls } }] }) });
  await createFeedbackCompletion(retryConfig, transport as any)(messages, FEEDBACK_TOOLS);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(transport.mock.calls[2][0]).toBe('https://fallback.example/v1/chat/completions');
  expect(transport.mock.calls[2][1].headers.Authorization).toBe('Bearer fallback-secret');
  expect(JSON.parse(transport.mock.calls[2][1].body)).toMatchObject({ model: 'fallback-model', messages, parallel_tool_calls: false });
});

test.each([401, 403, 400])('does not retry or change provider for HTTP %s', async status => {
  const transport = jest.fn().mockResolvedValue(rejected(status));
  await expect(createFeedbackCompletion(retryConfig, transport as any)([], FEEDBACK_TOOLS)).rejects.toThrow(`HTTP ${status}`);
  expect(transport).toHaveBeenCalledTimes(1);
});

test('reports safe provider/status diagnostics when all configured attempts fail', async () => {
  const transport = jest.fn().mockResolvedValue(rejected(502));
  const message = await createFeedbackCompletion(retryConfig, transport as any)([], FEEDBACK_TOOLS).catch(error => error.message);
  expect(transport).toHaveBeenCalledTimes(4);
  expect(message).toContain('daiYu HTTP 502'); expect(message).toContain('tuZi HTTP 502');
  expect(message).toContain('意见已保存'); expect(message).not.toMatch(/secret|https?:/u);
});

test('does not replay malformed successful responses or ambiguous transport failures', async () => {
  for (const response of [
    { ok: true, json: async () => ({ status: 'completed', output: [] }) },
    { ok: true, json: async () => { throw new Error('private body'); } }
  ]) {
    const transport = jest.fn().mockResolvedValue(response);
    await expect(createFeedbackCompletion(retryConfig, transport as any)([], FEEDBACK_TOOLS)).rejects.toThrow('响应格式无效');
    expect(transport).toHaveBeenCalledTimes(1);
  }
  const transport = jest.fn().mockRejectedValue(Object.assign(new Error('https://private/?key=secret'), { code: 'ECONNRESET' }));
  await expect(createFeedbackCompletion(retryConfig, transport as any)([], FEEDBACK_TOOLS)).rejects.toThrow('连接结果不明');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('honors Retry-After and shares the remaining request budget across retries', async () => {
  let now = 1000;
  const timing = { now: () => now, sleep: jest.fn(async (ms: number) => { now += ms; }) };
  const transport = jest.fn().mockResolvedValueOnce({ ...rejected(429), headers: { get: () => '3' } }).mockResolvedValueOnce(completed());
  await createFeedbackCompletion(retryConfig, transport as any, timing)([], FEEDBACK_TOOLS);
  expect(timing.sleep).toHaveBeenCalledWith(3000);
  expect(transport.mock.calls[1][1].timeout).toBe(117000);
  transport.mockReset().mockResolvedValue({ ...rejected(429), headers: { get: () => '180' } });
  await expect(createFeedbackCompletion(retryConfig, transport as any, timing)([], FEEDBACK_TOOLS)).rejects.toThrow('总时限');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('never retries an ambiguous timeout or redirects and sanitizes invalid fallback configuration', async () => {
  for (const type of ['request-timeout', 'aborted', 'no-redirect']) {
    const transport = jest.fn().mockRejectedValue(Object.assign(new Error('secret transport message'), { type }));
    const message = await createFeedbackCompletion(retryConfig, transport as any)([], FEEDBACK_TOOLS).catch(error => error.message);
    expect(message).not.toContain('secret'); expect(transport).toHaveBeenCalledTimes(1);
  }
  const transport = jest.fn().mockResolvedValue(rejected(502));
  const config = structuredClone(retryConfig); config.ai.text.tuZi.baseUrl = 'https://user:secret@bad.example/?key=secret';
  const message = await createFeedbackCompletion(config, transport as any)([], FEEDBACK_TOOLS).catch(error => error.message);
  expect(message).toContain('tuZi 配置无效'); expect(message).not.toMatch(/secret|bad.example/u);
  expect(transport).toHaveBeenCalledTimes(2);
});

test('sends a serial tool conversation to the configured provider and sanitizes transport errors', async () => {
  const config = { ai: { text: { daiYu: { apiKey: 'private-test-key', baseUrl: 'https://provider.example/v1', model: 'test-model' } } } };
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'inspect_clip', arguments: '{}' } }
  ] } }] }) });
  const complete = createFeedbackCompletion(config, transport as any);
  const messages = [{ role: 'system' as const, content: 'Inspect the authorized clip.' }];
  expect((await complete(messages, FEEDBACK_TOOLS)).tool_calls?.[0].function.name).toBe('inspect_clip');
  expect(transport.mock.calls[0][0]).toBe('https://provider.example/v1/chat/completions');
  expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({ model: 'test-model', messages, tool_choice: 'required', parallel_tool_calls: false });
  transport.mockRejectedValueOnce(new Error('private-test-key'));
  await expect(complete(messages, FEEDBACK_TOOLS)).rejects.toThrow('意见已保存');
});

test('uses Responses function calls and outputs when the production provider selects Responses', async () => {
  const transport = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'completed', output: [
    { type: 'function_call', call_id: 'call_2', name: 'enqueue_submission', arguments: '{}' }
  ] }) });
  const complete = createFeedbackCompletion({ ai: { text: { daiYu: { apiKey: 'test', baseUrl: 'https://provider.example/v1/responses', apiMode: 'responses' } } } }, transport as any);
  const result = await complete([{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect_clip', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ready":true}' }], FEEDBACK_TOOLS);
  expect(result.tool_calls?.[0].function.name).toBe('enqueue_submission');
  expect(transport.mock.calls[0][0]).toBe('https://provider.example/v1/responses');
  expect(JSON.parse(transport.mock.calls[0][1].body).input).toEqual([
    { type: 'function_call', call_id: 'call_1', name: 'inspect_clip', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ready":true}' }
  ]);
});
