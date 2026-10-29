import sharp from 'sharp';
import { Response } from 'node-fetch';
import { qqImagePreviews, QQ_IMAGE_PREVIEW_BYTES, QQ_IMAGE_PREVIEW_ALLOWANCE } from './QQImageVision';
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
  await expect(qqImagePreviews(Array(9).fill(original))).rejects.toThrow('count');
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
