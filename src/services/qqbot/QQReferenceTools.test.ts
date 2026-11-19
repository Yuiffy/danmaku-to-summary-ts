import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { createQQReferenceLoader, withQQReferenceTools } from './QQReferenceTools';
import { QQImageCharacter, QQImageDelivery } from './QQImagePolicy';
import { publishableQQReferenceReply, qqDigest, qqRequest } from './QQPolicy';
import { QQImageInputs } from './QQImageInputs';
import { createQQAnswerer } from './QQAgent';
import { sendQQReply } from '../../tools/qqbot/run';

const at = Date.parse('2026-11-18T08:00:00Z');
const request = (text = '发我小岁的参考原图') => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member', groupOpenid: 'group', messageId: 'reference', content: text, timestamp: new Date(at).toISOString() }, at)!;
const base: QQImageCharacter = { name: '岁己SUI', aliases: ['岁己', '小岁'], description: '默认形象', referenceImage: 'public/reference_images/sui.png' };
const skin = { ...base, name: '岁己·JK', aliases: ['JK岁己'], baseCharacter: base.name, skin: 'JK' };
const tool = (session: ReturnType<typeof withQQReferenceTools>, name: string) => session.tools.find(item => item.name === name)!;
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-references-')); await fs.mkdir(path.join(root, 'public/reference_images'), { recursive: true }); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('catalogue pages preserve all entries and aliases beyond twelve and the model reply limit', async () => {
  const characters = Array.from({ length: 60 }, (_, i) => ({ ...base, name: `角色${i}`, aliases: Array.from({ length: 8 }, (_, j) => `别称${i}号${j}`) }));
  const load = jest.fn(), messages: string[] = [];
  const read = async (page: number) => tool(withQQReferenceTools(undefined, request(), characters, load,
    result => messages.push(result.text)), 'list_image_references').execute({ query: '', page }) as Promise<{ total: number; pages: number }>;
  const first = await read(1);
  expect(first.total).toBe(60); expect(first.pages).toBeGreaterThan(1);
  for (let page = 2; page <= first.pages; page++) await read(page);
  for (const character of characters) {
    expect(messages.join('\n')).toContain(character.name);
    for (const alias of character.aliases) expect(messages.join('\n')).toContain(alias);
  }
  for (const message of messages) { expect(publishableQQReferenceReply(message)).toBe(message); expect(Array.from(message).length).toBeLessThan(4500); }
  expect(messages[0]).toContain('第1/'); expect(messages[0]).toContain('翻页');
  expect(load).not.toHaveBeenCalled();
});

test('queries normalize full width and aliases, include skins, and reject invalid pages without choosing a reply', async () => {
  const observe = jest.fn(), session = withQQReferenceTools(undefined, request(), [base, skin], jest.fn(), observe);
  const list = tool(session, 'list_image_references');
  expect(await list.execute({ query: '', page: 99 })).toMatchObject({ status: 'blocked', pages: 1 });
  expect(observe).not.toHaveBeenCalled();
  expect(await list.execute({ query: ' 小岁 ', page: 1 })).toMatchObject({ total: 2 });
  expect(observe.mock.calls[0][0].text).toContain('别称：JK岁己');
  expect(await tool(session, 'send_image_reference').execute({ name: '岁己' })).toMatchObject({ status: 'blocked' });
});

test('unknown, partial and ambiguous aliases cannot select files, while a canonical name wins', async () => {
  const other = { ...base, name: '另一个角色', aliases: ['小岁'] }, load = jest.fn(async () => ({ file: 'original.png', model: 'reference-original', sha256: 'a'.repeat(64), prompt: 'reference' }));
  const session = withQQReferenceTools(undefined, request(), [base, other], load, jest.fn()), send = tool(session, 'send_image_reference');
  for (const name of ['小岁', '岁己的立绘', '../secret', '未知']) expect(await send.execute({ name })).toMatchObject({ status: 'blocked' });
  expect(load).not.toHaveBeenCalled();
  expect(await send.execute({ name: ' 岁己ＳＵＩ ' })).toMatchObject({ status: 'ready' });
  expect(load).toHaveBeenCalledWith(base);
  expect(await send.execute({ name: base.name })).toMatchObject({ status: 'blocked' });
});

test.each(['png', 'jpeg', 'webp'] as const)('uploads exact %s reference bytes and retains a same-group editable receipt', async format => {
  const req = request(), bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer();
  await fs.writeFile(path.join(root, base.referenceImage), bytes);
  const image = await createQQReferenceLoader(root, '900000001', req, new AbortController().signal)(base);
  expect(await fs.readFile(image.file)).toEqual(bytes); expect(image.sha256).toBe(qqDigest(bytes));
  const bot = { uploadMedia: jest.fn(async (args: { localPath: string }) => {
    expect(await fs.readFile(args.localPath)).toEqual(bytes); return { file_info: 'uploaded' };
  }), send: jest.fn(async () => ({ id: 'qq-reference' })) };
  const receipt = await sendQQReply(bot as any, req, '参考原图', image);
  expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({ messageReference: { message_id: req.msgId } }));
  const network = jest.fn(), inputs = new QQImageInputs(root, '900000001', network);
  await inputs.remember(req, image, receipt);
  const quoted = { ...req, imageInput: { urls: [], reply: receipt.id } };
  expect((await sharp((await inputs.load(quoted, new AbortController().signal))[0]).metadata()).width).toBe(20);
  expect(network).not.toHaveBeenCalled();
  await expect(inputs.load({ ...quoted, targetId: 'other-group' }, new AbortController().signal)).rejects.toThrow();
});

test('missing, oversized and escaped references fail without exposing paths or selecting a reply', async () => {
  const req = request(), load = createQQReferenceLoader(root, '900000001', req, new AbortController().signal), observe = jest.fn();
  const session = withQQReferenceTools(undefined, req, [base], load, observe);
  const failed = await tool(session, 'send_image_reference').execute({ name: '小岁' });
  expect(failed).toMatchObject({ status: 'failed' }); expect(JSON.stringify(failed)).not.toContain(root); expect(observe).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, base.referenceImage), Buffer.alloc(10 * 1024 * 1024 + 1));
  await expect(load(base)).rejects.toThrow('size');
  const outside = path.join(root, 'outside.png'); await fs.writeFile(outside, 'private');
  await expect(load({ ...base, referenceImage: outside })).rejects.toThrow('path');
  const link = path.join(root, 'public/reference_images/linked');
  await fs.symlink(root, link, 'junction');
  await expect(load({ ...base, referenceImage: 'public/reference_images/linked/outside.png' })).rejects.toThrow('path');
});

test('agent can select a registered original with no image generation tools or model-visible paths', async () => {
  const req = request(), image = { file: 'server-only.png', model: 'reference-original', sha256: 'a'.repeat(64), prompt: 'reference', reference: true as const };
  let delivery: QQImageDelivery | undefined;
  const session = withQQReferenceTools(undefined, req, [base], async () => image, value => { delivery = value; });
  const model = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: {
    tool_calls: [{ id: 'original', type: 'function', function: { name: 'send_image_reference', arguments: JSON.stringify({ name: '小岁' }) } }] } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ answer: '这是岁己的参考原图。', basis: 'general', evidenceIds: [] }) } }] }) });
  await createQQAnswerer({ url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'test-private' }, undefined, model as any, undefined, session)(req, new AbortController().signal);
  expect(delivery?.image).toBe(image);
  expect(JSON.stringify(model.mock.calls)).not.toContain('server-only.png');
});
