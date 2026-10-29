import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { createQQAnswerer } from './QQAgent';
import { createQQImageTools } from './QQImageTools';
import { createQQImageGenerator } from './QQImage';
import { QQImageInputs } from './QQImageInputs';
import { QQImageConfig, QQImageToolResult } from './QQImagePolicy';
import { QQ_LIMITS, qqRequest, QQ_PRIVATE_REPLY } from './QQPolicy';
import { QQWorker } from './QQWorker';
import { newQQState } from './QQState';
import { createQQKnowledge } from './QQKnowledge';

const at = Date.parse('2026-10-28T20:56:05+08:00');
const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'private-test-key' };
const config: QQImageConfig = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high', dailyLimit: 300, userDailyLimit: 30,
  timeoutMs: 180000, characters: [] };
const inbound = { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'private-user', groupOpenid: 'private-group',
  messageId: 'private-message', timestamp: new Date(at).toISOString(), content: '生成图片,改成一前一后抬棺',
  msgType: 103, msgElements: [{ msg_idx: 'private-reference', attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/private-image' }] }] };
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = (name: string, args: unknown, id: string) => response({ tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
const final = () => response({ content: JSON.stringify({ answer: '已经按原图调整好前后位置啦。', basis: 'general', evidenceIds: [] }) });
const command = { mode: 'edit' as const, instruction: '仅将原图中抬棺的两名女生调整为一前一后，保留棺内女生和画风。', characters: [] };
let root: string, png: Buffer;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-agent-'));
  png = await sharp({ create: { width: 8, height: 4, channels: 4, background: '#aabbcc' } }).png().toBuffer();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test.each([1, 2, 3])('agent independently chooses %i tools and original image bytes reach edits exactly once', async count => {
  const model = jest.fn();
  if (count >= 2) model.mockResolvedValueOnce(call('read_image_sources', {}, 'source'));
  if (count === 3) model.mockResolvedValueOnce(call('find_image_characters', { query: '岁己' }, 'characters'));
  model.mockResolvedValueOnce(call('generate_image', command, 'render')).mockResolvedValueOnce(final());
  const download = jest.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
  const inputs = new QQImageInputs(root, '900000001', download as any);
  const paid = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const generate = createQQImageGenerator(root, '900000001', config, settings, paid as any, inputs);
  const state = newQQState('900000001');
  const knowledge = createQQKnowledge({ questions: { enabled: true, providerConfigPath: 'unused',
    lexical: { enabled: true, directory: path.join(root, 'unused-index') }, recordingRoots: { '25788785': [root] } } },
  { runtimeConfigPath: 'unused', roomId: '25788785', collaborationRooms: [] });
  const send = jest.fn(async () => {}), trace = jest.fn(async () => {});
  const worker = new QQWorker({ credentialsPath: 'unused', providerConfigPath: 'unused', dailyTokenBudget: 409600,
    maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY, images: config }, state, {
    now: () => at, save: async () => {}, record: async () => {}, image: generate, send, sleep: async () => {}, report: () => {},
    answer: async (request, signal, execute) => {
      const tools = createQQImageTools(request, config, () => inputs.load(request, signal), execute!);
      return createQQAnswerer(settings, knowledge, model as any, trace, tools)(request, signal);
    }
  });
  worker.receive(inbound); await worker.idle();
  expect(state.paused).toBe(false); expect(state.images).toBe(1);
  expect(model).toHaveBeenCalledTimes(count + 1); expect(paid).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(1);
  const [url, init] = paid.mock.calls[0] as unknown as [string, any];
  expect(url).toContain('/images/edits'); expect(init.body.getBuffer().toString('latin1')).toContain(png.toString('latin1'));
  expect(init.body.getBuffer().toString()).toContain('source-1.png');
  expect(init.body.getBuffer().toString()).toContain('保留原图中全部人物的性别');
  expect(send).toHaveBeenCalledTimes(1); expect((send.mock.calls[0] as unknown as any[])[2].file).toContain('.png');
  expect(trace.mock.calls.at(-1)).toBeDefined();
  const context = JSON.stringify(model.mock.calls);
  expect(context).not.toMatch(/private-user|private-group|private-message|private-reference|private-image/u);
});

test('the same available image tools can be skipped entirely for ordinary chat', async () => {
  const request = qqRequest({ ...inbound, content: '这张图真好看' }, at)!;
  const load = jest.fn(), render = jest.fn();
  const model = jest.fn(async () => response({ content: JSON.stringify({ answer: '喜欢就好呀。', basis: 'general', evidenceIds: [] }) }));
  await createQQAnswerer(settings, undefined, model as any, undefined, createQQImageTools(request, config, load, render))(request, new AbortController().signal);
  expect(load).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
});

test('a visual follow-up supplies real image pixels to the answering model after source discovery without rendering', async () => {
  const request = qqRequest({ ...inbound, content: '你的脚怎么穿模了' }, at)!;
  const load = jest.fn(async () => [png]), render = jest.fn(), trace = jest.fn(async () => {});
  const model = jest.fn().mockResolvedValueOnce(call('read_image_sources', {}, 'view'))
    .mockImplementationOnce(async (_url, options) => {
      const body = JSON.parse(options.body);
      const images = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part.type === 'image_url');
      expect(images).toHaveLength(1);
      const url = images[0].image_url.url;
      expect(url).toMatch(/^data:image\/jpeg;base64,/u);
      expect((await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata()).width).toBe(8);
      expect(body.messages.find((message: any) => message.role === 'tool').content).not.toContain('base64');
      return response({ content: JSON.stringify({ answer: '图中脚部与边缘重叠了。', basis: 'general', evidenceIds: [] }) });
    });
  expect(await createQQAnswerer(settings, undefined, model as any, trace,
    createQQImageTools(request, config, load, render))(request, new AbortController().signal)).toContain('脚部');
  expect(load).toHaveBeenCalledTimes(1); expect(render).not.toHaveBeenCalled();
  expect(JSON.stringify(trace.mock.calls.map(args => args[1]))).not.toMatch(/data:image|base64|private-image|private-reference/u);
});

test('failed image discovery never sends invented pixels or starts rendering', async () => {
  const request = qqRequest({ ...inbound, content: '这张图是什么' }, at)!;
  const load = jest.fn(async () => { throw new Error('download failed'); }), render = jest.fn();
  const model = jest.fn().mockResolvedValueOnce(call('read_image_sources', {}, 'view'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '这次读取原图失败，请重新附图。', basis: 'general', evidenceIds: [] }) }));
  await createQQAnswerer(settings, undefined, model as any, undefined,
    createQQImageTools(request, config, load, render))(request, new AbortController().signal);
  expect(JSON.stringify(model.mock.calls)).not.toContain('data:image');
  expect(render).not.toHaveBeenCalled();
});

test('missing source, invented names and create-on-quote cannot spend image budget', async () => {
  const request = qqRequest(inbound, at)!, load = jest.fn(async () => { throw new Error('private download error'); });
  const render = jest.fn<Promise<QQImageToolResult>, any[]>(async () => ({ status: 'generated', message: 'done' }));
  const tools = createQQImageTools(request, config, load, render).tools;
  const generate = tools.find(tool => tool.name === 'generate_image')!;
  expect(await generate.execute({ ...command, mode: 'create' })).toMatchObject({ status: 'blocked' });
  expect(await generate.execute({ ...command, characters: ['invented'] })).toMatchObject({ status: 'blocked' });
  expect(await generate.execute(command)).toMatchObject({ status: 'blocked', message: expect.stringContaining('没有拿到原图') });
  expect(render).not.toHaveBeenCalled();
});

test('duplicate or unknown tools and tool loops remain bounded by the agent ceiling', async () => {
  const request = qqRequest(inbound, at)!, load = jest.fn(async () => [png]), render = jest.fn();
  const model = jest.fn(async () => call('read_image_sources', {}, 'repeat'));
  await expect(createQQAnswerer(settings, undefined, model as any, undefined,
    createQQImageTools(request, config, load, render))(request, new AbortController().signal)).rejects.toThrow();
  expect(model.mock.calls.length).toBeLessThanOrEqual(QQ_LIMITS.agentTurns); expect(load).toHaveBeenCalledTimes(1); expect(render).not.toHaveBeenCalled();
});

test.each(['reservation', 'artifact'])('SDK tool %s checkpoint failures pause the worker before further calls or sending', async stage => {
  const model = jest.fn().mockResolvedValueOnce(call('generate_image', command, 'render')).mockResolvedValueOnce(final());
  const state = newQQState('900000001'), send = jest.fn();
  const report = jest.fn();
  const image = jest.fn(async () => ({ file: 'local.png', model: config.model, sha256: 'a'.repeat(64), prompt: 'original source prompt' }));
  const worker = new QQWorker({ credentialsPath: 'unused', providerConfigPath: 'unused', dailyTokenBudget: 409600,
    maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY, images: config }, state, {
    now: () => at, save: async () => { if (stage === 'reservation' && state.images) throw new Error('disk full'); },
    record: async (_request, update) => { if (stage === 'artifact' && update.image) throw new Error('disk full'); },
    image, send, sleep: async () => {}, report,
    answer: async (request, signal, execute) => createQQAnswerer(settings, undefined, model as any, undefined,
      createQQImageTools(request, config, async () => [png], execute!))(request, signal)
  });
  worker.receive(inbound); await worker.idle();
  expect(state.paused).toBe(true);
  expect(send).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
  expect(image).toHaveBeenCalledTimes(stage === 'artifact' ? 1 : 0);
});

test('the agent can discover multiple character references in a single tool operation', async () => {
  const characters = ['岁己', '栞栞', '弥月'].map(name => ({ name, aliases: [name], description: `${name}外观`, referenceImage: `public/reference_images/${name}.png` }));
  const tools = createQQImageTools(qqRequest(inbound, at)!, { ...config, characters }, jest.fn(), jest.fn()).tools;
  expect(await tools.find(tool => tool.name === 'find_image_characters')!.execute({ query: '岁己、栞栞和弥月' }))
    .toMatchObject({ characters: characters.map(({ name }) => ({ name })) });
});

test('the agent can generate the reported new drawing without a confirmation round trip', async () => {
  const request = qqRequest({ ...inbound, content: '生成岁己和栞栞在wwe赛场上大战的图片', msgType: undefined, msgElements: undefined }, at)!;
  const render = jest.fn(async () => ({ status: 'generated' as const, message: '图片生成完成。' }));
  const model = jest.fn().mockResolvedValueOnce(call('generate_image',
    { mode: 'create', instruction: request.text, characters: [] }, 'create'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '图片生成完成。', basis: 'general', evidenceIds: [] }) }));
  await createQQAnswerer(settings, undefined, model as any, undefined,
    createQQImageTools(request, config, jest.fn(), render))(request, new AbortController().signal);
  expect(render).toHaveBeenCalledTimes(1);
  const instructions = JSON.stringify(model.mock.calls[0]);
  expect(instructions).toContain('无需固定确认口令或重复确认');
  expect(instructions).not.toContain('新图需用户正文以');
});
