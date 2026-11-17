import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { QQRecentImages, QQ_RECENT_IMAGE_WINDOW_MS } from './QQRecentImages';
import { QQImageInputs } from './QQImageInputs';
import { createQQImageTools } from './QQImageTools';
import { createQQImageGenerator } from './QQImage';
import { createQQAnswerer } from './QQAgent';
import { QQInbound, QQRequest, QQ_PRIVATE_REPLY, qqDigest, qqRequest } from './QQPolicy';
import { QQImageConfig } from './QQImagePolicy';
import { QQWorker } from './QQWorker';
import { QQImageJobs } from './QQImageJobs';
import { QQImageQueueInputs } from './QQImageQueueInputs';
import { newQQState } from './QQState';

const at = Date.parse('2026-11-10T00:05:00+08:00');
const appId = '900000001';
const config: QQImageConfig = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high',
  dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: [] };
const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake-private-key' };
const signal = () => new AbortController().signal;
const message = (id: string, extra: Partial<QQInbound> = {}): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE',
  senderId: 'private-user', groupOpenid: 'private-group', content: '', messageId: id,
  timestamp: new Date(at - 1000).toISOString(), attachments: [{ content_type: 'image/png', url: `https://gchat.qpic.cn/${id}?token=private` }], ...extra });
const question = (text = '影子上的光环忘记去掉了', extra: Partial<QQInbound> = {}): QQRequest => qqRequest(message('question', {
  rawEventType: 'GROUP_AT_MESSAGE_CREATE', attachments: undefined, timestamp: new Date(at).toISOString(), content: text, ...extra
}), at)!;
const response = (message: unknown, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason }] }) });
const call = (name: string, args: unknown, id: string) => response({ tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
const final = (answer: string) => response({ content: JSON.stringify({ answer, basis: 'general', evidenceIds: [] }) });
let root: string, png: Buffer, other: Buffer;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-recent-images-'));
  png = await sharp({ create: { width: 8, height: 4, channels: 4, background: '#ff0000' } }).png().toBuffer();
  other = await sharp({ create: { width: 4, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function fixture() {
  const download = jest.fn(async (url: string) => new Response(url.includes('/older?') ? png : other, { headers: { 'content-type': 'image/png' } }));
  const inputs = new QQImageInputs(root, appId, download as any);
  const recent = new QQRecentImages(root, appId, inputs, () => at);
  return { inputs, recent, download };
}

test('ordinary authenticated image events survive restart and bind exact originals only after selection', async () => {
  const f = fixture();
  await f.recent.capture(message('older', { timestamp: new Date(at - 10 * 60000).toISOString() }));
  expect(f.download).not.toHaveBeenCalled();
  const request = question();
  const session = new QQRecentImages(root, appId, f.inputs, () => at).forRequest(request, signal());
  const found = await session.read();
  expect(found.images).toHaveLength(1);
  expect(found.images[0]).toMatchObject({ id: 'recent_1', available: true, speaker: 'current_user', imageCount: 1 });
  expect(request.imageInput).toBeUndefined();
  await session.select('recent_1');
  expect(await f.inputs.load(request, signal())).toEqual([png]);
  await session.read(); await session.select('recent_1');
  expect(f.download).toHaveBeenCalledTimes(1);
  await expect(session.select('invented')).rejects.toThrow();
});

test('group, application, future and expiry boundaries also hold across Shanghai midnight', async () => {
  const f = fixture();
  await f.recent.capture(message('older', { timestamp: new Date(at - QQ_RECENT_IMAGE_WINDOW_MS).toISOString() }));
  await f.recent.capture(message('expired', { timestamp: new Date(at - QQ_RECENT_IMAGE_WINDOW_MS - 1).toISOString() }));
  await f.recent.capture(message('future', { timestamp: new Date(at + 1).toISOString() }));
  await f.recent.capture(message('other-group', { groupOpenid: 'another-group' }));
  const read = await f.recent.forRequest(question(), signal()).read();
  expect(read.images).toHaveLength(1); expect(read.images[0].available).toBe(true);
  expect((await new QQRecentImages(root, '900000002', f.inputs, () => at).forRequest(question(), signal()).read()).images).toEqual([]);
  expect((await f.recent.forRequest({ ...question(), scope: 'c2c' }, signal()).read()).images).toEqual([]);
  expect(f.download).toHaveBeenCalledTimes(1);
});

test('arbitrary text URLs, quote-only events, wrong event types and invalid CDN URLs are never archived', async () => {
  const f = fixture();
  await f.recent.capture(message('text', { attachments: undefined, content: 'https://gchat.qpic.cn/untrusted' }));
  await f.recent.capture(message('quote', { attachments: undefined, refMsgIdx: 'old', msgElements: [{ msg_idx: 'old',
    attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/quoted' }] }] }));
  await f.recent.capture(message('private', { kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE' }));
  await f.recent.capture(message('invalid', { attachments: [{ content_type: 'image/png', url: 'http://127.0.0.1/private' }] }));
  expect((await f.recent.forRequest(question(), signal()).read()).images).toEqual([]);
  expect(f.download).not.toHaveBeenCalled();
});

test('candidate discovery is bounded, deduplicated, and cannot select unread or unavailable images', async () => {
  const f = fixture();
  for (let index = 0; index < 5; index++) await f.recent.capture(message(`image-${index}`, { timestamp: new Date(at - index * 1000).toISOString() }));
  await f.recent.capture(message('image-0', { timestamp: new Date(at).toISOString() }));
  const session = f.recent.forRequest(question(), signal());
  await expect(session.select('recent_1')).rejects.toThrow();
  const found = await session.read();
  expect(found.limited).toBe(true); expect(found.images).toHaveLength(3); expect(f.download).toHaveBeenCalledTimes(3);
  await session.select('recent_2');
  await expect(session.select('recent_1')).rejects.toThrow();
  const failedInputs = new QQImageInputs(root, appId, jest.fn(async () => { throw new Error('private failure'); }) as any);
  const failed = new QQRecentImages(root, appId, failedInputs).forRequest(question(), signal());
  expect((await failed.read()).images.every(image => !image.available && !image.preview)).toBe(true);
  await expect(failed.select('recent_1')).rejects.toThrow();
});

test('explicit source images take priority and never fall back to historical candidates', async () => {
  const request = question('这张图是什么', { attachments: message('current').attachments });
  const recent = { read: jest.fn(), select: jest.fn() }, load = jest.fn(async () => [other]);
  const tools = createQQImageTools(request, config, load, jest.fn(), undefined, undefined, recent).tools;
  expect(tools.some(tool => tool.name === 'read_recent_images')).toBe(false);
  await tools.find(tool => tool.name === 'read_image_sources')!.execute({});
  expect(recent.read).not.toHaveBeenCalled();
});

test('a late bot image pickup indexes the original job file and can be found by another member', async () => {
  const f = fixture();
  const original = question('生成星空图片');
  const file = path.join(root, 'data/runtime/qqbot/records', appId, '2026-11-09', `${original.key}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, png);
  const pickup = question('收图', { messageId: 'pickup', senderId: 'different-user' });
  await f.inputs.remember(pickup, { file, model: config.model, prompt: 'scene', sha256: qqDigest(png) }, { id: 'private-receipt' });
  await f.recent.remember(pickup, '图片生成完成。', 'private-receipt');
  const request = question();
  const session = new QQRecentImages(root, appId, new QQImageInputs(root, appId), () => at).forRequest(request, signal());
  expect((await session.read()).images[0]).toMatchObject({ available: true, speaker: 'bot' });
  await session.select('recent_1');
  expect(await new QQImageInputs(root, appId).load(request, signal())).toEqual([png]);
  expect(f.download).not.toHaveBeenCalled();
});

test('cross-group or already attached source binding is rejected before reading', async () => {
  const f = fixture(), request = question();
  await expect(f.inputs.select(request, { ...request, targetId: 'other-group', imageInput: { urls: [] } }, signal())).rejects.toThrow();
  await expect(f.inputs.select({ ...request, imageInput: { urls: [] } }, { ...request, imageInput: { urls: [] } }, signal())).rejects.toThrow();
  expect(f.download).not.toHaveBeenCalled();
});

test.each(['edit', 'queued', 'view', 'ambiguous'] as const)('unquoted %s runs the agent with actual candidate previews and preserves worker quotas', async mode => {
  const f = fixture();
  await f.recent.capture(message('older', { content: '红色原图', timestamp: new Date(at - 2000).toISOString() }));
  await f.recent.capture(message('newer', { senderId: 'another-user', content: '别人的独立蓝色图片要求' }));
  const paid = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const generate = createQQImageGenerator(root, appId, config, settings, paid as any, f.inputs);
  const model = jest.fn().mockResolvedValueOnce(call('read_recent_images', {}, 'recent'));
  if (mode !== 'ambiguous') model.mockResolvedValueOnce(call('select_recent_image', { id: 'recent_2' }, 'select'));
  const editing = mode === 'edit' || mode === 'queued';
  if (editing) model.mockResolvedValueOnce(call('generate_image', { mode: 'edit', instruction: '去掉红色原图影子上的光环，保留其他细节。', characters: [] }, 'edit'));
  model.mockResolvedValueOnce(final(mode === 'ambiguous' ? '你指红色还是蓝色那张图？' : mode === 'view' ? '红色这张图的影子确实还有光环。' : '原图修改完成。'));
  const state = newQQState(appId), send = jest.fn(async () => {});
  const queueInputs = new QQImageQueueInputs(root, appId, f.inputs);
  const jobs = new QQImageJobs(root, appId, 180000, {
    prepare: (request, command, abort) => queueInputs.prepare(request, command, abort),
    generate: async (request, abort, command, input) => generate(request, abort, command, input ? await queueInputs.load(input) : undefined),
    now: () => at, report: () => {}, fatal: async error => { throw error; } });
  await jobs.open();
  const worker = new QQWorker({ credentialsPath: 'unused', providerConfigPath: 'unused', dailyTokenBudget: 409600,
    maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY, images: config }, state, {
    now: () => at, save: async () => {}, record: async () => {}, image: generate, send, sleep: async () => {}, report: () => {},
    ...(mode === 'queued' ? { enqueueImage: (request, command) => jobs.enqueue(request, command),
      waitImage: (request, abort, waitMs) => jobs.wait(request, abort, waitMs) } : {}),
    answer: (request, abort, execute) => createQQAnswerer(settings, undefined, model as any, undefined,
      createQQImageTools(request, config, () => f.inputs.load(request, abort), execute!, undefined, undefined, f.recent.forRequest(request, abort)))(request, abort)
  });
  worker.receive(message('question', { rawEventType: 'GROUP_AT_MESSAGE_CREATE', attachments: undefined,
    timestamp: new Date(at).toISOString(), content: mode === 'view' ? '这张图的影子有什么问题' : '影子上的光环忘记去掉了' }));
  await worker.idle();
  expect(state.paused).toBe(false); expect(send).toHaveBeenCalledTimes(1);
  await jobs.idle(); await jobs.close();
  expect(paid).toHaveBeenCalledTimes(editing ? 1 : 0);
  expect(state.images || 0).toBe(editing ? 1 : 0);
  expect(f.download).toHaveBeenCalledTimes(2);
  const bodies = model.mock.calls.map(args => JSON.parse((args as unknown as [string, any])[1].body));
  const previews = (body: any) => body.messages.flatMap((msg: any) => Array.isArray(msg.content) ? msg.content : []).filter((part: any) => part.type === 'image_url');
  expect(previews(bodies[0])).toHaveLength(0); expect(previews(bodies[1])).toHaveLength(1);
  const overview = Buffer.from(previews(bodies[1])[0].image_url.url.split(',')[1], 'base64');
  expect(await sharp(overview).metadata()).toMatchObject({ width: 1024, height: 672 });
  // Candidate 1 remains blue and candidate 2 red in the numbered overview.
  for (const [index, channel] of [2, 0].entries()) {
    const pixel = await sharp(overview).extract({ left: index * 512 + 256, top: 352, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[channel]).toBeGreaterThan(240);
    expect(pixel[2 - channel]).toBeLessThan(10);
  }
  expect(JSON.stringify(bodies)).not.toMatch(/private-group|private-user|gchat.qpic|token=private/u);
  if (mode !== 'ambiguous') expect(previews(bodies[2])).toHaveLength(1);
  if (editing) {
    const [endpoint, init] = paid.mock.calls[0] as unknown as [string, any];
    expect(endpoint).toContain('/images/edits');
    expect(init.body.getBuffer().includes(png)).toBe(true); expect(init.body.getBuffer().includes(other)).toBe(false);
  }
});
