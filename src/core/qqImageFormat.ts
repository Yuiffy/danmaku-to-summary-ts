/** Stored QQ image formats; missing format in version-1 sidecars means PNG. */
export type QQImageFormat = 'png' | 'gif';
export function qqImageBufferFormat(bytes: Buffer): QQImageFormat | undefined {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  return undefined;
}
export const validQQImageFormat = (format: unknown): format is QQImageFormat | undefined =>
  format === undefined || format === 'png' || format === 'gif';
