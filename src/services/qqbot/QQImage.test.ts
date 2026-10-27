import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { createQQImageGenerator } from './QQImage';
import { QQImageConfig, qqImagePlan, qqImageRequested } from './QQImagePolicy';
import { qqImageCharacters } from './QQImageCatalog';
import { qqDigest, qqRequest } from './QQPolicy';
import { QQRecords } from './QQRecords';
import { AdminQQRecords } from '../admin/AdminQQRecords';

let root: string;
const options: QQImageConfig = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high', dailyLimit: 20, userDailyLimit: 3, timeoutMs: 180000,
  characters: [{ name: '岁己', aliases: ['岁己', '小岁', 'sui'], description: '白发红瞳', referenceImage: 'public/reference_images/sui.png' },
    { name: '栞栞', aliases: ['栞栞', '小栞'], description: '黄色头发', referenceImage: 'public/reference_images/shiori.png' }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-')); fs.mkdirSync(path.join(root, 'public/reference_images'), { recursive: true }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const request = (text: string) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'member', groupOpenid: 'group',
  messageId: 'message', content: text, timestamp: '2026-10-28T02:00:00Z' }, Date.parse('2026-10-28T02:00:00Z'))!;

test('accepts common drawing requests without treating ordinary chat as image creation', () => {
  for (const text of ['画一个星汐', '给我画小岁', '画张七海', '生成三理穿宇航服的图片']) expect(qqImageRequested(text)).toBe(true);
  for (const text of ['今天聊什么', '三理昨天画画了吗']) expect(qqImageRequested(text)).toBe(false);
});
test('combines matched character references with user scene, without matching English substrings', () => {
  const plan = qqImagePlan(request('生成小岁和小栞一起吃冰淇淋的图片'), options);
  expect(plan.references).toEqual(options.characters!.map(item => item.referenceImage));
  expect(plan.prompt).toContain('一起吃冰淇淋'); expect(plan.prompt).toContain('白发红瞳'); expect(plan.prompt).toContain('黄色头发');
  expect(qqImagePlan(request('生成 a red suit 的图片'), options).references).toEqual([]);
});
test('catalogue includes registry aliases and named references outside the registry', () => {
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ ai: { streamerRegistry: {
    seki: { displayName: '星汐Seki', aliases: ['七宝'], referenceImages: ['public/reference_images/seki.png'], characterDescription: '绿色头发' }
  }, roomSettings: {
    '123': { anchorName: '礼墨Sumi', characterDescription: '礼墨Sumi（东方龙少女）', referenceImage: 'public/reference_images/sumi_standing.png' },
    '456': { anchorName: '星汐', characterDescription: '星汐Seki（绿色头发）', referenceImage: 'public/reference_images/seki.png' }
  } } }));
  fs.writeFileSync(path.join(root, 'public/reference_images/seki.png'), 'reference');
  fs.writeFileSync(path.join(root, 'public/reference_images/七海手办.png'), 'reference');
  fs.writeFileSync(path.join(root, 'public/reference_images/sumi_standing.png'), 'reference');
  const characters = qqImageCharacters(root, { ...options, registryConfigPath: 'registry.json', characters: undefined });
  expect(qqImagePlan(request('生成七宝和七海一起跳舞的图片'), { ...options, characters }).references).toHaveLength(2);
  expect(qqImagePlan(request('生成星汐和礼墨一起跳舞的图片'), { ...options, characters }).references).toEqual([
    'public/reference_images/seki.png', 'public/reference_images/sumi_standing.png'
  ]);
});
test('sends real multipart reference bytes to dedicated provider once and archives viewable PNG', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#aaccee' } }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'public/reference_images/sui.png'), png);
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 }));
  const message = request('生成岁己在月球上看星星的图片');
  const result = await createQQImageGenerator(root, '900000001', options, { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake-qq-key' }, transport as any)(message, new AbortController().signal);
  const [endpoint, init] = transport.mock.calls[0] as unknown as [string, any];
  expect(endpoint).toBe('http://127.0.0.1:8080/v1/images/edits');
  expect(init.headers.Authorization).toBe('Bearer fake-qq-key'); expect(init.body.getBuffer().toString()).toContain('name="image[]"');
  expect(init.body.getBuffer().toString()).toContain('Content-Type: image/png'); expect(transport).toHaveBeenCalledTimes(1);
  expect(qqDigest(fs.readFileSync(result.file))).toBe(result.sha256);
  await new QQRecords(root, '900000001').write(message, { status: 'sent', model: result.model, image: { sha256: result.sha256, prompt: result.prompt } });
  expect(new AdminQQRecords(root).image('900000001', '2026-10-28', message.key)).toEqual(fs.readFileSync(result.file));
  fs.writeFileSync(result.file, 'tampered'); expect(() => new AdminQQRecords(root).image('900000001', '2026-10-28', message.key)).toThrow();
});
test('generic requests use generations and never download provider-supplied URLs or retry', async () => {
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ url: 'http://127.0.0.1/private' }] }), { status: 200 }));
  const generate = createQQImageGenerator(root, '900000001', options, { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake' }, transport as any);
  await expect(generate(request('生成星空的图片'), new AbortController().signal)).rejects.toThrow('QQ image bytes missing');
  expect(transport).toHaveBeenCalledTimes(1); expect((transport.mock.calls[0] as unknown as [string])[0]).toContain('/images/generations');
});
