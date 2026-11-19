import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { QQRequest, qqDigest, publishableQQReferenceReply } from './QQPolicy';
import { QQImageCharacter, QQImageDelivery, qqResolveImageCharacter } from './QQImagePolicy';
import type { QQImageToolSession } from './QQImageTools';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';

const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();

/** Paths and original bytes remain server-owned; the agent only selects registered names. */
export function withQQReferenceTools(session: QQImageToolSession | undefined, request: QQRequest,
  characters: readonly QQImageCharacter[], load: (character: QQImageCharacter) => Promise<QQImageDelivery['image']>,
  observe: (delivery: QQImageDelivery) => void): QQImageToolSession {
  let selected = false;
  const deliver = (delivery: QQImageDelivery) => {
    if (!publishableQQReferenceReply(delivery.text)) throw new Error('Invalid public reference catalogue');
    observe(delivery);
    return { status: delivery.image ? 'ready' : 'listed', message: delivery.text };
  };
  return { ...session, instructions: (session?.instructions || '') +
    '用户索取已收录角色的参考原图时用send_image_reference，按完整名字或唯一别名选择，不调用generate_image、不重画。' +
    '询问知道哪些参考图、角色或别称时用list_image_references，空query列全部，page从1开始；也可按人名筛选。' +
    '目录及原图由服务端按工具结果交付，最终简短说明即可，不删减目录、别称或声称已生成。一次艾特最多交付一页目录或一张原图；有更多页时告知页数和翻页说法，不连续调用覆盖本页。' +
    '原图可能是含多个角色的整张设定表，不裁剪；想要未收录的图就如实说明。', tools: [...session?.tools || [],
    { name: 'list_image_references', description: '展示已收录的全部参考图名称、角色衣装归属和所有别称，支持分页或按人名筛选。结果由服务端完整发送，不受普通回答300字限制；不生成图片。',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 80 },
        page: { type: 'integer', minimum: 1 } }, required: ['query', 'page'] },
      execute: async args => {
        if (selected) return { status: 'blocked', message: '本题已选择目录或原图，请据已有结果回答。' };
        const { query, page } = args as { query: string; page: number }, key = normalize(query);
        const direct = characters.filter(item => !key || [item.name, ...item.aliases, item.baseCharacter || '', item.skin || '']
          .some(name => normalize(name).includes(key)));
        const bases = new Set(direct.filter(item => !item.baseCharacter).map(item => item.name));
        const matches = characters.filter(item => direct.includes(item) || !!item.baseCharacter && bases.has(item.baseCharacter));
        const pages = [''];
        for (const [index, item] of matches.entries()) {
          const row = `${index + 1}. ${item.name}${item.baseCharacter ? `（${item.baseCharacter} / ${item.skin}）` : ''}\n别称：${item.aliases.join('、')}\n`;
          // Keep ordinary rows together; exceptionally long alias sets continue without losing any aliases.
          const chars = Array.from(row);
          if (Array.from(pages.at(-1)!).length + chars.length > 3500 && pages.at(-1)) pages.push('');
          for (let offset = 0; offset < chars.length; offset += 3500) {
            if (offset) pages.push('');
            pages[pages.length - 1] += chars.slice(offset, offset + 3500).join('');
          }
        }
        if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) return { status: 'blocked', pages: pages.length, message: `请查询1—${pages.length}页。` };
        const text = `参考图目录：共${matches.length}项，第${page}/${pages.length}页。\n` +
          (pages[page - 1] || '没有匹配的参考图。\n') +
          '取图请说“发我岁己的参考原图”，也可使用上面登记的别称。' +
          (pages.length > 1 ? `\n翻页请说“列出${query ? `关于${query}的` : '全部'}参考图第N页”（共${pages.length}页）。` : '');
        selected = true;
        return { ...deliver({ text }), total: matches.length, page, pages: pages.length };
      } },
    { name: 'send_image_reference', description: '按完整角色/衣装名或唯一登记别名，准备一张现有参考原图供QQ回复；不生成、不裁剪、不消耗生图额度。未知或歧义名称先查询目录。',
      parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'] },
      execute: async args => {
        if (selected || request.scope !== 'group') return { status: 'blocked', message: '本题不能再选择参考图。' };
        let character: QQImageCharacter;
        try { character = qqResolveImageCharacter((args as { name: string }).name, characters); }
        catch { return { status: 'blocked', message: '参考图名称未知或有歧义，请查询目录并选择完整名称。' }; }
        try {
          const image = await load(character);
          if (!image) throw new Error('Reference missing');
          selected = true;
          return deliver({ text: `${character.name}的参考原图（整张原文件）。`, image });
        } catch { return { status: 'failed', message: '这张参考原图暂时无法读取，请稍后重试或选择其他素材。' }; }
      } }
  ] };
}

/** Validate the trusted source and snapshot its exact bytes before passive delivery. */
export function createQQReferenceLoader(root: string, appId: string, request: QQRequest, signal: AbortSignal) {
  return async (character: QQImageCharacter): Promise<NonNullable<QQImageDelivery['image']>> => {
    signal.throwIfAborted();
    if (request.scope !== 'group' || !/^[1-9]\d{0,24}$/u.test(appId) || !/^[a-f0-9]{64}$/u.test(request.key)) throw new Error('Invalid reference owner');
    const allowed = await fs.realpath(path.join(root, 'public/reference_images'));
    const source = await fs.realpath(path.resolve(root, character.referenceImage)), relative = path.relative(allowed, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid reference path');
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Invalid reference size');
    const bytes = await fs.readFile(source);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Invalid reference size');
    const metadata = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format || '')) throw new Error('Invalid reference image');
    signal.throwIfAborted();
    const directory = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(request.createdAt));
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${request.key}.reference.${metadata.format}`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return { file, sha256: qqDigest(bytes), model: 'reference-original', prompt: `角色参考原图：${character.name}`, reference: true };
  };
}
