import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QQImageJobs } from './QQImageJobs';
import { QQImageResult } from './QQImagePolicy';
import { qqDigest, qqRequest } from './QQPolicy';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';

const appId = '900000001', epoch = Date.parse('2026-10-29T02:00:00Z');
const command = { mode: 'create' as const, instruction: '生成星空图片', characters: [] };
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-jobs-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function fixture() {
  let now = epoch;
  const request = (id: string, user = 'member-a', group = 'group-a') => qqRequest({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    messageId: id, senderId: user, groupOpenid: group, timestamp: new Date(now).toISOString(), content: command.instruction }, now)!;
  let finish!: (value: QQImageResult) => void, fail!: (error: unknown) => void;
  const io = { now: () => now, generate: jest.fn((_request, signal: AbortSignal) => new Promise<QQImageResult>((resolve, reject) => {
    finish = resolve; fail = reject;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })), report: jest.fn(), fatal: jest.fn(async () => {}) };
  const jobs = new QQImageJobs(root, appId, 900000, io);
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
  expect(f.jobs.admission(f.request('duplicate'))).toContain('未领取');
  f.advance(6 * 60000); f.finish(await f.artifact(first)); await f.jobs.idle();
  const next = f.request('fresh'); const delivery = await f.jobs.pending(next);
  expect(delivery!.image!.file).toContain(next.key); expect(delivery!.image!.file).not.toContain(first.key);
  expect(await fs.readFile(delivery!.image!.file)).toEqual(Buffer.from('test image bytes'));
  await f.jobs.delivered(next); expect(await f.jobs.pending(f.request('after'))).toBeUndefined();
  expect(f.io.generate).toHaveBeenCalledTimes(1); await f.jobs.close();
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
  expect(await recovered.pending(f.request('later'))).toEqual({ text: expect.stringContaining('发送结果尚待核对') });
  expect(f.io.generate).toHaveBeenCalledTimes(1); await recovered.close();
});

test('provider failure does not retry, and successful notice receipt releases a new explicit attempt', async () => {
  const f = fixture(); await f.jobs.open(); await f.jobs.enqueue(f.request('original'), command);
  f.fail(new Error('private provider detail')); await f.jobs.idle();
  const next = f.request('failure-notice'); expect((await f.jobs.pending(next))!.text).toContain('生成失败');
  expect(f.jobs.admission(f.request('early'))).toBeDefined(); await f.jobs.delivered(next);
  expect(f.jobs.admission(f.request('new'))).toBeUndefined(); expect(f.io.generate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.io.report.mock.calls)).not.toContain('private provider detail'); await f.jobs.close();
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

test('global background capacity blocks a third task before provider IO', async () => {
  const f = fixture(); await f.jobs.open();
  await f.jobs.enqueue(f.request('a'), command); await f.jobs.enqueue(f.request('b', 'member-b'), command);
  expect(await f.jobs.enqueue(f.request('c', 'member-c'), command)).toMatchObject({ status: 'blocked', message: expect.stringContaining('两张') });
  expect(f.io.generate).toHaveBeenCalledTimes(2); await f.jobs.close();
});

test('changed image bytes fail closed before delivery intent', async () => {
  const f = fixture(); await f.jobs.open(); const first = f.request('original');
  await f.jobs.enqueue(first, command); const result = await f.artifact(first); f.finish(result); await f.jobs.idle();
  await fs.writeFile(result.file, 'tampered'); await expect(f.jobs.pending(f.request('next'))).rejects.toThrow('changed');
  expect(JSON.parse(await fs.readFile(f.journal, 'utf8')).jobs[first.key].status).toBe('ready'); await f.jobs.close();
});

test('failed durable admission prevents any paid call', async () => {
  const f = fixture(); await f.jobs.open(); await fs.mkdir(path.dirname(f.journal), { recursive: true }); await fs.mkdir(f.journal);
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
  expect((await f.jobs.pending(f.request('duplicate')))!.image).toBeUndefined();
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
