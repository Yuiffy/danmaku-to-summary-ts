import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QQImageJobs } from './QQImageJobs';
import { QQImageResult } from './QQImagePolicy';
import { qqDigest, qqRequest } from './QQPolicy';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { qqFailure } from './QQDiagnostics';

const appId = '900000001', epoch = Date.parse('2026-10-29T02:00:00Z');
const command = { mode: 'create' as const, instruction: '生成星空图片', characters: [] };
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-jobs-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function fixture(mediaOperators: string[] = []) {
  let now = epoch;
  const request = (id: string, user = 'member-a', group = 'group-a', content = command.instruction) => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    messageId: id, senderId: user, groupOpenid: group, timestamp: new Date(now).toISOString(), content }, now)!;
  let finish!: (value: QQImageResult) => void, fail!: (error: unknown) => void;
  const io = { now: () => now, generate: jest.fn((_request, signal: AbortSignal) => new Promise<QQImageResult>((resolve, reject) => {
    finish = resolve; fail = reject;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })), report: jest.fn(), fatal: jest.fn(async () => {}) };
  const jobs = new QQImageJobs(root, appId, 900000, io, { mediaOperators });
  const journal = path.join(root, 'data/runtime/qqbot/image-jobs', `${appId}.json`);
  const artifact = async (req: ReturnType<typeof request>) => {
    const bytes = Buffer.from('test image bytes');
    const file = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(req.createdAt), `${req.key}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    return { file, model: 'gpt-image-2.5-sunburst', sha256: qqDigest(bytes), prompt: 'scene' };
  };
  return { jobs, io, request, artifact, journal, finish: (result: QQImageResult) => finish(result), fail: (error: unknown) => fail(error),
    advance: (ms: number) => { now += ms; } };
}

test('durable admission acknowledges immediately and a fresh mention picks up beyond five minutes without rendering again', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  expect(await f.jobs.enqueue(first, command)).toMatchObject({ status: 'pending' });
  expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key].status).toBe('running');
  expect((await f.jobs.pending(f.request('waiting')))!.image).toBeUndefined();
  expect(f.jobs.admission(f.request('duplicate'))).toBeUndefined();
  f.advance(6 * 60000); f.finish(await f.artifact(first)); await f.jobs.idle();
  const next = f.request('fresh'); const delivery = await f.jobs.pending(next);
  expect(delivery!.image!.file).toContain(next.key); expect(delivery!.image!.file).not.toContain(first.key);
  expect(await fs.readFile(delivery!.image!.file)).toEqual(Buffer.from('test image bytes'));
  await f.jobs.delivered(next); expect(await f.jobs.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
});

test('four operator images coexist with two ordinary jobs without raising ordinary concurrency', async () => {
  const operator = qqDigest(JSON.stringify(['group', 'operator'])), f = fixture([operator]); await f.jobs.open();
  await f.jobs.enqueue(f.request('normal-a', 'member-a'), command);
  await f.jobs.enqueue(f.request('normal-b', 'member-b'), command);
  expect(f.jobs.admission(f.request('normal-c', 'member-c'))).toBeUndefined();
  for (let i = 0; i < 4; i++) expect((await f.jobs.enqueue(f.request(`operator-${i}`, 'operator'), command)).status).toBe('pending');
  expect((await f.jobs.enqueue(f.request('operator-overflow', 'operator'), command))).toMatchObject({ queued: true });
  expect(f.io.generate).toHaveBeenCalledTimes(6);
  await f.jobs.close(); expect(f.io.fatal).not.toHaveBeenCalled();
});

test('pickup is bound to the initiating user and group, and ready artifacts survive restart', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle(); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  expect(await recovered.pending(f.request('other-user', 'member-b'))).toBeUndefined();
  expect(await recovered.pending(f.request('other-group', 'member-a', 'group-b'))).toBeUndefined();
  expect((await recovered.pending(f.request('owner')))!.image).toBeDefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('supplemental native quote survives restart without entering the generation payload', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('creation-message');
  await f.jobs.enqueue(first, command);
  expect(f.io.generate.mock.calls[0][0]).not.toHaveProperty('replyMsgId');
  expect(f.io.generate.mock.calls[0][0].msgId).toBe('');
  f.finish(await f.artifact(first)); await f.jobs.idle(); await f.jobs.close();
  const next = fixture(); await next.jobs.open();
  try {
    const trigger = next.request('fresh-message', 'member-b');
    expect(next.jobs.hasReady(trigger)).toBe(true);
    const result = await next.jobs.ready(trigger);
    expect(result?.request).toMatchObject({ msgId: trigger.msgId, replyMsgId: first.msgId, user: first.user });
    await next.jobs.delivered(result!.request);
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key].status).toBe('delivered');
    expect(next.io.generate).not.toHaveBeenCalled();
  } finally { await next.jobs.close(); }
});

test('legacy ready jobs without a creation message only use their owner fresh window', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('legacy');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle(); await f.jobs.close();
  const journal = JSON.parse(await fs.readFile(f.journal, 'utf8'));
  delete journal.jobs[first.key].replyMsgId;
  await fs.writeFile(f.journal, JSON.stringify(journal));
  const next = fixture(); await next.jobs.open();
  try {
    const other = next.request('other-window', 'member-b'), owner = next.request('owner-window');
    expect(next.jobs.hasReady(other)).toBe(false);
    expect(await next.jobs.ready(other)).toBeUndefined();
    expect(await fs.readFile(f.journal, 'utf8')).toBe(JSON.stringify(journal));
    expect(next.jobs.hasReady(owner)).toBe(true);
    expect((await next.jobs.ready(owner))?.request).toMatchObject({ msgId: owner.msgId, replyMsgId: owner.msgId, user: first.user });
    expect(next.io.generate).not.toHaveBeenCalled();
  } finally { await next.jobs.close(); }
});

test.each(['bad id', '', 'x'.repeat(257), 123])('invalid persisted native quote %p fails closed', async replyMsgId => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle(); await f.jobs.close();
  const journal = JSON.parse(await fs.readFile(f.journal, 'utf8'));
  journal.jobs[first.key].replyMsgId = replyMsgId;
  await fs.writeFile(f.journal, JSON.stringify(journal));
  const next = fixture();
  await expect(next.jobs.open()).rejects.toThrow('Invalid QQ image job');
  expect(next.io.generate).not.toHaveBeenCalled();
});

test('interrupted running attempts are reported once after restart and never replayed', async () => {
  const f = fixture(); await f.jobs.open(); await f.jobs.enqueue(f.request('original'), command);
  // Snapshot represents a process crash, without asking the old owner to perform recovery.
  const crashed = await fs.readFile(f.journal); await f.jobs.close(); await fs.writeFile(f.journal, crashed);
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  const next = f.request('next'); expect((await recovered.pending(next))!.text).toContain('未能确认');
  await recovered.delivered(next); expect(await recovered.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('an uncertain delivery survives restart and another mention cannot resend', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle();
  await f.jobs.pending(f.request('delivery')); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  await recovered.delivered(f.request('wrong-receipt'));
  expect(await recovered.pending(f.request('later', 'member-a', 'group-a', ''))).toEqual({ text: expect.stringContaining('发送结果尚待核对') });
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('an explicit request to resend the previous result recovers one uncertain delivery', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle();
  await f.jobs.pending(f.request('delivery')); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  const resend = f.request('resend', 'member-a', 'group-a', '那你把上一张结果发我呀');
  const delivery = await recovered.pending(resend);
  expect(delivery?.image?.file).toContain(resend.key);
  expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key]).toMatchObject({ status: 'delivering', deliveryRequest: resend.key, deliveryRecovery: true });
  expect(await recovered.pending(f.request('resend-again', 'member-a', 'group-a', '上一张图发我'))).toEqual({ text: expect.stringContaining('已停止重发') });
  await recovered.delivered(resend); expect(await recovered.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('an uncertain previous image cannot hijack a new quoted edit, and the new job is picked up first', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle();
  await f.jobs.pending(f.request('delivery'));
  const edit = { ...f.request('new-edit', 'member-a', 'group-a', '变岁己，保留参考图服装，不要帽子'), imageInput: { urls: [], reply: 'source-id' } };
  expect(await f.jobs.pending(edit)).toBeUndefined();
  expect(f.jobs.admission(edit)).toBeUndefined();
  expect(await f.jobs.enqueue(edit, { mode: 'edit', instruction: edit.text, characters: [] })).toMatchObject({ status: 'pending' });
  f.finish(await f.artifact(edit)); await f.jobs.idle();
  const pickup = f.request('new-pickup', 'member-a', 'group-a', '');
  expect((await f.jobs.pending(pickup))?.image).toBeDefined();
  await f.jobs.delivered(pickup);
  const journal = JSON.parse(await fs.readFile(f.journal, 'utf8'));
  expect(journal.jobs[first.key]).toMatchObject({ status: 'delivering', deliveryRequest: f.request('delivery').key });
  expect(journal.jobs[edit.key].status).toBe('delivered');
  expect(f.io.generate).toHaveBeenCalledTimes(2); await f.jobs.close();
});

test('an unsuccessful recovery remains locked after restart while new conversation can continue', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); f.finish(await f.artifact(first)); await f.jobs.idle();
  await f.jobs.pending(f.request('delivery'));
  await f.jobs.pending(f.request('retry', 'member-a', 'group-a', '收图')); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  expect(await recovered.pending(f.request('again', 'member-a', 'group-a', '收图'))).toEqual({ text: expect.stringContaining('已停止重发') });
  expect(await recovered.pending(f.request('chat', 'member-a', 'group-a', '你好'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('pickup never falls back to a stale uncertain image after the latest failure notice was delivered', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    const old = f.request('old'); await f.jobs.enqueue(old, command);
    f.finish(await f.artifact(old)); await f.jobs.idle(); await f.jobs.pending(f.request('old-delivery'));
    f.advance(7 * 86400000);
    const latest = f.request('latest'); await f.jobs.enqueue(latest, command);
    f.fail(qqFailure('image_http', 'image_moderation', { httpStatus: 400 })); await f.jobs.idle();
    const notice = f.request('failure-notice'); await f.jobs.pending(notice); await f.jobs.delivered(notice);
    const pickup = f.request('pickup', 'member-a', 'group-a', '收图');
    expect(await f.jobs.pending(pickup)).toEqual({ text: '这个要求过不了审核，换张图或换个要求试试。' });
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[old.key].deliveryRequest).toBe(f.request('old-delivery').key);
    expect(f.io.generate).toHaveBeenCalledTimes(2);
  } finally { await f.jobs.close(); }
});

test('a newer running image takes precedence over an older ready image', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    const old = f.request('old'); await f.jobs.enqueue(old, command);
    f.finish(await f.artifact(old)); await f.jobs.idle(); f.advance(1000);
    await f.jobs.enqueue(f.request('latest'), command);
    expect(await f.jobs.pending(f.request('pickup', 'member-a', 'group-a', '收图'))).toEqual({ text: expect.stringContaining('后台生成') });
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[old.key].status).toBe('ready');
  } finally { await f.jobs.close(); }
});

test('status reads and collection remain bound to the authenticated owner and group', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    const original = f.request('original'); await f.jobs.enqueue(original, command);
    const before = await fs.readFile(f.journal, 'utf8');
    expect(await f.jobs.status(f.request('query'))).toMatchObject({ status: 'running' });
    for (const other of [f.request('other-owner', 'member-b'), f.request('other-group', 'member-a', 'group-b'),
      { ...f.request('private'), scope: 'c2c' as const }]) {
      expect(await f.jobs.status(other)).toMatchObject({ status: 'none' });
      expect(await f.jobs.collect(other)).toBeUndefined();
    }
    expect(await fs.readFile(f.journal, 'utf8')).toBe(before);
    f.finish(await f.artifact(original)); await f.jobs.idle();
    const ready = await fs.readFile(f.journal, 'utf8');
    expect(await f.jobs.status(f.request('ready-query'))).toEqual({ status: 'ready', message: '图片已经生成，可以领取。' });
    expect(await fs.readFile(f.journal, 'utf8')).toBe(ready);
    expect(f.io.generate).toHaveBeenCalledTimes(1);
  } finally { await f.jobs.close(); }
});

test.each(['收图', '图来', '能交货了吗', '刚才那份给一下'])('agent collection can resend only the latest delivered image once, including after restart: %s', async content => {
  const f = fixture(); await f.jobs.open();
  const latest = f.request('latest'); await f.jobs.enqueue(latest, command);
  f.finish(await f.artifact(latest)); await f.jobs.idle();
  const delivery = f.request('delivery'); await f.jobs.pending(delivery); await f.jobs.delivered(delivery); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  try {
    expect(await recovered.pending(f.request('chat', 'member-a', 'group-a', '你好'))).toBeUndefined();
    const pickup = f.request('pickup', 'member-a', 'group-a', content);
    expect((await recovered.collect(pickup))?.image?.sha256).toBe(qqDigest(Buffer.from('test image bytes')));
    await recovered.delivered(pickup);
    expect(await recovered.collect(f.request('again', 'member-a', 'group-a', content))).toEqual({ text: expect.stringContaining('已停止重发') });
    expect(f.io.generate).toHaveBeenCalledTimes(1);
  } finally { await recovered.close(); }
});

test('retryable upstream HTTP failure is retried once and emits the safe provider message', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  const result = await f.artifact(first);
  f.io.generate.mockReset()
    .mockRejectedValueOnce(qqFailure('image_http', 'http_error', { httpStatus: 502, upstreamMessage: 'Upstream request failed' }))
    .mockResolvedValueOnce(result);
  await f.jobs.enqueue(first, command); await f.jobs.idle();
  expect(f.io.generate).toHaveBeenCalledTimes(2);
  expect(f.io.report).toHaveBeenCalledWith({ event: 'qq_image_job_retry', requestId: first.key, scope: 'group', retryAttempt: 2,
    failure: expect.objectContaining({ httpStatus: 502, upstreamMessage: 'Upstream request failed' }) });
  expect((await f.jobs.pending(f.request('pickup')))!.image).toBeDefined(); await f.jobs.close();
});

test('non-retryable provider failure remains single-shot, and successful notice receipt releases a new explicit attempt', async () => {
  const f = fixture(); await f.jobs.open(); await f.jobs.enqueue(f.request('original'), command);
  f.fail(new Error('private provider detail')); await f.jobs.idle();
  const next = f.request('failure-notice'); expect((await f.jobs.pending(next))!.text).toContain('生成失败');
  expect(f.jobs.admission(f.request('early'))).toBeUndefined(); await f.jobs.delivered(next);
  expect(f.jobs.admission(f.request('new'))).toBeUndefined(); expect(f.io.generate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.io.report.mock.calls)).not.toContain('private provider detail'); await f.jobs.close();
});

test.each([
  [502, '图片上游服务返回 HTTP 502'],
  [503, '图片上游服务返回 HTTP 503'],
  [504, '图片上游服务返回 HTTP 504'],
])('failed background attempt exposes the safe HTTP cause for %i', async (httpStatus, text) => {
  const f = fixture(); f.io.generate.mockReset().mockRejectedValue(qqFailure('image_http', 'http_error', { httpStatus }));
  await f.jobs.open(); await f.jobs.enqueue(f.request('original'), command); await f.jobs.idle();
  expect((await f.jobs.pending(f.request('notice')))!.text).toContain(text);
  await f.jobs.close();
});

test('background deadline is fifteen minutes and remains independent of any original request controller', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(); await f.jobs.open(); await f.jobs.enqueue(f.request('original'), command);
    await jest.advanceTimersByTimeAsync(300001); expect(f.io.generate.mock.calls[0][1].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(600000); await f.jobs.idle();
    expect(f.io.generate.mock.calls[0][1].aborted).toBe(true);
    expect((await f.jobs.pending(f.request('next')))!.text).toContain('未能确认'); await f.jobs.close();
  } finally { jest.useRealTimers(); }
});

test('global background capacity queues a third task before provider IO', async () => {
  const f = fixture(); await f.jobs.open();
  await f.jobs.enqueue(f.request('a'), command); await f.jobs.enqueue(f.request('b', 'member-b'), command);
  expect(await f.jobs.enqueue(f.request('c', 'member-c'), command)).toMatchObject({ status: 'pending', queued: true, message: expect.stringContaining('第1位') });
  expect(f.io.generate).toHaveBeenCalledTimes(2); await f.jobs.close();
});

test('changed image bytes fail closed before delivery intent', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); const result = await f.artifact(first); f.finish(result); await f.jobs.idle();
  await fs.writeFile(result.file, 'tampered'); await expect(f.jobs.pending(f.request('next'))).rejects.toThrow('changed');
  expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key].status).toBe('ready'); await f.jobs.close();
});

test('failed durable admission prevents any paid call', async () => {
  const f = fixture(); await f.jobs.open(); await fs.unlink(f.journal); await fs.mkdir(f.journal);
  await expect(f.jobs.enqueue(f.request('original'), command)).rejects.toThrow();
  expect(f.io.generate).not.toHaveBeenCalled(); await f.jobs.close();
});

test('failed ready checkpoint triggers fatal handling and cannot be mistaken for a provider failure', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
  await fs.unlink(f.journal); await fs.mkdir(f.journal); f.finish(await f.artifact(first)); await f.jobs.idle();
  expect(f.io.fatal).toHaveBeenCalledTimes(1); expect(f.io.report).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'qq_image_job_failed' }));
  expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
});

test('waiting for a fast attempt claims the original request once and its successful receipt completes the job', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
  const waiting = f.jobs.wait(first, new AbortController().signal, 220000);
  f.advance(68000); f.finish(await f.artifact(first));
  const delivery = await waiting;
  expect(delivery).toMatchObject({ text: '图片生成完成。', image: { file: expect.stringContaining(first.key) } });
  expect((await f.jobs.pending(f.request('duplicate', 'member-a', 'group-a', '')))!.image).toBeUndefined();
  await f.jobs.delivered(first); expect(await f.jobs.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
});

test('releasing the original reply wait leaves the paid task running for later pickup', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
    const waiting = f.jobs.wait(first, new AbortController().signal, 220000);
    await jest.advanceTimersByTimeAsync(220000); f.advance(220000);
    expect(await waiting).toBeUndefined(); expect(f.io.generate.mock.calls[0][1].aborted).toBe(false);
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key].status).toBe('running');
    f.advance(140000); f.finish(await f.artifact(first)); await f.jobs.idle();
    expect((await f.jobs.pending(f.request('later')))!.image).toBeDefined();
    expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
  } finally { jest.useRealTimers(); }
});

test('aborting only a reply waiter cannot cancel the provider or claim delivery', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
  const controller = new AbortController(); const waiting = f.jobs.wait(first, controller.signal, 220000);
  controller.abort(); expect(await waiting).toBeUndefined(); expect(f.io.generate.mock.calls[0][1].aborted).toBe(false);
  f.finish(await f.artifact(first)); await f.jobs.idle();
  expect((await f.jobs.pending(f.request('later')))!.image).toBeDefined(); await f.jobs.close();
});

test('zero remaining wait still returns an already-ready result, and a different user cannot wait on it', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
  expect(await f.jobs.wait(first, new AbortController().signal, 0)).toBeUndefined();
  f.finish(await f.artifact(first)); await f.jobs.idle();
  expect(await f.jobs.wait({ ...first, user: f.request('wrong-user', 'member-b').user }, new AbortController().signal, 0)).toBeUndefined();
  expect((await f.jobs.wait(first, new AbortController().signal, 0))!.image).toBeDefined(); await f.jobs.close();
});

test('a fast provider failure returns a status notice on the original request without retrying', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original'); await f.jobs.enqueue(first, command);
  const waiting = f.jobs.wait(first, new AbortController().signal, 220000);
  f.fail(new Error('failed')); expect(await waiting).toMatchObject({ text: expect.stringContaining('失败') });
  await f.jobs.delivered(first); expect(f.jobs.admission(f.request('next'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
});

test.each([
  ['image_sexual' as const, '太色了，生不出来，换张图或换个要求试试。'],
  ['image_moderation' as const, '这个要求过不了审核，换张图或换个要求试试。'],
])('an upstream %s refusal survives restart and delivers a short reason once without retrying', async (code, text) => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command);
  f.fail(qqFailure('image_http', code, { httpStatus: 400, requestId: 'rejected-123' }));
  await f.jobs.idle(); await f.jobs.close();
  const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
  const next = f.request('notice');
  expect(await recovered.pending(next)).toEqual({ text });
  await recovered.delivered(next);
  expect(await recovered.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1);
  expect(f.io.report).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({ code }) }));
  await recovered.close();
});

test('twenty waiting jobs are durable, duplicates are idempotent, and only a full queue refuses', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    await f.jobs.enqueue(f.request('running-a'), command); await f.jobs.enqueue(f.request('running-b'), command);
    for (let i = 0; i < 20; i++) {
      const result = await f.jobs.enqueue(f.request(`queued-${i}`), command);
      expect(result).toMatchObject({ status: 'pending', queued: true });
      expect(result.message).toContain(`第${i + 1}位`); expect(result.message).toContain('分钟后开始');
    }
    const before = await fs.readFile(f.journal, 'utf8');
    expect((await f.jobs.enqueue(f.request('queued-0'), command)).status).toBe('pending');
    expect((await f.jobs.enqueue(f.request('overflow'), command))).toMatchObject({ status: 'blocked', message: expect.stringContaining('排队满了') });
    expect(await fs.readFile(f.journal, 'utf8')).toBe(before);
    expect(f.io.generate).toHaveBeenCalledTimes(2);
  } finally { await f.jobs.close(); }
  const recovered = new QQImageJobs(root, appId, 900000, f.io);
  await recovered.open();
  try {
    expect(f.io.generate).toHaveBeenCalledTimes(4);
    const jobs = Object.values(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs) as Array<{status: string}>;
    expect(jobs.filter(job => job.status === 'unknown')).toHaveLength(2);
    expect(jobs.filter(job => job.status === 'queued')).toHaveLength(18);
  } finally { await recovered.close(); }
});

test('finishing an attempt dispatches the oldest eligible queued job without another QQ mention', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    await f.jobs.enqueue(f.request('a'), command); const second = f.request('b'); await f.jobs.enqueue(second, command);
    const third = f.request('c'); await f.jobs.enqueue(third, command);
    const fourth = f.request('d'); await f.jobs.enqueue(fourth, command);
    f.finish(await f.artifact(second));
    // wait() observes the finished attempt and the scheduler's new dispatch.
    await f.jobs.wait(second, new AbortController().signal, 1000);
    for (let i = 0; i < 20 && f.io.generate.mock.calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.io.generate.mock.calls[2][0].key).toBe(third.key);
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[fourth.key].status).toBe('queued');
  } finally { await f.jobs.close(); }
});

test('the eleventh provider start waits for the rolling timer and survives a restart', async () => {
  jest.useFakeTimers();
  const f = fixture();
  const image = { file: 'unused.png', model: 'gpt-image-2.5-sunburst', sha256: 'a'.repeat(64), prompt: 'scene' };
  f.io.generate.mockImplementation(async () => image);
  await f.jobs.open();
  try {
    for (let i = 0; i < 10; i++) { await f.jobs.enqueue(f.request(`burst-${i}`), command); await f.jobs.idle(); }
    expect(f.io.generate).toHaveBeenCalledTimes(10);
    const next = f.request('eleventh'); expect(await f.jobs.enqueue(next, command)).toMatchObject({ queued: true });
    await f.jobs.close();
    const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
    try {
      f.advance(599999); await jest.advanceTimersByTimeAsync(599999); expect(f.io.generate).toHaveBeenCalledTimes(10);
      f.advance(1); await jest.advanceTimersByTimeAsync(1); await recovered.idle();
      expect(f.io.generate).toHaveBeenCalledTimes(11);
    } finally { await recovered.close(); }
  } finally { await f.jobs.close(); jest.useRealTimers(); }
});

test('preparation failure neither creates a queued attempt nor pauses the service', async () => {
  const f = fixture(); const jobs = new QQImageJobs(root, appId, 900000, { ...f.io,
    prepare: async () => { throw qqFailure('image_prepare', 'image_unavailable'); } });
  await jobs.open();
  expect(await jobs.enqueue(f.request('bad-source'), command)).toMatchObject({ status: 'failed', message: expect.stringContaining('下载') });
  expect(f.io.generate).not.toHaveBeenCalled(); expect(f.io.fatal).not.toHaveBeenCalled(); await jobs.close();
});

test('twenty waiting tasks persist on stop, duplicates are idempotent, and only overflow is refused', async () => {
  const f = fixture(); await f.jobs.open();
  try {
    await f.jobs.enqueue(f.request('running-a'), command); await f.jobs.enqueue(f.request('running-b'), command);
    for (let i = 1; i <= 20; i++) {
      expect(await f.jobs.enqueue(f.request(`queued-${i}`), command)).toMatchObject({ queued: true, message: expect.stringContaining(`第${i}位`) });
    }
    expect(await f.jobs.enqueue(f.request('queued-1'), command)).toMatchObject({ queued: true });
    expect(await f.jobs.enqueue(f.request('overflow'), command)).toMatchObject({ status: 'blocked', message: expect.stringContaining('排队满了') });
    expect(f.io.generate).toHaveBeenCalledTimes(2);
    await f.jobs.close();
    const journal = JSON.parse(await fs.readFile(f.journal, 'utf8'));
    expect(Object.values(journal.jobs).filter((job: any) => job.status === 'queued')).toHaveLength(20);
    expect(Object.keys(journal.jobs)).toHaveLength(22);
    const recovered = new QQImageJobs(root, appId, 900000, f.io); await recovered.open();
    try {
      expect(f.io.generate.mock.calls.slice(2).map(call => call[0].key)).toEqual([f.request('queued-1').key, f.request('queued-2').key]);
      expect(f.io.generate).toHaveBeenCalledTimes(4);
    } finally { await recovered.close(); }
  } finally { await f.jobs.close(); }
});

test('gateway retries and simultaneous admissions share one atomic rolling start allowance', async () => {
  const f = fixture(); await f.jobs.open();
  f.io.generate.mockRejectedValue(qqFailure('image_http', 'http_error', { httpStatus: 502 }));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.jobs.enqueue(f.request(`racing-${i}`, `member-${i}`), command)));
    await f.jobs.idle();
    expect(f.io.generate.mock.calls.length).toBeLessThanOrEqual(10);
    expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).starts).toHaveLength(10);
  } finally { await f.jobs.close(); }
});
