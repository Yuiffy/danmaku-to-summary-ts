import { Readable } from 'stream';
import sharp from 'sharp';
import { Response } from 'node-fetch';
import { QQImageInputs } from './QQImageInputs';
import { qqRequest } from './QQPolicy';
import { createQQImageTools } from './QQImageTools';

const MiB = 1024 * 1024;
const signal = () => new AbortController().signal;
const request = (count = 1) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member', groupOpenid: 'group', messageId: 'large-image', timestamp: '2026-11-18T05:36:00Z',
  content: '把图改成蓝色', attachments: Array.from({ length: count }, (_, i) => ({ content_type: 'image/png',
    url: `https://multimedia.nt.qq.com.cn/download?file=${i}&rkey=private` })) }, Date.parse('2026-11-18T05:36:00Z'))!;

test.each([true, false])('downloads and compresses a valid image over 10 MiB (length header=%s)', async declared => {
  const original = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#aaccee' } })
    .png({ compressionLevel: 0 }).toBuffer();
  expect(original.length).toBeGreaterThan(10 * MiB);
  const download = jest.fn(async () => new Response(original, { headers: { 'content-type': 'image/png',
    ...(declared ? { 'content-length': String(original.length) } : {}) } }));
  const observe = jest.fn();
  const input = request();
  const inputs = new QQImageInputs('', '900000001', download as any, observe);
  const [normalized] = await inputs.load(input, signal());
  expect(normalized.length).toBeLessThanOrEqual(10 * MiB);
  expect(await sharp(normalized).metadata()).toMatchObject({ format: 'png', width: 2048, height: 2048 });
  expect(await inputs.load(input, signal())).toEqual([normalized]);
  expect(download).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0][1]).toMatchObject({ outcome: 'loaded', bytes: original.length, normalizedBytes: normalized.length });
});

test('resizes high-entropy large PNGs while preserving alpha and aspect ratio', async () => {
  const pixels = Buffer.alloc(2300 * 2300 * 4);
  let state = 123456789;
  for (let i = 0; i < pixels.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[i] = state & 255; }
  const original = await sharp(pixels, { raw: { width: 2300, height: 2300, channels: 4 } }).png().toBuffer();
  expect(original.length).toBeGreaterThan(10 * MiB);
  const inputs = new QQImageInputs('', '900000001', (async () => new Response(original,
    { headers: { 'content-type': 'image/png', 'content-length': String(original.length) } })) as any);
  const [normalized] = await inputs.load(request(), signal());
  expect(normalized.length).toBeLessThanOrEqual(10 * MiB);
  expect(await sharp(normalized).metadata()).toMatchObject({ format: 'png', width: 1024, height: 1024, hasAlpha: true });
});

test.each(['headers', 'stream', 'buffer'])('oversize %s returns the precise message and never admits paid generation', async mode => {
  const response = mode === 'stream' ? new Response(Readable.from([Buffer.alloc(17 * MiB), Buffer.alloc(16 * MiB)]),
    { size: 32 * MiB, headers: { 'content-type': 'image/png' } }) : new Response('', { headers: {
    'content-type': 'image/png', ...(mode === 'headers' ? { 'content-length': String(33 * MiB) } : {}) } });
  const body = jest.spyOn(response, 'buffer');
  if (mode === 'buffer') body.mockResolvedValue(Buffer.alloc(33 * MiB));
  const normalize = jest.fn(), paid = jest.fn(), observe = jest.fn(), observedResult = jest.fn();
  const input = request();
  const inputs = new QQImageInputs('', '900000001', (async () => response) as any, observe, normalize);
  const tools = createQQImageTools(input, { enabled: true, model: 'fake', quality: 'high',
    dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: [] },
  () => inputs.load(input, signal()), paid, undefined, observedResult);
  await tools.prepare!();
  const result = await tools.tools.find(tool => tool.name === 'generate_image')!.execute({ mode: 'edit', instruction: '改成蓝色', characters: [] });
  expect(result).toEqual({ status: 'blocked', message: '图片超过 32 MiB 下载上限，无法读取。请压缩到 10 MiB 以内后重新发送。' });
  expect(await tools.tools.find(tool => tool.name === 'read_image_sources')!.execute({})).toEqual({ available: false, message: result.message });
  expect(observedResult).toHaveBeenCalledWith(result);
  expect(observe.mock.calls[0][1]).toMatchObject({ outcome: 'failed', failure: { code: 'image_download_size' } });
  expect(JSON.stringify(observe.mock.calls[0][1])).not.toContain('rkey=private');
  if (mode === 'headers') expect(body).not.toHaveBeenCalled();
  expect(normalize).not.toHaveBeenCalled(); expect(paid).not.toHaveBeenCalled();
});

test('multi-image aggregate budget rejects a known overflow before reading the next body', async () => {
  const response = () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': String(23 * MiB) } });
  const responses = [response(), response(), response()];
  responses[0].buffer = async () => Buffer.alloc(23 * MiB);
  responses[1].buffer = async () => Buffer.alloc(23 * MiB);
  const thirdBody = jest.spyOn(responses[2], 'buffer');
  const normalize = jest.fn(async () => Buffer.from('normalized'));
  const inputs = new QQImageInputs('', '900000001', (async () => responses.shift()!) as any, undefined, normalize);
  await expect(inputs.load(request(3), signal())).rejects.toMatchObject({ diagnostic: { code: 'image_size' } });
  expect(thirdBody).not.toHaveBeenCalled(); expect(normalize).toHaveBeenCalledTimes(2);
});

test('network failures remain download failures without asserting an unobserved size', async () => {
  const observe = jest.fn();
  const inputs = new QQImageInputs('', '900000001', (async () => { throw new Error('connection closed'); }) as any, observe);
  await expect(inputs.load(request(), signal())).rejects.toThrow('connection closed');
  expect(observe.mock.calls[0][1]).toMatchObject({ outcome: 'failed', step: 'download' });
  expect(observe.mock.calls[0][1].failure.code).not.toBe('image_download_size');
});
