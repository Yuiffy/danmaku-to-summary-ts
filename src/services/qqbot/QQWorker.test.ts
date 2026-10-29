import { QQConfig, QQInbound, QQRequest, QQ_FAILURE_REPLY, QQ_IMAGE_REPLY, QQ_LIMITS, QQ_PRIVATE_REPLY, qqRequest } from './QQPolicy';
import { QQTextAnswer, QQWorker } from './QQWorker';
import { newQQState } from './QQState';
import { QQRecordUpdate } from './QQRecords';
import { QQExecuteImage, QQImageCommand, QQImageDelivery, QQImageResult, QQImageToolResult, QQ_IMAGE_CONFIRM_PREFIX, QQ_IMAGE_LIMITS } from './QQImagePolicy';
import { qqFailure } from './QQDiagnostics';

const epoch = Date.parse('2026-10-28T02:00:00Z');
const config: QQConfig = { credentialsPath: 'credentials.json', providerConfigPath: 'provider.json', dailyTokenBudget: QQ_LIMITS.reservation * 8,
  maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY };
function setup(overrides: Partial<QQConfig> = {}) {
  let now = epoch;
  const state = newQQState('900000001');
  const saved: typeof state[] = [];
  const io = { now: () => now, save: jest.fn(async () => { saved.push(structuredClone(state)); }), record: jest.fn<Promise<void>, [QQRequest, QQRecordUpdate]>(async () => {}),
    answer: jest.fn<Promise<QQTextAnswer>, [QQRequest, AbortSignal, QQExecuteImage?]>(async () => '你好呀，今天想聊些什么？'),
    image: jest.fn<Promise<QQImageResult>, [QQRequest, AbortSignal, QQImageCommand?]>(async () => ({ file: 'image.png', model: 'gpt-image-2.5-sunburst', sha256: 'a'.repeat(64), prompt: 'scene' })),
    pendingImage: jest.fn<Promise<QQImageDelivery | undefined>, [QQRequest]>(async () => undefined),
    imageAdmission: jest.fn<string | undefined, [QQRequest]>(() => undefined),
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

test('image input diagnostics describe only authenticated accepted mentions without retaining media or quote identifiers', async () => {
  const { worker, message, io } = setup({ images: { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high',
    dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000 } });
  const source = { content_type: 'image/png', url: 'https://gchat.qpic.cn/image?private-token=secret' };
  const quoted = { msgType: 103, msgElements: [{ attachments: [source] }] };
  expect(worker.receive(message('noise', { ...quoted, rawEventType: 'GROUP_MESSAGE_CREATE' }))).toBe(false);
  expect(io.report).not.toHaveBeenCalled();
  const accepted = message('edit', { ...quoted, content: '把头像换成岁己' });
  expect(worker.receive(accepted)).toBe(true);
  expect(worker.receive(accepted)).toBe(false);
  await worker.idle();
  const events = io.report.mock.calls.map(([event]) => event).filter(event => event.event === 'qq_image_input');
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ event: 'qq_image_input', scope: 'group', requestId: qqRequest(accepted, epoch)!.key,
    imageInput: { messageType: 103, hasReference: false, attachmentCount: 0, elementCount: 1,
      elementAttachmentCount: 1, sourceCount: 1, inputPresent: true, invalid: false } });
  expect(JSON.stringify(events)).not.toMatch(/private-token|secret|gchat|member-a|group-a|把头像/u);
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
test('failure events and stored diagnostics share the receipt hash, including queue wait', async () => {
  const { worker, message, io, advance } = setup();
  const inbound = message();
  const id = qqRequest(inbound, epoch)!.key;
  io.answer.mockRejectedValue(qqFailure('model_budget', 'budget_exceeded', { turn: 4, budgetBefore: 60000, charge: 10000, budgetLimit: 65536 }));
  worker.receive(inbound); advance(45000); await worker.idle();
  expect(io.record.mock.calls.some(([, update]) => update.queuedMs === 45000)).toBe(true);
  expect(io.record.mock.calls.find(([, update]) => update.failure)?.[1]).toMatchObject({ error: 'model_failed', failure: { stage: 'model_budget', code: 'budget_exceeded', turn: 4 } });
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'qq_model_failed', requestId: id,
    failure: expect.objectContaining({ stage: 'model_budget', code: 'budget_exceeded', turn: 4, budgetBefore: 60000, charge: 10000, budgetLimit: 65536, elapsedMs: 0 }) }));
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'qq_reply_sent', requestId: id }));
  expect(io.record.mock.calls.at(-1)?.[1].status).toBe('sent');
});
test('trace persistence failure pauses the worker without sending a fallback reply', async () => {
  const { worker, message, io, state } = setup();
  io.answer.mockRejectedValue(qqFailure('trace_record', 'record_failed', { systemCode: 'ENOSPC' }));
  worker.receive(message()); await worker.idle();
  expect(state.paused).toBe(true); expect(io.send).not.toHaveBeenCalled();
  expect(io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'qq_state_failure', requestId: expect.stringMatching(/^[a-f0-9]{64}$/u), failure: expect.objectContaining({ code: 'record_failed' }) }));
});
test('an uncertain fallback send retains the original generation failure separately', async () => {
  const { worker, message, io, state } = setup();
  io.answer.mockRejectedValue(qqFailure('model_http', 'http_error', { httpStatus: 503 }));
  io.send.mockRejectedValue(Object.assign(new Error('private send detail'), { code: 'ECONNRESET' }));
  worker.receive(message()); await worker.idle();
  expect(state.paused).toBe(true);
  expect(io.record.mock.calls.find(([, update]) => update.failure)?.[1].failure).toMatchObject({ code: 'http_error', httpStatus: 503 });
  expect(io.record.mock.calls.find(([, update]) => update.sendFailure)?.[1]).toMatchObject({ status: 'unknown', sendFailure: { stage: 'send', code: 'send_failed', systemCode: 'ECONNRESET' } });
  expect(JSON.stringify(io.report.mock.calls)).not.toContain('private send detail');
});
test('deadline expiry is distinct from worker shutdown in persisted diagnostics', async () => {
  jest.useFakeTimers();
  try {
    const { worker, message, io } = setup();
    io.answer.mockImplementation(async (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    worker.receive(message());
    await jest.advanceTimersByTimeAsync(QQ_LIMITS.timeoutMs + 1); await worker.idle();
    expect(io.record.mock.calls.find(([, update]) => update.failure)?.[1].failure?.code).toBe('timeout');
    expect(io.send.mock.calls[0][1]).toBe(QQ_FAILURE_REPLY);
  } finally { jest.useRealTimers(); }
});
test('successful agents settle all model turns after a durable ceiling reservation, while invalid settlement keeps the ceiling', async () => {
  const { worker, message, io, state, saved } = setup();
  io.answer.mockResolvedValueOnce({ text: '10月27日唱歌看电影。', tokens: 4620 });
  worker.receive(message('agent')); await worker.idle();
  expect(saved.some(snapshot => snapshot.tokens === QQ_LIMITS.reservation && Object.values(snapshot.receipts)[0].status === 'generating')).toBe(true);
  expect(state.tokens).toBe(4620);
  expect(io.send.mock.calls[0][1]).toContain('看电影');
  io.answer.mockResolvedValueOnce({ text: '无效结算', tokens: -1 });
  worker.receive(message('invalid')); await worker.idle();
  expect(state.tokens).toBe(4620 + QQ_LIMITS.reservation);
  expect(io.send.mock.calls[1][1]).toBe(QQ_FAILURE_REPLY);
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
test('five-hour windows survive midnight while the daily budget resets', async () => {
  const { worker, message, io, state } = setup();
  const user = qqRequest(message(), epoch)!.user;
  state.day = '2026-10-27'; state.tokens = config.dailyTokenBudget;
  state.users[user] = { count: 100, starts: Array(QQ_LIMITS.userWindowReplies).fill(epoch - 60000) };
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
const images = { enabled: true, model: 'gpt-image-2.5-sunburst', quality: 'high' as const, dailyLimit: 300, userDailyLimit: 30, timeoutMs: 180000, characters: [] };
function imageAgent(mode: 'create' | 'edit' = 'create', overrides: Partial<QQConfig> = {}) {
  const fixture = setup({ images, ...overrides });
  fixture.io.answer.mockImplementation(async (request, _signal, execute) => {
    const result = await execute!({ mode, instruction: request.text, characters: [] });
    return { text: result.status === 'generated' ? '给你改好啦～' : result.message, tokens: 100 };
  });
  return fixture;
}

test.each(['改成一前一后抬棺', '生成图片,改成一前一后抬棺', '人物的位置照这个要求调整'])
('the agent selects editing independently of keyword routing: %s', async content => {
  const { worker, message, io, state } = imageAgent('edit');
  worker.receive(message('edit', { content, msgType: 103, msgElements: [{ msg_idx: 'own-image-index' }] })); await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.image).toHaveBeenCalledTimes(1);
  expect(io.image.mock.calls[0][0]).toMatchObject({ text: content, imageInput: { reply: 'own-image-index' } });
  expect(io.image.mock.calls[0][2]).toMatchObject({ mode: 'edit' });
  expect(state.images).toBe(1); expect(state.tokens).toBe(100);
  expect(io.send).toHaveBeenCalledWith(expect.anything(), '给你改好啦～', expect.objectContaining({ file: 'image.png' }));
});

test('the agent can answer image-related words or quoted chatter without executing any image tool', async () => {
  const { worker, message, io, state } = setup({ images });
  worker.receive(message('chat', { content: '生成图片这个功能怎么用', refMsgIdx: 'own-image-index' })); await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.image).not.toHaveBeenCalled(); expect(state.images || 0).toBe(0);
});

test('edit tool requires a source and create tool cannot discard a quoted source', async () => {
  const f = imageAgent('edit');
  f.worker.receive(f.message('missing', { content: '生成图片,改成一前一后抬棺' })); await f.worker.idle();
  expect(f.io.image).not.toHaveBeenCalled(); expect(f.io.send.mock.calls[0][1]).toContain('请引用要修改的图片');
  const g = imageAgent('create');
  g.worker.receive(g.message('discard', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成图片`, refMsgIdx: 'original' })); await g.worker.idle();
  expect(g.io.image).not.toHaveBeenCalled(); expect(g.io.send.mock.calls[0][1]).toContain('不能丢弃原图');
});

test.each(['生成岁己和栞栞在wwe赛场上大战的图片', '生成一张森亚露露卡抱向主视角的图', '生成星空图片', '请帮我画一个星汐'])
('a direct drawing request can spend image budget without a confirmation prefix: %s', async content => {
  const { worker, message, io, state } = imageAgent();
  worker.receive(message('direct', { content })); await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.image).toHaveBeenCalledTimes(1);
  expect(state.images).toBe(1); expect(state.tokens).toBe(100);
});

test.each(['生成图片这个功能怎么用', '不要生成星空图片', '“生成星空图片”是什么意思', '确认', '生成图片'])
('a model cannot authorize images from a question, negation, example or incomplete request: %s', async content => {
  const { worker, message, io, state, advance } = imageAgent();
  worker.receive(message('unconfirmed', { content })); await worker.idle();
  expect(io.answer).toHaveBeenCalledTimes(1); expect(io.image).not.toHaveBeenCalled();
  expect(state.images || 0).toBe(0); expect(state.tokens).toBe(100); expect(state.lastImageAt).toBeUndefined();
  expect(io.send.mock.calls[0][1]).toContain('请直接说明要画的主体和场景');
  advance(60001);
  worker.receive(message('confirmed', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.images).toBe(1);
});

test('image quota is durable before the paid tool and the artifact is archived before a single media reply', async () => {
  const { worker, message, io, state, saved } = imageAgent();
  io.image.mockImplementation(async () => {
    expect(saved.some(snapshot => snapshot.images === 1 && snapshot.tokens === QQ_LIMITS.reservation)).toBe(true);
    return { file: 'image.png', model: images.model, sha256: 'a'.repeat(64), prompt: 'scene' };
  });
  io.send.mockImplementation(async (_request, _text, image) => {
    expect(io.record.mock.calls.some(([, update]) => update.image?.sha256 === image?.sha256)).toBe(true);
  });
  worker.receive(message('image', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成三理在月球上的图片` })); await worker.idle();
  expect(state.images).toBe(1); expect(io.send).toHaveBeenCalledTimes(1);
});

test('personal image window admits ten and refuses the next tool call', async () => {
  const { worker, message, io, state, advance } = imageAgent();
  for (let i = 0; i < 11; i++) {
    advance(60001); worker.receive(message(`image-${i}`, { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  }
  expect(io.image).toHaveBeenCalledTimes(10); expect(state.images).toBe(10);
  expect(state.paused).toBe(false); expect(io.send.mock.calls[10][1]).toContain('每5小时最多10张');
});

test.each([-1, 0])('image window expires exactly at five hours (offset %i ms)', async offset => {
  const { worker, message, io, state } = imageAgent();
  const user = qqRequest(message(), epoch)!.user;
  state.day = '2026-10-28'; state.images = 10;
  state.users[user] = { count: 0, starts: [], images: 10, imageStarts: Array(10).fill(epoch - QQ_IMAGE_LIMITS.userWindowMs - offset) };
  worker.receive(message('boundary', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(offset === 0 ? 1 : 0);
  expect(state.users[user].images).toBe(offset === 0 ? 11 : 10);
});

test('daily counts reset at Shanghai midnight while image windows survive cleanup', async () => {
  const { worker, message, io, state, advance } = imageAgent();
  const user = qqRequest(message(), epoch)!.user;
  const midnight = Date.parse('2026-10-28T16:00:00Z');
  state.day = '2026-10-28'; state.images = 300;
  state.users[user] = { count: 0, starts: [], images: 30, imageStarts: Array(10).fill(midnight - 60000) };
  advance(midnight - epoch);
  worker.receive(message('midnight', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).not.toHaveBeenCalled(); expect(state.images).toBe(0); expect(state.users[user].imageStarts).toHaveLength(10);
  advance(QQ_IMAGE_LIMITS.userWindowMs);
  worker.receive(message('expired', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.users[user].images).toBe(1);
});

test.each(['daily', 'global', 'cooldown'])('image %s gate reports its actual cause without reserving an image', async gate => {
  const { worker, message, io, state } = imageAgent();
  const user = qqRequest(message(), epoch)!.user;
  state.day = '2026-10-28'; state.images = gate === 'global' ? 300 : 0;
  state.users[user] = { count: 0, starts: [], images: gate === 'daily' ? 30 : 0 };
  if (gate === 'cooldown') state.lastImageAt = epoch - 1000;
  worker.receive(message(gate, { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).not.toHaveBeenCalled(); expect(state.users[user].imageStarts).toEqual([]);
  expect(io.send.mock.calls[0][1]).toContain(gate === 'daily' ? '每天最多30张' : gate === 'global' ? '每天最多300张' : '至少1分钟');
});

test('global capacity admits the 300th image and blocks another user', async () => {
  const { worker, message, io, state, advance } = imageAgent();
  state.day = '2026-10-28'; state.images = 299;
  worker.receive(message('last', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle(); advance(60001);
  worker.receive(message('full', { senderId: 'member-b', content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.images).toBe(300); expect(io.send.mock.calls[1][1]).toContain('每天最多300张');
});

test('personal image quotas apply across groups and remain independent between members', async () => {
  const { worker, message, io, state } = imageAgent();
  const user = qqRequest(message(), epoch)!.user;
  state.day = '2026-10-28'; state.images = 10;
  state.users[user] = { count: 0, starts: [], images: 10, imageStarts: Array(10).fill(epoch - 60000) };
  worker.receive(message('other-group', { groupOpenid: 'group-b', content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).not.toHaveBeenCalled();
  worker.receive(message('other-member', { senderId: 'member-b', content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.users[user].images).toBe(10);
});

test('image failures spend one reservation, remain visible and cannot trigger another paid call', async () => {
  const { worker, message, io, state } = imageAgent();
  io.image.mockRejectedValue(new Error('private image diagnostics'));
  io.answer.mockImplementation(async (request, _signal, execute) => {
    const first = await execute!({ mode: 'create', instruction: request.text, characters: [] });
    const second = await execute!({ mode: 'create', instruction: '另一张图片', characters: [] });
    expect(second.status).toBe('blocked'); return { text: first.message, tokens: 100 };
  });
  worker.receive(message('image', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(io.image).toHaveBeenCalledTimes(1); expect(state.images).toBe(1); expect(io.send.mock.calls[0][2]).toBeUndefined();
  expect(io.record.mock.calls.some(([, update]) => update.error === 'image_failed')).toBe(true);
  expect(JSON.stringify(io.report.mock.calls)).not.toContain('private image diagnostics');
});

test('image checkpoint failure pauses before a paid tool and prevents replying', async () => {
  const { worker, message, io, state } = imageAgent();
  io.save.mockImplementation(async () => { if (state.images) throw new Error('disk full'); });
  worker.receive(message('image', { content: `${QQ_IMAGE_CONFIRM_PREFIX}生成星空图片` })); await worker.idle();
  expect(state.paused).toBe(true); expect(io.image).not.toHaveBeenCalled(); expect(io.send).not.toHaveBeenCalled();
});

test('background admission reserves once and a later pickup bypasses model and image quotas', async () => {
  const f = imageAgent();
  const enqueue = jest.fn<Promise<QQImageToolResult>, [QQRequest, QQImageCommand]>(async () => ({ status: 'pending', message: '图片任务已接收，稍后再次艾特领取。' }));
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io, enqueueImage: enqueue });
  f.io.answer.mockImplementation(async (request, _signal, execute) => {
    await execute!({ mode: 'create', instruction: request.text, characters: [] });
    return { text: '图片已经画好啦', tokens: 100 };
  });
  worker.receive(f.message('original', { content: '生成星空图片' })); await worker.idle();
  expect(enqueue).toHaveBeenCalledTimes(1); expect(f.io.image).not.toHaveBeenCalled();
  expect(f.state.images).toBe(1); expect(f.io.send.mock.calls[0][1]).toContain('已接收');
  f.advance(360000);
  f.io.pendingImage.mockResolvedValueOnce({ text: '上次的图片生成完成', image: { file: 'pickup.png', model: images.model, sha256: 'b'.repeat(64), prompt: 'scene' } });
  worker.receive(f.message('pickup', { content: '' })); await worker.idle();
  expect(f.state.images).toBe(1); expect(f.state.tokens).toBe(100); expect(f.io.answer).toHaveBeenCalledTimes(1);
  expect(f.io.send.mock.calls[1][2]?.file).toBe('pickup.png');
  expect(f.io.record.mock.calls.some(([, update]) => update.image?.sha256 === 'b'.repeat(64))).toBe(true);
});

test('a fast durable image is sent on the original mention instead of forcing a second mention', async () => {
  const f = imageAgent();
  const image = { file: 'ready.png', model: images.model, sha256: 'b'.repeat(64), prompt: 'scene' };
  const waitImage = jest.fn(async () => { f.advance(68000); return { text: '图片生成完成。', image }; });
  const enqueueImage = jest.fn(async () => ({ status: 'pending' as const, message: '后台生成，请再次艾特领取。' }));
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io, ...{ waitImage, enqueueImage } });
  worker.receive(f.message('fast', { content: '生成星空图片' })); await worker.idle();
  expect(waitImage).toHaveBeenCalledTimes(1); expect(f.io.send).toHaveBeenCalledWith(expect.anything(), '图片生成完成。', image);
  expect(f.io.send).toHaveBeenCalledTimes(1); expect(enqueueImage).toHaveBeenCalledTimes(1); expect(f.io.image).not.toHaveBeenCalled();
  expect(f.state.images).toBe(1); expect(f.state.tokens).toBe(100);
  expect(f.io.record.mock.calls.some(([, update]) => update.image?.sha256 === image.sha256)).toBe(true);
});

test('only a slow image falls back, with queue and model time deducted and twenty seconds left for sending', async () => {
  const f = imageAgent();
  const waitImage = jest.fn(async (_request: QQRequest, _signal: AbortSignal, waitMs: number) => { f.advance(waitMs); return undefined; });
  const enqueueImage = jest.fn(async () => ({ status: 'pending' as const, message: '后台生成，请再次艾特领取。' }));
  f.io.answer.mockImplementation(async (request, _signal, execute) => {
    f.advance(45000); const result = await execute!({ mode: 'create', instruction: request.text, characters: [] });
    return { text: result.message, tokens: 100 };
  });
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io, waitImage, enqueueImage });
  worker.receive(f.message('slow', { content: '生成星空图片' })); f.advance(30000); await worker.idle();
  expect(waitImage.mock.calls[0][2]).toBe(145000);
  expect(f.io.send.mock.calls[0][1]).toContain('再次艾特'); expect(f.io.send.mock.calls[0][2]).toBeUndefined();
  expect(f.io.send).toHaveBeenCalledTimes(1); expect(f.state.images).toBe(1);
  expect(f.io.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'qq_image_deferred', elapsedMs: 220000 }));
});

test('a wait checkpoint failure pauses without sending a misleading acceptance or image', async () => {
  const f = imageAgent();
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io,
    enqueueImage: async () => ({ status: 'pending', message: 'pending' }), waitImage: async () => { throw new Error('disk full'); } });
  worker.receive(f.message('failure', { content: '生成星空图片' })); await worker.idle();
  expect(f.state.paused).toBe(true); expect(f.io.send).not.toHaveBeenCalled(); expect(f.io.image).not.toHaveBeenCalled();
});

test('stopping during the reply wait suppresses any send', async () => {
  const f = imageAgent();
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io,
    enqueueImage: async () => ({ status: 'pending', message: 'pending' }), waitImage: async (_request, signal) => {
      worker.stop(); expect(signal.aborted).toBe(true); return undefined;
    } });
  worker.receive(f.message('stop', { content: '生成星空图片' })); await worker.idle();
  expect(f.io.send).not.toHaveBeenCalled(); expect(f.state.images).toBe(1);
});

test('pending status replies do not consume model or image budget even when the daily model budget is exhausted', async () => {
  const f = setup({ images }); f.state.day = '2026-10-28'; f.state.tokens = config.dailyTokenBudget;
  f.io.pendingImage.mockResolvedValue({ text: '上一张图还在后台生成' });
  f.worker.receive(f.message('waiting')); await f.worker.idle();
  expect(f.io.answer).not.toHaveBeenCalled(); expect(f.io.image).not.toHaveBeenCalled();
  expect(f.state.tokens).toBe(config.dailyTokenBudget); expect(f.state.images || 0).toBe(0);
  expect(f.io.send.mock.calls[0][1]).toContain('后台生成');
});

test('background capacity rejection happens before image quota reservation', async () => {
  const f = imageAgent(); f.io.imageAdmission.mockReturnValue('后台已有两张图在生成');
  f.worker.receive(f.message('full', { content: '生成星空图片' })); await f.worker.idle();
  expect(f.io.image).not.toHaveBeenCalled(); expect(f.state.images || 0).toBe(0);
  expect(f.io.send.mock.calls[0][1]).toContain('两张图');
});

test('background journal admission failure pauses before sending an acknowledgement', async () => {
  const f = imageAgent();
  const worker = new QQWorker({ ...config, images }, f.state, { ...f.io, enqueueImage: async () => { throw new Error('disk full'); } });
  worker.receive(f.message('image', { content: '生成星空图片' })); await worker.idle();
  expect(f.state.paused).toBe(true); expect(f.io.send).not.toHaveBeenCalled(); expect(f.io.image).not.toHaveBeenCalled();
});
