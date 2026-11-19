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
import { qqImageCommandPlan, qqImageCommandReply } from './QQImagePolicy';
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

test('known short names in the four-character Codex request resolve before admission and rendering', async () => {
  const characters = [
    { name: '岁己SUI', aliases: ['岁己'] }, { name: '栞栞', aliases: ['小栞'] },
    { name: '米汀', aliases: ['米丁'] }, { name: '饼干岁人', aliases: ['饼干人'] }
  ].map(item => ({ ...item, description: item.name, referenceImage: `public/reference_images/${item.name}.png` }));
  const request = qqRequest({ ...inbound, msgElements: undefined, msgType: undefined,
    content: '生成图片：饼干岁人在电脑前使用codex高冷神秘地进行开发。岁己、栞栞、米汀三人围着饼干岁人。' }, at)!;
  const options = { ...config, characters }, observed = jest.fn();
  const render = jest.fn(async (selected) => {
    const plan = qqImageCommandPlan(request, selected, options, 0);
    expect(plan.references).toEqual(characters.map(item => item.referenceImage));
    expect(plan.prompt).toContain('codex');
    return { status: 'pending' as const, message: '图片任务已接收。' };
  });
  const generate = createQQImageTools(request, options, jest.fn(), render, undefined, observed).tools.find(item => item.name === 'generate_image')!;
  expect(await generate.execute({ mode: 'create', instruction: request.text,
    characters: [' 岁己ＳＵＩ ', '小栞', '米丁', '饼干人', '岁己'] })).toMatchObject({ status: 'pending' });
  expect(render).toHaveBeenCalledWith(expect.objectContaining({ characters: characters.map(item => item.name) }));
  expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending' }));
  // The renderer also validates short names when reached without the agent tool adapter.
  expect(qqImageCommandPlan(request, { mode: 'create', instruction: request.text, characters: ['岁己'] }, options, 0).references)
    .toEqual(characters.map(item => item.referenceImage));
});

test('unknown and ambiguous image selections remain blocked before paid admission', async () => {
  const characters = ['甲', '乙'].map(name => ({ name, aliases: ['共同别名'], description: name, referenceImage: `public/reference_images/${name}.png` }));
  const request = qqRequest({ ...inbound, msgElements: undefined, msgType: undefined, content: '画一张星空图片' }, at)!;
  const options = { ...config, characters }, render = jest.fn();
  const generate = createQQImageTools(request, options, jest.fn(), render).tools.find(item => item.name === 'generate_image')!;
  for (const name of ['共同别名', '未收录', '甲的立绘']) {
    expect(await generate.execute({ mode: 'create', instruction: request.text, characters: [name] })).toMatchObject({ status: 'blocked' });
    expect(() => qqImageCommandPlan(request, { mode: 'create', instruction: request.text, characters: [name] }, options, 0)).toThrow();
  }
  expect(render).not.toHaveBeenCalled();
});

test('a multi-character query returns every directly matched identity before related outfit expansion', async () => {
  const base = { name: '岁己SUI', aliases: ['岁己'], description: '默认', referenceImage: 'public/reference_images/base.png' };
  const skins = Array.from({ length: 12 }, (_, i) => ({ ...base, name: `岁己·衣装${i}`, aliases: [`衣装${i}`], baseCharacter: base.name, skin: `衣装${i}` }));
  const cookie = { ...base, name: '饼干岁人', aliases: ['饼干人'] };
  const tools = createQQImageTools(qqRequest(inbound, at)!, { ...config, characters: [base, ...skins, cookie] }, jest.fn(), jest.fn());
  const result = await tools.tools.find(item => item.name === 'find_image_characters')!.execute({ query: '岁己、饼干岁人' });
  expect(result).toMatchObject({ limited: true });
  expect((result as { characters: Array<{ name: string }> }).characters.slice(0, 2)).toMatchObject([{ name: base.name }, { name: cookie.name }]);
});
let root: string, png: Buffer;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-agent-'));
  png = await sharp({ create: { width: 8, height: 4, channels: 4, background: '#aabbcc' } }).png().toBuffer();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test.each([6, 8, 12, 24])('multi-image planning keeps generation tools available after intent, source and character reads (%i sources)', async count => {
  const request = qqRequest({ ...inbound, content: '把这批图一起变成一个长漫，白发校服角色全部变弥月，黄发角色变岁己',
    msgElements: [{ msg_idx: 'private-reference', attachments: Array.from({ length: count }, (_, index) =>
      ({ content_type: 'image/png', url: `https://gchat.qpic.cn/private-image-${index}` })) }] }, at)!;
  request.chatContext = [{ version: 1, id: 'context', appId: '900000001', conversation: 'c'.repeat(64), user: request.user,
    text: '保留原来的文字和画风，按图片顺序排列。', createdAt: at - 1000 }];
  const sources = await Promise.all(Array.from({ length: count }, (_, index) => sharp({ create: {
    width: 480, height: 720, channels: 3, background: { r: index * 10, g: 90, b: 150 } } }).png().toBuffer()));
  const render = jest.fn(async () => ({ status: 'pending' as const, message: '图片任务已接收。' }));
  const model = jest.fn().mockResolvedValueOnce(response({ content: JSON.stringify({ relatedMessageIds: ['context'],
    relatedContext: ['按图片顺序排列'], subject: '长漫', requestedChanges: [request.text], preserve: ['文字', '画风'],
    excludedOtherSpeakerRequirements: [], needsClarification: false, clarifiedInstruction: request.text }) }))
    .mockResolvedValueOnce(call('read_image_sources', {}, 'sources'))
    .mockResolvedValueOnce(call('find_image_characters', { query: '岁己、弥月' }, 'characters'))
    .mockResolvedValueOnce(call('generate_image', { mode: 'edit', instruction: request.text, characters: [] }, 'render'))
    .mockResolvedValueOnce(final());
  const knowledge = createQQKnowledge({ questions: { enabled: true, providerConfigPath: 'unused',
    lexical: { enabled: true, directory: path.join(root, 'unused-index') }, recordingRoots: { '25788785': [root] } } },
  { runtimeConfigPath: 'unused', roomId: '25788785', collaborationRooms: [] });
  const load = jest.fn(async () => sources), traces: any[] = [];
  const tools = createQQImageTools(request, config, load, render);
  await createQQAnswerer(settings, knowledge, model as any, async (_request, trace) => { traces.push(structuredClone(trace)); }, tools)
    (request, new AbortController().signal);
  expect(render).toHaveBeenCalledTimes(1);
  await expect(load.mock.results[0].value).resolves.toHaveLength(count);
  for (const [, init] of model.mock.calls.slice(1, 4)) {
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools.some((item: any) => item.function.name === 'generate_image')).toBe(true);
  }
  expect(traces.at(-1).calls.reduce((sum: number, item: any) => sum + item.charge, 0)).toBeLessThanOrEqual(QQ_LIMITS.reservation);
});

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
  expect(model).toHaveBeenCalledTimes(count); expect(paid).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(1);
  const [url, init] = paid.mock.calls[0] as unknown as [string, any];
  expect(url).toContain('/images/edits'); expect(init.body.getBuffer().toString('latin1')).toContain(png.toString('latin1'));
  expect(init.body.getBuffer().toString()).toContain('source-1.png');
  expect(init.body.getBuffer().toString()).toContain('保留原图中全部人物的性别');
  expect(send).toHaveBeenCalledTimes(1); expect((send.mock.calls[0] as unknown as any[])[2].file).toContain('.png');
  expect(trace.mock.calls.at(-1)).toBeDefined();
  const context = JSON.stringify(model.mock.calls);
  expect(context).not.toMatch(/private-user|private-group|private-message|private-reference|private-image/u);
});

test.each(['quote', 'attachment'])('replacement via %s sends source then target bytes even when the agent omits characters', async source => {
  const character = { name: '岁己', aliases: ['岁己', '小岁'], description: '白发红瞳', referenceImage: 'public/reference_images/sui.png' };
  await fs.mkdir(path.join(root, 'public/reference_images'), { recursive: true });
  const reference = await sharp({ create: { width: 4, height: 8, channels: 4, background: '#dd5577' } }).png().toBuffer();
  await fs.writeFile(path.join(root, character.referenceImage), reference);
  const options = { ...config, characters: [character] };
  const sourceAttachment = { content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture&rkey=private-token' };
  const request = qqRequest({ ...inbound, content: '变岁己，保留黑白漫画和构图',
    msgElements: [{ msg_idx: 'private-reference', attachments: [sourceAttachment] }],
    ...(source === 'attachment' ? { msgElements: undefined, msgType: undefined,
      attachments: [sourceAttachment] } : {}) }, at)!;
  const download = jest.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
  const inputs = new QQImageInputs(root, '900000001', download as any);
  const paid = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const generate = createQQImageGenerator(root, '900000001', options, settings, paid as any, inputs);
  const render = jest.fn(async (edit) => {
    await generate(request, new AbortController().signal, edit);
    return { status: 'generated' as const, message: '图片生成完成。' };
  });
  const model = jest.fn().mockResolvedValueOnce(call('read_image_sources', {}, 'source'))
    .mockResolvedValueOnce(call('find_image_characters', { query: '岁己' }, 'target'))
    .mockResolvedValueOnce(call('generate_image', { mode: 'edit', instruction: request.text, characters: [] }, 'replace'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '图片生成完成。', basis: 'general', evidenceIds: [] }) }));
  const tools = createQQImageTools(request, options, () => inputs.load(request, new AbortController().signal), render);
  await createQQAnswerer(settings, undefined, model as any, undefined, tools)(request, new AbortController().signal);
  expect(JSON.stringify(model.mock.calls[0])).toContain('“变岁己”就是换成岁己');
  expect(paid).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledTimes(1);
  const [url, init] = paid.mock.calls[0] as unknown as [string, any];
  expect(url).toContain('/images/edits');
  const parts = init.body.getBuffer().toString('latin1').split(`--${init.body.getBoundary()}`)
    .filter((part: string) => part.includes('name="image[]"'));
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain('source-1.png'); expect(parts[0]).toContain(png.toString('latin1'));
  expect(parts[1]).toContain('character-1.png'); expect(parts[1]).toContain(reference.toString('latin1'));
  expect(init.body.getBuffer().toString()).toContain('参考图2只用于锁定岁己');
  expect(init.body.getBuffer().toString()).toContain(request.text);
});

test.each(['这效果太好', '这张图真好看', '生成的图片也太好看了', '生成得太好了', '这张图是怎么生成的？', '太好看了，别再画了'])
('a quoted image receives a text reply without offering generation for %s', async content => {
  const request = qqRequest({ ...inbound, content }, at)!;
  expect(request.imageInput?.reply).toBe('private-reference');
  const load = jest.fn(), render = jest.fn();
  const model = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    const names = body.tools.map((tool: any) => tool.function.name);
    expect(names).toContain('read_image_sources');
    expect(names).not.toContain('generate_image');
    return response({ content: JSON.stringify({ answer: '这张的效果我也挺喜欢。', basis: 'general', evidenceIds: [] }) });
  });
  await expect(createQQAnswerer(settings, undefined, model as any, undefined,
    createQQImageTools(request, config, load, render))(request, new AbortController().signal)).resolves.toBe('这张的效果我也挺喜欢。');
  expect(load).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
});

test.each(['create', 'edit'] as const)('a model-selected %s cannot charge for praise on a quoted image', async mode => {
  const request = qqRequest({ ...inbound, content: '这效果太好' }, at)!;
  expect(qqImageCommandReply(request, { mode, instruction: '照着原图再生成一张', characters: [] }, config))
    .toBe('请说明要画什么，或想对原图做哪些修改。');
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

test('unreadable sources and invented names cannot spend image budget in either mode', async () => {
  const request = qqRequest(inbound, at)!, load = jest.fn(async () => { throw new Error('private download error'); });
  const render = jest.fn<Promise<QQImageToolResult>, any[]>(async () => ({ status: 'generated', message: 'done' }));
  const tools = createQQImageTools(request, config, load, render).tools;
  const generate = tools.find(tool => tool.name === 'generate_image')!;
  expect(await generate.execute({ ...command, mode: 'create' })).toMatchObject({ status: 'blocked' });
  expect(await generate.execute({ ...command, characters: ['invented'] })).toMatchObject({ status: 'blocked' });
  expect(await generate.execute(command)).toMatchObject({ status: 'blocked', message: expect.stringContaining('没有拿到原图') });
  expect(render).not.toHaveBeenCalled();
});

test.each([
  ['加入一个饼干人作为老公', 'create'],
  ['这效果太好了，再把背景换成蓝色', 'edit']
] as const)('a clear edit to a quoted source reaches rendering as an edit: %s', async (content, mode) => {
  const request = qqRequest({ ...inbound, content }, at)!;
  const load = jest.fn(async () => [png]);
  const render = jest.fn<Promise<QQImageToolResult>, any[]>(async () => ({ status: 'generated', message: 'done' }));
  const generate = createQQImageTools(request, config, load, render).tools.find(tool => tool.name === 'generate_image')!;
  expect(await generate.execute({ mode, instruction: request.text, characters: [] }))
    .toEqual({ status: 'generated', message: 'done' });
  expect(load).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith({ mode: 'edit', instruction: request.text, characters: [] });
});

test('image tool observers receive the concrete blocked message for the QQ reply layer', async () => {
  const request = qqRequest(inbound, at)!;
  const observed: QQImageToolResult[] = [];
  const render = jest.fn<Promise<QQImageToolResult>, any[]>(async () => ({ status: 'generated', message: 'done' }));
  const tools = createQQImageTools(request, config, jest.fn(async () => [png]), render, undefined,
    result => observed.push(result)).tools;
  const generate = tools.find(tool => tool.name === 'generate_image')!;
  const result = await generate.execute({ ...command, characters: ['invented'] });
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining('角色参考名称未知或有歧义') });
  expect(observed).toEqual([result]);
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
