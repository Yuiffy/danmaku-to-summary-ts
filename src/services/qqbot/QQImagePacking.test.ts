import sharp from 'sharp';
import { qqImagePackedBuffers, qqImagePacking, qqImagePackingNotice, qqImagePackingPrompt } from './QQImagePacking';

test('packing covers every original and identity once, in order, within eight uploads for every allowed count', () => {
  for (let sources = 0; sources <= 24; sources++) for (let references = 0; references <= 8; references++) {
    const plan = qqImagePacking(sources, references);
    expect(plan.sources.flat()).toEqual(Array.from({ length: sources }, (_, index) => index));
    expect(plan.references.flat()).toEqual(Array.from({ length: references }, (_, index) => index));
    expect(plan.sources.length + plan.references.length).toBeLessThanOrEqual(8);
    expect(plan.packed).toBe(sources + references > 8);
    expect(!!qqImagePackingNotice(sources, references)).toBe(plan.packed);
  }
  expect(() => qqImagePacking(25, 0)).toThrow();
  expect(() => qqImagePacking(1, 9)).toThrow();
});

test('collages preserve every cell, singleton bytes, source numbering and reference separation', async () => {
  const sources = await Promise.all(['#ff0000', '#0000ff', '#00ff00'].map(background =>
    sharp({ create: { width: 10, height: 10, channels: 3, background } }).png().toBuffer()));
  const packed = await qqImagePackedBuffers(sources, [[0, 1], [2]], 'SOURCE', new AbortController().signal);
  expect(packed[1]).toBe(sources[2]);
  expect(await sharp(packed[0]).metadata()).toMatchObject({ format: 'jpeg', width: 1536, height: 1064 });
  for (const [index, channel] of [0, 2].entries()) {
    const pixel = await sharp(packed[0]).extract({ left: index * 768 + 384, top: 552, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[channel]).toBeGreaterThan(240);
    expect(pixel[2 - channel]).toBeLessThan(10);
  }
  const mapping = qqImagePackingPrompt(qqImagePacking(1, 8)).join('\n');
  expect(mapping).toContain('上传图1包含原图1');
  expect(mapping).toContain('上传图2包含角色参考1、2');
  expect(mapping).toContain('CHARACTER编号');
  const abort = new AbortController(); abort.abort();
  await expect(qqImagePackedBuffers(sources, [[0, 1]], 'SOURCE', abort.signal)).rejects.toThrow();
});
