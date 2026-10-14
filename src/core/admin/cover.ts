import { CoverSelection } from './contracts';

/** Video-relative seconds and a rectangle normalized to the decoded frame. */
export function coverSelection(value: any): CoverSelection {
  if (!value || typeof value.time !== 'number' || !Number.isFinite(value.time) || value.time < 0
    || !Number.isInteger(value.part) || value.part < 1 || value.part > 1000
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 300 || value.text.includes('\0')) {
    throw new Error('请选择有效的画面、分 P 和封面文字');
  }
  let crop: CoverSelection['crop'];
  if (value.crop != null) {
    const { x, y, width, height } = value.crop;
    if (![x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item))
      || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
      throw new Error('裁剪区域必须在画面内');
    }
    crop = { x, y, width, height };
  }
  return { time: value.time, part: value.part, text: value.text, ...(crop ? { crop } : {}) };
}
