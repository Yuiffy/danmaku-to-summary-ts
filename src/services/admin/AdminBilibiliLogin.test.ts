import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AdminBilibiliLogin } from './AdminBilibiliLogin';
import { AdminConfigStore } from './AdminConfigStore';
import { atomicJson, readJson, redact, HIDDEN } from './AdminFiles';
import { createAdminServer } from './AdminServer';
import { LoginProbe } from './BilibiliLoginProbe';

let root: string, configs: AdminConfigStore, login: AdminBilibiliLogin;
const oldCookie = 'DedeUserID=123; SESSDATA=old-session; bili_jct=old-csrf';
const cookie = 'DedeUserID=123; SESSDATA=new-session; bili_jct=new-csrf';
const valid: LoginProbe = { login: 'valid', uid: '123', accountName: '鹿饼', refresh: 'not-needed' };
const probe = jest.fn<Promise<LoginProbe>, [string, AbortSignal]>();
const service = jest.fn<Promise<'valid' | 'unavailable'>, [AbortSignal]>();
const signal = () => new AbortController().signal;
const input = () => ({ revision: configs.get('secrets').revision, cookie, acTimeValue: 'new-refresh' });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-login-'));
  configs = new AdminConfigStore(root);
  atomicJson(configs.path('secrets'), { bilibili: { cookie: oldCookie, ac_time_value: 'old-refresh' }, other: { token: 'keep-me' } });
  atomicJson(configs.path('live-vote'), { botUid: 123 });
  probe.mockReset().mockResolvedValue(valid); service.mockReset().mockResolvedValue('valid');
  login = new AdminBilibiliLogin(configs, root, { probe, service });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('validates, backs up and preserves unrelated secrets without returning credentials', async () => {
  const result = await login.save(input(), signal());
  expect(result.status).toMatchObject({ login: 'valid', expectedUid: '123', service: 'valid', hasRefreshToken: true });
  expect(readJson(configs.path('secrets'))).toEqual({ bilibili: { cookie, csrf: 'new-csrf', ac_time_value: 'new-refresh' }, other: { token: 'keep-me' } });
  const backup = path.join(root, 'data/runtime/admin/config-backups');
  expect(readJson(path.join(backup, fs.readdirSync(backup)[0])).bilibili.cookie).toBe(oldCookie);
  for (const secret of ['new-session', 'new-csrf', 'new-refresh', 'keep-me']) expect(JSON.stringify(result)).not.toContain(secret);
});
it.each([
  { cookie: 'DedeUserID=999; SESSDATA=x; bili_jct=y' },
  { cookie: 'DedeUserID=123; bili_jct=x' },
  { cookie: cookie + '; SESSDATA=duplicate' },
  { acTimeValue: '' }, { cookie: cookie + '\r\nInjected: yes' }
])('rejects malformed or wrong-account input before network IO: %j', async override => {
  const before = fs.readFileSync(configs.path('secrets'), 'utf8');
  await expect(login.save({ ...input(), ...override }, signal())).rejects.toThrow();
  expect(probe).not.toHaveBeenCalled(); expect(fs.readFileSync(configs.path('secrets'), 'utf8')).toBe(before);
});
it.each([{ ...valid, login: 'invalid' as const }, { ...valid, uid: '456' }, { ...valid, login: 'unavailable' as const }])('never saves a rejected remote login', async result => {
  probe.mockResolvedValue(result);
  await expect(login.save(input(), signal())).rejects.toThrow();
  expect(readJson(configs.path('secrets')).bilibili.cookie).toBe(oldCookie);
});
it('rechecks revisions after remote validation and keeps concurrent changes', async () => {
  probe.mockImplementation(async () => { atomicJson(configs.path('secrets'), { external: 'changed' }); return valid; });
  await expect(login.save(input(), signal())).rejects.toMatchObject({ status: 409 });
  expect(readJson(configs.path('secrets'))).toEqual({ external: 'changed' });
});
it('serializes recovery and cancels before persistence', async () => {
  let resolve!: (value: LoginProbe) => void;
  probe.mockImplementation(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController(), value = input(), first = login.save(value, controller.signal);
  await expect(login.save(value, signal())).rejects.toMatchObject({ status: 409 });
  controller.abort(); resolve(valid);
  await expect(first).rejects.toThrow();
  expect(readJson(configs.path('secrets')).bilibili.cookie).toBe(oldCookie);
});
it('reports a successful save even if comment service checking fails afterward', async () => {
  service.mockRejectedValue(new Error('offline'));
  expect((await login.save(input(), signal())).status.service).toBe('unavailable');
  expect(readJson(configs.path('secrets')).bilibili.cookie).toBe(cookie);
});
it('reports recorder synchronization from target identity and a fresh healthy heartbeat', async () => {
  const target = path.join(root, 'recorder.json');
  atomicJson(target, { global: { Cookie: { Value: oldCookie } } });
  atomicJson(path.join(root, 'data/runtime/recorder_watchdog.settings.json'), { cookieSync: { enabled: true, sourcePath: configs.path('secrets'), recorderConfigPath: target } });
  const stateFile = path.join(root, 'data/runtime/recorder_watchdog.state.json');
  atomicJson(stateFile, { heartbeatAt: Date.now(), phase: 'healthy', cookieSync: { status: 'current' } });
  expect((await login.status(signal())).recorderSync).toBe('current');
  atomicJson(target, { global: { Cookie: { Value: cookie } } });
  expect((await login.status(signal())).recorderSync).toBe('pending');
  atomicJson(stateFile, { heartbeatAt: 1 });
  expect((await login.status(signal())).recorderSync).toBe('unavailable');
});
it('masks refresh and CSRF values through the general config endpoint too', () => {
  expect(redact({ ac_time_value: 'a', acTimeValue: 'b', csrf: 'c', bili_jct: 'd', SESSDATA: 'e' }))
    .toEqual({ ac_time_value: HIDDEN, acTimeValue: HIDDEN, csrf: HIDDEN, bili_jct: HIDDEN, SESSDATA: HIDDEN });
});
it('keeps both login routes behind admin auth and rejects oversized requests', async () => {
  const token = 'a'.repeat(64), app = createAdminServer({ configs, bilibiliLogin: login } as any, token);
  await request(app).get('/bilibili/login').expect(403);
  await request(app).post('/bilibili/login').send(input()).expect(403);
  const auth = { Authorization: `Bearer ${token}` };
  await request(app).get('/bilibili/login').set(auth).expect(200);
  await request(app).post('/bilibili/login').set(auth).send({ cookie: 'x'.repeat(66000) }).expect(413);
  await request(app).post('/bilibili/login').set(auth).send(input()).expect(200);
});
