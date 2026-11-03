import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { qqImageCharacters } from './QQImageCatalog';
import { QQImageConfig, qqImageCommandPlan, qqImagePlan, validateQQImageConfig } from './QQImagePolicy';
import { createQQImageTools } from './QQImageTools';
import { createQQImageGenerator } from './QQImage';
import { QQImageInputs } from './QQImageInputs';
import { qqRequest } from './QQPolicy';

const project = path.resolve(__dirname, '../../..');
const skins = ['小红帽', '小花帽', '小蓝帽', '小猫帽'];
let root: string, config: QQImageConfig;
const at = Date.parse('2026-10-30T10:00:00Z');
function request(text: string, edit = false) {
  return qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'member', groupOpenid: 'group',
    messageId: 'skin-request', content: text, timestamp: new Date(at).toISOString(),
    ...(edit ? { attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?rkey=private-token' }] } : {}) }, at)!;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-skins-'));
  config = JSON.parse(await fs.readFile(path.join(project, 'config/qqbot.example.json'), 'utf8')).images;
  await fs.mkdir(path.join(root, 'public/reference_images'), { recursive: true });
  for (const [index, skin] of config.characters!.entries()) {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: index * 50, g: 50, b: 100, alpha: 1 } } }).png().toBuffer();
    await fs.writeFile(path.join(root, skin.referenceImage), bytes);
  }
  const defaultReference = config.characters!.find(item => item.skin === '小猫帽')!.referenceImage;
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, config.registryConfigPath!), JSON.stringify({ ai: { streamerRegistry: {
    sui: { displayName: '岁己SUI', aliases: ['岁己', '小岁'], referenceImages: [defaultReference], characterDescription: '岁己默认形象' },
    shiori: { displayName: '栞栞', aliases: ['栞栞'], referenceImages: ['public/reference_images/shiori.png'], characterDescription: '栞栞的独立形象' }
  } } }));
  await fs.writeFile(path.join(root, 'public/reference_images/shiori.png'), await sharp({ create: {
    width: 8, height: 8, channels: 4, background: '#ffeedd'
  } }).png().toBuffer());
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('the maintained QQ configuration resolves four distinct skin references and keeps the default unchanged', async () => {
  expect(() => validateQQImageConfig(config)).not.toThrow();
  const characters = qqImageCharacters(root, config);
  expect(characters.filter(item => item.skin).map(item => item.skin)).toEqual(skins);
  expect(new Set(characters.map(item => item.name)).size).toBe(characters.length);
  const plan = qqImagePlan(request('生成岁己看星星的图片'), { ...config, characters });
  expect(plan.references).toEqual([config.characters!.find(item => item.skin === '小猫帽')!.referenceImage]);
  expect(plan.prompt).toContain('参考图1只用于锁定岁己SUI');
  for (const item of config.characters!) {
    const file = path.join(project, item.referenceImage);
    expect((await sharp(file).metadata()).width).toBeGreaterThan(0);
    expect((await fs.stat(file)).size).toBeLessThan(5 * 1024 * 1024);
  }
});

test.each(skins)('queries %s as a skin of 岁己 without generating or exposing file paths', async skin => {
  const render = jest.fn(), load = jest.fn();
  const tools = createQQImageTools(request('岁己有哪些皮肤参考？'), { ...config, characters: qqImageCharacters(root, config) }, load, render).tools;
  const find = tools.find(tool => tool.name === 'find_image_characters')!;
  const result = await find.execute({ query: skin });
  expect(result).toMatchObject({ characters: [{ name: `岁己·${skin}`, baseCharacter: '岁己SUI', skin }] });
  expect(JSON.stringify(result)).not.toMatch(/reference_images|\.png|private-token/u);
  const all = await find.execute({ query: '岁己' }) as { characters: Array<{ skin?: string }> };
  expect(all.characters.filter(item => item.skin).map(item => item.skin)).toEqual(skins);
  const byAlias = await find.execute({ query: '小岁' }) as { characters: Array<{ skin?: string }> };
  expect(byAlias.characters.filter(item => item.skin).map(item => item.skin)).toEqual(skins);
  expect(render).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});

test.each(skins)('%s replaces the default reference even if the agent selects the base identity', skin => {
  const characters = qqImageCharacters(root, config), options = { ...config, characters };
  const original = request(`变岁己${skin}，保留黑白画风和构图`, true);
  const plan = qqImageCommandPlan(original, { mode: 'edit', instruction: original.text, characters: ['岁己SUI'] }, options, 1);
  expect(plan.references).toEqual([config.characters!.find(item => item.skin === skin)!.referenceImage]);
  expect(plan.prompt).toContain(`参考图2只用于锁定岁己·${skin}`);
  expect(plan.prompt).toContain('用户指定的皮肤是该角色的具体衣装与造型');
  expect(plan.prompt).toContain('默认保留原图的画风');
  expect(plan.prompt).not.toContain('参考图3只用于锁定岁己SUI');
});

test('one explicit skin keeps other characters and two explicitly requested skins remain distinct', () => {
  const options = { ...config, characters: qqImageCharacters(root, config) };
  const blue = config.characters!.find(item => item.skin === '小蓝帽')!.referenceImage;
  const red = config.characters!.find(item => item.skin === '小红帽')!.referenceImage;
  expect(qqImagePlan(request('生成小岁小蓝帽和栞栞散步的图片'), options).references)
    .toEqual(['public/reference_images/shiori.png', blue]);
  const plan = qqImagePlan(request('画岁己小红帽和小蓝帽同框的图片'), options);
  expect(plan.references).toEqual([red, blue]);
  expect(plan.prompt).toContain('岁己·小红帽'); expect(plan.prompt).toContain('岁己·小蓝帽');
});

test('a model-selected conflicting skin cannot override the skin explicitly requested by the user', () => {
  const original = request('变岁己小蓝帽', true);
  const plan = qqImageCommandPlan(original, { mode: 'edit', instruction: original.text, characters: ['岁己·小红帽'] },
    { ...config, characters: qqImageCharacters(root, config) }, 1);
  expect(plan.references).toEqual([config.characters!.find(item => item.skin === '小蓝帽')!.referenceImage]);
});

test.each(skins.flatMap(skin => [false, true].map(edit => ({ skin, edit }))))
('uploads only the chosen $skin reference with edit=$edit through the real multipart adapter', async ({ skin, edit }) => {
  const source = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const download = jest.fn(async () => new Response(source, { headers: { 'content-type': 'image/png' } }));
  const inputs = new QQImageInputs(root, '900000001', download as any);
  const paid = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: source.toString('base64') }] })));
  const original = request(edit ? `变${skin}` : `生成岁己${skin}看星星的图片`, edit);
  await createQQImageGenerator(root, '900000001', config,
    { url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'fake-offline' }, paid as any, inputs)(
    original, new AbortController().signal, { mode: edit ? 'edit' : 'create', instruction: original.text, characters: ['岁己SUI'] });
  const [url, init] = paid.mock.calls[0] as unknown as [string, any];
  expect(url).toContain('/images/edits');
  const parts = init.body.getBuffer().toString('latin1').split(`--${init.body.getBoundary()}`).filter((part: string) => part.includes('name="image[]"'));
  expect(parts).toHaveLength(edit ? 2 : 1);
  const reference = await fs.readFile(path.join(root, config.characters!.find(item => item.skin === skin)!.referenceImage));
  expect(parts.at(-1)).toContain(reference.toString('latin1'));
  if (edit) expect(parts[0]).toContain(source.toString('latin1'));
  expect(init.body.getBuffer().toString()).toContain(`只用于锁定岁己·${skin}`);
  expect(download).toHaveBeenCalledTimes(edit ? 1 : 0); expect(paid).toHaveBeenCalledTimes(1);
});

test('skin configuration rejects incomplete metadata and unknown parents', () => {
  expect(() => validateQQImageConfig({ ...config, characters: [{ ...config.characters![0], skin: undefined }] })).toThrow();
  expect(() => qqImageCharacters(root, { ...config, characters: [{ ...config.characters![0], baseCharacter: 'unknown' }] })).toThrow('Unknown QQ skin character');
});
