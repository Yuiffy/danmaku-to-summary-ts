import sharp from 'sharp';
import { QQ_IMAGE_INPUT_LIMIT } from './QQImageInputPolicy';

export const QQ_IMAGE_PREVIEW_BYTES = 256 * 1024;
export const QQ_IMAGE_PREVIEW_ALLOWANCE = 16384;

/** Bounded, metadata-free previews for answering; full originals remain owned by the edit adapter. */
export async function qqImagePreviews(sources: Buffer[]): Promise<Buffer[]> {
  if (!sources.length || sources.length > QQ_IMAGE_INPUT_LIMIT) throw new Error('Invalid QQ image source count');
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
