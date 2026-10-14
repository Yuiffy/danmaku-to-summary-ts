import { createFeedbackCompletion } from './AdminFeedbackClient';
import { FEEDBACK_TOOLS } from './AdminFeedbackAgent';

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
