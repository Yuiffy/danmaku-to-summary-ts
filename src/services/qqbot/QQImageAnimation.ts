import sharp from 'sharp';
import { qqImageBufferFormat } from '../../core/qqImageFormat';
import { qqFailure } from './QQDiagnostics';

/** Validate every frame without re-encoding away timing, loop count or transparency. */
export async function validateQQGif(bytes: Buffer, stage: 'image_prepare' | 'image_decode', requireAnimation = false): Promise<Buffer> {
  if (bytes.length > 10 * 1024 * 1024) throw qqFailure(stage, 'image_size');
  if (qqImageBufferFormat(bytes) !== 'gif') throw qqFailure(stage, requireAnimation ? 'image_animation' : 'image_bytes');
  // Read metadata without libvips' aggregate pixel guard first.  Otherwise a
  // large but valid GIF throws a generic "Input image exceeds pixel limit"
  // before we can classify it as the user-facing size failure.
  let image: sharp.Sharp;
  let metadata: sharp.Metadata;
  try {
    image = sharp(bytes, { animated: true, limitInputPixels: false, failOn: 'error' });
    metadata = await image.metadata();
  } catch {
    throw qqFailure(stage, 'image_bytes');
  }
  const pages = metadata.pages || 1;
  if (requireAnimation && pages < 2) throw qqFailure(stage, 'image_animation');
  const width = metadata.width || 0;
  const height = metadata.pageHeight || metadata.height || 0;
  // The contact sheet only decodes a few representative frames.  Budget the
  // pixels of each frame instead of multiplying by the animation length; a
  // normal 512×512 GIF can legitimately contain dozens of frames.
  if (pages > 120 || !width || !height || width * height > 25_000_000) throw qqFailure(stage, 'image_size');
  for (const page of new Set([0, pages - 1])) {
    try {
      await sharp(bytes, { page, pages: 1, limitInputPixels: 25_000_000, failOn: 'error' })
        .resize({ width: 1, height: 1, fit: 'inside' }).png().toBuffer();
    } catch {
      throw qqFailure(stage, 'image_bytes');
    }
  }
  return bytes;
}
