import sharp from 'sharp';
import { QQ_IMAGE_SOURCE_LIMIT } from './QQImageInputPolicy';

export const QQ_IMAGE_PREVIEW_BYTES = 256 * 1024;
export const QQ_IMAGE_PREVIEW_ALLOWANCE = 16384;

/** One numbered overview bounds repeated planning costs; generation still receives every original. */
export async function qqImagePlanningPreviews(sources: readonly Buffer[]): Promise<readonly Buffer[]> {
  if (sources.length < 2) return sources;
  if (sources.length > QQ_IMAGE_SOURCE_LIMIT) throw new Error('Invalid QQ image source count');
  const columns = sources.length <= 4 ? 2 : 3, width = 512, height = 640, labelHeight = 32;
  const tiles = await Promise.all(sources.map(async (source, index) => {
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}">` +
      `<rect width="100%" height="100%" fill="#202124"/><text x="12" y="23" fill="white" font-family="Arial" font-size="20">IMAGE ${index + 1}/${sources.length}</text></svg>`);
    const tile = await sharp(source, { limitInputPixels: 25_000_000 })
      .resize(width, height, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' })
      .extend({ top: labelHeight, bottom: 0, left: 0, right: 0, background: '#202124' })
      .composite([{ input: label, left: 0, top: 0 }]).png().toBuffer();
    return { input: tile, left: index % columns * width, top: Math.floor(index / columns) * (height + labelHeight) };
  }));
  const sheet = await sharp({ create: { width: columns * width,
    height: Math.ceil(sources.length / columns) * (height + labelHeight), channels: 3, background: '#202124' } })
    .composite(tiles).jpeg({ quality: 75 }).toBuffer();
  if (sheet.length <= QQ_IMAGE_PREVIEW_BYTES) return [sheet];
  for (const edge of [1280, 1024, 768]) {
    const preview = await sharp(sheet).resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    if (preview.length <= QQ_IMAGE_PREVIEW_BYTES) return [preview];
  }
  throw new Error('QQ image preview too large');
}

/** Bounded, metadata-free previews for answering; full originals remain owned by the edit adapter. */
export async function qqImagePreviews(sources: Buffer[]): Promise<Buffer[]> {
  if (!sources.length || sources.length > QQ_IMAGE_SOURCE_LIMIT) throw new Error('Invalid QQ image source count');
  const previews: Buffer[] = [];
  for (const source of sources) {
    let preview = await sharp(source, { limitInputPixels: 25_000_000 }).rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 75 }).toBuffer();
    if (preview.length > QQ_IMAGE_PREVIEW_BYTES) preview = await sharp(preview)
      .resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    if (preview.length > QQ_IMAGE_PREVIEW_BYTES) throw new Error('QQ image preview too large');
    previews.push(preview);
  }
  return previews;
}
