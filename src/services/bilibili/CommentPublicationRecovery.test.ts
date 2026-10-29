import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { recoverCommentReceipt } from './CommentPublicationRecovery';
import { spawnPython } from '../../utils/pythonProcess';

jest.mock('../../utils/pythonProcess', () => ({ spawnPython: jest.fn() }));
const intent = { request: { dynamicId: '123', content: 'exact original text', images: ['original.png'] }, startedAt: 1000000, attachedSummary: true };
const credentials = { session: 'session', csrf: 'csrf', uid: '12', payload: 'payload' };
let child: any;
beforeEach(() => {
  jest.useFakeTimers();
  child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = jest.fn();
  (spawnPython as jest.Mock).mockReturnValue(child);
});
afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('uses the fixed read-only CLI contract and preserves long receipt IDs', async () => {
  const pending = recoverCommentReceipt(intent, credentials);
  expect((spawnPython as jest.Mock).mock.calls[0][0].slice(1)).toEqual(['123', 'exact original text', 'session', 'csrf', '12', '1000000', '1', 'payload']);
  const receipt = { replyId: '12345678901234567890', replyTime: 1001000 };
  child.stdout.write(JSON.stringify({ status: 'found', receipt })); child.emit('close', 0);
  await expect(pending).resolves.toEqual(receipt);
});

test.each([
  ['invalid json', 0], [JSON.stringify({ status: 'missing' }), 0],
  [JSON.stringify({ status: 'found', receipt: { replyId: '1', replyTime: 0 } }), 0],
  [JSON.stringify({ status: 'found', receipt: { replyId: 123, replyTime: 1001000 } }), 0],
  [JSON.stringify({ status: 'found', receipt: { replyId: '123', replyTime: 1001000 } }), 1]
])('treats malformed or unavailable lookup as no receipt (%s)', async (output, code) => {
  const pending = recoverCommentReceipt(intent, credentials);
  child.stdout.write(output); child.emit('close', code);
  await expect(pending).resolves.toBeUndefined();
});

test('bounds stalled and oversized lookups', async () => {
  const pending = recoverCommentReceipt(intent, credentials);
  jest.advanceTimersByTime(30000);
  await expect(pending).resolves.toBeUndefined(); expect(child.kill).toHaveBeenCalledTimes(1);
  const oversized = recoverCommentReceipt(intent, credentials);
  child.stdout.write('x'.repeat(65537));
  await expect(oversized).resolves.toBeUndefined(); expect(child.kill).toHaveBeenCalledTimes(2);
});
