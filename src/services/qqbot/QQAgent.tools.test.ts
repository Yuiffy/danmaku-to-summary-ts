import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createQQAnswerer } from './QQAgent';
import { createQQKnowledge, QQKnowledge, QQReadTool } from './QQKnowledge';
import { QQ_LIMITS, QQRequest } from './QQPolicy';
import { createQQImageTools } from './QQImageTools';

const request: QQRequest = { key: 'receipt', user: 'hash', scope: 'group', targetId: 'private-group', msgId: 'private-msg',
  text: '岁己最新直播播了什么', createdAt: Date.parse('2026-10-28T02:00:00+08:00') };
const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'qq-secret-key' };
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = (name: string, args: unknown, id = 'call1') => response({ tool_calls: [{ type: 'function', id,
  function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
const final = (answer: string, basis = 'evidence', evidenceIds = ['ev1']) => response({ content: JSON.stringify({ answer, basis, evidenceIds }) });
const signal = () => new AbortController().signal;
const tool = (name: string, execute: QQReadTool['execute']): QQReadTool => ({ name, description: name,
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }, execute });
const knowledge = (tools: QQReadTool[]): QQKnowledge => () => ({ scope: '仅岁己SUI', tools, close: async () => {} });

test('screenshot question lets the SDK agent select real latest-overview IO and answer in two model turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-agent-tools-'));
  try {
    const roomRoot = path.join(root, '25788785_岁己SUI', '2026_10_27');
    await fs.mkdir(roomRoot, { recursive: true });
    await fs.writeFile(path.join(roomRoot, '录制-25788785-20261027-200816-824-唱聊_merged_LIVE_CONTENT.json'),
      JSON.stringify({ schemaVersion: 1, status: 'success', roomId: '25788785', content: {
        overview: '杂谈、演唱《Innocence》、同步观看《黑衣人3》', topics: ['发型审美', '猫咪嘉嘉'] } }));
    const context = createQQKnowledge({ questions: { enabled: true, providerConfigPath: 'unused',
      lexical: { enabled: true, directory: path.join(root, 'unused-index') }, recordingRoots: { '25788785': [path.dirname(roomRoot)] } } },
    { runtimeConfigPath: 'unused', roomId: '25788785', collaborationRooms: [] });
    const trace = jest.fn(async () => {});
    const transport = jest.fn().mockResolvedValueOnce(call('read_live_overview', { date: null }))
      .mockResolvedValueOnce(final('最近有梗概的是10月27日那场：杂谈、唱《Innocence》，还一起看了《黑衣人3》。', 'evidence', ['r25788785_overview1_1']));
    const answer = await createQQAnswerer(settings, context, transport as any, trace)(request, signal());
    expect(answer).toContain('黑衣人3'); expect(transport).toHaveBeenCalledTimes(2);
    const first = JSON.parse(transport.mock.calls[0][1].body), second = JSON.parse(transport.mock.calls[1][1].body);
    expect(first.tools.map((entry: any) => entry.function.name)).toEqual(expect.arrayContaining(['read_live_overview', 'search_recordings', 'list_recordings', 'read_context']));
    expect(first.messages[0].content).toContain('最新不等于今天');
    expect(JSON.stringify(second.messages)).toContain('Innocence');
    expect(JSON.stringify(second)).not.toMatch(/private-group|private-msg|qq-secret-key|unused-index/u);
    expect(trace.mock.calls[0][1]).toMatchObject({ modelCalls: 2, tools: [{ name: 'read_live_overview', status: 'ok' }] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('tool failure is data for replanning, then another tool and an evidence-backed answer', async () => {
  const read = jest.fn(async () => { throw new Error('D:/private/leak'); });
  const search = jest.fn(async () => ({ hits: [{ evidenceId: 'ev1', date: '2026-10-27', text: '今晚看黑衣人3' }], limited: true }));
  const transport = jest.fn().mockResolvedValueOnce(call('read_live_overview', {}))
    .mockResolvedValueOnce(call('search_recordings', {}, 'call2')).mockResolvedValueOnce(final('10月27日提到看《黑衣人3》，这只是部分资料。'));
  expect(await createQQAnswerer(settings, knowledge([tool('read_live_overview', read), tool('search_recordings', search)]), transport as any)(request, signal())).toContain('部分资料');
  expect(read).toHaveBeenCalledTimes(1); expect(search).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[1][1].body).toContain('工具失败');
  expect(transport.mock.calls[1][1].body).not.toContain('private/leak');
});

test('casual chat can answer directly with available tools and does not run fixed keyword retrieval', async () => {
  const read = jest.fn();
  const transport = jest.fn(async () => final('辛苦啦，今晚先好好休息。', 'general', []));
  await createQQAnswerer(settings, knowledge([tool('read_live_overview', read)]), transport as any)({ ...request, text: '安慰我两句' }, signal());
  expect(read).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
});

test('unknown tools never execute, bogus citations fail, and tool loops stop at the configured model turn limit', async () => {
  const execute = jest.fn(async () => ({ evidenceId: 'ev1', text: '唱歌' }));
  const context = knowledge([tool('read_live_overview', execute)]);
  const bad = jest.fn(async () => call('run_shell', {}));
  await expect(createQQAnswerer(settings, context, bad as any)(request, signal())).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(bad).toHaveBeenCalledTimes(1);
  const wrong = jest.fn().mockResolvedValueOnce(call('read_live_overview', {})).mockResolvedValueOnce(final('编造', 'evidence', ['unknown']));
  await expect(createQQAnswerer(settings, context, wrong as any)(request, signal())).rejects.toThrow();
  const loop = jest.fn(async () => call('read_live_overview', {}));
  await expect(createQQAnswerer(settings, context, loop as any)(request, signal())).rejects.toThrow();
  expect(loop.mock.calls.length).toBeLessThanOrEqual(QQ_LIMITS.agentTurns);
  expect(execute).toHaveBeenCalledTimes(2); // One in the citation case, once in the deduplicated loop.
});

test.each([
  ['insufficient', ['ev1'], true],
  ['insufficient', [], true],
  ['insufficient', ['unknown'], false],
  ['general', ['ev1'], false],
  ['evidence', [], false]
])('partial answers keep checked citations: basis=%s ids=%j accepted=%s', async (basis, ids, accepted) => {
  const read = jest.fn(async () => ({ evidenceId: 'ev1', text: '买了但还没下载', limited: true }));
  const transport = jest.fn().mockResolvedValueOnce(call('search_recordings', {}))
    .mockResolvedValueOnce(final('已有购买线索，实际游玩日期尚不能确认。', basis, ids));
  const answer = createQQAnswerer(settings, knowledge([tool('search_recordings', read)]), transport as any)(request, signal());
  if (accepted) await expect(answer).resolves.toContain('尚不能确认');
  else await expect(answer).rejects.toMatchObject({ diagnostic: { code: 'invalid_evidence' } });
});

test('oversized tool evidence is bounded with an explicit truncation marker and cannot overspend the reservation', async () => {
  const execute = async () => ({ hits: Array.from({ length: 32 }, (_, i) => ({ evidenceId: `ev${i}`, text: '唱歌'.repeat(300) })), limited: true });
  const transport = jest.fn().mockResolvedValueOnce(call('search_recordings', {})).mockResolvedValueOnce(final('部分资料中提到了唱歌。', 'evidence', ['ev0']));
  await createQQAnswerer(settings, knowledge([tool('search_recordings', execute)]), transport as any)(request, signal());
  const body = JSON.parse(transport.mock.calls[1][1].body), output = JSON.parse(body.messages.find((message: any) => message.role === 'tool').content);
  expect(output.truncated).toBe(true); expect(output.untrustedEvidence.limited).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(6200);
  const reserved = transport.mock.calls.reduce((sum, [, options]) => sum + Buffer.byteLength(options.body, 'utf8') + 768 + 256, 0);
  expect(reserved).toBeLessThanOrEqual(QQ_LIMITS.reservation);
});

test('a bounded exploration reserves its final answer and never executes tools after cancellation', async () => {
  const read = jest.fn(async () => ({ evidenceId: 'ev1', text: '唱歌'.repeat(300), limited: true }));
  const transport = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.tool_choice === 'none' ? final('已读到的片段提到了唱歌，覆盖有限。') :
      call('read_context', { index: transport.mock.calls.length }, `call${transport.mock.calls.length}`);
  });
  const definition = { ...tool('read_context', read), parameters: { type: 'object' as const, additionalProperties: false as const,
    properties: { index: { type: 'integer' } }, required: ['index'] } };
  const answer = await createQQAnswerer(settings, knowledge([definition]), transport as any)(request, signal());
  expect(answer).toContain('唱歌');
  expect(read).toHaveBeenCalledTimes(QQ_LIMITS.agentTurns - 1);
  expect(transport.mock.calls.length).toBeLessThanOrEqual(QQ_LIMITS.agentTurns);
  expect(JSON.parse(transport.mock.calls.at(-1)![1].body).tool_choice).toBe('none');
  expect(JSON.parse(transport.mock.calls.at(-1)![1].body).tools).toBeUndefined();
  const controller = new AbortController();
  const abort = jest.fn(async () => { controller.abort(); return { evidenceId: 'ev1', text: '唱歌' }; });
  const model = jest.fn(async () => call('read_context', {}));
  await expect(createQQAnswerer(settings, knowledge([tool('read_context', abort)]), model as any)(request, controller.signal)).rejects.toThrow();
  expect(model).toHaveBeenCalledTimes(1); expect(abort).toHaveBeenCalledTimes(1);
});

test('large tool schemas do not consume the answer reserve before a focused search and context read', async () => {
  const execute = jest.fn(async () => ({ evidenceId: 'ev1', text: '已核对的历史游戏线索', limited: true }));
  const definitions = ['read_live_overview', 'list_recordings', 'search_recordings', 'read_context'].map(name =>
    ({ ...tool(name, execute), description: '资料工具说明'.repeat(100) }));
  const plan = definitions.map(definition => definition.name);
  const choices: string[] = [];
  const transport = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body), index = transport.mock.calls.length - 1;
    choices.push(body.tool_choice);
    if (body.tool_choice === 'none' || index === plan.length) return final('历史资料中有游戏线索，覆盖有限。');
    return call(plan[index], {}, `call${index}`);
  });
  await createQQAnswerer(settings, knowledge(definitions), transport as any)({ ...request, text: '上次玩某游戏是什么时候' }, signal());
  expect(execute).toHaveBeenCalledTimes(4);
  expect(choices.slice(0, 4)).toEqual(['auto', 'auto', 'auto', 'auto']);
  if (choices.at(-1) === 'none') expect(JSON.parse(transport.mock.calls.at(-1)![1].body).tools).toBeUndefined();
  const reserved = transport.mock.calls.reduce((sum, [, options]) => sum + Buffer.byteLength(options.body, 'utf8') + 768 + 256, 0);
  expect(reserved).toBeLessThanOrEqual(QQ_LIMITS.reservation);
});

test('full recording and image schemas can search after browsing while escaping stays within the final answer budget', async () => {
  const context = createQQKnowledge({ questions: { enabled: true, providerConfigPath: 'unused',
    lexical: { enabled: true, directory: 'unused-index' }, recordingRoots: { '25788785': ['D:/25788785_岁己SUI'] } } },
  { runtimeConfigPath: 'unused', roomId: '25788785', collaborationRooms: [] });
  const execute = jest.fn(async (name: string) => name === 'read_live_overview' ?
    { artifacts: [{ evidenceId: 'overview1', text: '近期直播概述'.repeat(95) }] } :
    { hits: Array.from({ length: 32 }, (_, index) => ({ evidenceId: `ev${index + 1}`, date: '2024-08-30',
      text: '游戏历史线索和带转义的文字"\\'.repeat(35) })), limited: true });
  const tools: QQKnowledge = (...args) => {
    const session = context(...args);
    return { ...session, tools: session.tools.map(definition => ({ ...definition, execute: () => execute(definition.name) })) };
  };
  const paidImage = jest.fn();
  const images = createQQImageTools(request, { enabled: true, model: 'unused', quality: 'high',
    dailyLimit: 1, userDailyLimit: 1, timeoutMs: 1000 }, paidImage, paidImage);
  const plan = [
    ['read_live_overview', { date: null }],
    ['list_recordings', { collection: 'recordings', kind: 'all', date: null, offset: 0, limit: 12, preview: 'head', cuesPerRecording: 2 }],
    ['search_recordings', { terms: ['某游戏'], kind: 'all', date: null, query: null, withinEvidenceId: null, collection: 'recordings' }]
  ] as const;
  const transport = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body), index = transport.mock.calls.length - 1;
    return body.tool_choice === 'none' || index >= plan.length ? final('已查到历史线索，覆盖有限。') :
      call(plan[index][0], plan[index][1], `call${index}`);
  });
  await createQQAnswerer(settings, tools, transport as any, undefined, images)({ ...request, text: '上次玩某游戏是什么时候' }, signal());
  expect(execute.mock.calls.map(([name]) => name)).toEqual(plan.map(([name]) => name));
  expect(paidImage).not.toHaveBeenCalled();
  const last = JSON.parse(transport.mock.calls.at(-1)![1].body);
  const output = JSON.parse(last.messages.filter((message: any) => message.role === 'tool').at(-1).content);
  expect(output.truncated).toBe(true);
  expect(output.untrustedEvidence.hits[0].evidenceId).toBe('ev1');
  const reserved = transport.mock.calls.reduce((sum, [, options]) => sum + Buffer.byteLength(options.body, 'utf8') + 768 + 256, 0);
  expect(reserved).toBeLessThanOrEqual(QQ_LIMITS.reservation);
});
