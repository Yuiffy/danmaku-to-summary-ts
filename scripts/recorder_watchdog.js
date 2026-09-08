'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const WINDOWS_HELPER = path.join(__dirname, 'recorder_watchdog_windows.ps1');
const DEFAULTS = {
  enabled: false, autoRestart: false, executablePath: '', arguments: [], workingDirectory: '',
  powershellPath: 'pwsh.exe', pollIntervalMs: 5000, missingGraceMs: 15000,
  startupGraceMs: 60000, stableMs: 15000, restartCooldownMs: 60000,
  maxRestarts: 3, restartWindowMs: 900000, notificationRetryMs: 60000
};
const LABELS = {
  missing: '\u5f55\u64ad\u59ec\u8fdb\u7a0b\u6d88\u5931',
  recovered: '\u5f55\u64ad\u59ec\u8fdb\u7a0b\u5df2\u6062\u590d',
  launch_failed: '\u5f55\u64ad\u59ec\u91cd\u542f\u5931\u8d25',
  blocked: '\u5f55\u64ad\u59ec\u5df2\u505c\u6b62\u81ea\u52a8\u91cd\u8bd5',
  identity_mismatch: '\u5f55\u64ad\u59ec\u8def\u5f84\u6216\u5b9e\u4f8b\u53d8\u5316',
  observer_error: '\u5f55\u64ad\u59ec\u5b88\u62a4\u68c0\u67e5\u5931\u8d25',
  test: '\u5f55\u64ad\u59ec\u5b88\u62a4\u6d4b\u8bd5\u901a\u77e5'
};

function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 300);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw };
  for (const key of ['enabled', 'autoRestart']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  for (const key of Object.keys(DEFAULTS).filter(key => typeof DEFAULTS[key] === 'number')) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (config.pollIntervalMs < 1000 || config.pollIntervalMs > 60000) throw new Error('pollIntervalMs must be 1000..60000');
  if (!Array.isArray(config.arguments) || config.arguments.some(value => typeof value !== 'string')) throw new Error('arguments must be a string array');
  if (config.enabled && (!path.win32.isAbsolute(config.executablePath) || path.win32.extname(config.executablePath).toLowerCase() !== '.exe')) throw new Error('Configure an absolute executablePath ending in .exe');
  config.workingDirectory ||= path.win32.dirname(config.executablePath);
  config.processName = path.win32.basename(config.executablePath, path.win32.extname(config.executablePath));
  if (config.enabled && !path.win32.isAbsolute(config.workingDirectory)) throw new Error('workingDirectory must be absolute');
  return config;
}

function sameExecutable(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

function noticeContent(kind, config, now, details = '') {
  return [
    `## ${LABELS[kind] || kind}`,
    `Time: ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
    `Process: ${config.processName || 'BililiveRecorder.WPF'}.exe`,
    `Auto restart: ${config.autoRestart ? 'enabled' : 'notification only'}`,
    details
  ].filter(Boolean).join('\n');
}

class RecorderWatchdog {
  constructor(config, dependencies = {}, persisted = {}) {
    this.config = config;
    this.now = dependencies.now || Date.now;
    this.launch = dependencies.launch || (() => launchRecorder(config));
    this.save = dependencies.save || (() => {});
    this.notify = dependencies.notify || (async () => false);
    this.control = dependencies.control || (() => ({}));
    this.log = dependencies.log || (() => {});
    this.state = {
      version: 1, phase: 'initializing', attempts: [], notices: [], incident: null,
      blocked: false, launchUntil: 0, lastSeen: null, resetToken: null, ...persisted,
      missingSince: null, missingSamples: 0, candidate: null, observerErrorSince: null
    };
    if (this.state.version !== 1 || !Array.isArray(this.state.attempts) || !Array.isArray(this.state.notices)) throw new Error('Invalid watchdog state; refusing automatic restart');
    this.startupUntil = this.now() + config.startupGraceMs;
    this.flushing = false;
  }

  persist() {
    this.state.watchdogPid = process.pid;
    this.state.heartbeatAt = this.now();
    this.save(this.state);
  }

  phase(value) {
    if (this.state.phase !== value) this.log(value);
    this.state.phase = value;
  }

  notice(kind, key, details) {
    if (this.state.notices.some(notice => notice.key === key)) return;
    this.state.notices.push({ key, kind, content: noticeContent(kind, this.config, this.now(), details), nextAttemptAt: 0 });
  }

  async observe(snapshot) {
    const now = this.now();
    const state = this.state;
    const control = this.control();
    if (control.resetToken && control.resetToken !== state.resetToken) {
      state.resetToken = control.resetToken;
      state.blocked = false;
      state.attempts = [];
      state.launchUntil = 0;
      state.missingSince = null;
      state.missingSamples = 0;
    }
    if (!this.config.enabled || (control.paused && (!control.until || now < control.until))) {
      this.phase(this.config.enabled ? 'paused' : 'disabled');
      state.missingSince = null;
      state.missingSamples = 0;
      this.persist();
      return;
    }
    if (snapshot.error || !Array.isArray(snapshot.processes)) {
      state.missingSince = null;
      state.missingSamples = 0;
      state.observerErrorSince ??= now;
      this.phase('observer_error');
      if (now - state.observerErrorSince >= this.config.missingGraceMs) {
        this.notice('observer_error', `observer-${state.observerErrorSince}`, 'Process inspection failed. No recorder is killed or restarted on unknown state.');
      }
      this.persist();
      return;
    }
    state.observerErrorSince = null;
    if (snapshot.processes.length) {
      state.missingSince = null;
      state.missingSamples = 0;
      this.startupUntil = 0;
      if (snapshot.processes.length !== 1 || !sameExecutable(snapshot.processes[0].executablePath, this.config.executablePath)) {
        if (state.phase !== 'identity_mismatch') this.notice('identity_mismatch', `identity-${now}`, 'A same-name process exists with a different/unknown path, or multiple instances exist. Automatic launch is blocked; check the configured executable path.');
        state.blocked = true;
        this.phase('identity_mismatch');
        this.persist();
        return;
      }
      const current = snapshot.processes[0];
      state.lastSeen = { ...current, observedAt: now };
      state.launchUntil = 0;
      if (state.incident || state.blocked) {
        const identity = `${current.pid}:${current.startedAt}`;
        if (state.candidate?.identity !== identity) state.candidate = { identity, since: now };
        this.phase('confirming_recovery');
        if (now - state.candidate.since >= this.config.stableMs) {
          this.notice('recovered', `${state.incident?.id || state.candidate.since}-recovered`, `PID: ${current.pid}. The process is present and stable; this is not a recording/file-growth guarantee.`);
          state.incident = null;
          state.blocked = false;
          this.phase('healthy');
        }
      } else {
        this.phase('healthy');
      }
      this.persist();
      return;
    }
    state.candidate = null;
    state.missingSince ??= now;
    state.missingSamples++;
    if (now < this.startupUntil || state.missingSamples < 2 || now - state.missingSince < this.config.missingGraceMs) {
      this.phase('confirming_missing');
      this.persist();
      return;
    }
    if (!state.incident) {
      state.incident = { id: crypto.randomUUID(), missingSince: state.missingSince };
      this.notice('missing', `${state.incident.id}-missing`, `Confirmed absent for ${Math.floor((now - state.missingSince) / 1000)}s. Last PID: ${state.lastSeen?.pid || 'unknown'}.`);
    }
    state.attempts = state.attempts.filter(at => now - at < this.config.restartWindowMs);
    if (!this.config.autoRestart || state.blocked) {
      this.phase(state.blocked ? 'manual_action_required' : 'missing');
      this.persist();
      return;
    }
    if (now < state.launchUntil) {
      this.phase('starting');
      this.persist();
      return;
    }
    if (state.attempts.length >= this.config.maxRestarts) {
      state.blocked = true;
      this.phase('manual_action_required');
      this.notice('blocked', `${state.incident.id}-blocked`, `Restart limit reached: ${this.config.maxRestarts} attempts within ${this.config.restartWindowMs / 60000} minutes. Automatic retries are stopped until recovery or manual resume.`);
      this.persist();
      return;
    }
    if (state.attempts.length && now - state.attempts.at(-1) < this.config.restartCooldownMs) {
      this.phase('cooldown');
      this.persist();
      return;
    }
    state.attempts.push(now);
    state.launchUntil = now + this.config.startupGraceMs;
    this.phase('starting');
    this.persist();
    try {
      state.lastLaunch = { at: now, ...(await this.launch()) };
    } catch (error) {
      state.lastLaunch = { at: now, error: safeError(error) };
      this.notice('launch_failed', `${state.incident.id}-launch-${now}`, safeError(error));
    }
    this.persist();
  }

  async flushNotifications() {
    if (this.flushing) return;
    const control = this.control();
    if (!this.config.enabled || (control.paused && (!control.until || this.now() < control.until))) return;
    this.flushing = true;
    try {
      for (const notice of [...this.state.notices]) {
        if (notice.sentAt || this.now() < notice.nextAttemptAt) continue;
        notice.nextAttemptAt = this.now() + this.config.notificationRetryMs;
        this.persist();
        try {
          if (!await this.notify(notice.content)) throw new Error('WeCom webhook is not configured');
          notice.sentAt = this.now();
          delete notice.error;
        } catch (error) { notice.error = safeError(error); }
        this.persist();
      }
      const sent = this.state.notices.filter(notice => notice.sentAt).slice(-20);
      this.state.notices = [...sent, ...this.state.notices.filter(notice => !notice.sentAt)];
    } finally { this.flushing = false; }
  }
}

function helperArguments(mode, config) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', WINDOWS_HELPER, '-Mode', mode, '-ProcessName', config.processName, '-IntervalMs', String(config.pollIntervalMs)];
}

function runHelper(mode, config, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.powershellPath, helperArguments(mode, config), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${mode} helper timed out`)); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr || `Helper exited ${code}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid JSON from Windows helper')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

function launchRecorder(config) {
  // The short-lived launcher exits before the recorder is supervised. Stopping
  // the watchdog does not intentionally terminate the recorder it launched.
  return runHelper('Launch', config, { executablePath: config.executablePath, workingDirectory: config.workingDirectory, arguments: config.arguments });
}

function observeProcesses(config, onSnapshot, onFailure) {
  const child = spawn(config.powershellPath, helperArguments('Watch', config), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  let stopping = false, stderr = '', lastSample = Date.now();
  lines.on('line', line => {
    lastSample = Date.now();
    try { onSnapshot(JSON.parse(line)); } catch (error) { onFailure(error); }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-2000); });
  child.on('error', error => { if (!stopping) onFailure(error); });
  child.on('close', code => { if (!stopping) onFailure(new Error(`Process observer exited ${code}: ${stderr}`)); });
  const timer = setInterval(() => {
    if (Date.now() - lastSample > Math.max(30000, config.pollIntervalMs * 4)) onFailure(new Error('Process observer stopped reporting'));
  }, config.pollIntervalMs);
  return () => { stopping = true; clearInterval(timer); lines.close(); child.kill(); };
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      return () => { if (readJson(file, {}).token === token) fs.unlinkSync(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(file, null);
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('Invalid watchdog lock; refusing to start another instance');
      try { process.kill(owner.pid, 0); throw new Error(`Watchdog already running (PID ${owner.pid})`); }
      catch (aliveError) {
        if (aliveError.code !== 'ESRCH') throw aliveError;
        fs.unlinkSync(file);
      }
    }
  }
  throw new Error('Could not acquire watchdog lock');
}

async function sendNotification(content) {
  const config = require('../src/scripts/config-loader').getConfig();
  const { sendWeChatMarkdown } = require('../src/scripts/wechat_work_markdown');
  return sendWeChatMarkdown(config.wechatWork?.webhookUrl, content, { timeout: 10000 });
}

async function runWatchdog(config, files) {
  if (process.platform !== 'win32') throw new Error('Recorder watchdog requires Windows and PowerShell 7');
  const release = acquireLock(files.lock);
  const log = text => console.log(`[recorder-watchdog] ${new Date().toISOString()} ${text}`);
  let stopObserver = () => {}, serial = Promise.resolve(), stopping = false;
  const guard = new RecorderWatchdog(config, {
    save: state => writeJson(files.state, state), control: () => readJson(files.control, {}), notify: sendNotification, log
  }, readJson(files.state, {}));
  const stop = (code, error) => {
    if (stopping) return;
    stopping = true;
    if (error) console.error(safeError(error));
    stopObserver();
    clearInterval(notifyTimer);
    guard.phase(code ? 'observer_failed' : 'stopped');
    const finish = () => {
      try { guard.persist(); release(); } finally { process.exit(code); }
    };
    if (code && error) {
      const key = crypto.createHash('sha256').update(safeError(error)).digest('hex');
      guard.notice('observer_error', `fatal-${key}`, safeError(error));
      guard.persist();
      guard.flushNotifications().catch(() => {}).finally(finish);
      setTimeout(finish, 12000).unref();
    } else { finish(); }
  };
  const notifyTimer = setInterval(() => { guard.flushNotifications().catch(error => stop(1, error)); }, 1000);
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  if (!config.enabled) {
    guard.phase('disabled');
    guard.persist();
    return;
  }
  stopObserver = observeProcesses(config, snapshot => {
    serial = serial.then(() => guard.observe(snapshot)).catch(error => stop(1, error));
  }, error => stop(1, error));
  log(`Watching ${config.processName}; autoRestart=${config.autoRestart}; poll=${config.pollIntervalMs}ms`);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    exe: { type: 'string' }, 'working-directory': { type: 'string' }, powershell: { type: 'string' },
    argument: { type: 'string', multiple: true }, 'notify-only': { type: 'boolean' },
    minutes: { type: 'string', default: '30' }, indefinite: { type: 'boolean' }
  } });
  const directory = path.resolve(process.env.RECORDER_WATCHDOG_RUNTIME_DIR || path.join(ROOT, 'data/runtime'));
  const files = Object.fromEntries(['settings', 'state', 'control', 'lock'].map(name => [name, path.join(directory, `recorder_watchdog.${name}.json`)]));
  const raw = readJson(files.settings, {});
  const command = positionals[0] || 'status';
  if (command === 'configure') {
    const config = normalizeConfig({ ...raw, enabled: true, executablePath: values.exe || raw.executablePath,
      workingDirectory: values['working-directory'] || (values.exe ? path.win32.dirname(values.exe) : raw.workingDirectory),
      powershellPath: values.powershell || raw.powershellPath || DEFAULTS.powershellPath,
      arguments: values.argument || raw.arguments || [], autoRestart: !values['notify-only'] });
    if (!fs.statSync(config.executablePath).isFile() || !fs.statSync(config.workingDirectory).isDirectory()) throw new Error('Invalid recorder executable/working directory');
    writeJson(files.settings, config);
    console.log(JSON.stringify({ settingsPath: files.settings, config }, null, 2));
    return;
  }
  const config = normalizeConfig(raw);
  if (command === 'pause') {
    const minutes = Number(values.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) throw new Error('minutes must be between 0 and 10080');
    const control = { paused: true, until: values.indefinite ? null : Date.now() + minutes * 60000 };
    writeJson(files.control, control);
    console.log(JSON.stringify(control));
  } else if (command === 'resume') {
    writeJson(files.control, { paused: false, resetToken: crypto.randomUUID() });
    console.log('Watchdog resumed; restart limit reset.');
  } else if (command === 'status') {
    const state = readJson(files.state, {});
    console.log(JSON.stringify({ configured: config.enabled, autoRestart: config.autoRestart, executablePath: config.executablePath,
      heartbeatFresh: Boolean(state.heartbeatAt && Date.now() - state.heartbeatAt < Math.max(30000, config.pollIntervalMs * 4)),
      state, control: readJson(files.control, {}) }, null, 2));
  } else if (command === 'check') {
    if (!config.enabled) throw new Error('Configure the watchdog first');
    console.log(JSON.stringify(await runHelper('Snapshot', config), null, 2));
  } else if (command === 'test-notification') {
    if (!await sendNotification(noticeContent('test', config, Date.now(), 'Test only. No recorder process was stopped or restarted.'))) throw new Error('WeCom webhook is missing');
    console.log('WeCom accepted the watchdog test notification.');
  } else if (command === 'run') {
    await runWatchdog(config, files);
  } else { throw new Error('Expected configure, run, check, status, pause, resume, or test-notification'); }
}

module.exports = { DEFAULTS, RecorderWatchdog, normalizeConfig, sameExecutable, safeError, runHelper, launchRecorder, observeProcesses, acquireLock, writeJson, readJson };
if (require.main === module) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
