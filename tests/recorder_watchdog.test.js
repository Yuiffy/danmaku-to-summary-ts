'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  DEFAULTS, RecorderWatchdog, normalizeConfig, sameExecutable, safeError,
  launchRecorder, observeProcesses, runHelper, acquireLock
} = require('../scripts/recorder_watchdog');

const executablePath = 'C:\\Recorder\\BililiveRecorder.WPF.exe';
const running = (pid = 42, executable = executablePath) => ({ processes: [{ pid, executablePath: executable, startedAt: `start-${pid}`, sessionId: 1 }] });
const missing = { processes: [] };

function fixture(overrides = {}, persisted = {}) {
  let now = 100000;
  let control = {};
  const launches = [], messages = [], saves = [];
  const config = normalizeConfig({ ...DEFAULTS, enabled: true, autoRestart: true, executablePath, ...overrides });
  const guard = new RecorderWatchdog(config, {
    now: () => now, control: () => control,
    launch: async () => { launches.push(now); return { started: true, pid: 99 }; },
    notify: async text => { messages.push(text); return true; },
    save: state => saves.push(structuredClone(state))
  }, persisted);
  return { guard, config, launches, messages, saves,
    advance: ms => { now += ms; }, control: value => { control = value; },
    async disappear() { await guard.observe(running()); await guard.observe(missing); now += config.missingGraceMs; await guard.observe(missing); }
  };
}

test('configuration is opt-in and validates executable/argument boundaries', () => {
  assert.equal(normalizeConfig().enabled, false);
  assert.throws(() => normalizeConfig({ enabled: true, executablePath: 'relative.exe' }));
  assert.throws(() => normalizeConfig({ arguments: 'a b' }));
  assert.throws(() => normalizeConfig({ pollIntervalMs: 0 }));
  assert.throws(() => normalizeConfig({ maxRestarts: -1 }));
  assert(sameExecutable('c:/Recorder/BililiveRecorder.WPF.exe', executablePath));
  assert(!sameExecutable(null, executablePath));
  assert(!safeError(new Error('request to https://host/path?key=secret failed')).includes('secret'));
});

test('a healthy existing recorder is neither restarted nor announced repeatedly', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) { await f.guard.observe(running()); f.advance(10000); }
  await f.guard.flushNotifications();
  assert.equal(f.guard.state.phase, 'healthy');
  assert.equal(f.launches.length, 0);
  assert.equal(f.messages.length, 0);
});

test('confirmed absence launches once and emits one missing notification', async () => {
  const f = fixture();
  await f.disappear();
  assert.equal(f.launches.length, 1);
  for (let i = 0; i < 4; i++) { f.advance(5000); await f.guard.observe(missing); await f.guard.flushNotifications(); }
  assert.equal(f.launches.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.guard.state.phase, 'starting');
  assert.equal(f.saves.find(state => state.attempts.length).lastLaunch, undefined, 'attempt must be durable before launch');
});

test('a short disappearance is ignored', async () => {
  const f = fixture();
  await f.guard.observe(running());
  await f.guard.observe(missing);
  f.advance(10000);
  await f.guard.observe(running());
  assert.equal(f.launches.length, 0);
  assert.equal(f.guard.state.notices.length, 0);
});

test('an initially absent recorder gets a boot grace period', async () => {
  const f = fixture();
  await f.guard.observe(missing);
  f.advance(15000);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 0);
  f.advance(45000);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 1);
});

test('inspection failures cannot be mistaken for process exit', async () => {
  const f = fixture();
  await f.guard.observe(running());
  await f.guard.observe(missing);
  f.advance(15000);
  await f.guard.observe({ error: 'access denied' });
  f.advance(30000);
  await f.guard.observe({ error: 'access denied' });
  await f.guard.flushNotifications();
  assert.equal(f.launches.length, 0);
  assert.equal(f.messages.length, 1);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 0, 'fresh missing confirmation is required after an inspection error');
});

test('notify-only mode never launches a missing recorder', async () => {
  const f = fixture({ autoRestart: false });
  await f.disappear();
  f.advance(300000);
  await f.guard.observe(missing);
  await f.guard.flushNotifications();
  assert.equal(f.launches.length, 0);
  assert.equal(f.messages.length, 1);
});

test('pause suppresses recovery actions and resumes after its deadline', async () => {
  const f = fixture();
  await f.guard.observe(running());
  f.control({ paused: true, until: 140000 });
  await f.guard.observe(missing);
  f.advance(30000);
  await f.guard.observe(missing);
  assert.equal(f.guard.state.phase, 'paused');
  assert.equal(f.launches.length, 0);
  f.advance(10000);
  await f.guard.observe(missing);
  f.advance(15000);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 1);
});

test('indefinite pause also suspends pending notification delivery', async () => {
  const f = fixture();
  await f.disappear();
  f.control({ paused: true, until: null });
  f.advance(1000000);
  await f.guard.observe(missing);
  await f.guard.flushNotifications();
  assert.equal(f.launches.length, 1);
  assert.equal(f.messages.length, 0);
});

test('recovery requires a stable PID and is notified only once', async () => {
  const f = fixture();
  await f.disappear();
  await f.guard.observe(running(99));
  f.advance(10000);
  await f.guard.observe(running(100));
  f.advance(10000);
  await f.guard.observe(running(100));
  assert.equal(f.guard.state.phase, 'confirming_recovery');
  f.advance(5000);
  await f.guard.observe(running(100));
  await f.guard.flushNotifications();
  await f.guard.observe(running(100));
  await f.guard.flushNotifications();
  assert.equal(f.guard.state.phase, 'healthy');
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1], /PID: 100/);
});

test('crash loops stop after the restart budget, even across watchdog restarts', async () => {
  const f = fixture();
  await f.disappear();
  for (let i = 0; i < 2; i++) { f.advance(60000); await f.guard.observe(missing); }
  assert.equal(f.launches.length, 3);
  f.advance(60000);
  await f.guard.observe(missing);
  assert.equal(f.guard.state.blocked, true);
  const resumed = fixture({}, structuredClone(f.guard.state));
  resumed.advance(500000);
  await resumed.guard.observe(missing);
  resumed.advance(15000);
  await resumed.guard.observe(missing);
  assert.equal(resumed.launches.length, 0);
  resumed.control({ paused: false, resetToken: 'manual-retry' });
  await resumed.guard.observe(missing);
  resumed.advance(15000);
  await resumed.guard.observe(missing);
  assert.equal(resumed.launches.length, 1);
});

test('launch failures are reported and cooldown prevents a retry storm', async () => {
  const f = fixture();
  f.guard.launch = async () => { f.launches.push(true); throw new Error('executable missing'); };
  await f.disappear();
  await f.guard.flushNotifications();
  f.advance(5000);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 1);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1], /executable missing/);
});

test('different, inaccessible, or duplicate process identities never launch another copy', async () => {
  for (const sample of [running(1, 'C:\\Other\\BililiveRecorder.WPF.exe'), running(1, null), { processes: [...running(1).processes, ...running(2).processes] }]) {
    const f = fixture();
    await f.guard.observe(sample);
    f.advance(900000);
    await f.guard.observe(missing);
    f.advance(15000);
    await f.guard.observe(missing);
    assert.equal(f.launches.length, 0);
    assert.equal(f.guard.state.blocked, true);
  }
});

test('a corrected process identity clears the block only after stable observation', async () => {
  const f = fixture();
  await f.guard.observe(running(1, null));
  await f.guard.observe(running());
  assert.equal(f.guard.state.blocked, true);
  f.advance(15000);
  await f.guard.observe(running());
  assert.equal(f.guard.state.blocked, false);
});

test('network failure is retried without duplicating successful delivery or blocking launch', async () => {
  const f = fixture();
  let calls = 0;
  f.guard.notify = async () => { calls++; if (calls === 1) throw new Error('offline'); return true; };
  await f.disappear();
  await f.guard.flushNotifications();
  await f.guard.flushNotifications();
  assert.equal(calls, 1);
  assert.equal(f.launches.length, 1);
  f.advance(60000);
  await f.guard.flushNotifications();
  await f.guard.flushNotifications();
  assert.equal(calls, 2);
});

test('an in-flight notification does not stop process observations', async () => {
  const f = fixture();
  await f.disappear();
  let finish;
  f.guard.notify = () => new Promise(resolve => { finish = resolve; });
  const flushing = f.guard.flushNotifications();
  f.advance(60000);
  await f.guard.observe(missing);
  assert.equal(f.launches.length, 2);
  finish(true);
  await flushing;
});

test('a duplicate-launch race is handled without reporting unverified recovery', async () => {
  const f = fixture();
  f.guard.launch = async () => ({ started: false, reason: 'already_running' });
  await f.disappear();
  assert.equal(f.guard.state.phase, 'starting');
  assert.equal(f.guard.state.lastLaunch.started, false);
  assert.equal(f.guard.state.notices.filter(notice => notice.kind === 'recovered').length, 0);
});

test('watchdog state lock rejects an already running owner', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-watchdog-lock-'));
  try {
    const file = path.join(directory, 'lock.json');
    const release = acquireLock(file);
    assert.throws(() => acquireLock(file), /already running/);
    release();
    acquireLock(file)();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Windows native observer and launcher recover a disposable fixture, not the real recorder', {
  skip: process.platform !== 'win32' || process.env.RECORDER_WATCHDOG_NATIVE_TEST !== '1', timeout: 45000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder watchdog native '));
  const fixtureExe = path.join(directory, `recorder-fixture-${process.pid}.exe`);
  const script = path.join(directory, 'fixture script.cjs');
  const argumentsPath = path.join(directory, 'received arguments.json');
  const expectedArguments = ['space separated', 'embedded "quote"', '', '\u5f55\u64ad path'];
  fs.copyFileSync(process.execPath, fixtureExe);
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); setInterval(() => {}, 1000);\n");
  const config = normalizeConfig({ enabled: true, autoRestart: true, executablePath: fixtureExe,
    powershellPath: process.env.RECORDER_WATCHDOG_TEST_POWERSHELL || 'pwsh.exe',
    arguments: [script, argumentsPath, ...expectedArguments], workingDirectory: directory, pollIntervalMs: 1000, missingGraceMs: 1000,
    startupGraceMs: 3000, stableMs: 1000, restartCooldownMs: 3000 });
  let stop = () => {}, failure = null;
  const children = new Set();
  const messages = [];
  try {
    const first = await launchRecorder(config);
    assert.equal(first.started, true);
    children.add(first.pid);
    const duplicate = await launchRecorder(config);
    assert.equal(duplicate.started, false);
    const guard = new RecorderWatchdog(config, { launch: async () => {
      const result = await launchRecorder(config);
      if (result.pid) children.add(result.pid);
      return result;
    }, notify: async text => { messages.push(text); return true; } });
    let serial = Promise.resolve();
    stop = observeProcesses(config, sample => {
      serial = serial.then(() => guard.observe(sample)).catch(error => { failure = error; });
    }, error => { failure = error; });
    const until = async condition => {
      const deadline = Date.now() + 20000;
      while (!condition()) {
        if (failure) throw failure;
        if (Date.now() > deadline) throw new Error('Native watchdog verification timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await until(() => guard.state.phase === 'healthy');
    assert.deepEqual(JSON.parse(fs.readFileSync(argumentsPath, 'utf8')), expectedArguments);
    process.kill(first.pid);
    await until(() => children.size === 2 && guard.state.phase === 'healthy' && guard.state.lastSeen.pid !== first.pid);
    await guard.flushNotifications();
    assert.equal(messages.length, 2);
    const recoveredPid = guard.state.lastSeen.pid;
    stop();
    await serial;
    process.kill(recoveredPid, 0);
    assert((await runHelper('Snapshot', config)).processes.some(item => item.pid === recoveredPid));
  } finally {
    stop();
    for (const pid of children) { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
