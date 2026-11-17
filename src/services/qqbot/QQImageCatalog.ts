import * as fs from 'fs';
import * as path from 'path';
import { readJsonObject } from '../../core/config/ConfigLayers';
import { QQImageCharacter, QQImageConfig } from './QQImagePolicy';

// Reuse the AI-video binggan identity; the small devil on 岁己's sheet is a separate subject.
const suiCookieCharacters: QQImageCharacter[] = [{
  name: '饼干岁人', aliases: ['饼干岁人', '饼干人', '饼干岁'],
  referenceImage: 'public/reference_images/binggan_sui_humanoid.png',
  description: 'AI生视频常用的饼干岁人：完整的圆形金黄色巧克力豆饼干就是整个头部，饼干表面有简单可爱的五官，头戴小金色皇冠；脖子以下是正常人类比例的身体、手臂和双腿。没有人类脸孔或头发，不能画成人脸加饼干发饰，也不是细四肢的小恶魔饼干。参考图是同一角色的三视图与服饰细节，只取身份，不复制多视图排版。默认深色夹克、白T恤、深灰长裤、白色运动鞋与斜挎包；服饰和动作可按用户要求或原图保留，但替换角色时必须将整个头部换成饼干头。'
}, {
  name: '恶魔饼干岁', aliases: ['恶魔饼干岁'],
  referenceImage: 'public/reference_images/岁己SUI小猫帽带饼干岁紫色外套双马尾.png',
  description: '参考图右上方的小小恶魔饼干岁：浅金色带深色斑点的饼干身体、细细四肢和可爱表情。只参考这个小饼干角色；它与饼干头、人类身体的饼干岁人是不同形象，不是白发女生或岁己的皮肤；未要求岁己时不要加入岁己。'
}];

/** Reuse the maintained streamer registry, plus named assets not yet in that registry. No secret layers. */
export function qqImageCharacters(root: string, config: QQImageConfig): QQImageCharacter[] {
  if (!config.registryConfigPath) return config.characters || [];
  const document = readJsonObject(path.resolve(root, config.registryConfigPath)) as any;
  const registry = document.ai?.streamerRegistry || {}, rooms = document.ai?.roomSettings || {}, characters: QQImageCharacter[] = [];
  if (Object.keys(registry).length > 200) throw new Error('QQ character registry too large');
  if (Object.keys(rooms).length > 1000) throw new Error('QQ character room catalogue too large');
  const used = new Set<string>();
  const add = (name: string, aliases: string[], referenceImage: string, description: string) => {
    const names = [...new Set(aliases.flatMap(value => typeof value === 'string' ? [value, value.match(/^[\p{Script=Han}]+/u)?.[0] || ''] : [])
      .filter(value => value.trim().length >= 2 && value.length <= 80))];
    const existing = characters.find(character => character.referenceImage === referenceImage ||
      character.aliases.some(alias => names.some(value => alias.toLocaleLowerCase() === value.toLocaleLowerCase())));
    if (existing) existing.aliases = [...new Set([...existing.aliases, ...names])].slice(0, 64);
    else characters.push({ name, aliases: names.slice(0, 64), referenceImage, description: description.slice(0, 1000) });
    used.add(referenceImage);
  };
  for (const [id, item] of Object.entries(registry) as Array<[string, any]>) {
    const reference = (item.referenceImages || []).find((value: unknown) => typeof value === 'string' && value.startsWith('public/reference_images/') && fs.existsSync(path.resolve(root, value)));
    if (!reference) continue;
    for (const value of item.referenceImages) used.add(value);
    const aliases = [...new Set<string>([item.displayName, id, ...(item.mentionLabels || []), ...(item.aliases || [])]
      .filter(value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 80))];
    add(item.displayName || id, aliases, reference, String(item.characterDescription || '以参考图中的人物外观为准'));
  }
  for (const item of Object.values(rooms) as any[]) {
    const reference = item.referenceImage;
    if (typeof reference !== 'string' || !reference.startsWith('public/reference_images/') || !fs.existsSync(path.resolve(root, reference))) continue;
    const identity = String(item.characterDescription || '').split(/[（(，,。；;]/u)[0].trim();
    const name = String(item.anchorName || identity || path.parse(reference).name);
    add(name, [name, identity], reference, String(item.characterDescription || '以参考图中的人物外观为准'));
  }
  const directory = path.join(root, 'public/reference_images');
  // Explicit outfits retain their own names and metadata instead of becoming duplicate filename-derived characters.
  for (const character of config.characters || []) used.add(character.referenceImage);
  for (const character of suiCookieCharacters) used.add(character.referenceImage);
  const files = fs.readdirSync(directory); if (files.length > 1000) throw new Error('QQ reference catalogue too large');
  for (const file of files) {
    const reference = `public/reference_images/${file}`;
    if (used.has(reference) || !/\.(png|jpg|jpeg|webp)$/iu.test(file)) continue;
    const name = path.parse(file).name;
    const short = name.replace(/(?:参考图|全身立绘|立绘|手办|新衣|制服|全身|无头罩|双马尾|多形态).*$/u, '').trim();
    add(short || name, [name, short], reference, '按对应角色参考图还原外观和人物身份');
  }
  const catalogue = [...characters, ...(config.characters || [])];
  for (const character of suiCookieCharacters) {
    if (!catalogue.some(item => item.name === character.name) && fs.existsSync(path.resolve(root, character.referenceImage))) {
      catalogue.push({ ...character, aliases: [...character.aliases] });
    }
  }
  for (const character of catalogue) if (character.baseCharacter && !catalogue.some(base => base.name === character.baseCharacter && !base.baseCharacter)) {
    throw new Error('Unknown QQ skin character');
  }
  return catalogue;
}
