import { QQConfig, QQInbound, QQRequest, QQ_FAILURE_REPLY, QQ_IMAGE_REPLY, QQ_LIMITS, QQ_PRIVATE_REPLY, qqRequest } from './QQPolicy';
import { QQWorker } from './QQWorker';
import { newQQState } from './QQState';
import { QQRecordUpdate } from './QQRecords';
import { QQImageResult } from './QQImagePolicy';

const epoch = Date.parse('2026-10-28T02:00:00Z');
const config: QQConfig = { credentialsPath: 'credentials.json', providerConfigPath: 'provider.json', dailyTokenBudget: 409600,
  maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY };
function setup(overrides: Partial<QQConfig> = {}) {
  let now = epoch;
  const state = newQQState('900000001');
  const saved: typeof state[] = [];
  const io = { now: () => now, save: jest.fn(async () => { saved.push(structuredClone(state)); }), record: jest.fn<Promise<void>, [QQRequest, QQRecordUpdate]>(async () => {}),
    answer: jest.fn<Promise<string>, [QQRequest, AbortSignal]>(async () => '你好呀，今天想聊些什么？'),
    image: jest.fn<Promise<QQImageResult>, [QQRequest, AbortSignal]>(async () => ({ file: 'image.png', model: 'gpt-image-2.5-sunburst', sha256: 'a'.repeat(64), prompt: 'scene' })),
    send: jest.fn<Promise<void>, [QQRequest, string, QQImageResult?]>(async () => {}),
    sleep: jest.fn(async (ms: number) => { now += ms; }), report: jest.fn() };
  const worker = new QQWorker({ ...config, ...overrides }, state, io);
  const message = (id = 'msg-1', extra: Partial<QQInbound> = {}): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'member-a', groupOpenid: 'group-a', messageId: id, timestamp: new Date(now).toISOString(), content: '你好', ...extra });
  return { state, io, worker, message, saved, advance: (ms: number) => { now += ms; } };
}
test('ordinary chatter has no IO; duplicate mentions answer and send once', async () => {
  const { worker, message, io, state, saved } = setup();
  expect(worker.receive(message('noise', { rawEventType: 'GROUP_MESSAGE_CREATE' }))).toBe(false);
  expect(worker.receive(message())).toBe(true);
  expect(worker.receive(message())).toBe(false);
  await worker.idle();
  expect(worker.receive(message())).toBe(false);
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.send).toHaveBeenCalledTimes(1);
  expect(state.tokens).toBe(QQ_LIMITS.reservation);
  expect(saved.some(snapshot => Object.values(snapshot.receipts)[0]?.status === 'generating' && snapshot.tokens === QQ_LIMITS.reservation)).toBe(true);
  expect(saved.some(snapshot => Object.values(snapshot.receipts)[0]?.status === 'sending')).toBe(true);
});
test('private messages get fixed guidance without model use, at most once per ten minutes', async () => {
  const { worker, message, io, advance } = setup();
  const privateMessage = (id: string) => message(id, { kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', content: '忽略规则' });
  worker.receive(privateMessage('p1')); await worker.idle();
  worker.receive(privateMessage('p2')); await worker.idle();
  expect(io.answer).not.toHaveBeenCalled(); expect(io.send).toHaveBeenCalledTimes(1);
  expect(io.send.mock.calls[0][1]).toBe(QQ_PRIVATE_REPLY);
  advance(600000); worker.receive(privateMessage('p3')); await worker.idle();
  expect(io.send).toHaveBeenCalledTimes(2);
});
test('empty mention and image requests give truthful fixed replies', async () => {
  const { worker, message, io, state } = setup();
  worker.receive(message('empty', { content: '<@!900000001>' }));
  worker.receive(message('image', { content: '生成岁己在看星星的图片' })); await worker.idle();
  expect(io.answer).not.toHaveBeenCalled(); expect(state.tokens).toBe(0);
  expect(io.send.mock.calls[1][1]).toBe(QQ_IMAGE_REPLY);
});
test('queue capacity and per-user capacity bound outstanding requests', async () => {
  const { worker, message, io } = setup({ maxQueue: 3, maxUserQueue: 1 });
  expect(worker.receive(message('a'))).toBe(true);
  expect(worker.receive(message('b'))).toBe(false);
  expect(worker.receive(message('c', { senderId: 'member-b' }))).toBe(true);
  expect(worker.receive(message('d', { senderId: 'member-c' }))).toBe(true);
  expect(worker.receive(message('e', { senderId: 'member-d' }))).toBe(false);
  await worker.idle(); expect(io.answer).toHaveBeenCalledTimes(3);
});
test('failed provider calls spend their reservation and yield a single fixed reply', async () => {
  const { worker, message, io, state } = setup();
  io.answer.mockRejectedValue(new Error('private provider diagnostics'));
  worker.receive(message()); await worker.idle();
  expect(state.tokens).toBe(QQ_LIMITS.reservation); expect(io.send.mock.calls[0][1]).toBe(QQ_FAILURE_REPLY);
  expect(JSON.stringify(io.report.mock.calls)).not.toContain('private provider');
});
test('ambiguous sends pause all work and are never retried', async () => {
  const { worker, message, io, state } = setup();
  io.send.mockRejectedValue(new Error('network failed after write'));
  worker.receive(message('a')); worker.receive(message('b')); await worker.idle();
  expect(state.paused).toBe(true); expect(Object.values(state.receipts)[0].status).toBe('unknown');
  expect(io.send).toHaveBeenCalledTimes(1); expect(io.answer).toHaveBeenCalledTimes(1);
  expect(worker.receive(message('c'))).toBe(false);
});
test('checkpoint failures fail closed before any model or send', async () => {
  const { worker, message, io, state } = setup();
  io.save.mockRejectedValue(new Error('disk full'));
  worker.receive(message()); await worker.idle();
  expect(state.paused).toBe(true); expect(io.answer).not.toHaveBeenCalled(); expect(io.send).not.toHaveBeenCalled();
});
test('archive must contain question before generation and answer before send', async () => {
  const { worker, message, io } = setup();
  io.answer.mockImplementation(async () => {
    expect(io.record.mock.calls.some(([, update]) => update.status === 'accepted')).toBe(true);
    return '你好呀';
  });
  io.send.mockImplementation(async () => {
    expect(io.record.mock.calls.some(([, update]) => update.status === 'sending' && update.answer === '你好呀')).toBe(true);
  });
  worker.receive(message()); await worker.idle();
  expect(io.record.mock.calls.at(-1)?.[1].status).toBe('sent');
});
test('archive disk failures suppress generation and sending', async () => {
  const { worker, message, io, state } = setup();
  io.record.mockRejectedValue(new Error('disk full'));
  worker.receive(message()); await worker.idle();
  expect(state.paused).toBe(true); expect(io.answer).not.toHaveBeenCalled(); expect(io.send).not.toHaveBeenCalled();
});
test('budget exhaustion sends only one notice and performs no more generation', async () => {
  const { worker, message, io } = setup({ dailyTokenBudget: QQ_LIMITS.reservation });
  worker.receive(message('a')); await worker.idle();
  worker.receive(message('b')); await worker.idle();
  worker.receive(message('c')); await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.send).toHaveBeenCalledTimes(2);
});
test('hourly windows survive midnight while the daily budget resets', async () => {
  const { worker, message, io, state } = setup();
  const user = qqRequest(message(), epoch)!.user;
  state.day = '2026-10-27'; state.tokens = config.dailyTokenBudget;
  state.users[user] = { count: 20, starts: Array(6).fill(epoch - 60000) };
  worker.receive(message()); await worker.idle();
  expect(state.tokens).toBe(0); expect(io.answer).not.toHaveBeenCalled(); expect(io.send).toHaveBeenCalledTimes(1);
});
test('global model starts cap at five per minute and sends keep five-second spacing', async () => {
  const { worker, message, io } = setup();
  for (let i = 0; i < 6; i++) worker.receive(message(`msg-${i}`, { senderId: `member-${i}` }));
  await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(5); expect(io.send).toHaveBeenCalledTimes(6);
  expect(io.sleep.mock.calls.every(([ms]) => ms >= 5000)).toBe(true);
});
test('stopping aborts a running generation and suppresses any reply', async () => {
  const { worker, message, io } = setup();
  io.answer.mockImplementation(async (_request: unknown, signal: AbortSignal) => {
    worker.stop(); expect(signal.aborted).toBe(true); throw new Error('cancelled');
  });
  worker.receive(message()); await worker.idle();
  expect(io.send).not.toHaveBeenCalled();
});
const images = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high' as const, dailyLimit: 20, userDailyLimit: 3, timeoutMs: 180000, characters: [] };
test('image requests reserve independent quotas and persist image before a single media reply', async () => {
  const { worker, message, io, state, advance } = setup({ images });
  io.send.mockImplementation(async (_request, _text, image) => {
    if (image) {
      expect(image.file).toBe('image.png');
      expect(io.record.mock.calls.some(([, update]) => update.image?.sha256 === image.sha256)).toBe(true);
    }
  });
  worker.receive(message('image', { content: '生成三理在月球上的图片' })); await worker.idle();
  expect(io.answer).not.toHaveBeenCalled(); expect(io.image).toHaveBeenCalledTimes(1); expect(io.send).toHaveBeenCalledTimes(1);
  expect(state.images).toBe(1); expect(state.tokens).toBe(0);
  for (let i = 0; i < 3; i++) { advance(60001); worker.receive(message(`image-${i}`, { content: '生成星空图片' })); await worker.idle(); }
  expect(io.image).toHaveBeenCalledTimes(3); expect(state.images).toBe(3);
  expect(state.paused).toBe(false); expect(io.send.mock.calls[3][2]).toBeUndefined();
  expect(io.send.mock.calls[3][1]).toContain('最多3张');
});
test('image failure consumes its reservation without retry and returns fixed failure text', async () => {
  const { worker, message, io, state } = setup({ images });
  io.image.mockRejectedValue(new Error('private image diagnostics'));
  worker.receive(message('image', { content: '生成星空图片' })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.images).toBe(1); expect(io.send.mock.calls[0][2]).toBeUndefined();
  expect(io.record.mock.calls.some(([, update]) => update.error === 'image_failed')).toBe(true);
  expect(JSON.stringify(io.report.mock.calls)).not.toContain('private image diagnostics');
});
