import * as fs from 'fs';
import * as path from 'path';
import { readJsonObject } from '../../core/config/ConfigLayers';
import { QQImageCharacter, QQImageConfig } from './QQImagePolicy';

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
  const files = fs.readdirSync(directory); if (files.length > 1000) throw new Error('QQ reference catalogue too large');
  for (const file of files) {
    const reference = `public/reference_images/${file}`;
    if (used.has(reference) || !/\.(png|jpg|jpeg|webp)$/iu.test(file)) continue;
    const name = path.parse(file).name;
    const short = name.replace(/(?:参考图|全身立绘|立绘|手办|新衣|制服|全身|无头罩|双马尾|多形态).*$/u, '').trim();
    add(short || name, [name, short], reference, '按对应角色参考图还原外观和人物身份');
  }
  return [...characters, ...(config.characters || [])];
}
