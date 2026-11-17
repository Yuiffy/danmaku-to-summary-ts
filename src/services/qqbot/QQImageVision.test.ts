import sharp from 'sharp';
import { Response } from 'node-fetch';
import { qqImagePreviews, qqImagePlanningPreviews, QQ_IMAGE_PREVIEW_BYTES, QQ_IMAGE_PREVIEW_ALLOWANCE } from './QQImageVision';
import { createQQAgentModel } from './QQAgentModel';
import { QQ_LIMITS } from './QQPolicy';

test('source previews strip metadata and fit the byte, dimension and image-count limits', async () => {
  const original = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#aabbcc' } })
    .withMetadata().png().toBuffer();
  const [preview] = await qqImagePreviews([original]);
  const metadata = await sharp(preview).metadata();
  expect(metadata).toMatchObject({ format: 'jpeg', width: 1024 });
  expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined();
  expect(preview.length).toBeLessThanOrEqual(QQ_IMAGE_PREVIEW_BYTES);
  await expect(qqImagePreviews([])).rejects.toThrow('count');
  await expect(qqImagePreviews(Array(25).fill(original))).rejects.toThrow('count');
});

test('vision reserves image capacity separately from base64 transport and remains within the request budget', async () => {
  const previews = [Buffer.alloc(200 * 1024, 1)];
  const calls: any[] = [];
  const transport = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
  const model = createQQAgentModel({ url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'fake-key' },
    new AbortController().signal, transport as any, undefined, call => { calls.push({ ...call }); }, undefined, () => previews);
  const request = { input: '看图', systemInstructions: '据图回答', tools: [], outputType: 'text' as const,
    modelSettings: {}, handoffs: [] };
  await model.getResponse(request);
  const call = calls.at(-1);
  expect(call.requestBytes).toBeGreaterThan(QQ_LIMITS.reservation);
  expect(call.charge).toBeGreaterThan(QQ_IMAGE_PREVIEW_ALLOWANCE);
  expect(call.charge).toBeLessThan(QQ_IMAGE_PREVIEW_ALLOWANCE + 3000);
  expect(call.status).toBe('ok'); expect(transport).toHaveBeenCalledTimes(1);
});

test.each([6, 8, 12, 24])('planning overview preserves all %i sources in row order without altering the originals', async count => {
  const colors = Array.from({ length: count }, (_, index) => ({ r: 20 + index * 10, g: 80, b: 160 }));
  const sources = await Promise.all(colors.map(background => sharp({ create: { width: 80, height: 100, channels: 3, background } }).png().toBuffer()));
  const originals = sources.map(source => Buffer.from(source));
  const [overview] = await qqImagePlanningPreviews(sources);
  expect(overview.length).toBeLessThanOrEqual(QQ_IMAGE_PREVIEW_BYTES);
  const metadata = await sharp(overview).metadata();
  expect(metadata).toMatchObject({ format: 'jpeg', width: 1536, height: Math.ceil(count / 3) * 672 });
  expect(metadata.exif).toBeUndefined();
  for (const [index, color] of colors.entries()) {
    const pixel = await sharp(overview).extract({ left: index % 3 * 512 + 256,
      top: Math.floor(index / 3) * 672 + 352, width: 1, height: 1 }).raw().toBuffer();
    expect(Math.abs(pixel[0] - color.r)).toBeLessThan(5);
    expect(Math.abs(pixel[1] - color.g)).toBeLessThan(5);
    expect(Math.abs(pixel[2] - color.b)).toBeLessThan(5);
  }
  expect(sources).toEqual(originals);
  await expect(qqImagePlanningPreviews(Array(25).fill(sources[0]))).rejects.toThrow('count');
});
