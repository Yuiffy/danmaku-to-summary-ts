import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { qqImageCharacters } from './QQImageCatalog';
import { QQImageConfig, qqImageCommandPlan, qqImagePlan, qqMatchedImageCharacters } from './QQImagePolicy';
import { createQQImageTools } from './QQImageTools';
import { qqRequest } from './QQPolicy';
import { qqVideoPlan } from './QQVideoPolicy';
import { createQQImageGenerator } from './QQImage';
import sharp from 'sharp';
import { Response } from 'node-fetch';

const project = path.resolve(__dirname, '../../..');
const referenceImage = 'public/reference_images/binggan_sui_humanoid.png';
const devilReference = 'public/reference_images/岁己SUI小猫帽带饼干岁紫色外套双马尾.png';
let root: string, config: QQImageConfig;
const request = (text: string, edit = false) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member', groupOpenid: 'group', messageId: 'mascot-request', content: text,
  timestamp: '2026-11-16T02:00:00Z', ...(edit ? { attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/source' }] } : {})
}, Date.parse('2026-11-16T02:00:00Z'))!;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-catalog-'));
  fs.mkdirSync(path.join(root, 'public/reference_images'), { recursive: true });
  fs.copyFileSync(path.join(project, referenceImage), path.join(root, referenceImage));
  fs.copyFileSync(path.join(project, devilReference), path.join(root, devilReference));
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ ai: { streamerRegistry: {
    sui: { displayName: '岁己SUI', aliases: ['岁己', '小岁'], referenceImages: [devilReference], characterDescription: '白发红瞳女生' }
  } } }));
  config = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high', dailyLimit: 20,
    userDailyLimit: 3, timeoutMs: 180000, registryConfigPath: 'registry.json' };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test.each(['饼干岁人', '饼干人', '饼干岁'])('%s discovers and binds the AI-video cookie-headed humanoid', async alias => {
  const characters = qqImageCharacters(root, config), options = { ...config, characters };
  const original = request(`生成一个${alias}挥手的图片`);
  expect(qqMatchedImageCharacters(original, options).map(item => item.name)).toEqual(['饼干岁人']);
  const render = jest.fn(), load = jest.fn();
  const tools = createQQImageTools(original, options, load, render).tools;
  const found = await tools.find(tool => tool.name === 'find_image_characters')!.execute({ query: alias });
  expect(found).toMatchObject({ characters: [{ name: '饼干岁人', aliases: ['饼干岁人', '饼干人', '饼干岁'] }], limited: false });
  expect(JSON.stringify(found)).not.toContain('reference_images');
  expect(render).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  const plan = qqImageCommandPlan(original, { mode: 'create', instruction: original.text, characters: [] }, options, 0);
  expect(plan.references).toEqual([referenceImage]);
  expect(plan.prompt).toContain('参考图1只用于锁定饼干岁人');
  expect(plan.prompt).toContain('饼干就是整个头部');
  expect(plan.prompt).toContain('正常人类比例的身体');
  expect(plan.prompt).not.toContain('只用于锁定岁己SUI');
});

test('the humanoid stays independent in a joint scene, a skin selection and an additive source edit', () => {
  const example = JSON.parse(fs.readFileSync(path.join(project, 'config/qqbot.example.json'), 'utf8')).images;
  const cat = example.characters.find((item: { skin?: string }) => item.skin === '小猫帽');
  const options = { ...config, characters: qqImageCharacters(root, { ...config, characters: [cat] }) };
  expect(qqMatchedImageCharacters({ text: '画岁己和饼干人一起散步' }, options).map(item => item.name)).toEqual(['岁己SUI', '饼干岁人']);
  expect(qqMatchedImageCharacters({ text: '画小猫帽岁己和饼干岁一起散步' }, options).map(item => item.name)).toEqual(['岁己·小猫帽', '饼干岁人']);
  const edit = request('加入一个饼干人作为老公', true);
  const plan = qqImageCommandPlan(edit, { mode: 'edit', instruction: edit.text, characters: [] }, options, 1);
  expect(plan.references).toEqual([referenceImage]);
  expect(plan.prompt).toContain('参考图2只用于锁定饼干岁人');
  expect(plan.prompt).toContain('必须将整个头部换成饼干头');
  expect(plan.prompt).toContain('其余人物保持原样');
  expect(qqImagePlan(request('画岁己看星星'), options).references).toEqual([devilReference]);
  expect(qqMatchedImageCharacters({ text: '画一盘普通饼干' }, options)).toEqual([]);
});

test('devil discovery and rendering do not also bind the overlapping generic humanoid alias', async () => {
  const options = { ...config, characters: qqImageCharacters(root, config) };
  const original = request('生成恶魔饼干岁的图片');
  const tools = createQQImageTools(original, options, jest.fn(), jest.fn()).tools;
  const found = await tools.find(tool => tool.name === 'find_image_characters')!.execute({ query: '恶魔饼干岁' });
  expect(found).toMatchObject({ characters: [{ name: '恶魔饼干岁' }], limited: false });
  expect(qqMatchedImageCharacters(original, options).map(item => item.name)).toEqual(['恶魔饼干岁']);
  expect(qqImageCommandPlan(original, { mode: 'create', instruction: original.text, characters: [] }, options, 0).references).toEqual([devilReference]);
  expect(qqMatchedImageCharacters({ text: '画恶魔饼干岁和饼干岁人同框' }, options).map(item => item.name)).toEqual(['饼干岁人', '恶魔饼干岁']);
});

test.each(['饼干岁人', '饼干人', '饼干岁', '恶魔饼干岁'])('video uses the same trusted identity for %s', alias => {
  const characters = qqImageCharacters(root, config);
  const plan = qqVideoPlan(`生成${alias}挥手的视频`, { instruction: '挥手', characters: [alias], voices: [], model: null, ratio: null, duration: null }, characters);
  expect(plan.references.map(item => item.referenceImage)).toEqual([alias === '恶魔饼干岁' ? devilReference : referenceImage]);
});

test.each([false, true])('the real multipart adapter sends the correct humanoid reference with edit=%s', async edit => {
  const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const reference = await sharp(path.join(root, referenceImage)).png().toBuffer();
  const transport = jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: source.toString('base64') }] })));
  const original = request(edit ? '变岁己和饼干岁人。“小八”文字改为饼干岁。' : '画一个饼干人挥手', edit);
  await createQQImageGenerator(root, '900000001', config, { url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'offline' },
    transport as any, { loadForGeneration: async () => [source] } as any)(original, new AbortController().signal,
    { mode: edit ? 'edit' : 'create', instruction: original.text, characters: [] });
  const [url, init] = transport.mock.calls[0] as unknown as [string, any];
  expect(url).toContain('/images/edits');
  const parts = init.body.getBuffer().toString('latin1').split(`--${init.body.getBoundary()}`).filter((part: string) => part.includes('name="image[]"'));
  expect(parts).toHaveLength(edit ? 3 : 1);
  expect(parts.at(-1)).toContain(reference.toString('latin1'));
  if (edit) expect(parts[0]).toContain(source.toString('latin1'));
  expect(init.body.getBuffer().toString()).toContain('必须将整个头部换成饼干头');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('missing assets are not advertised, explicit identities win, and no filename duplicate is added', () => {
  const custom = { name: '饼干岁人', aliases: ['自定义饼干岁'], referenceImage, description: '自定义外观' };
  const characters = qqImageCharacters(root, { ...config, characters: [custom] });
  expect(characters.filter(item => item.name === '饼干岁人')).toEqual([custom]);
  expect(characters.some(item => item.name === 'binggan_sui_humanoid')).toBe(false);
  fs.unlinkSync(path.join(root, referenceImage));
  expect(qqImageCharacters(root, config).some(item => item.name === '饼干岁人')).toBe(false);
  fs.unlinkSync(path.join(root, devilReference));
  expect(qqImageCharacters(root, config)).toEqual([]);
});
