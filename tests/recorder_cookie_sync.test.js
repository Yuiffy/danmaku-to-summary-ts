'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readCookieSyncPlan } = require('../scripts/recorder_cookie_sync');
const { RecorderWatchdog, normalizeConfig, runHelper, launchRecorder } = require('../scripts/recorder_watchdog');

const cookie = (session, uid = '123') => `DedeUserID=${uid}; SESSDATA=${session}; bili_jct=csrf; buvid3=device`;
const exe = 'C:\\Recorder\\BililiveRecorder.WPF.exe';
const options = { enabled: true, sourcePath: 'C:\\Config\\secret.json', recorderConfigPath: 'C:\\Recording\\config.json' };
const running = { processes: [{ pid: 42, executablePath: exe, startedAt: 'same-start' }] };

function files(t, oldCookie = cookie('old-private-session'), newCookie = cookie('new-private-session')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-cookie-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'secret.json');
  const recorderConfigPath = path.join(directory, 'config.json');
  fs.writeFileSync(sourcePath, '\uFEFF' + JSON.stringify({ bilibili: { cookie: newCookie }, unrelated: true }));
  fs.writeFileSync(recorderConfigPath, JSON.stringify({ global: { Cookie: { HasValue: true, Value: oldCookie } }, rooms: [25788785] }));
  return { sourcePath, recorderConfigPath, enabled: true };
}

test('detects session rotation without leaking credentials or changing files', t => {
  const f = files(t);
  const before = fs.readFileSync(f.recorderConfigPath, 'utf8');
  const plan = readCookieSyncPlan(f);
  assert.equal(plan.changed, true);
  assert(!JSON.stringify(plan).includes('private-session'));
  assert.equal(fs.readFileSync(f.recorderConfigPath, 'utf8'), before);
});

test('does not restart for cookie ordering or unrelated browser preferences', t => {
  const f = files(t, cookie('same'), 'theme=dark; ' + cookie('same'));
  assert.equal(readCookieSyncPlan(f).changed, false);
});

test('rejects foreign accounts, incomplete credentials and malformed JSON without quoting secrets', t => {
  const f = files(t, cookie('old'), cookie('new', '456'));
  assert.throws(() => readCookieSyncPlan(f), /accounts differ/);
  fs.writeFileSync(f.sourcePath, JSON.stringify({ bilibili: { cookie: 'SESSDATA=private-session' } }));
  assert.throws(() => readCookieSyncPlan(f), /missing DedeUserID/);
  fs.writeFileSync(f.sourcePath, '{private-session');
  assert.throws(() => readCookieSyncPlan(f), error => !error.message.includes('private-session'));
});

test('cookie sync is disabled by default and requires separate absolute paths', () => {
  assert.equal(normalizeConfig().cookieSync, null);
  assert.equal(normalizeConfig({ cookieSync: options }).cookieSync.intervalMs, 60000);
  assert.throws(() => normalizeConfig({ cookieSync: { ...options, intervalMs: 0 } }));
  assert.throws(() => normalizeConfig({ cookieSync: { enabled: true, sourcePath: 'relative' } }));
  assert.throws(() => normalizeConfig({ cookieSync: { ...options, recorderConfigPath: options.sourcePath } }));
});

function guardFixture(configOverrides = {}) {
  let now = 100000, changed = true, control = {};
  const syncs = [];
  const config = normalizeConfig({ enabled: true, autoRestart: true, executablePath: exe, cookieSync: options, ...configOverrides });
  const guard = new RecorderWatchdog(config, {
    now: () => now, control: () => control,
    cookiePlan: () => ({ changed, fingerprint: 'opaque-fingerprint', sourceHash: 'source', configHash: 'target' }),
    syncCookie: async (current, plan) => { syncs.push({ current, plan }); changed = false; return { changed: true, pid: 43 }; }
  });
  return { guard, syncs, advance: ms => { now += ms; }, control: value => { control = value; }, changed: value => { changed = value; } };
}

test('rotated credentials trigger exactly one synchronization and reuses process identity', async () => {
  const f = guardFixture();
  await f.guard.observe(running);
  assert.equal(f.syncs.length, 1);
  assert.equal(f.syncs[0].current.pid, 42);
  assert.equal(f.guard.state.cookieSync.status, 'applied');
  for (let i = 0; i < 5; i++) { f.advance(60000); await f.guard.observe(running); }
  assert.equal(f.syncs.length, 1);
  assert.equal(f.guard.state.cookieSync.status, 'current');
});

test('five-second process checks only read credentials once per configured minute', async () => {
  const f = guardFixture();
  let reads = 0;
  const plan = f.guard.cookiePlan;
  f.guard.cookiePlan = () => { reads++; return plan(); };
  f.changed(false);
  await f.guard.observe(running);
  f.changed(true);
  for (let i = 0; i < 11; i++) {
    f.advance(5000);
    await f.guard.observe(running);
  }
  assert.equal(reads, 1);
  assert.equal(f.syncs.length, 0);
  assert.equal(f.guard.state.lastSeen.observedAt, 155000);
  assert.equal(f.guard.state.cookieSyncNextCheckAt, 160000);
  f.advance(5000);
  await f.guard.observe(running);
  assert.equal(reads, 2);
  assert.equal(f.syncs.length, 1);
});

test('pause, notify-only mode and wrong process identity cannot restart for credentials', async () => {
  const paused = guardFixture();
  paused.control({ paused: true });
  await paused.guard.observe(running);
  assert.equal(paused.syncs.length, 0);
  const notifyOnly = guardFixture({ autoRestart: false });
  await notifyOnly.guard.observe(running);
  assert.equal(notifyOnly.syncs.length, 0);
  assert.equal(notifyOnly.guard.state.cookieSync.status, 'pending');
  const wrong = guardFixture();
  await wrong.guard.observe({ processes: [{ ...running.processes[0], executablePath: 'C:\\Other\\recorder.exe' }] });
  assert.equal(wrong.syncs.length, 0);
});

test('sync failures preserve a cooldown, share the restart budget and redact errors', async () => {
  const f = guardFixture({ maxRestarts: 2 });
  let calls = 0;
  f.guard.syncCookie = async () => { calls++; throw new Error('private-session'); };
  await f.guard.observe(running);
  await f.guard.observe(running);
  assert.equal(calls, 1);
  f.advance(60000);
  await f.guard.observe(running);
  assert.equal(calls, 2);
  f.advance(60000);
  await f.guard.observe(running);
  assert.equal(calls, 2);
  assert(!JSON.stringify(f.guard.state).includes('private-session'));
  assert.equal(f.guard.state.notices.length, 1);
});

test('Windows helper leaves matching credentials untouched and rejects a changed source', { skip: process.platform !== 'win32' }, async t => {
  const f = files(t, cookie('same'), cookie('same'));
  const plan = readCookieSyncPlan(f);
  const config = normalizeConfig({ executablePath: process.execPath, workingDirectory: path.dirname(process.execPath) });
  const spec = { ...f, ...plan, executablePath: process.execPath, workingDirectory: path.dirname(process.execPath), arguments: [], expectedPid: 0, expectedStartedAt: 'never' };
  const result = await runHelper('SyncCookie', config, spec);
  assert.equal(result.changed, false);
  fs.writeFileSync(f.sourcePath, JSON.stringify({ bilibili: { cookie: cookie('new-private-session') } }));
  await assert.rejects(runHelper('SyncCookie', config, spec), error => /synchronization failed/.test(error.message) && !error.message.includes('private-session'));
  assert.equal(JSON.parse(fs.readFileSync(f.recorderConfigPath)).global.Cookie.Value, cookie('same'));
  const updated = { ...spec, ...readCookieSyncPlan(f) };
  await assert.rejects(runHelper('SyncCookie', config, updated), /synchronization failed/);
  assert.equal(JSON.parse(fs.readFileSync(f.recorderConfigPath)).global.Cookie.Value, cookie('same'));
});

test('Windows helper atomically installs credentials and restarts only its disposable fixture', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-cookie-native-'));
  const fixtureExe = path.join(directory, `cookie-fixture-${process.pid}.exe`);
  const script = path.join(directory, 'fixture.cjs');
  const sourcePath = path.join(directory, 'secret.json');
  const recorderConfigPath = path.join(directory, 'config.json');
  const children = new Set();
  const original = { global: { Cookie: { HasValue: true, Value: cookie('old') }, TimingCheckInterval: { HasValue: true, Value: 360 } }, rooms: [{ RoomId: 25788785, AutoRecord: true }] };
  try {
    fs.copyFileSync(process.execPath, fixtureExe);
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    fs.writeFileSync(sourcePath, JSON.stringify({ bilibili: { cookie: cookie('new') } }));
    fs.writeFileSync(recorderConfigPath, JSON.stringify(original));
    const config = normalizeConfig({ enabled: true, autoRestart: true, executablePath: fixtureExe, workingDirectory: directory, arguments: [script] });
    const first = await launchRecorder(config);
    children.add(first.pid);
    const current = (await runHelper('Snapshot', config)).processes.find(item => item.pid === first.pid);
    assert(current);
    const plan = readCookieSyncPlan({ sourcePath, recorderConfigPath });
    const result = await runHelper('SyncCookie', config, { ...config, sourcePath, recorderConfigPath, ...plan, expectedPid: current.pid, expectedStartedAt: current.startedAt });
    children.add(result.pid);
    assert.equal(result.changed, true);
    assert.notEqual(result.pid, first.pid);
    const updated = JSON.parse(fs.readFileSync(recorderConfigPath, 'utf8'));
    assert.equal(updated.global.Cookie.Value, cookie('new'));
    updated.global.Cookie.Value = cookie('old');
    assert.deepEqual(updated, original);
    assert.deepEqual(JSON.parse(fs.readFileSync(recorderConfigPath + '.before-cookie-sync', 'utf8')), original);
    assert.equal(readCookieSyncPlan({ sourcePath, recorderConfigPath }).changed, false);
    assert((await runHelper('Snapshot', config)).processes.some(item => item.pid === result.pid));
  } finally {
    for (const pid of children) { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
