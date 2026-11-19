import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { qqRequest, publishableQQAnswer, publishableQQVideoReview } from './QQPolicy';
import type { QQImageCharacter } from './QQImagePolicy';
import { qqVideoPlan, qqVideoRequested, qqVideoStandaloneEdit, QQVideoCommand, QQVideoConfig } from './QQVideoPolicy';
import { qqVideoSelection, qqVideoSpans } from './QQVideoCutPolicy';
import { QQVideoQueue, QQVideoQueueReply, qqCanvasAccount, qqVideoProcess } from './QQVideoQueue';
import { createQQVideoTools, mergeQQMediaTools } from './QQVideoTools';
import { createQQAnswerer } from './QQAgent';
import { qqFailure } from './QQDiagnostics';
import { createQQImageTools } from './QQImageTools';

const at = Date.parse('2026-11-15T01:00:00Z'), signal = () => new AbortController().signal;
const config: QQVideoConfig = { enabled: true, queuePath: 'queue.json', voices: [{ name: '岁己', aliases: ['岁己', '小岁'], audio: 'voice.mp3' }] };
const base: QQImageCharacter = { name: '岁己SUI', aliases: ['岁己'], referenceImage: 'public/reference_images/base.png', description: '基础形象' };
const jk: QQImageCharacter = { name: '岁己·JK', aliases: ['单马尾无外套JK', 'JK岁己'], referenceImage: 'public/reference_images/jk.png', description: '单马尾，无外套JK', baseCharacter: base.name, skin: 'JK' };
const command: QQVideoCommand = { instruction: '缓慢转身，固定镜头。', characters: [], voices: [], model: null, ratio: null, duration: null };
const request = (text: string, id = 'message', attachments = false) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'member', groupOpenid: 'group',
  messageId: id, timestamp: new Date(at).toISOString(), content: text, ...(attachments ? { attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/test' }] } : {}) }, at)!;

test.each(['怎么生成视频？', '例如生成岁己的视频', '不要生成视频', '生成视频可以吗？', '确认生成视频'])('does not admit help, examples, negation or confirmation as a new request: %s', text => {
  expect(qqVideoRequested(text)).toBe(false);
});
test('video policy applies defaults, explicit model/ratio/duration and shared outfit replacement', () => {
  expect(qqVideoPlan('生成JK岁己转身的视频', { ...command, characters: [base.name] }, [base, jk])).toEqual({
    model: 'seedance2.0fast_vip', ratio: '9:16', duration: 15, references: [jk] });
  expect(qqVideoPlan('直接生成单马尾无外套JK的视频，mini 横屏16:9 10秒', command, [base, jk])).toMatchObject({ model: 'seedance2.0mini', ratio: '16:9', duration: 10, references: [jk] });
  for (const setting of ['seedance2.5', '1080P', '30秒', '2:1']) expect(() => qqVideoPlan(`生成岁己视频 ${setting}`, command, [base])).toThrow();
});

test('cut times are separate from generation settings and local edit does not authorize generation', () => {
  const text = '截取00:18到00:26作为参考，再生成岁己散步的视频，横屏16:9，10秒';
  expect(qqVideoStandaloneEdit(text, true)).toBe(false);
  expect(qqVideoPlan(text, command, [base], true)).toMatchObject({ ratio: '16:9', duration: 10 });
  expect(qqVideoPlan('截取5到12秒作为参考，生成岁己视频', command, [base], true)).toMatchObject({ duration: 15 });
  expect(qqVideoSelection('用这段视频的第18秒到第24秒作参考，再生成岁己视频').selection)
    .toEqual({ kind: 'keep', spans: [{ startMs: 18000, endMs: 24000 }] });
  for (const edit of ['剪辑这个视频，保留前8秒', '保留00:02-00:06和00:18-00:24，拼起来发我', '删掉5-12秒']) {
    expect(qqVideoStandaloneEdit(edit, true)).toBe(true);
    expect(qqVideoRequested(edit)).toBe(false);
  }
  expect(qqVideoStandaloneEdit('怎么剪辑这个视频？', true)).toBe(false);
  expect(qqVideoStandaloneEdit('别截取5到10秒', true)).toBe(false);
  const removal = qqVideoSelection('删掉15-20秒和2-5秒').selection!;
  expect(qqVideoSpans(removal, 23000)).toEqual([{ startMs: 0, endMs: 2000 },
    { startMs: 5000, endMs: 15000 }, { startMs: 20000, endMs: 23000 }]);
  expect(() => qqVideoSpans(removal, 18000)).toThrow('原视频长18秒');
});

test('draft binds the rendered clip and shows selected source ranges in a sendable review', async () => {
  const { queue, io } = fixture();
  const req = request('截取00:18到00:26作为参考，再生成岁己散步的视频，10秒');
  req.videoInput = { urls: ['https://multimedia.nt.qq.com.cn/video'] };
  const cut = { file: path.join(root, 'cut.mp4'), durationMs: 8000, cut: '18–26秒' };
  io.loadVideos.mockResolvedValue([cut]);
  const result = await queue.enqueue(req, command, signal());
  expect(result.status).toBe('draft');
  expect(result.message).toContain('取原片18–26秒');
  expect(publishableQQVideoReview(result.message)).toBe(result.message);
  expect(io.bridge.mock.calls.at(-1)![0]).toMatchObject({ videos: [cut.file], videoDurationsMs: [8000], duration: 10 });
});

test('video catalogue names and registered aliases resolve to the same reference without duplicates', () => {
  for (const name of ['岁己', '岁己SUI', ' 岁己sui ', '岁己ＳＵＩ']) {
    expect(qqVideoPlan('生成岁己转身的视频', { ...command, characters: [name, base.name] }, [base, jk]).references).toEqual([base]);
  }
  expect(qqVideoPlan('生成JK岁己转身的视频', { ...command, characters: ['岁己', 'JK岁己'] }, [base, jk]).references).toEqual([jk]);
});

test('video selection rejects unknown, partial and ambiguous aliases instead of guessing a reference', () => {
  const other = { ...jk, name: '另一角色', aliases: ['岁己', '共同别名'], baseCharacter: undefined, skin: undefined };
  const shared = { ...base, aliases: [...base.aliases, '共同别名'] };
  for (const name of ['未收录角色', '岁', '共同别名']) {
    expect(() => qqVideoPlan('生成转身的视频', { ...command, characters: [name] }, [shared, other])).toThrow();
  }
  expect(qqVideoPlan('生成转身的视频', { ...command, characters: [base.name] }, [shared, other]).references).toEqual([shared]);
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-video-'));
  await fs.mkdir(path.join(root, 'public/reference_images'), { recursive: true });
  for (const character of [base, jk]) await fs.writeFile(path.join(root, character.referenceImage), 'reference');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture() {
  const bridge = jest.fn<Promise<QQVideoQueueReply>, [any, AbortSignal]>(async payload => payload.action === 'lookup' ? { status: 'missing' } : { status: payload.direct ? 'pending' : 'draft', draft: payload.draft });
  const io = { bridge, account: jest.fn(async () => ({ ok: true, data: { userId: '123' } })), load: jest.fn(async () => [Buffer.from('one'), Buffer.from('two')]),
    loadVideos: jest.fn(async () => [{ file: path.join(root, 'source.mp4'), durationMs: 3000 }]) };
  const queue = new QQVideoQueue(root, '900000001', { ...config, queuePath: path.join(root, 'queue.json') }, [base, jk], io);
  return { queue, io };
}

test('default preview contains every attachment/outfit/voice and exact prompt without paid account IO', async () => {
  const { queue, io } = fixture();
  const delivery = await queue.enqueue(request('生成单马尾无外套JK视频，用岁己的声线', 'draft', true), command, signal());
  expect(delivery.status).toBe('draft');
  const payload = io.bridge.mock.calls.at(-1)![0];
  expect(payload.images).toHaveLength(3); expect(payload.audio).toHaveLength(1); expect(payload.direct).toBe(false);
  expect(payload.images.at(-1)).toBe(path.join(root, jk.referenceImage));
  expect(payload.prompt).toContain('@Image 3'); expect(payload.prompt).toContain('@Audio 1');
  expect(payload.draft.materials).toEqual(['图片1：用户附图1', '图片2：用户附图2', '图片3：岁己·JK', '音频1：岁己声线']);
  expect(delivery.message).toContain(payload.prompt);
  expect(delivery.message).toContain('确认生成视频'); expect(delivery.message).not.toContain(root);
  expect(publishableQQVideoReview(delivery.message)).toBe(delivery.message);
  expect(publishableQQAnswer(delivery.message)).toBeUndefined();
  expect(io.account).not.toHaveBeenCalled();
});

test('multi-character video without attachments binds built-in references and saves canonical draft names', async () => {
  const others: QQImageCharacter[] = [
    { name: '栞栞', alias: '栞栞' }, { name: '弥月Mizuki', alias: '弥月' },
    { name: '犬绒Mofu', alias: '犬绒' }, { name: '米汀', alias: '米汀' }
  ].map(({ name, alias }, index) => ({ name, aliases: [alias], referenceImage: `public/reference_images/character-${index}.png`, description: '角色外观参考' }));
  for (const character of others) await fs.writeFile(path.join(root, character.referenceImage), 'reference');
  const characters = [base, ...others], { io } = fixture();
  const queue = new QQVideoQueue(root, '900000001', config, characters, io);
  const req = request('生成岁己栞栞弥月犬绒米汀在LOL比赛中夺冠,把耳机取下来后站起来庆祝的视频');
  expect(req.imageInput).toBeUndefined();
  const delivery = await queue.enqueue(req, { ...command, characters: ['岁己', '栞栞', '弥月', '犬绒', '米汀'] }, signal());
  expect(delivery.status).toBe('draft');
  const payload = io.bridge.mock.calls.at(-1)![0];
  expect(payload.images).toEqual(characters.map(character => path.join(root, character.referenceImage)));
  expect(payload.draft.command.characters).toEqual(characters.map(character => character.name));
  expect(payload.draft.sourceCount).toBe(0);
  for (const [index, character] of characters.entries()) {
    expect(payload.prompt).toContain(`@Image ${index + 1} 是${character.name}的外观参考`);
    expect(delivery.message).toContain(`图片${index + 1}：${character.name}`);
  }
  expect(io.load).not.toHaveBeenCalled(); expect(io.account).not.toHaveBeenCalled();
});
test('direct generation authenticates Canvas and admits text-only t2v', async () => {
  const { queue, io } = fixture();
  expect((await queue.enqueue(request('直接生成雨落池塘的视频，mini 8秒'), command, signal())).status).toBe('pending');
  const payload = io.bridge.mock.calls.at(-1)![0];
  expect(payload).toMatchObject({ images: [], audio: [], direct: true, duration: 8, model: 'seedance2.0mini' });
  expect(io.account).toHaveBeenCalledTimes(1);
});

test('server-bound operator limits reach both direct admission and approval; refused drafts remain unsubmitted', async () => {
  const { io } = fixture(), req = request('直接生成雨落池塘的视频');
  const queue = new QQVideoQueue(root, '900000001', config, [base, jk], io, { mediaOperators: [req.user] });
  await queue.enqueue(req, command, signal());
  expect(io.bridge.mock.calls.at(-1)![0].admission).toEqual({ dailyLimit: 300, userDailyLimit: 150,
    userWindowLimit: 50, intervalSeconds: 10, maxActive: 4, independentInterval: true });
  io.bridge.mockResolvedValueOnce({ status: 'limited', limitReason: 'interval', retryAt: at + 60000 });
  const result = await queue.approve(request('确认生成视频'), signal());
  expect(io.bridge.mock.calls.at(-1)![0].admission.maxActive).toBe(4);
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining('全局视频启动间隔') });
  expect(result.message).toContain('本次未提交生成');
});
test('quoted video becomes a video reference with the named character, without loading it as an image', async () => {
  const { queue, io } = fixture();
  const req = qqRequest({kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',senderId:'member',groupOpenid:'group',
    messageId:'video-quote', timestamp:new Date(at).toISOString(),content:'直接生成ai视频变岁己',msgType:103,refMsgIdx:'quote',
    msgElements:[{msg_idx:'quote',attachments:[{content_type:'video/mp4',url:'https://multimedia.nt.qq.com.cn/video'}]}]},at)!;
  expect(req.imageInput).toBeUndefined(); expect(req.videoInput?.urls).toHaveLength(1);
  expect((await queue.enqueue(req,command,signal())).status).toBe('pending');
  const payload = io.bridge.mock.calls.at(-1)![0];
  expect(payload.videos).toEqual([path.join(root,'source.mp4')]);
  expect(payload.images).toEqual([path.join(root,base.referenceImage)]);
  expect(payload.videoDurationsMs).toEqual([3000]);
  expect(payload.prompt).toContain('@Video 1'); expect(payload.prompt).toContain('@Image 1');
  expect(payload.draft.materials).toContain('视频1：用户参考视频（3秒）');
  expect(io.load).not.toHaveBeenCalled(); expect(io.loadVideos).toHaveBeenCalledTimes(1);
});

test('quoted-video availability reaches the agent before tools and survives an accidental image read', async () => {
  const { queue, io } = fixture(), observed = jest.fn(), imageLoad = jest.fn(), render = jest.fn();
  const req = request('直接生成ai视频，用岁己形象代替原视频角色来演这个视频。');
  req.videoInput = { urls: ['https://multimedia.nt.qq.com.cn/download?private-token'] };
  const tools = mergeQQMediaTools(req, createQQImageTools(req, { characters: [base] } as any, imageLoad, render),
    createQQVideoTools(req, config, queue, signal(), observed))!;
  const reply = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
  const call = (name: string, args: unknown) => reply({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  const model = jest.fn().mockResolvedValueOnce(call('read_image_sources', {}))
    .mockResolvedValueOnce(call('read_video_sources', {}))
    .mockResolvedValueOnce(call('generate_video', { ...command, instruction: req.text, characters: ['岁己'] }))
    .mockResolvedValueOnce(reply({ content: JSON.stringify({ answer: '视频已进入队列。', basis: 'general', evidenceIds: [] }) }));
  await createQQAnswerer({ url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'fake-test-key' }, undefined,
    model as any, undefined, tools)(req, signal());
  const initial = JSON.stringify(JSON.parse(model.mock.calls[0][1].body));
  expect(initial).toContain('本条消息已携带或引用1段视频');
  const imageRead = JSON.parse(model.mock.calls[1][1].body).messages.find((item: any) => item.role === 'tool');
  expect(JSON.parse(imageRead.content).untrustedEvidence).toMatchObject({ available: false, videoAvailable: true, videoSourceCount: 1 });
  const videoRead = JSON.parse(model.mock.calls[2][1].body).messages.filter((item: any) => item.role === 'tool').at(-1);
  expect(JSON.parse(videoRead.content).untrustedEvidence).toMatchObject({ available: true, sourceCount: 1, verified: false });
  expect(JSON.stringify(model.mock.calls)).not.toContain('private-token');
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  expect(io.loadVideos).toHaveBeenCalledTimes(1); expect(imageLoad).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  expect(io.bridge.mock.calls.at(-1)![0].videos).toEqual([path.join(root, 'source.mp4')]);
  expect(io.bridge.mock.calls.at(-1)![0].prompt).toContain('@Video 1');
});

test.each([undefined, { urls: [], invalid: true }, { urls: ['https://gchat.qpic.cn/video'], invalid: true }])(
  'video source discovery reports absent or invalid bindings without paid or queue IO: %j', async videoInput => {
    const { queue, io } = fixture(), req = request('生成岁己视频'); req.videoInput = videoInput;
    const tools = createQQVideoTools(req, config, queue, signal(), jest.fn());
    const result = await tools.tools.find(tool => tool.name === 'read_video_sources')!.execute({});
    expect(result).toMatchObject({ available: false, verified: false });
    expect(io.bridge).not.toHaveBeenCalled(); expect(io.loadVideos).not.toHaveBeenCalled(); expect(io.account).not.toHaveBeenCalled();
  });
test('failed video source cannot degrade to character-only generation and draft edits retain video references', async () => {
  const { queue,io }=fixture(), req=request('直接生成岁己视频');
  req.videoInput={urls:['https://gchat.qpic.cn/video']};
  io.loadVideos.mockRejectedValueOnce(new Error('private source error'));
  expect((await queue.enqueue(req,command,signal())).message).toContain('参考视频');
  expect(io.bridge.mock.calls.map(([payload])=>payload.action)).toEqual(['lookup']);
  await queue.enqueue(request('生成岁己视频'),command,signal());
  const draft=io.bridge.mock.calls.at(-1)![0].draft;
  io.bridge.mockImplementation(async payload=>payload.action==='lookup'?{status:'missing'}:payload.action==='draft'?{
    status:'draft',draft,images:[],videos:[{file:path.join(root,'source.mp4'),durationMs:3000}]}:{status:'draft',draft:payload.draft});
  const result=await queue.enqueue(request('修改视频：横屏'),command,signal());
  expect(result.status).toBe('draft');
  expect(io.bridge.mock.calls.at(-1)![0].videos).toEqual([path.join(root,'source.mp4')]);
});
test('exact request replay avoids reading attachments or account again', async () => {
  const { queue, io } = fixture(); io.bridge.mockResolvedValue({ status: 'pending' });
  expect((await queue.enqueue(request('直接生成岁己视频'), command, signal())).status).toBe('pending');
  expect(io.bridge).toHaveBeenCalledTimes(1); expect(io.load).not.toHaveBeenCalled(); expect(io.account).not.toHaveBeenCalled();
});
test.each(['image_unavailable', 'image_bytes', 'image_size'] as const)('source failure %s asks for a fresh image without claiming a queued video', async code => {
  const { queue, io } = fixture(), observed = jest.fn();
  io.load.mockRejectedValue(qqFailure('image_prepare', code));
  const req = request('直接生成ai视频变岁己', 'missing-quoted-source');
  req.imageInput = { reply: 'quoted-message', urls: [] };
  const tools = createQQVideoTools(req, config, queue, signal(), observed);
  const result = await tools.tools.find(tool => tool.name === 'generate_video')!.execute(command);
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining('原图') });
  expect(result.message).toContain('未提交');
  expect(result.message).not.toContain('查询视频进度');
  expect(observed).toHaveBeenCalledWith(result);
  expect(io.bridge.mock.calls.map(([payload]) => payload.action)).toEqual(['lookup']);
  await expect(fs.stat(path.join(root, 'data/runtime/qqbot/video-inputs'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('source cancellation still propagates and a real bridge failure retains the queue error', async () => {
  const { queue, io } = fixture(), abort = new AbortController();
  io.load.mockImplementation(async () => { abort.abort(new Error('cancelled')); throw new Error('download failed'); });
  await expect(queue.enqueue(request('直接生成岁己视频', 'abort', true), command, abort.signal)).rejects.toThrow('cancelled');
  io.bridge.mockRejectedValue(new Error('private bridge error'));
  const tools = createQQVideoTools(request('直接生成岁己视频'), config, queue, signal(), jest.fn());
  expect(await tools.tools.find(tool => tool.name === 'generate_video')!.execute(command)).toMatchObject({ status: 'failed', message: expect.stringContaining('视频队列暂时不可用') });
});
test('real JSON-stdin Python bridge persists the same reviewed task through confirmation without invoking a provider', async () => {
  const queueFile = path.join(root, 'queue.json'); await fs.writeFile(queueFile, JSON.stringify({ tasks: [] }));
  const queue = new QQVideoQueue(root, '900000001', { ...config, queuePath: queueFile }, [base, jk], {
    bridge: async (payload, abort) => await qqVideoProcess('python', [path.resolve(__dirname, '../../../scripts/seedance_qq_bridge.py'), '--queue', queueFile], abort, payload) as QQVideoQueueReply,
    account: async () => ({ ok: true, data: { userId: '123' } }), load: async () => [] });
  const draft = await queue.enqueue(request('生成JK岁己转身的视频', 'cross-language-draft'), command, signal());
  expect(draft.status).toBe('draft'); expect(draft.message).toContain('岁己·JK');
  expect(await queue.readDraft(request('修改视频：8秒'), signal())).toMatchObject({ status: 'draft', materials: ['图片1：岁己·JK'] });
  const before = JSON.parse(await fs.readFile(queueFile, 'utf8')).tasks[0];
  expect(before.status).toBe('draft'); expect(before.backend).toBe('dreamina-canvas');
  expect((await queue.approve(request('确认生成视频', 'cross-language-confirm'), signal())).status).toBe('pending');
  const after = JSON.parse(await fs.readFile(queueFile, 'utf8')).tasks;
  expect(after).toHaveLength(1); expect(after[0].status).toBe('pending'); expect(after[0].canvas).toEqual(before.canvas);
});
test('confirmation cannot be supplied by model arguments or an unrelated message', async () => {
  const { queue, io } = fixture();
  await queue.approve(request('你好'), signal());
  await queue.confirm(request('确认视频90积分，顺便再生成一个'), signal());
  expect(io.bridge).not.toHaveBeenCalled();
  io.bridge.mockResolvedValue({ status: 'pending' });
  await queue.approve(request('确认生成视频'), signal());
  expect(io.bridge.mock.calls.at(-1)![0].action).toBe('approve');
  await queue.confirm(request('确认视频90积分'), signal());
  expect(io.bridge.mock.calls.at(-1)![0]).toMatchObject({ action: 'confirm', credits: 90 });
});
test('draft edits inherit user attachments and unchanged settings, then preview again', async () => {
  const { queue, io } = fixture();
  await queue.enqueue(request('生成JK岁己转身的视频，mini 8秒', 'first', true), command, signal());
  const original = io.bridge.mock.calls.at(-1)![0];
  io.bridge.mockImplementation(async payload => payload.action === 'lookup' ? { status: 'missing' } : payload.action === 'draft' ? { status: 'draft', draft: original.draft, images: original.images.slice(0, 2) } : { status: 'draft', draft: payload.draft });
  const result = await queue.enqueue(request('修改视频：改成10秒横屏', 'edit'), { ...command, instruction: '岁己缓慢转身，固定镜头，横屏10秒。' }, signal());
  const edited = io.bridge.mock.calls.at(-1)![0];
  expect(edited).toMatchObject({ duration: 10, ratio: '16:9', model: 'seedance2.0mini', direct: false });
  expect(edited.images).toEqual(original.images); expect(result.status).toBe('draft');
  expect(result.message).toContain('本次修改优先');
});
test('unknown voices and silent model voice additions cannot enqueue', async () => {
  const { queue, io } = fixture();
  expect((await queue.enqueue(request('生成岁己视频，用未收录人物的声线'), { ...command, voices: ['未收录'] }, signal())).status).toBe('blocked');
  expect((await queue.enqueue(request('生成岁己视频'), { ...command, voices: ['岁己'] }, signal())).status).toBe('blocked');
  expect(io.bridge.mock.calls.every(([payload]) => payload.action === 'lookup')).toBe(true);
});
test('account failure and empty credit wallet produce distinct truthful replies', async () => {
  const { queue, io } = fixture();
  expect(qqCanvasAccount({ total_credit: 0, user_id: 0 })).toBe(false);
  io.account.mockResolvedValue({ ok: false, data: { userId: '' } });
  expect((await queue.enqueue(request('直接生成岁己视频'), command, signal())).message).toContain('登录状态');
  io.bridge.mockResolvedValue({ status: 'paused', failureCode: 'insufficient_credits' });
  expect((await queue.collect(request('领取视频'), signal())).message).toContain('没积分了');
  io.bridge.mockResolvedValue({ status: 'paused', failureCode: 'confirmation_required', requiredCredits: 90 });
  expect((await queue.collect(request('领取视频'), signal())).message).toContain('无需回复积分确认');
});

test('pickup distinguishes invalid task parameters from provider availability', async () => {
  const { queue, io } = fixture();
  io.bridge.mockResolvedValue({ status: 'paused', failureCode: 'invalid_request' });
  expect((await queue.collect(request('领取视频'), signal())).message).toContain('参数未通过校验');
  io.bridge.mockResolvedValue({ status: 'paused', failureCode: 'provider_unavailable' });
  expect((await queue.collect(request('领取视频'), signal())).message).toContain('生成服务暂时不可用');
  expect(io.account).not.toHaveBeenCalled();
});
test('collection returns only a registered MP4 within the scoped result directory', async () => {
  const { queue, io } = fixture(), taskId = `qq_900000001_${'a'.repeat(64)}`;
  const directory = path.join(root, 'qq-results', taskId), file = path.join(directory, 'video.mp4');
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(file, Buffer.from('0000ftypisom0000'));
  io.bridge.mockResolvedValue({ status: 'completed', taskId, file });
  expect((await queue.collect(request('领取视频'), signal())).video?.file).toBe(file);
  io.bridge.mockResolvedValue({ status: 'completed', taskId, file: path.join(root, 'public/reference_images/base.png') });
  await expect(queue.collect(request('领取视频'), signal())).rejects.toThrow();
});
test('only trusted video previews may exceed the short answer limit; private paths are always rejected', () => {
  expect(publishableQQVideoReview('视频草稿\nprompt：' + '风吹树叶。'.repeat(100))).toBeDefined();
  expect(publishableQQVideoReview('视频草稿\nD:/private/secret')).toBeUndefined();
  expect(publishableQQVideoReview('视频草稿 @everyone')).toBeUndefined();
});
test('Luna organizes video in the existing tool loop, invokes once, and never runs image generation', async () => {
  const { queue, io } = fixture(), req = request('生成JK岁己视频'), observed = jest.fn();
  const videoTools = createQQVideoTools(req, config, queue, signal(), observed);
  const imageGenerate = jest.fn(), tools = mergeQQMediaTools(req, { instructions: '', tools: [{ name: 'generate_image', description: 'image', parameters: {}, execute: imageGenerate }] }, videoTools)!;
  expect(tools.tools.some(tool => tool.name === 'generate_image')).toBe(false);
  const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }], usage: { total_tokens: 100 } }) });
  const transport = jest.fn().mockResolvedValueOnce(response({ tool_calls: [{ id: 'video', type: 'function', function: { name: 'generate_video', arguments: JSON.stringify({ ...command, characters: ['JK岁己'] }) } }] }, 'tool_calls'))
    .mockResolvedValueOnce(response({ content: JSON.stringify({ answer: '请检查视频草稿。', basis: 'general', evidenceIds: [] }) }));
  await expect(createQQAnswerer({ url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'fake-test-key' }, undefined, transport as any, undefined, tools)(req, signal())).resolves.toBe('请检查视频草稿。');
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  expect(io.bridge.mock.calls.filter(([payload]) => payload.action === 'enqueue')).toHaveLength(1);
  expect(io.bridge.mock.calls.at(-1)![0].draft.command.characters).toEqual([jk.name]);
  expect(transport).toHaveBeenCalledTimes(2); expect(imageGenerate).not.toHaveBeenCalled();
  await tools.tools.find(tool => tool.name === 'generate_video')!.execute(command);
  expect(io.bridge.mock.calls.filter(([payload]) => payload.action === 'enqueue')).toHaveLength(1);
});
