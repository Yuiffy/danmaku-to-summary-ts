import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QQImageQueueInputs, validQQImageQueuedInput } from './QQImageQueueInputs';
import { QQImageInputs } from './QQImageInputs';
import { qqRequest } from './QQPolicy';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-input-queue-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const command = { mode: 'edit' as const, instruction: '变成水彩画', characters: [] };
function request() {
  return { ...qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'private-message-id', senderId: 'private-user-id',
    groupOpenid: 'private-group-id', timestamp: '2026-11-16T02:00:00Z', content: '变成水彩画' }, Date.parse('2026-11-16T02:00:00Z'))!,
    imageInput: { urls: ['https://signed-url.example/expired'], reply: 'private-quote-id' }, senderName: 'private-nickname' };
}
test('frozen references survive restart without URLs, platform IDs, or another network read', async () => {
  const loadForGeneration = jest.fn(async () => [Buffer.from('normalized image')]);
  const inputs = { loadForGeneration } as unknown as QQImageInputs;
  const queue = new QQImageQueueInputs(root, '900000001', inputs);
  const payload = await queue.prepare(request(), command, new AbortController().signal);
  const stored = JSON.stringify(payload);
  for (const secret of ['private-message-id', 'private-user-id', 'private-group-id', 'private-nickname', 'signed-url', 'private-quote-id']) expect(stored).not.toContain(secret);
  const recovered = new QQImageQueueInputs(root, '900000001', { loadForGeneration: async () => { throw new Error('expired'); } } as unknown as QQImageInputs);
  expect(await recovered.load(JSON.parse(stored))).toEqual([Buffer.from('normalized image')]);
  expect(loadForGeneration).toHaveBeenCalledTimes(1);
});
test('tampered frozen references fail before reaching generation', async () => {
  const queue = new QQImageQueueInputs(root, '900000001', { loadForGeneration: async () => [Buffer.from('image')] } as unknown as QQImageInputs);
  const input = await queue.prepare(request(), command, new AbortController().signal);
  await fs.writeFile(path.join(root, 'data/runtime/qqbot/image-queue-inputs/900000001', input.sources[0] + '.png'), 'changed');
  await expect(queue.load(input)).rejects.toThrow('changed');
});

test('twelve frozen originals preserve order and reference count across restart without another download', async () => {
  const buffers = Array.from({ length: 12 }, (_, index) => Buffer.from(`original ${index + 1}`));
  const loadForGeneration = jest.fn(async () => buffers);
  const config = { enabled: true, model: 'test', dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000,
    characters: ['角色甲', '角色乙'].map(name => ({ name, aliases: [name], description: name, referenceImage: 'public/reference_images/test.png' })) };
  const queue = new QQImageQueueInputs(root, '900000001', { loadForGeneration } as unknown as QQImageInputs, config);
  const input = await queue.prepare(request(), { ...command, characters: ['角色甲', '角色乙'] }, new AbortController().signal);
  expect(input.referenceCount).toBe(2); expect(input.sources).toHaveLength(12);
  const download = jest.fn(async () => { throw new Error('expired URL'); });
  const restarted = new QQImageQueueInputs(root, '900000001', { loadForGeneration: download } as unknown as QQImageInputs, config);
  expect(await restarted.load(JSON.parse(JSON.stringify(input)))).toEqual(buffers);
  expect(loadForGeneration).toHaveBeenCalledTimes(1); expect(download).not.toHaveBeenCalled();
  for (const referenceCount of [-1, 9, 1.5, '2', null]) {
    expect(validQQImageQueuedInput({ ...input, referenceCount } as typeof input, input.request.key, input.request.user)).toBe(false);
  }
});
