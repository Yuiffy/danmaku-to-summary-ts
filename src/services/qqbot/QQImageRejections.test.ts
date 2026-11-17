import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QQImageRejections, qqImageRejectionNotice } from './QQImageRejections';
import { QQSendRejectedError } from './QQSendReceipt';
import { QQRequest, qqDigest } from './QQPolicy';

let root: string;
const appId = '900000001', key = qqDigest('rejected-request');
const request: QQRequest = { key, user: qqDigest('user'), scope: 'group', targetId: 'private-target', msgId: 'private-message',
  text: '远处的变小红帽岁己，近处的变栞栞', createdAt: Date.parse('2026-11-10T02:49:26Z') };
const error = new QQSendRejectedError(40034006);
const receiptFile = () => path.join(root, 'data/runtime/qqbot/send-alerts', appId, `${key}.json`);
const readReceipt = async () => JSON.parse(await fs.readFile(receiptFile(), 'utf8'));
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-rejection-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const file = path.join(root, 'data/runtime/qqbot/records', appId, '2026-11-10', `${key}.png`);
  const bytes = Buffer.from('fixture-image');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  const image = { file, sha256: qqDigest(bytes), model: 'fixture-image-model', prompt: 'private-prompt' };
  const io = { sendNotice: jest.fn<Promise<'sent' | 'expired'>, [QQRequest, string]>(async () => 'sent'),
    sendText: jest.fn(async (_text: string) => true), sendImage: jest.fn(async (_file: string) => true), report: jest.fn() };
  return { image, io, alerts: new QQImageRejections(root, appId, io) };
}

test('checkpoints each intent before QQ text and WeCom text/image, then deduplicates concurrent calls and restarts', async () => {
  const { image, io, alerts } = await setup();
  io.sendNotice.mockImplementation(async () => { expect((await readReceipt()).qqNotice).toBe('sending'); return 'sent'; });
  io.sendText.mockImplementation(async () => { expect((await readReceipt()).wecomText).toBe('sending'); return true; });
  io.sendImage.mockImplementation(async () => { expect((await readReceipt()).wecomImage).toBe('sending'); return true; });
  await Promise.all([alerts.handle(request, image, error), alerts.handle(request, image, error)]);
  await new QQImageRejections(root, appId, io).handle(request, image, error);
  expect(io.sendNotice).toHaveBeenCalledTimes(1); expect(io.sendText).toHaveBeenCalledTimes(1); expect(io.sendImage).toHaveBeenCalledTimes(1);
  expect(io.sendNotice).toHaveBeenCalledWith(request, expect.stringContaining('QQ拒绝发送'));
  expect(io.sendText).toHaveBeenCalledWith(expect.stringContaining('错误码40034006'));
  expect(io.sendText.mock.calls[0][0]).toContain(request.text);
  expect(io.sendText.mock.calls[0][0]).not.toMatch(/private-target|private-message|private-prompt/u);
  expect(io.sendImage).toHaveBeenCalledWith(await fs.realpath(image.file));
  expect(await readReceipt()).toMatchObject({ qqNotice: 'sent', wecomText: 'sent', wecomImage: 'sent', imageSha256: image.sha256 });
  expect(JSON.stringify(io.report.mock.calls)).not.toMatch(/private-|fixture-image|栞/u);
});

test.each(['sendNotice', 'sendText', 'sendImage'] as const)('a failed %s does not suppress independent notices or authorize retries', async method => {
  const { image, io, alerts } = await setup();
  io[method].mockRejectedValue(new Error('private transport detail'));
  await expect(alerts.handle(request, image, error)).resolves.toBeUndefined();
  expect(io.sendNotice).toHaveBeenCalledTimes(1); expect(io.sendText).toHaveBeenCalledTimes(1); expect(io.sendImage).toHaveBeenCalledTimes(1);
  const field = { sendNotice: 'qqNotice', sendText: 'wecomText', sendImage: 'wecomImage' }[method];
  expect((await readReceipt())[field]).toBe('unknown');
  await new QQImageRejections(root, appId, io).handle(request, image, error);
  expect(io[method]).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(io.report.mock.calls)).not.toContain('private');
});

test('an expired QQ window still alerts WeCom without pretending the group received the notice', async () => {
  const { image, io, alerts } = await setup(); io.sendNotice.mockResolvedValue('expired');
  await alerts.handle(request, image, error);
  expect(io.sendText.mock.calls[0][0]).toContain('原消息已过回复时限');
  expect(await readReceipt()).toMatchObject({ qqNotice: 'expired', wecomText: 'sent', wecomImage: 'sent' });
});

test('unconfirmed notifier returns remain unknown and never report success', async () => {
  const { image, io, alerts } = await setup(); io.sendText.mockResolvedValue(false); io.sendImage.mockResolvedValue(false);
  await alerts.handle(request, image, error);
  expect(await readReceipt()).toMatchObject({ qqNotice: 'sent', wecomText: 'unknown', wecomImage: 'unknown' });
});

test('an interrupted notice is not replayed while previously unattempted alert steps may complete', async () => {
  const { image, io, alerts } = await setup();
  await fs.mkdir(path.dirname(receiptFile()), { recursive: true });
  await fs.writeFile(receiptFile(), JSON.stringify({ version: 1, appId, requestId: key, imageSha256: image.sha256,
    platformCode: 40034006, qqNotice: 'sending', wecomText: 'pending', wecomImage: 'pending' }));
  await alerts.handle(request, image, error);
  expect(io.sendNotice).not.toHaveBeenCalled(); expect(io.sendText).toHaveBeenCalledTimes(1);
  expect(await readReceipt()).toMatchObject({ qqNotice: 'unknown', wecomImage: 'sent' });
});

test('corrupt receipts fail closed before any external effects without propagating failure to the worker', async () => {
  const { image, io, alerts } = await setup();
  await fs.mkdir(path.dirname(receiptFile()), { recursive: true }); await fs.writeFile(receiptFile(), '{}');
  await expect(alerts.handle(request, image, error)).resolves.toBeUndefined();
  expect(io.sendNotice).not.toHaveBeenCalled(); expect(io.sendText).not.toHaveBeenCalled(); expect(io.sendImage).not.toHaveBeenCalled();
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ rejectionNotice: expect.objectContaining({ step: 'journal', outcome: 'unknown' }) }));
});

test('a changed or unrelated file cannot be forwarded as the rejected result', async () => {
  const { image, io, alerts } = await setup();
  await fs.writeFile(image.file, 'changed');
  await alerts.handle(request, image, error);
  expect(io.sendImage).not.toHaveBeenCalled(); expect((await readReceipt()).wecomImage).toBe('unknown');
  const unrelated = path.join(root, 'unrelated.png'); await fs.writeFile(unrelated, 'fixture-image');
  await new QQImageRejections(root, appId, io).handle({ ...request, key: qqDigest('outside') }, { ...image, file: unrelated }, error);
  expect(io.sendImage).not.toHaveBeenCalled();
});

test.each([40034006, 12345])('business code %s alone is not misrepresented as moderation', code => {
  expect(qqImageRejectionNotice(code)).toContain('QQ拒绝发送');
  expect(qqImageRejectionNotice(code)).toContain('未确认具体原因');
  expect(qqImageRejectionNotice(code)).not.toContain('违规');
});
