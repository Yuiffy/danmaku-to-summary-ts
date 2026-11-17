import { createQQAnswerer } from './QQAgent';
import { createQQImageTools } from './QQImageTools';
import { createQQImageTaskTools, withQQImageTaskTools, QQImageTaskActions } from './QQImageTaskTools';
import { QQRequest } from './QQPolicy';

const request: QQRequest = { key: 'receipt', user: 'private-user-digest', scope: 'group', targetId: 'private-group',
  msgId: 'private-message', text: '图来', createdAt: Date.parse('2026-11-17T12:51:00Z') };
const settings = { url: 'http://offline.invalid/v1/chat/completions', apiKey: 'offline-secret' };
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = (name: string, id: string) => response({ tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] }, 'tool_calls');
const final = (answer: string) => response({ content: JSON.stringify({ answer, basis: 'general', evidenceIds: [] }) });
function fixture() {
  const actions = { read: jest.fn<ReturnType<QQImageTaskActions['read']>, []>(async () => ({ status: 'ready', message: '图片已完成，可以领取。' })),
    collect: jest.fn<ReturnType<QQImageTaskActions['collect']>, []>(async () => ({ status: 'collected', message: '上次的图片生成完成，给你发来啦。' })) };
  const load = jest.fn(), generate = jest.fn();
  const imageTools = createQQImageTools(request, { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high',
    timeoutMs: 900000, dailyLimit: 300, userDailyLimit: 30 }, load, generate);
  return { actions, load, generate, session: withQQImageTaskTools(imageTools, actions) };
}

test.each(['图来', '我刚才没收到，能给我一下吗', '把刚才那份交给我吧'])('agent can choose status and collection semantically: %s', async text => {
  const f = fixture();
  const model = jest.fn().mockResolvedValueOnce(call('read_image_job', 'query'))
    .mockResolvedValueOnce(call('collect_image', 'pickup')).mockResolvedValueOnce(final('给你发来了。'));
  await expect(createQQAnswerer(settings, undefined, model as any, undefined, f.session)({ ...request, text }, new AbortController().signal))
    .resolves.toBe('给你发来了。');
  expect(f.actions.read).toHaveBeenCalledTimes(1); expect(f.actions.collect).toHaveBeenCalledTimes(1);
  expect(f.load).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  for (const [, init] of model.mock.calls) {
    const body = JSON.parse(init.body);
    expect(body.tools.map((item: any) => item.function.name)).toEqual(expect.arrayContaining(['read_image_job', 'collect_image']));
    expect(init.body).not.toMatch(/private-user-digest|private-group|private-message|offline-secret/u);
    for (const item of body.tools.filter((item: any) => ['read_image_job', 'collect_image'].includes(item.function.name))) {
      expect(item.function.parameters).toMatchObject({ properties: {}, additionalProperties: false });
    }
  }
  const last = JSON.parse(model.mock.calls.at(-1)![1].body);
  expect(last.messages.filter((item: any) => item.role === 'tool').map((item: any) => JSON.parse(item.content).untrustedEvidence.status))
    .toEqual(['ready', 'collected']);
});

test('ordinary chat can ignore task tools even if its text contains an old pickup command', async () => {
  const f = fixture(); const model = jest.fn(async () => final('正常回答当前问题。'));
  await createQQAnswerer(settings, undefined, model as any, undefined, f.session)
    ({ ...request, text: '收图功能怎么用？另外今天有什么消息？' }, new AbortController().signal);
  expect(f.actions.read).not.toHaveBeenCalled(); expect(f.actions.collect).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
});

test('agent status query reports a real failure without claiming a result or trying to generate', async () => {
  const f = fixture(); f.actions.read.mockResolvedValue({ status: 'failed', message: '这个要求过不了审核，换张图或换个要求试试。' });
  const model = jest.fn().mockResolvedValueOnce(call('read_image_job', 'query')).mockResolvedValueOnce(final('这个要求过不了审核。'));
  await expect(createQQAnswerer(settings, undefined, model as any, undefined, f.session)
    ({ ...request, text: '上一单到底为什么没出？' }, new AbortController().signal)).resolves.toContain('过不了审核');
  expect(f.actions.collect).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
});

test('task tools can stand alone and leave other media sessions intact', () => {
  const f = fixture(); const tasks = createQQImageTaskTools(f.actions);
  expect(tasks.tools.map(item => item.name)).toEqual(['read_image_job', 'collect_image']);
  expect(withQQImageTaskTools(undefined, f.actions)?.tools).toHaveLength(2);
  expect(withQQImageTaskTools(f.session)).toBe(f.session);
});
