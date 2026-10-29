import { Response } from 'node-fetch';
import { createQQAnswerer } from './QQAgent';
import { createQQAgentModel } from './QQAgentModel';
import { QQAgentTrace } from '../../core/admin/qqRecords';
import { QQModelCall } from '../../core/admin/qqDiagnostics';
import { QQRequest, QQ_LIMITS } from './QQPolicy';
import { qqFailure } from './QQDiagnostics';

const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'private-api-key' };
const request: QQRequest = { key: 'a'.repeat(64), user: 'b'.repeat(64), scope: 'group', targetId: 'private-openid',
  msgId: 'private-message-id', text: '你好', createdAt: Date.parse('2026-10-28T02:00:00Z') };
const signal = () => new AbortController().signal;
const reply = (answer = '你好呀', basis = 'general', evidenceIds: string[] = []) => ({ content: JSON.stringify({ answer, basis, evidenceIds }) });
const response = (message: unknown, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }] }),
  { status: 200, headers: { 'x-request-id': 'req-safe-123' } });
const toolCall = { tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_context', arguments: '{}' } }] };
const knowledge = (execute = async (): Promise<unknown> => ({ evidenceId: 'ev1', text: '今天继续玩' }), close = async () => {}) => () => ({ scope: '岁己', close,
  tools: [{ name: 'read_context', description: '读取上下文', parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const }, execute }] });

test.each([
  ['HTTP error', () => new Response('private provider diagnostics', { status: 429, headers: { 'x-request-id': 'req-safe-123' } }), 'model_http', 'http_error', 429],
  ['invalid JSON', () => new Response('{private-api-key', { status: 200 }), 'model_decode', 'invalid_json', 200],
  ['truncated output', () => response(reply(), 'length'), 'model_output', 'truncated', 200],
  ['empty output', () => response({ content: '' }), 'model_output', 'empty_output', 200],
  ['bad tool call', () => response(toolCall, 'tool_calls'), 'model_output', 'invalid_tool', 200],
  ['invalid final schema', () => response({ content: 'private provider diagnostics' }), 'agent_run', 'invalid_schema', undefined],
  ['invalid citation', () => response(reply('查到了', 'evidence', ['invented'])), 'answer_validation', 'invalid_evidence', undefined],
  ['unsafe final answer', () => response(reply('@所有人')), 'answer_validation', 'unsafe_answer', undefined],
  ['secret final answer', () => response(reply(settings.apiKey)), 'answer_validation', 'secret_output', undefined]
])('%s retains the precise failure and completed HTTP metadata without exposing raw data', async (_name, makeResponse, stage, code, status) => {
  const snapshots: QQAgentTrace[] = [];
  const transport = jest.fn(async () => (makeResponse as () => Response)());
  let caught: any;
  try { await createQQAnswerer(settings, undefined, transport as any, async (_request, trace) => { snapshots.push(structuredClone(trace)); })(request, signal()); }
  catch (error) { caught = error; }
  expect(caught).toMatchObject({ message: 'QQ generation failed', diagnostic: { stage, code, ...(status ? { httpStatus: status } : {}) } });
  const trace = snapshots.at(-1)!;
  expect(trace.modelCalls).toBe(1); expect(trace.calls).toHaveLength(1);
  expect(trace.calls![0]).toMatchObject({ turn: 1, httpStatus: status || 200, status: ['agent_run', 'answer_validation'].includes(stage as string) ? 'ok' : 'failed' });
  expect(trace.failures![0]).toMatchObject({ stage, code });
  expect(snapshots[0].calls![0].status).toBe('running');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(trace)).not.toMatch(/private-api-key|private provider diagnostics|private-openid|private-message-id/u);
});

test('all successful calls and tool transitions are checkpointed in execution order', async () => {
  const snapshots: QQAgentTrace[] = [];
  const transport = jest.fn().mockResolvedValueOnce(response(toolCall, 'tool_calls')).mockResolvedValueOnce(response(reply('原话在资料中', 'evidence', ['ev1'])));
  const answer = await createQQAnswerer(settings, knowledge(), transport as any, async (_request, trace) => { snapshots.push(structuredClone(trace)); })(request, signal());
  expect(answer).toBe('原话在资料中');
  expect(snapshots.some(trace => trace.calls?.length === 1 && trace.tools[0]?.status === 'ok')).toBe(true);
  expect(snapshots.at(-1)).toMatchObject({ modelCalls: 2, tools: [{ name: 'read_context', status: 'ok' }],
    calls: [{ status: 'ok', httpStatus: 200, requestId: 'req-safe-123' }, { status: 'ok', httpStatus: 200 }], failures: [] });
});

test('budget blocks before HTTP keep the attempted turn, byte counts and cumulative reservation', async () => {
  const calls: QQModelCall[] = [];
  const transport = jest.fn(async () => response(reply()));
  const model = createQQAgentModel(settings, signal(), transport as any, undefined, call => { if (!calls.includes(call)) calls.push(call); });
  const inputBytes = Math.floor(QQ_LIMITS.reservation / 2.5);
  const input = { input: 'x'.repeat(inputBytes), systemInstructions: '', tools: [], outputType: 'text' } as any;
  await model.getResponse(input); await model.getResponse(input);
  await expect(model.getResponse(input)).rejects.toMatchObject({ diagnostic: { stage: 'model_budget', code: 'budget_exceeded', turn: 3,
    budgetBefore: calls[0].charge + calls[1].charge, budgetLimit: QQ_LIMITS.reservation } });
  expect(transport).toHaveBeenCalledTimes(2); expect(calls).toHaveLength(3); expect(calls[2].status).toBe('blocked');
  expect(calls[2].requestBytes).toBeGreaterThan(inputBytes); expect(calls[2].budgetBefore + calls[2].charge).toBeGreaterThan(QQ_LIMITS.reservation);
});

test('network errors preserve safe exception type, system code and fingerprint only', async () => {
  const transport = jest.fn(async () => { throw Object.assign(new Error(`private provider diagnostics ${settings.apiKey} C:\\private\\secret.json`), { name: 'FetchError', code: 'ECONNRESET' }); });
  let trace: QQAgentTrace | undefined;
  await expect(createQQAnswerer(settings, undefined, transport as any, async (_request, value) => { trace = structuredClone(value); })(request, signal()))
    .rejects.toMatchObject({ diagnostic: { stage: 'model_http', code: 'network', errorName: 'FetchError', systemCode: 'ECONNRESET' } });
  expect(trace!.calls![0].failure!.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(trace)).not.toMatch(/private|secret\.json|api-key/u);
});

test('failed tools retain their cause even if the model can give an insufficient-evidence answer', async () => {
  let trace: QQAgentTrace | undefined;
  const transport = jest.fn().mockResolvedValueOnce(response(toolCall, 'tool_calls')).mockResolvedValueOnce(response(reply('目前资料不足', 'insufficient')));
  await createQQAnswerer(settings, knowledge(async () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }); }), transport as any,
    async (_request, value) => { trace = structuredClone(value); })(request, signal());
  expect(trace!.tools[0]).toMatchObject({ status: 'failed', failure: { stage: 'tool', code: 'tool_failed', systemCode: 'ENOENT' } });
  expect(JSON.stringify(trace)).not.toContain('private path');
});

test('cleanup errors cannot hide a primary failure and cannot prevent the final archive', async () => {
  let trace: QQAgentTrace | undefined;
  const transport = jest.fn(async () => response(reply('查到了', 'evidence', ['invented'])));
  const session = knowledge(undefined, async () => { throw new Error('private close failure'); });
  await expect(createQQAnswerer(settings, session, transport as any, async (_request, value) => { trace = structuredClone(value); })(request, signal()))
    .rejects.toMatchObject({ diagnostic: { stage: 'answer_validation', code: 'invalid_evidence' } });
  expect(trace!.failures!.map(value => value.code)).toEqual(['invalid_evidence', 'cleanup_failed']);
});

test('diagnostic checkpoint failure before HTTP fails closed', async () => {
  const transport = jest.fn(async () => response(reply()));
  await expect(createQQAnswerer(settings, undefined, transport as any, async () => { throw Object.assign(new Error('disk path private'), { code: 'ENOSPC' }); })(request, signal()))
    .rejects.toMatchObject({ diagnostic: { stage: 'trace_record', code: 'record_failed', systemCode: 'ENOSPC' } });
  expect(transport).not.toHaveBeenCalled();
});

test.each(['timeout', 'aborted'] as const)('abort reason is classified as %s without discarding HTTP stage', async code => {
  const controller = new AbortController();
  const transport = jest.fn(async () => { controller.abort(qqFailure('agent_run', code)); throw new Error('private abort message'); });
  await expect(createQQAnswerer(settings, undefined, transport as any)(request, controller.signal))
    .rejects.toMatchObject({ diagnostic: { stage: 'model_http', code } });
});
