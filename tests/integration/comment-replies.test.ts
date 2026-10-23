import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CommentStateStore } from '../../src/services/bilibili/comment-replies/CommentState';
import { CommentWorker } from '../../src/services/bilibili/comment-replies/CommentWorker';
import { CommentReplyConfig, LIMITS, shanghaiDay } from '../../src/services/bilibili/comment-replies/CommentPolicy';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-replies-test-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const config: CommentReplyConfig = { botUid: '99', unlimitedUids: [], credentialConfigPath: 'config/production.json',
  providerConfigPath: 'config/production.json', dailyTokenBudget: 204800, maxQueue: 20, maxUserQueue: 10, pollIntervalMs: 30000 };

test('exclusive owner, restart-safe quotas/budget, durable send intents and replay suppression', async () => {
  const file = path.join(directory, 'state.json'); let now = Date.UTC(2026, 9, 22);
  const store = new CommentStateStore(file, '99'), state = await store.open();
  const second = new CommentStateStore(file, '99'); await expect(second.open()).rejects.toMatchObject({ code: 'EEXIST' });
  const save = (value: typeof state) => store.save(value);
  const answer = jest.fn(async () => '你好呀');
  const send = jest.fn(async () => {
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.jobs[0].status).toBe('sending');
    expect(disk.days[shanghaiDay(now)].tokens).toBe(LIMITS.tokenReservation);
    throw new Error('connection closed after server accepted POST');
  });
  const worker = new CommentWorker(config, state, { save, answer, send, now: () => now });
  const event = { key: '1:10:200', uid: '1', oid: '10', type: 1, root: '100', parent: '200', text: '你好', createdAt: now, trigger: 'mention' as const };
  await worker.admit(event); await worker.tick(); await store.close();
  const next = new CommentStateStore(file, '99'), recovered = await next.open();
  try {
    const worker2 = new CommentWorker(config, recovered, { save: value => next.save(value), answer, send, now: () => now });
    now += 60000;
    expect(await worker2.admit(event)).toBe('duplicate'); await worker2.tick();
    expect(send).toHaveBeenCalledTimes(1); expect(answer).toHaveBeenCalledTimes(1);
    expect(recovered.paused).toBe(true); expect(recovered.jobs[0].status).toBe('unknown');
    expect(recovered.days[shanghaiDay(now)].users['1'].count).toBe(1);
  } finally { await next.close(); }
});

test('crash during provider call is terminal; crash during POST becomes unknown and pauses on restart', async () => {
  const file = path.join(directory, 'state.json'); const store = new CommentStateStore(file, '99'), state = await store.open();
  const event = { key: '1:10:200', uid: '1', oid: '10', type: 1, root: '100', parent: '200', text: '你好', createdAt: Date.now(), trigger: 'mention' as const };
  state.jobs.push({ event, status: 'generating', admittedAt: Date.now() }, { event: { ...event, key: '1:10:201', parent: '201' }, status: 'sending', admittedAt: Date.now(), answer: '你好呀' });
  state.rotation.push('1'); await store.save(state); await store.close();
  const recoveredStore = new CommentStateStore(file, '99');
  try {
    const recovered = await recoveredStore.open();
    expect(recovered.jobs.map(job => job.status)).toEqual(['failed', 'unknown']); expect(recovered.paused).toBe(true);
  } finally { await recoveredStore.close(); }
});

test('corrupt state and wrong account fail closed while releasing their owner lock', async () => {
  const file = path.join(directory, 'state.json'); await fs.writeFile(file, 'not JSON');
  await expect(new CommentStateStore(file, '99').open()).rejects.toThrow('refusing to reset');
  await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  const store = new CommentStateStore(file, '99'); await fs.unlink(file); await store.open(); await store.close();
  await expect(new CommentStateStore(file, '100').open()).rejects.toThrow('schema/account');
  await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('malformed quota state cannot silently reset daily limits', async () => {
  const file = path.join(directory, 'state.json'), store = new CommentStateStore(file, '99');
  const state = await store.open();
  state.days['2026-10-22'] = { tokens: -4096, users: {} };
  await store.save(state); await store.close();
  await expect(new CommentStateStore(file, '99').open()).rejects.toThrow('budget state');
});

test('an auto-restarted consumer reclaims a dead owner but preserves uncertain publication and its pause', async () => {
  const file = path.join(directory, 'dead-owner.json'), store = new CommentStateStore(file, '99');
  const state = await store.open(), now = Date.now();
  state.jobs.push({ event: { key: '1:10:200', uid: '1', oid: '10', type: 1, root: '200', parent: '200', text: '你好',
    createdAt: now, trigger: 'mention' }, status: 'sending', answer: '来啦', admittedAt: now });
  state.rotation.push('1'); await store.save(state); await store.close();
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: 12345, botUid: '99' }));
  const isAlive = jest.fn((pid: number) => pid !== 12345);
  const resumed = new CommentStateStore(file, '99', isAlive);
  try {
    const recovered = await resumed.open();
    expect(isAlive).toHaveBeenCalledWith(12345); expect(recovered.paused).toBe(true);
    expect(recovered.jobs[0].status).toBe('unknown');
    const send = jest.fn(), answer = jest.fn();
    await new CommentWorker(config, recovered, { now: Date.now, save: value => resumed.save(value), answer, send }).tick();
    expect(send).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  } finally { await resumed.close(); }
});

test('concurrent dead-owner recovery admits exactly one consumer', async () => {
  const file = path.join(directory, 'reclaim-race.json');
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: 12345, botUid: '99' }));
  const stores = [new CommentStateStore(file, '99', pid => pid !== 12345), new CommentStateStore(file, '99', pid => pid !== 12345)];
  const results = await Promise.allSettled(stores.map(store => store.open()));
  try {
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')).pid).toBe(process.pid);
  } finally { await Promise.all(stores.map(store => store.close())); }
});

test('uninspectable or mismatched owners are never reclaimed', async () => {
  const file = path.join(directory, 'unknown-owner.json');
  for (const owner of [{ pid: 12345, botUid: '100' }, { pid: '12345', botUid: '99' }, { pid: 12345, botUid: '99' }]) {
    await fs.writeFile(`${file}.lock`, JSON.stringify(owner));
    const isAlive = () => { throw Object.assign(new Error('inspection denied'), { code: 'EPERM' }); };
    await expect(new CommentStateStore(file, '99', isAlive).open()).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(`${file}.lock`, 'utf8'))).toEqual(owner);
    await expect(fs.stat(`${file}.lock.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

test('interrupted like intent pauses on recovery without repeating the like or model call', async () => {
  const file = path.join(directory, 'state.json'), store = new CommentStateStore(file, '99');
  const state = await store.open();
  state.jobs.push({ event: { key: '11:10:200', uid: '1', oid: '10', type: 11, root: '100', parent: '200', text: '你好', createdAt: Date.now() },
    status: 'generating', likeStatus: 'pending', processingAt: Date.now(), admittedAt: Date.now() });
  state.rotation.push('1'); await store.save(state); await store.close();
  const next = new CommentStateStore(file, '99');
  try {
    const recovered = await next.open();
    expect(recovered.paused).toBe(true); expect(recovered.jobs[0]).toMatchObject({ status: 'failed', likeStatus: 'unknown' });
  } finally { await next.close(); }
});

test('rolling fan quotas and first-notice suppression survive a store restart across midnight', async () => {
  const file = path.join(directory, 'fan-state.json');
  let now = Date.UTC(2026, 9, 22, 15, 59);
  const fanConfig: CommentReplyConfig = { ...config, fanQuota: { suiUid: '1954091502', relatedUids: ['1609526545'],
    hourly: { sui: 12, related: 6, other: 3 }, daily: { sui: 30, related: 15, other: 10 } } };
  const store = new CommentStateStore(file, '99'), state = await store.open();
  const answer = jest.fn(async () => '来啦'), send = jest.fn(async () => '123');
  const event = (id: number) => ({ key: `1:10:${id}`, uid: '1', oid: '10', type: 1, root: String(id), parent: String(id),
    text: '你好', createdAt: now, trigger: 'mention' as const });
  const worker = new CommentWorker(fanConfig, state, { now: () => now, save: value => store.save(value), answer, send });
  for (let id = 1; id <= 4; id++) { await worker.admit(event(id)); await worker.tick(); now += 60000; }
  expect(answer).toHaveBeenCalledTimes(3); expect(send).toHaveBeenCalledTimes(4);
  await store.close();
  const next = new CommentStateStore(file, '99'), recovered = await next.open();
  try {
    const resumed = new CommentWorker(fanConfig, recovered, { now: () => now, save: value => next.save(value), answer, send });
    await resumed.admit(event(5)); await resumed.tick();
    expect(send).toHaveBeenCalledTimes(4); expect(answer).toHaveBeenCalledTimes(3);
    expect(recovered.jobs.at(-1)?.status).toBe('skipped');
    now += 3600000; await resumed.admit(event(6)); await resumed.tick();
    expect(answer).toHaveBeenCalledTimes(4);
  } finally { await next.close(); }
});
