import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { createQQImageGenerator } from './QQImage';
import { QQImageConfig, QQ_IMAGE_CONFIRM_PREFIX, qqImageConfirmationReply, qqImagePlan, qqImageRequested, validateQQImageConfig } from './QQImagePolicy';
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

const confirmedRequest = (text: string) => request(`${QQ_IMAGE_CONFIRM_PREFIX}${text}`);

test.each(['生成岁己和栞栞在wwe赛场上大战的图片', '确认按描述生图:岁己和栞栞在WWE风格摔角赛场上对战的画面'])
('a direct drawing request or compatible prefix authorizes creation: %s', text => {
  const original = request(text);
  expect(qqImageConfirmationReply(original, options)).toBeUndefined();
  const plan = qqImagePlan(original, options);
  expect(plan.references).toEqual(options.characters!.map(character => character.referenceImage));
  expect(plan.prompt).toContain(text.replace(/^确认按描述生图:/u, ''));
});

test('image configuration accepts a global daily capacity of 300 and rejects an excess or fractional capacity', () => {
  expect(() => validateQQImageConfig({ ...options, dailyLimit: 300, userDailyLimit: 30 })).not.toThrow();
  for (const dailyLimit of [301, 300.5]) expect(() => validateQQImageConfig({ ...options, dailyLimit })).toThrow('Invalid QQ image configuration');
});

test('direct requests can draw unfamiliar characters without vouching for their identities', () => {
  const unknown = request('生成一张森亚露露卡抱向主视角的图');
  expect(qqImageConfirmationReply(unknown, options)).toBeUndefined();
  const mixed = qqImagePlan(request('生成小岁和森亚露露卡一起吃冰淇淋的图片'), options);
  expect(mixed.references).toEqual([options.characters![0].referenceImage]);
  expect(mixed.prompt).toContain('外观未经核实');
  const confirmed = qqImagePlan(confirmedRequest(unknown.text), options);
  expect(confirmed.references).toEqual([]); expect(confirmed.prompt).toContain(unknown.text);
  expect(confirmed.prompt).not.toContain(QQ_IMAGE_CONFIRM_PREFIX);
});

test.each(['确认按描述生图：', '不要确认按描述生图：画森亚露露卡', '“确认按描述生图：画森亚露露卡”是什么意思', '确认生图'])
('empty, negated, quoted or incomplete confirmation cannot authorize an image: %s', text => {
  expect(qqImageConfirmationReply(request(text), options)).toBeDefined();
});

test('a model cannot turn chatter into paid creation or create image artifacts', async () => {
  const transport = jest.fn();
  const generate = createQQImageGenerator(root, '900000001', options, { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake' }, transport);
  await expect(generate(request('生成图片这个功能怎么用'), new AbortController().signal)).rejects.toMatchObject({ diagnostic: { stage: 'image_prepare' } });
  await expect(generate(request('不要生成星空图片'), new AbortController().signal,
    { mode: 'create', instruction: '模型声称用户已经确认', characters: [] })).rejects.toMatchObject({ diagnostic: { stage: 'image_prepare' } });
  expect(transport).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
});

test('agent creation cannot omit known references explicitly named by the user', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#aaccee' } }).png().toBuffer();
  for (const character of options.characters!) fs.writeFileSync(path.join(root, character.referenceImage), png);
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  const generate = createQQImageGenerator(root, '900000001', options,
    { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake' }, transport as any);
  const result = await generate(request('画小岁和栞栞在月球上'), new AbortController().signal,
    { mode: 'create', instruction: '月球合影', characters: [] });
  expect(result.prompt).toContain('参考图1只用于锁定岁己'); expect(result.prompt).toContain('参考图2只用于锁定栞栞');
  expect((transport.mock.calls[0] as unknown as [string])[0]).toContain('/images/edits');
});

test('accepts common drawing requests without treating ordinary chat as image creation', () => {
  for (const text of ['画一个星汐', '给我画小岁', '画张七海', '生成三理穿宇航服的图片']) expect(qqImageRequested(text)).toBe(true);
  for (const text of ['今天聊什么', '三理昨天画画了吗']) expect(qqImageRequested(text)).toBe(false);
});
test('combines matched character references with user scene, without matching English substrings', () => {
  const plan = qqImagePlan(confirmedRequest('生成小岁和小栞一起吃冰淇淋的图片'), options);
  expect(plan.references).toEqual(options.characters!.map(item => item.referenceImage));
  expect(plan.prompt).toContain('一起吃冰淇淋'); expect(plan.prompt).toContain('白发红瞳'); expect(plan.prompt).toContain('黄色头发');
  expect(qqImagePlan(confirmedRequest('生成 a red suit 的图片'), options).references).toEqual([]);
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
  expect(qqImagePlan(confirmedRequest('生成七宝和七海一起跳舞的图片'), { ...options, characters }).references).toHaveLength(2);
  expect(qqImagePlan(confirmedRequest('生成星汐和礼墨一起跳舞的图片'), { ...options, characters }).references).toEqual([
    'public/reference_images/seki.png', 'public/reference_images/sumi_standing.png'
  ]);
});

test('maintained catalogue resolves both 七海 and 阿梓 in an interaction request', () => {
  const production = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config/production.json'), 'utf8'));
  const registry = production.ai.streamerRegistry;
  const rooms = production.ai.roomSettings;
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ ai: {
    streamerRegistry: { azusa: registry.azusa }, roomSettings: { '80397': rooms['80397'], '21452505': rooms['21452505'] }
  } }));
  for (const reference of ['azusa_standing.png', '七海手办.png']) fs.writeFileSync(path.join(root, 'public/reference_images', reference), 'reference');
  const config = { ...options, registryConfigPath: 'registry.json', characters: undefined };
  const characters = qqImageCharacters(root, config);
  const text = '生成一张七海使用魔贯光杀炮攻击阿梓的图';
  const plan = qqImagePlan(confirmedRequest(text), { ...config, characters });
  expect(new Set(plan.references)).toEqual(new Set(['public/reference_images/七海手办.png', 'public/reference_images/azusa_standing.png']));
  expect(qqImageConfirmationReply(request(text), { ...config, characters })).toBeUndefined();
  expect(plan.prompt).toContain(text);
  expect(plan.prompt).toContain(rooms['80397'].characterDescription);
  expect(plan.prompt).toContain(rooms['21452505'].characterDescription);
});

test.each([2, 3, 8])('uploads all %i distinct character references with matching prompt identities in one request', async count => {
  const names = ['七海', '阿梓', '岁己', '栞栞', '三理', '星汐', '弥月', '犬绒'].slice(0, count);
  const characters = names.map((name, index) => ({ name, aliases: [name], description: `${name}的独立角色外观`, referenceImage: `public/reference_images/role-${index}.png` }));
  const references: Buffer[] = [];
  for (const [index, character] of characters.entries()) {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 25 * index, g: 80, b: 160, alpha: 1 } } }).png().toBuffer();
    fs.writeFileSync(path.join(root, character.referenceImage), png); references.push(png);
  }
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: references[0].toString('base64') }] }), { status: 200 }));
  const text = count === 2 ? '生成一张七海使用魔贯光杀炮攻击阿梓的图' : `生成${names.join('、')}同框聚会的图片`;
  const result = await createQQImageGenerator(root, '900000001', { ...options, characters },
    { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake' }, transport as any)(confirmedRequest(text), new AbortController().signal);
  expect(transport).toHaveBeenCalledTimes(1);
  const [endpoint, init] = transport.mock.calls[0] as unknown as [string, any];
  expect(endpoint).toContain('/images/edits');
  const parts = init.body.getBuffer().toString('latin1').split(`--${init.body.getBoundary()}`).filter((part: string) => part.includes('name="image[]"'));
  expect(parts).toHaveLength(count);
  for (const [index, character] of characters.entries()) {
    expect(parts[index]).toContain(references[index].toString('latin1'));
    expect(parts[index]).toContain(`filename="character-${index + 1}.png"`);
    expect(result.prompt).toContain(`参考图${index + 1}只用于锁定${character.name}的角色身份`);
  }
  expect(result.prompt).toContain('不要把多张参考图融合成同一个角色');
  expect(result.prompt).toContain(text);
});
test('sends real multipart reference bytes to dedicated provider once and archives viewable PNG', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#aaccee' } }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'public/reference_images/sui.png'), png);
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 }));
  const message = confirmedRequest('生成岁己在月球上看星星的图片');
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
  await expect(generate(confirmedRequest('生成星空的图片'), new AbortController().signal)).rejects.toMatchObject({ diagnostic: { stage: 'image_decode', code: 'image_bytes', httpStatus: 200 } });
  expect(transport).toHaveBeenCalledTimes(1); expect((transport.mock.calls[0] as unknown as [string])[0]).toContain('/images/generations');
});
test('image HTTP failures retain status and upstream ID while omitting the provider error body', async () => {
  const transport = jest.fn(async () => new Response('private provider diagnostics fake-qq-key', { status: 503, headers: { 'x-request-id': 'image-req-123' } }));
  const generate = createQQImageGenerator(root, '900000001', options, { url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'fake-qq-key' }, transport as any);
  let error: any;
  try { await generate(confirmedRequest('生成星空图片'), new AbortController().signal); } catch (caught) { error = caught; }
  expect(error.diagnostic).toMatchObject({ stage: 'image_http', code: 'http_error', httpStatus: 503, requestId: 'image-req-123' });
  expect(JSON.stringify(error.diagnostic)).not.toMatch(/private|fake-qq-key/u); expect(transport).toHaveBeenCalledTimes(1);
});
