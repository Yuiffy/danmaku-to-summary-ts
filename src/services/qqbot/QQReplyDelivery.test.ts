import { qqReplyParts, sendQQProgress, QQReplyDeliveryIO } from './QQReplyDelivery';
import { qqRequest, QQ_LIMITS } from './QQPolicy';
import { newQQState, QQState } from './QQState';
import { QQSendRejectedError } from './QQSendReceipt';

const at = Date.parse('2026-11-15T06:00:00Z');
const request = qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'member', groupOpenid: 'group',
  messageId: 'message', content: '生成星空图', timestamp: new Date(at).toISOString() }, at)!;

test.each(['景'.repeat(4500), '😀'.repeat(4500), ('短句。'.repeat(210) + '\n').repeat(6)])('splitting preserves every Unicode character in at most four numbered messages', text => {
  const parts = qqReplyParts(text);
  expect(parts.length).toBeLessThanOrEqual(4);
  expect(parts.every(part => Array.from(part).length <= 1200)).toBe(true);
  expect(parts.map(part => part.replace(/^（\d\/\d）/u, '')).join('')).toBe(text);
});

test('short replies stay unchanged and oversized drafts fail before any IO', () => {
  expect(qqReplyParts('你好')).toEqual(['你好']);
  expect(() => qqReplyParts('景'.repeat(4501))).toThrow();
});

function setup() {
  let now = at;
  const state = newQQState('900000001'); state.receipts[request.key] = { at, status: 'generating' }; state.lastSendAt = at;
  const saved: QQState[] = [];
  const io: QQReplyDeliveryIO & { send: jest.Mock; report: jest.Mock } = {
    now: () => now, sleep: jest.fn(async ms => { now += ms; }), stopping: () => false,
    save: jest.fn(async value => { saved.push(structuredClone(value)); }), record: jest.fn(async () => {}),
    send: jest.fn(async () => { expect(saved.at(-1)!.receipts[request.key].status).toBe('sending'); return { id: 'receipt' }; }), report: jest.fn()
  };
  return { state, io, saved };
}

test('progress is paced and checkpointed before sending, then returns to generating', async () => {
  const { state, io } = setup();
  await expect(sendQQProgress(request, '收到生图要求，正在处理。', state, io)).resolves.toBe(true);
  expect(io.sleep).toHaveBeenCalledWith(QQ_LIMITS.sendIntervalMs);
  expect(state.receipts[request.key].status).toBe('generating'); expect(state.paused).toBe(false);
  expect(io.report).toHaveBeenCalledWith('qq_progress_sent'); expect(io.send).toHaveBeenCalledTimes(1);
  expect(state.receipts[request.key].replies).toBe(1);
});

test('a fully reserved passive allowance suppresses another progress message', async () => {
  const { state, io } = setup(); state.receipts[request.key].replies = 5;
  await expect(sendQQProgress(request, '收到', state, io)).resolves.toBe(false);
  expect(io.send).not.toHaveBeenCalled(); expect(state.receipts[request.key].replies).toBe(5);
});

test.each(['network', 'missing-receipt'])('uncertain progress delivery pauses without a resend: %s', async failure => {
  const { state, io } = setup();
  if (failure === 'network') io.send.mockRejectedValue(new Error('network'));
  else io.send.mockResolvedValue({});
  await expect(sendQQProgress(request, '收到', state, io)).rejects.toThrow();
  expect(state.receipts[request.key].status).toBe('unknown'); expect(state.paused).toBe(true);
  expect(io.send).toHaveBeenCalledTimes(1); expect(io.report).toHaveBeenCalledWith('qq_progress_unknown');
});

test('an explicit progress rejection continues the request without retrying the notice', async () => {
  const { state, io } = setup(); io.send.mockRejectedValue(new QQSendRejectedError(40034006));
  await expect(sendQQProgress(request, '收到', state, io)).resolves.toBe(true);
  expect(state.paused).toBe(false); expect(state.receipts[request.key].status).toBe('generating');
  expect(io.send).toHaveBeenCalledTimes(1); expect(io.report).toHaveBeenCalledWith('qq_progress_rejected');
});

test('expired windows and failed checkpoints suppress progress sending', async () => {
  const { state, io } = setup(); io.now = () => at + QQ_LIMITS.maxAgeMs;
  await expect(sendQQProgress(request, '收到', state, io)).resolves.toBe(false);
  expect(io.send).not.toHaveBeenCalled();
  io.now = () => at; io.save = jest.fn(async () => { throw new Error('disk'); });
  await expect(sendQQProgress(request, '收到', state, io)).rejects.toThrow('disk');
  expect(io.send).not.toHaveBeenCalled();
});
