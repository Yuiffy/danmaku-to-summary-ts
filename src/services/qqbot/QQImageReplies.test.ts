import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QQImageJobs } from './QQImageJobs';
import { QQImageResult } from './QQImagePolicy';
import { QQConfig, QQInbound, QQRequest, QQ_LIMITS, qqDigest, qqRequest, qqImageReplyTrigger } from './QQPolicy';
import { newQQState, validateQQState } from './QQState';
import { QQWorker, QQWorkerIO } from './QQWorker';
import { sendQQProgress } from './QQReplyDelivery';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQRecordUpdate } from './QQRecords';
import { qqImageQueuedInput } from './QQImageQueueInputs';
import { qqFailure } from './QQDiagnostics';

const appId = '900000001', epoch = Date.parse('2026-11-16T10:00:00Z');
const config: QQConfig = { credentialsPath: 'credentials.json', providerConfigPath: 'provider.json',
  dailyTokenBudget: QQ_LIMITS.reservation * 20, maxQueue: 20, maxUserQueue: 2, privateReply: '请在群里提问。',
  images: { enabled: true, background: true, model: 'gpt-image-2.5-sunburst', timeoutMs: 900000,
    dailyLimit: 300, userDailyLimit: 30 } };
let root: string;
let cleanup: (() => Promise<void>) | undefined;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-replies-')); });
afterEach(async () => { await cleanup?.(); cleanup = undefined; await fs.rm(root, { recursive: true, force: true }); });

async function fixture(overrides: Partial<QQConfig> = {}, materials?: { sources: number; references: number }) {
  let now = epoch;
  const runtime: { worker?: QQWorker } = {};
  const state = newQQState(appId);
  const pending = new Map<string, (result: QQImageResult) => void>();
  const failures = new Map<string, (error: Error) => void>();
  const timers = new Map<() => void, number>();
  const completed = new Map<string, () => void>();
  const generate = jest.fn((request: QQRequest, signal: AbortSignal) => new Promise<QQImageResult>((resolve, reject) => {
    pending.set(request.key, resolve); failures.set(request.key, reject); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const jobs = new QQImageJobs(root, appId, 900000, { now: () => now, generate, fatal: jest.fn(async () => {}),
    ...(materials ? { prepare: async (request: QQRequest, command: Parameters<typeof qqImageQueuedInput>[1]) => ({
      ...qqImageQueuedInput(request, command, Array.from({ length: materials.sources }, (_, index) => qqDigest(String(index)))),
      referenceCount: materials.references }) } : {}),
    report: event => {
      if (['qq_image_job_ready', 'qq_image_job_failed'].includes(event.event)) { runtime.worker?.imageReady(event.requestId); completed.get(event.requestId)?.(); }
    } });
  await jobs.open();
  const record = jest.fn<Promise<void>, [QQRequest, QQRecordUpdate]>(async () => {});
  const save = jest.fn(async () => { validateQQState(state, appId); });
  const send = jest.fn<Promise<void>, [QQRequest, string, QQImageResult?]>(async request => { await jobs.delivered(request); });
  const answer = jest.fn<QQWorkerIO['answer']>(async (request, _signal, execute) => {
    if (request.text.startsWith('生成')) await execute!({ mode: 'create', instruction: request.text, characters: [] });
    return { text: '当前问题的回答。', tokens: 100 };
  });
  const progress = jest.fn<Promise<{ id: string }>, [QQRequest, string]>(async () => ({ id: 'progress' }));
  const worker = new QQWorker({ ...config, ...overrides }, state, { now: () => now, save, record, send, answer,
    sleep: async ms => { now += ms; }, report: jest.fn(),
    schedule: (callback, ms) => { timers.set(callback, now + ms); return () => { timers.delete(callback); }; },
    acknowledge: (request, text) => sendQQProgress(request, text, state, { now: () => now, save, record,
      stopping: () => false, sleep: async ms => { now += ms; }, send: async text => progress(request, text), report: () => {} }),
    pendingImage: request => jobs.pending(request), enqueueImage: (request, command) => jobs.enqueue(request, command),
    readImageTask: (request, position) => position === undefined ? jobs.activeTasks(request) : jobs.status(request, position),
    collectImage: (request, position) => jobs.collect(request, position),
    imagePickup: { count: request => jobs.countUnsent(request), next: request => jobs.ready(request, undefined, true),
      release: request => jobs.releaseUnsent(request) },
    hasReadyImage: request => jobs.hasReady(request), imagePending: key => jobs.isPending(key), readyImage: (request, key) => jobs.ready(request, key) });
  runtime.worker = worker;
  cleanup = async () => { worker.stop(); await worker.idle(); await jobs.close(); };
  const message = (id: string, content: string, extra: Partial<QQInbound> = {}): QQInbound => ({ kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'member-a', messageId: id, groupOpenid: 'group-a',
    timestamp: new Date(now).toISOString(), content, ...extra });
  const submit = async (id: string) => {
    const event = message(id, '生成星空图片'); const request = qqRequest(event, now)!;
    expect(worker.receive(event)).toBe(true); await worker.idle(); return request;
  };
  const complete = async (request: QQRequest, waitWorker = true) => {
    const ready = new Promise<void>(resolve => { completed.set(request.key, resolve); });
    const bytes = Buffer.from(`image for ${request.key}`);
    const file = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(request.createdAt), `${request.key}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    // A preceding completion may still be dispatching this queued request.
    for (let turn = 0; !pending.has(request.key) && turn < 100; turn++) await new Promise(resolve => setImmediate(resolve));
    expect(pending.has(request.key)).toBe(true);
    pending.get(request.key)!({ file, model: config.images!.model, sha256: qqDigest(bytes), prompt: request.text });
    await ready; if (waitWorker) await worker.idle();
  };
  const journal = async () => JSON.parse(await fs.readFile(path.join(root, 'data/runtime/qqbot/image-jobs', `${appId}.json`), 'utf8'));
  const fail = async (request: QQRequest, error = new Error('provider failed')) => {
    const finished = new Promise<void>(resolve => { completed.set(request.key, resolve); });
    failures.get(request.key)!(error); await finished; await worker.idle();
  };
  const taskAnswer = (action: 'read' | 'collect', position?: number) => answer.mockImplementationOnce(async (_request, _signal, _execute, tasks) =>
    ({ text: (await tasks![action](position)).message, tokens: 100 }));
  return { worker, jobs, state, send, answer, taskAnswer, save, record, generate, progress, message, submit, complete, journal,
    fail, timers, now: () => now, advance: (ms: number) => {
      now += ms;
      for (const [callback, at] of [...timers]) if (at <= now) { timers.delete(callback); callback(); }
    } };
}

test('background completion sends on the original window without blocking another question or charging again', async () => {
  const f = await fixture(); const original = await f.submit('original');
  expect(f.send).not.toHaveBeenCalled(); expect(f.state.receipts[original.key].replies).toBe(1);
  f.worker.receive(f.message('chat', '你好', { senderId: 'member-b' })); await f.worker.idle();
  expect(f.send.mock.calls[0][1]).toBe('当前问题的回答。');
  f.advance(90000); await f.complete(original);
  expect(f.send.mock.calls[1]).toEqual([original, '图片生成完成。', expect.objectContaining({ sha256: expect.any(String) })]);
  expect(f.state.receipts[original.key].replies).toBe(2); // receipt, finished image
  expect(f.timers.size).toBe(0);
  f.advance(QQ_LIMITS.maxAgeMs); await f.worker.idle(); expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.state.images).toBe(1); expect(f.state.tokens).toBe(200); expect(f.generate).toHaveBeenCalledTimes(1);
  expect((await f.journal()).jobs[original.key].status).toBe('delivered');
});

test.each(['running', 'queued', 'ready', 'failed'] as const)('the image owner can ask a new question while the latest image is %s', async phase => {
  const f = await fixture();
  if (phase === 'queued') { await f.submit('busy-a'); await f.submit('busy-b'); }
  const original = await f.submit('original');
  if (phase === 'ready' || phase === 'failed') {
    f.advance(QQ_LIMITS.maxAgeMs + 1);
    if (phase === 'ready') await f.complete(original); else await f.fail(original);
  }
  expect((await f.journal()).jobs[original.key].status).toBe(phase);
  const modelCalls = f.answer.mock.calls.length, imageCharges = f.state.images, generations = f.generate.mock.calls.length;
  f.send.mockClear();
  const event = f.message('new-question', '今天minimax和智谱和nvidia和amd怎么样');
  expect(f.worker.receive(event)).toBe(true); await f.worker.idle();
  expect(f.answer).toHaveBeenCalledTimes(modelCalls + 1);
  expect(f.send.mock.calls[0]).toEqual([expect.objectContaining({ msgId: event.messageId }), '当前问题的回答。', undefined]);
  expect(f.state.images).toBe(imageCharges); expect(f.generate).toHaveBeenCalledTimes(generations);
  if (phase === 'ready') {
    expect(f.send.mock.calls).toHaveLength(2); expect(f.send.mock.calls[1][2]).toBeDefined();
    expect((await f.journal()).jobs[original.key].status).toBe('delivered');
  } else expect((await f.journal()).jobs[original.key].status).toBe(phase);
  if (phase === 'running') {
    await f.complete(original);
    expect(f.send.mock.calls.filter(([request, , image]) => request.key === original.key && image)).toHaveLength(1);
  }
});

test.each(['收图', '图来', '图呢', '把图发我', '能交货了吗', '我刚才没收到，给一下呗'])('agent-selected image collection reports the actual task: %s', async content => {
  const f = await fixture(); await f.submit('original');
  const calls = f.answer.mock.calls.length;
  f.taskAnswer('collect');
  expect(f.worker.receive(f.message('image-status', content))).toBe(true); await f.worker.idle();
  expect(f.answer).toHaveBeenCalledTimes(calls + 1);
  expect(f.send.mock.calls[0][1]).toContain('后台生成');
  expect(f.generate).toHaveBeenCalledTimes(1); expect(f.state.images).toBe(1);
});

test.each(['queued', 'ready', 'failed'] as const)('agent collection reports the latest %s job without generating again', async phase => {
  const f = await fixture();
  if (phase === 'queued') { await f.submit('busy-a'); await f.submit('busy-b'); }
  const original = await f.submit('original');
  if (phase !== 'queued') {
    f.advance(QQ_LIMITS.maxAgeMs + 1);
    if (phase === 'ready') await f.complete(original);
    else await f.fail(original, qqFailure('image_http', 'image_sexual', { httpStatus: 400 }));
  }
  const calls = f.answer.mock.calls.length, charges = f.state.images, generations = f.generate.mock.calls.length;
  f.send.mockClear();
  f.taskAnswer('collect');
  expect(f.worker.receive(f.message('pickup', '图来'))).toBe(true); await f.worker.idle();
  expect(f.answer).toHaveBeenCalledTimes(calls + 1);
  expect(f.send).toHaveBeenCalledTimes(1);
  if (phase === 'ready') expect(f.send.mock.calls[0][2]?.sha256).toBe(qqDigest(Buffer.from(`image for ${original.key}`)));
  else expect(f.send.mock.calls[0][1]).toContain(phase === 'queued' ? '排队' : '太色了');
  expect(f.state.images).toBe(charges); expect(f.generate).toHaveBeenCalledTimes(generations);
});

test('agent status query reads a completed task without delivering it or borrowing the window for another image', async () => {
  const f = await fixture(); const original = await f.submit('original');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  const before = await f.journal(); f.taskAnswer('read', 1);
  f.worker.receive(f.message('query', '刚才那单到哪一步了？')); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][1]).toContain('可以领取');
  expect(f.send.mock.calls[0][2]).toBeUndefined(); expect(await f.journal()).toEqual(before);
  expect(f.generate).toHaveBeenCalledTimes(1); expect(f.state.images).toBe(1);
});

test.each(['ready', 'failed'] as const)('an explicit older pickup reports the %s task even after a newer image was delivered', async status => {
  const f = await fixture(); const previous = await f.submit('previous');
  f.advance(1000);
  const latest = await f.submit('latest'); await f.complete(latest);
  f.advance(QQ_LIMITS.maxAgeMs + 1);
  if (status === 'ready') await f.complete(previous);
  else await f.fail(previous, qqFailure('image_http', 'image_moderation', { httpStatus: 400 }));
  f.send.mockClear();
  const before = await f.journal();
  expect(before.jobs[latest.key].status).toBe('delivered');

  f.taskAnswer('read', 2);
  f.worker.receive(f.message('query-previous', '再上一张到哪了？')); await f.worker.idle();
  expect(f.send.mock.calls[0][1]).toContain(status === 'ready' ? '可以领取' : '过不了审核');
  expect(f.send.mock.calls[0][2]).toBeUndefined();
  expect(await f.journal()).toEqual(before);

  f.taskAnswer('collect', 2);
  f.worker.receive(f.message('pickup-previous', '领取再上一张')); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(2);
  if (status === 'ready') expect(f.send.mock.calls[1][2]?.sha256).toBe(qqDigest(Buffer.from(`image for ${previous.key}`)));
  else {
    expect(f.send.mock.calls[1][1]).toContain('过不了审核');
    expect(f.send.mock.calls[1][2]).toBeUndefined();
  }
  const after = await f.journal();
  expect(after.jobs[previous.key].status).toBe('delivered');
  expect(after.jobs[latest.key]).toEqual(before.jobs[latest.key]);
  expect(await f.jobs.collect(previous, 3)).toEqual({ text: expect.stringContaining('没找到') });
  expect(f.generate).toHaveBeenCalledTimes(2); expect(f.state.images).toBe(2);
});

test('a claimed image still arrives when the model fails after calling collect', async () => {
  const f = await fixture(); const original = await f.submit('original');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  f.answer.mockImplementationOnce(async (_request, _signal, _execute, tasks) => {
    await tasks!.collect(); throw new Error('model failed after tool completion');
  });
  f.worker.receive(f.message('pickup', '刚才那张给我一下')); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][2]).toBeDefined();
  expect((await f.journal()).jobs[original.key].status).toBe('delivered'); expect(f.generate).toHaveBeenCalledTimes(1);
});

test('collection is single-use per message and prevents a later generation call in the same agent run', async () => {
  const f = await fixture(); const original = await f.submit('original');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  f.answer.mockImplementationOnce(async (_request, _signal, execute, tasks) => {
    expect((await tasks!.collect()).status).toBe('ready');
    expect((await tasks!.collect()).message).toContain('不能重复');
    expect((await execute!({ mode: 'create', instruction: '生成星空图片', characters: [] })).status).toBe('blocked');
    return { text: '取到了。', tokens: 100 };
  });
  f.worker.receive(f.message('pickup', '取来吧')); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1); expect(f.state.images).toBe(1);
});

test('collage admissions notify immediately for running and queued jobs even when the agent omits the notice', async () => {
  const f = await fixture({}, { sources: 12, references: 2 });
  const requests = [await f.submit('packed-a'), await f.submit('packed-b'), await f.submit('packed-c')];
  const journal = await f.journal();
  expect(journal.jobs[requests[0].key].status).toBe('running');
  expect(journal.jobs[requests[2].key].status).toBe('queued');
  for (const request of requests) {
    const notices = f.progress.mock.calls.filter(([sent, text]) => sent.key === request.key && text.includes('拼图后提交'));
    expect(notices).toHaveLength(1);
    expect(notices[0][1]).toContain('12张原图、2张角色参考，共8张上传图');
    expect(notices[0][1]).toContain('细节可能有所损失');
    expect(f.state.receipts[request.key].replies).toBe(2);
    expect(f.worker.receive(f.message(request.msgId, '生成星空图片'))).toBe(false);
  }
  expect(f.send).not.toHaveBeenCalled();
  f.advance(30000); await f.complete(requests[0]); await f.complete(requests[2]); await f.complete(requests[1]);
  expect(f.send.mock.calls.filter(([, , image]) => image)).toHaveLength(3);
  expect(f.generate).toHaveBeenCalledTimes(3); expect(f.state.images).toBe(3);
  expect(f.progress.mock.calls.filter(([, text]) => text.includes('拼图后提交'))).toHaveLength(3);
  for (const request of requests) expect((await f.journal()).jobs[request.key].status).toBe('delivered');
});

test('eight total materials do not add a collage acceptance message', async () => {
  const f = await fixture({}, { sources: 6, references: 2 });
  const request = await f.submit('unpacked');
  expect(f.progress).toHaveBeenCalledTimes(1);
  expect(f.progress.mock.calls[0][1]).not.toContain('拼图');
  expect(f.state.receipts[request.key].replies).toBe(1);
});

test('queued images also automatically reply when they finish inside their original window', async () => {
  const f = await fixture(); const a = await f.submit('a'), b = await f.submit('b'), c = await f.submit('c');
  expect((await f.journal()).jobs[c.key].status).toBe('queued');
  f.advance(30000); await f.complete(a); await f.complete(c);
  expect(f.send.mock.calls.filter(([request, , image]) => request.key === c.key && image)).toHaveLength(1);
  await f.complete(b); expect(f.generate).toHaveBeenCalledTimes(3);
});

test('only a still-pending job near the original deadline gets one pickup notice, then a fresh event delivers it', async () => {
  const f = await fixture(); const original = await f.submit('slow');
  f.advance(original.createdAt + QQ_LIMITS.maxAgeMs - 20001 - f.now()); await f.worker.idle();
  expect(f.send).not.toHaveBeenCalled(); expect(f.state.receipts[original.key].replies).toBe(1);
  f.advance(1); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][1]).toContain('稍后艾特我领取');
  expect(f.send.mock.calls[0][2]).toBeUndefined(); expect(f.state.receipts[original.key].replies).toBe(2);
  expect(f.timers.size).toBe(0);
  f.advance(60000); await f.complete(original);
  expect(f.send).toHaveBeenCalledTimes(1); expect((await f.journal()).jobs[original.key].status).toBe('ready');
  f.worker.receive(f.message('next-opportunity', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' })); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[1][2]).toBeDefined();
  expect(f.generate).toHaveBeenCalledTimes(1); expect(f.answer).toHaveBeenCalledTimes(1);
});

test('queued tasks also wait until their own original deadline before any pickup notice', async () => {
  const f = await fixture(); await f.submit('running-a'); await f.submit('running-b'); const queued = await f.submit('queued');
  expect((await f.journal()).jobs[queued.key].status).toBe('queued'); expect(f.send).not.toHaveBeenCalled();
  f.advance(queued.createdAt + QQ_LIMITS.maxAgeMs - 20000 - f.now()); await f.worker.idle();
  const notices = f.send.mock.calls.filter(([request]) => request.key === queued.key);
  expect(notices).toHaveLength(1); expect(notices[0][1]).toContain('生成或排队');
  expect(f.state.receipts[queued.key].replies).toBe(2); expect(f.generate).toHaveBeenCalledTimes(2);
});

test('a failed background job reports its error as the second reply and cancels the deadline notice', async () => {
  const f = await fixture(); const original = await f.submit('failed');
  f.advance(30000); await f.fail(original);
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][1]).not.toContain('稍后艾特我领取');
  expect(f.send.mock.calls[0][2]).toBeUndefined(); expect(f.state.receipts[original.key].replies).toBe(2);
  expect((await f.journal()).jobs[original.key].status).toBe('delivered'); expect(f.timers.size).toBe(0);
  f.advance(QQ_LIMITS.maxAgeMs); await f.worker.idle(); expect(f.send).toHaveBeenCalledTimes(1);
});

test('a completion already queued at the deadline wins over the pending notice', async () => {
  const f = await fixture(); const original = await f.submit('deadline-race');
  // Queue the callback but finish the job before the serial delivery loop resumes.
  let release!: () => void;
  f.answer.mockImplementationOnce(async () => new Promise(resolve => { release = () => resolve({ text: '当前问题的回答。', tokens: 100 }); }));
  f.worker.receive(f.message('busy', '你好', { senderId: 'member-b' }));
  for (let turn = 0; !release && turn < 100; turn++) await new Promise(resolve => setImmediate(resolve));
  expect(release).toBeDefined();
  f.advance(original.createdAt + QQ_LIMITS.maxAgeMs - 20000 - f.now());
  await f.complete(original, false);
  release(); await f.worker.idle();
  const replies = f.send.mock.calls.filter(([request]) => request.key === original.key);
  expect(replies).toHaveLength(1); expect(replies[0][2]).toBeDefined(); expect(f.timers.size).toBe(0);
});

test('shutdown cancels pending notice timers and expiration never sends on an old window', async () => {
  const f = await fixture(); const expired = await f.submit('expired');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.worker.idle();
  expect(f.send).not.toHaveBeenCalled(); expect(f.state.receipts[expired.key].status).toBe('skipped');
  expect(f.timers.size).toBe(0);
  await f.submit('stopped'); expect(f.timers.size).toBe(1); f.worker.stop();
  expect(f.timers.size).toBe(0); f.advance(QQ_LIMITS.maxAgeMs); await f.worker.idle(); expect(f.send).not.toHaveBeenCalled();
});

test('operators receive the same original-window automatic delivery without serial generation waits', async () => {
  const f = await fixture({ mediaOperators: [qqDigest(JSON.stringify(['group', 'member-a']))] });
  const original = await f.submit('operator-image');
  f.advance(60000); await f.complete(original);
  expect(f.send.mock.calls[0][0].msgId).toBe(original.msgId); expect(f.send.mock.calls[0][2]).toBeDefined();
});

test('completion without enough original send time leaves the result ready for a fresh message', async () => {
  const f = await fixture(); const original = await f.submit('near-expiry');
  f.advance(QQ_LIMITS.maxAgeMs - 10000); await f.complete(original);
  expect(f.send).toHaveBeenCalledTimes(1); expect((await f.journal()).jobs[original.key].status).toBe('ready');
  f.worker.receive(f.message('fresh', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' })); await f.worker.idle();
  expect(f.send.mock.calls[1][0].msgId).toBe('fresh'); expect(f.generate).toHaveBeenCalledTimes(1);
});

test('another member ordinary message delivers an expired result only in the same group and without a model call', async () => {
  const f = await fixture(); const original = await f.submit('old');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.worker.receive(f.message('wrong-group', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: 'group-b' }))).toBe(false);
  expect(f.worker.receive(f.message('bot', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', senderIsBot: true }))).toBe(false);
  const trigger = f.message('group-chat', '普通群聊', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' });
  expect(f.worker.receive(trigger)).toBe(true); await f.worker.idle();
  const [delivery, , image] = f.send.mock.calls[0];
  expect(delivery.msgId).toBe(trigger.messageId); expect(delivery.user).toBe(original.user);
  expect(delivery).toMatchObject({ replyMsgId: original.msgId });
  expect(delivery.key).not.toBe(original.key); expect(image!.file).toContain(delivery.key);
  expect(f.worker.receive(trigger)).toBe(false);
  expect(f.answer).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.state.tokens).toBe(100); expect(f.state.images).toBe(1);
  expect((await f.journal()).jobs[original.key].status).toBe('delivered');
});

test('answer the current mention first then borrow only one reply even when more are spare', async () => {
  const f = await fixture(); const originals = [];
  for (let index = 0; index < 4; index++) originals.push(await f.submit(`old-${index}`));
  f.advance(QQ_LIMITS.maxAgeMs + 1);
  for (const request of originals) await f.complete(request);
  f.send.mockClear(); const event = f.message('question', '你好', { senderId: 'member-b' });
  f.worker.receive(event); await f.worker.idle();
  expect(f.send.mock.calls[0][1]).toBe('当前问题的回答。');
  expect(f.send.mock.calls).toHaveLength(2); // one answer, one old image; spare allowance stays unused
  expect(f.send.mock.calls[1][2]).toBeDefined();
  expect(f.send.mock.calls[0][0].msgId).toBe(event.messageId);
  expect(f.send.mock.calls[1][0]).toMatchObject({ msgId: event.messageId, replyMsgId: originals[0].msgId });
  expect(f.state.receipts[qqRequest(event, Date.parse(event.timestamp))!.key].replies).toBe(2);
  expect(Object.values((await f.journal()).jobs).filter((job: any) => job.status === 'ready')).toHaveLength(3);
  // A fresh ordinary message can borrow one more; replaying either trigger cannot drain the queue.
  expect(f.worker.receive(event)).toBe(false);
  const next = f.message('ordinary-next', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' });
  expect(f.worker.receive(next)).toBe(true); await f.worker.idle();
  expect(f.send.mock.calls).toHaveLength(3); expect(f.worker.receive(next)).toBe(false);
  expect(f.state.receipts[qqImageReplyTrigger(next, Date.parse(next.timestamp))!.key].replies).toBe(1);
  const images = f.send.mock.calls.slice(1).map(([, , image]) => image!);
  expect(new Set(images.map(image => image.file)).size).toBe(2);
  expect(new Set(images.map(image => image.sha256)).size).toBe(2);
  expect(Object.values((await f.journal()).jobs).filter((job: any) => job.status === 'ready')).toHaveLength(2);
  expect(f.answer).toHaveBeenCalledTimes(5); expect(f.generate).toHaveBeenCalledTimes(4);
});

test('ready old images cannot spend a pending current image window before its own result and notice allowance', async () => {
  const f = await fixture(); const oldA = await f.submit('old-a'), oldB = await f.submit('old-b');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(oldA); await f.complete(oldB);
  f.send.mockClear();
  const current = await f.submit('current-image');
  // Only the receipt is sent. Pending work cannot lend its original window to old results.
  expect(f.state.receipts[current.key].replies).toBe(1);
  expect(f.send).not.toHaveBeenCalled();
  const before = await f.journal();
  expect(before.jobs[current.key].status).toBe('running');
  expect(before.jobs[oldA.key].status).toBe('ready'); expect(before.jobs[oldB.key].status).toBe('ready');
  f.advance(60000); await f.complete(current);
  // The current image goes first, followed by at most one old image despite the remaining allowance.
  expect(f.send.mock.calls[0][0].key).toBe(current.key); expect(f.send.mock.calls[0][2]).toBeDefined();
  expect(f.send.mock.calls).toHaveLength(2); expect(f.send.mock.calls[1][0].msgId).toBe(current.msgId);
  expect(f.state.receipts[current.key].replies).toBe(3);
  const after = await f.journal();
  expect(after.jobs[current.key].status).toBe('delivered');
  expect(after.jobs[oldA.key].status).toBe('delivered'); expect(after.jobs[oldB.key].status).toBe('ready');
  expect(f.generate).toHaveBeenCalledTimes(3);
});

test('unknown supplemental sending stops the batch and never automatically resends the claimed image', async () => {
  const f = await fixture(); const a = await f.submit('a'), b = await f.submit('b');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(a); await f.complete(b);
  f.send.mockRejectedValueOnce(new Error('unknown platform receipt'));
  f.worker.receive(f.message('trigger', '聊天', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' })); await f.worker.idle();
  expect(f.state.paused).toBe(true);
  const jobs = Object.values((await f.journal()).jobs) as any[];
  expect(jobs.filter(job => job.status === 'delivering')).toHaveLength(1);
  expect(jobs.filter(job => job.status === 'ready')).toHaveLength(1);
  expect(f.send).toHaveBeenCalledTimes(1);
});

test.each(['收图', '图来', '图片呢', '把图发我'])('generic pickup delivers all available images in creation order: %s', async content => {
  const f = await fixture(); const old = await f.submit('old');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(old);
  const latest = await f.submit('latest');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(latest); f.send.mockClear();
  f.taskAnswer('collect');
  f.worker.receive(f.message('pickup', content)); await f.worker.idle();
  expect(f.send.mock.calls.map(([request, , image]) => [request.msgId, request.replyMsgId, image?.sha256]))
    .toEqual([old, latest].map(request => ['pickup', request.msgId, qqDigest(Buffer.from(`image for ${request.key}`))]));
  expect(f.send.mock.calls[0][0].key).not.toBe(f.send.mock.calls[1][0].key);
  const journal = await f.journal();
  expect(journal.jobs[old.key].status).toBe('delivered'); expect(journal.jobs[latest.key].status).toBe('delivered');
  f.taskAnswer('collect');
  f.worker.receive(f.message('pickup-empty', content)); await f.worker.idle();
  expect(f.send.mock.calls[2][1]).toContain('没有已生成且尚未发送的图');
  expect(f.send.mock.calls[2][2]).toBeUndefined();
  expect(f.generate).toHaveBeenCalledTimes(2);
});

test.each(['running', 'delivered'] as const)('a pickup can claim an unsent result behind a newer %s job', async status => {
  const f = await fixture();
  const old = await f.submit('old');
  f.advance(QQ_LIMITS.maxAgeMs + 1);
  await f.complete(old);
  const latest = await f.submit('latest');
  if (status === 'delivered') {
    // Suppress borrowing a spare reply so that the older job still needs explicit pickup.
    f.state.receipts[latest.key].replies = 3;
    await f.complete(latest);
  }
  f.send.mockClear();
  f.taskAnswer('collect');
  f.worker.receive(f.message('pickup', '收图')); await f.worker.idle();
  expect(f.send.mock.calls.map(([, , image]) => image?.sha256)).toEqual([qqDigest(Buffer.from(`image for ${old.key}`))]);
  expect((await f.journal()).jobs[latest.key].status).toBe(status);
  expect(f.generate).toHaveBeenCalledTimes(2);
});

test('batch pickup shares the five-reply allowance and leaves overflow for the next mention', async () => {
  const f = await fixture();
  const requests: QQRequest[] = [];
  for (let index = 0; index < 6; index++) {
    const original = await f.submit(`original-${index}`); requests.push(original);
    f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  }
  f.send.mockClear();
  const event = f.message('batch', '领图');
  f.taskAnswer('collect');
  f.worker.receive(event); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(5);
  expect(f.state.receipts[qqRequest(event, f.now())!.key].replies).toBe(5);
  expect(f.send.mock.calls[4][1]).toContain('还有 1 张待领');
  expect((await f.journal()).jobs[requests[5].key].status).toBe('ready');
  f.worker.receive(f.message('empty-pickup', '')); await f.worker.idle();
  expect(f.send.mock.calls[5][2]?.sha256).toBe(qqDigest(Buffer.from(`image for ${requests[5].key}`)));
});

test('an uncertain batch send stops before claiming any remaining images', async () => {
  const f = await fixture();
  const first = await f.submit('first');
  const second = await f.submit('second');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(first); await f.complete(second);
  f.send.mockClear().mockRejectedValueOnce(new Error('unknown platform receipt'));
  f.taskAnswer('collect');
  f.worker.receive(f.message('batch', '领图')); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1);
  const journal = await f.journal();
  expect(journal.jobs[first.key].status).toBe('delivering');
  expect(journal.jobs[second.key].status).toBe('ready');
});

test('ongoing task query sends the full server list without claiming any images', async () => {
  const f = await fixture();
  await f.submit('first'); await f.submit('second'); await f.submit('third');
  f.send.mockClear();
  const before = await f.journal();
  f.answer.mockImplementationOnce(async (_request, _signal, _execute, tasks) => {
    await tasks!.read();
    return { text: '有些图在生成。', tokens: 100 };
  });
  f.worker.receive(f.message('progress-query', '还有哪些在生成？')); await f.worker.idle();
  expect(f.send.mock.calls[0][1]).toMatch(/2 张生成中、1 张排队、0 张待领取。\n倒数第1张 .*排队中.*\n倒数第2张 .*生成中.*\n倒数第3张 .*生成中/u);
  expect(f.send.mock.calls[0][2]).toBeUndefined();
  expect(await f.journal()).toEqual(before);
});

test('mention-only mode keeps ordinary chatter silent while another member mention can lend spare replies', async () => {
  const f = await fixture({ groupMessageMode: 'mention' }); const original = await f.submit('old');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  expect(f.worker.receive(f.message('ordinary', '你好', { rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'member-b' }))).toBe(false);
  f.worker.receive(f.message('mention', '你好', { senderId: 'member-b' })); await f.worker.idle();
  expect(f.send.mock.calls[0][1]).toBe('当前问题的回答。'); expect(f.send.mock.calls[1][2]).toBeDefined();
});

test('multipart answers use their reserved replies before images and never exceed the passive allowance', async () => {
  const f = await fixture(); const original = await f.submit('old');
  f.advance(QQ_LIMITS.maxAgeMs + 1); await f.complete(original);
  f.answer.mockResolvedValueOnce({ text: '景'.repeat(4500), tokens: 100, videoReview: true });
  const event = f.message('long-answer', '你好', { senderId: 'member-b' });
  f.worker.receive(event); await f.worker.idle();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][2]).toBeUndefined();
  expect(f.state.receipts[qqRequest(event, Date.parse(event.timestamp))!.key].replies).toBe(4);
  expect((await f.journal()).jobs[original.key].status).toBe('ready');
});
