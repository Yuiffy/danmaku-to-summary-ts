import sharp from 'sharp';
import { QQ_IMAGE_INPUT_LIMIT, QQ_IMAGE_SOURCE_LIMIT } from './QQImageInputPolicy';

export interface QQImagePacking { sources: number[][]; references: number[][]; packed: boolean }

/** Keep sources before identity references and use the minimum necessary merging. Indices are zero-based. */
export function qqImagePacking(sourceCount: number, referenceCount: number): QQImagePacking {
  if (!Number.isInteger(sourceCount) || sourceCount < 0 || sourceCount > QQ_IMAGE_SOURCE_LIMIT ||
    !Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > QQ_IMAGE_INPUT_LIMIT) throw new Error('Invalid QQ image counts');
  const groups = (count: number, slots: number) => {
    const result: number[][] = [];
    for (let index = 0; index < count; index++) {
      const group = Math.floor(index * Math.min(count, slots) / count);
      (result[group] ||= []).push(index);
    }
    return result;
  };
  const sources = groups(sourceCount, Math.max(1, QQ_IMAGE_INPUT_LIMIT - referenceCount));
  const references = groups(referenceCount, QQ_IMAGE_INPUT_LIMIT - sources.length);
  return { sources, references, packed: [...sources, ...references].some(group => group.length > 1) };
}

export function qqImagePackingNotice(sourceCount: number, referenceCount: number): string {
  const packing = qqImagePacking(sourceCount, referenceCount);
  return packing.packed ? `这次素材超过单次上传张数上限，将按编号合并为拼图后提交（${sourceCount}张原图、${referenceCount}张角色参考，共${packing.sources.length + packing.references.length}张上传图）；小字和细节可能有所损失。` : '';
}

/** High-resolution numbered input sheets, independent of the smaller planning overview. */
export async function qqImagePackedBuffers(buffers: readonly Buffer[], groups: readonly number[][],
  kind: 'SOURCE' | 'CHARACTER', signal: AbortSignal): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for (const group of groups) {
    signal.throwIfAborted();
    if (group.length === 1) { result.push(buffers[group[0]]); continue; }
    const columns = Math.ceil(Math.sqrt(group.length)), width = 768, height = 1024, labelHeight = 40;
    const tiles = [];
    for (const [position, index] of group.entries()) {
      signal.throwIfAborted();
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}">` +
        `<rect width="100%" height="100%" fill="#202124"/><text x="16" y="29" fill="white" font-family="Arial" font-size="26">${kind} ${index + 1}</text></svg>`);
      const tile = await sharp(buffers[index], { limitInputPixels: 25_000_000 }).rotate()
        .resize(width, height, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' })
        .extend({ top: labelHeight, bottom: 0, left: 0, right: 0, background: '#202124' })
        .composite([{ input: label, left: 0, top: 0 }]).png().toBuffer();
      tiles.push({ input: tile, left: position % columns * width, top: Math.floor(position / columns) * (height + labelHeight) });
    }
    const sheet = await sharp({ create: { width: columns * width, height: Math.ceil(group.length / columns) * (height + labelHeight),
      channels: 3, background: '#202124' } }).composite(tiles).jpeg({ quality: 92 }).toBuffer();
    signal.throwIfAborted();
    if (sheet.length > 10 * 1024 * 1024) throw new Error('QQ input collage too large');
    result.push(sheet);
  }
  return result;
}

export function qqImagePackingPrompt(packing: QQImagePacking): string[] {
  if (!packing.packed) return [];
  return ['上传素材已按编号拼图以适配张数上限。SOURCE编号对应原始输入图片序号；CHARACTER编号对应下文角色参考顺序。拼图不是新的剧情场景，不复制编号、边框或空白到成品；按编号分别处理每格，不串角色、不遗漏原图。',
    ...packing.sources.map((group, index) => `上传图${index + 1}包含原图${group.map(item => item + 1).join('、')}${group.length > 1 ? '，按SOURCE编号逐行从左到右读取' : ''}。`),
    ...packing.references.map((group, index) => `上传图${packing.sources.length + index + 1}包含角色参考${group.map(item => item + 1).join('、')}${group.length > 1 ? '，按CHARACTER编号逐行从左到右读取' : ''}；仅用于角色身份，不作为漫画页。`)];
}
