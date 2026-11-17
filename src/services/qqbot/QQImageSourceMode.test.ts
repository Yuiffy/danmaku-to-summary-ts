import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { createQQImageGenerator } from './QQImage';
import { QQImageConfig, qqImageCommandPlan, QQ_IMAGE_SOURCE_REPLY } from './QQImagePolicy';
import { createQQImageTools } from './QQImageTools';
import { QQImageInputs } from './QQImageInputs';
import { QQImageQueueInputs } from './QQImageQueueInputs';
import { qqRequest } from './QQPolicy';

const config: QQImageConfig = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high',
  dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: [] };
const settings = { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'test-key' };
const at = Date.parse('2026-11-17T20:00:00+08:00');
const request = (text: string) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member', groupOpenid: 'group', messageId: 'message', timestamp: new Date(at).toISOString(),
  content: text, attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/source' }] }, at)!;
let root: string, png: Buffer;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-source-mode-'));
  png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#aabbcc' } }).png().toBuffer();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test.each([
  '模仿这张参考图的风格，做一张岁己的，让岁己的某个部位也出框',
  '帮我生成人物的服装设计稿，优化细节',
  '生成cos图，要求人物唯美，符合3次元人物特征',
  '让栞栞咬岁己的人类耳朵，不要生成猫耳'
])('source-backed creation reaches the provider with the original bytes: %s', async text => {
  const original = request(text), command = { mode: 'create' as const, instruction: text, characters: [] };
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const inputs = { loadForGeneration: jest.fn(async () => [png]) } as unknown as QQImageInputs;
  const generate = createQQImageGenerator(root, '900000001', config, settings, transport as any, inputs);
  const render = jest.fn(async selected => {
    await generate(original, new AbortController().signal, selected);
    return { status: 'generated' as const, message: 'done' };
  });
  const tool = createQQImageTools(original, config, async () => [png], render).tools.find(item => item.name === 'generate_image')!;
  expect(await tool.execute(command)).toMatchObject({ status: 'generated' });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0] as unknown as [string, { body: { getBuffer(): Buffer } }];
  expect(url).toContain('/images/edits');
  expect(init.body.getBuffer().includes(png)).toBe(true);
  expect(init.body.getBuffer().toString()).toContain(text);
});

test.each(['create', 'edit'] as const)('%s cannot spend when a bound source loads no images', async mode => {
  const original = request('画一张星空图'), command = { mode, instruction: original.text, characters: [] };
  const render = jest.fn();
  const tool = createQQImageTools(original, config, async () => [], render).tools.find(item => item.name === 'generate_image')!;
  expect(await tool.execute(command)).toMatchObject({ status: 'blocked', message: QQ_IMAGE_SOURCE_REPLY });
  expect(render).not.toHaveBeenCalled();
  const transport = jest.fn();
  const generate = createQQImageGenerator(root, '900000001', config, settings, transport);
  await expect(generate(original, new AbortController().signal, command, [])).rejects.toMatchObject({ diagnostic: { stage: 'image_prepare' } });
  expect(transport).not.toHaveBeenCalled();
  expect(() => qqImageCommandPlan(original, command, config, 0)).toThrow();
});

test('reference creation survives queue freezing and restart with its original source', async () => {
  const original = request('模仿这张参考图的风格，做一张岁己的');
  const command = { mode: 'create' as const, instruction: original.text, characters: [] };
  const inputs = { loadForGeneration: jest.fn(async () => [png]) } as unknown as QQImageInputs;
  const queue = new QQImageQueueInputs(root, '900000001', inputs, config);
  const frozen = JSON.parse(JSON.stringify(await queue.prepare(original, command, new AbortController().signal)));
  const download = jest.fn(async () => { throw new Error('expired'); });
  const restarted = new QQImageQueueInputs(root, '900000001', { loadForGeneration: download } as unknown as QQImageInputs, config);
  const sources = await restarted.load(frozen);
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const generate = createQQImageGenerator(root, '900000001', config, settings, transport as any);
  const result = await generate(frozen.request, new AbortController().signal, frozen.command, sources);
  expect(result.prompt).toContain('附图只用于参考构图');
  expect(sources).toEqual([png]);
  expect(download).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(1);
});
