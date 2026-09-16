'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseStringPromise } = require('xml2js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WATCHDOG_DIR = 'C:\\Windows\\LiveKernelReports\\WATCHDOG';
const DEFAULT_WER_ARCHIVE_DIR = 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive';
const DEFAULT_WER_QUEUE_DIR = 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue';
const DEFAULT_OBS_LOG_DIR = path.join(process.env.APPDATA || '', 'obs-studio', 'logs');

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function envInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function getDefaultOutputDir() {
  const preferred = 'D:\\diagnostics\\gpu-tdr';
  try {
    if (fs.existsSync('D:\\')) return preferred;
  } catch (_error) {
    // Fall through to the system drive when the preferred drive is unavailable.
  }
  return path.join(process.env.SystemDrive || 'C:', 'diagnostics', 'gpu-tdr');
}

function buildConfig() {
  return {
    outputDir: path.resolve(process.env.GPU_TDR_CAPTURE_DIR || getDefaultOutputDir()),
    watchdogDir: path.resolve(process.env.GPU_TDR_WATCHDOG_DIR || DEFAULT_WATCHDOG_DIR),
    werArchiveDir: path.resolve(process.env.GPU_TDR_WER_ARCHIVE_DIR || DEFAULT_WER_ARCHIVE_DIR),
    werQueueDir: path.resolve(process.env.GPU_TDR_WER_QUEUE_DIR || DEFAULT_WER_QUEUE_DIR),
    obsLogDir: path.resolve(process.env.GPU_TDR_OBS_LOG_DIR || DEFAULT_OBS_LOG_DIR),
    eventPollMs: envInteger('GPU_TDR_EVENT_POLL_MS', 5000, 1000, 60000),
    dumpPollMs: envInteger('GPU_TDR_DUMP_POLL_MS', 1500, 500, 60000),
    eventRecords: envInteger('GPU_TDR_EVENT_RECORDS', 256, 32, 1000),
    eventGroupMs: envInteger('GPU_TDR_EVENT_GROUP_MS', 90000, 10000, 600000),
    startupGraceMs: envInteger('GPU_TDR_STARTUP_GRACE_MS', 120000, 0, 900000),
    dumpLookbackMs: envInteger('GPU_TDR_DUMP_LOOKBACK_MS', 10 * 60 * 1000, 30000, 60 * 60 * 1000),
    dumpCopyAttempts: envInteger('GPU_TDR_DUMP_COPY_ATTEMPTS', 8, 1, 30),
    dumpCopyDelayMs: envInteger('GPU_TDR_DUMP_COPY_DELAY_MS', 1000, 100, 10000),
    werMaxDepth: envInteger('GPU_TDR_WER_MAX_DEPTH', 3, 1, 8),
    maxEvidenceFiles: envInteger('GPU_TDR_MAX_EVIDENCE_FILES', 300, 20, 2000),
    captureExisting: envBoolean('GPU_TDR_CAPTURE_EXISTING', false),
    disableEvents: envBoolean('GPU_TDR_DISABLE_EVENTS', false),
    disableWatchdog: envBoolean('GPU_TDR_DISABLE_WATCHDOG', false),
    nvidiaSmi: process.env.NVIDIA_SMI_PATH || 'nvidia-smi.exe',
    wevtutil: process.env.WEVTUTIL_PATH || 'wevtutil.exe',
    tasklist: process.env.TASKLIST_PATH || 'tasklist.exe'
  };
}

function timestamp(value = Date.now()) {
  const date = new Date(value);
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join('') + '-' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    pad(date.getUTCMilliseconds(), 3)
  ].join('');
}

function safeName(value, fallback = 'unknown') {
  const result = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 140);
  return result || fallback;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function log(level, message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  const line = `[gpu-tdr] ${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

async function ensureDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

async function writeUtf8(filePath, content) {
  await ensureDirectory(path.dirname(filePath));
  await fsp.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  await writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonLine(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function runNative(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || PROJECT_ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: error.message, error });
      return;
    }

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (_error) {
        // The process may already have exited.
      }
    }, timeoutMs);

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: error.message, error });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        signal,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut
      });
    });
  });
}

function splitEventXml(output) {
  return output.match(/<Event\b[\s\S]*?<\/Event>/gi) || [];
}

function nodeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_')) {
    return nodeText(value._);
  }
  return '';
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function parseEventXml(xml) {
  try {
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      trim: true
    });
    const event = parsed.Event || {};
    const system = event.System || {};
    const providerNode = system.Provider || {};
    const rendering = event.RenderingInfo || {};
    const renderingProvider = nodeText(rendering.Provider);
    const eventData = event.EventData || {};
    const data = {};
    for (const item of asArray(eventData.Data)) {
      const name = item && item.$ && item.$.Name ? item.$.Name : `data_${Object.keys(data).length}`;
      data[name] = nodeText(item);
    }
    if (eventData.Binary !== undefined) data.Binary = nodeText(eventData.Binary);

    const timeCreated = system.TimeCreated && system.TimeCreated.$
      ? system.TimeCreated.$.SystemTime
      : undefined;
    const eventTimeMs = Date.parse(timeCreated || '') || 0;
    const eventId = Number.parseInt(nodeText(system.EventID), 10);
    const recordId = nodeText(system.EventRecordID);
    const provider = (providerNode.$ && providerNode.$.Name) || renderingProvider || 'unknown';
    const message = nodeText(rendering.Message);
    const renderedText = [message, ...Object.values(data)].filter(Boolean).join('\n');

    return {
      provider,
      eventId: Number.isFinite(eventId) ? eventId : null,
      recordId,
      timeCreated: timeCreated || null,
      eventTimeMs,
      channel: nodeText(system.Channel),
      computer: nodeText(system.Computer),
      message,
      data,
      renderedText,
      rawXml: xml
    };
  } catch (error) {
    return {
      provider: 'unparsed',
      eventId: null,
      recordId: '',
      timeCreated: null,
      eventTimeMs: 0,
      channel: '',
      computer: '',
      message: error.message,
      data: {},
      renderedText: error.message,
      rawXml: xml,
      parseError: error.message
    };
  }
}

function isInterestingEvent(event) {
  const provider = String(event.provider || '').toLowerCase();
  const text = `${event.message || ''}\n${event.renderedText || ''}`.toLowerCase();

  if (provider === 'nvlddmkm' && Number(event.eventId) === 153) return true;
  if (provider === 'display' && Number(event.eventId) === 4101) return true;
  if (provider.includes('dxgkrnl') && /tdr|timeout|reset|livekernel|watchdog/.test(text)) return true;
  if (provider.includes('wer') && /livekernel|watchdog|\b141\b|nvlddmkm|display driver/.test(text)) return true;
  if (Number(event.eventId) === 1001 && /livekernel|watchdog|\b141\b|nvlddmkm|display driver/.test(text)) return true;
  return false;
}

function eventKey(event) {
  return [
    event.channel || 'unknown',
    event.recordId || '',
    event.provider || '',
    event.eventId || '',
    event.timeCreated || ''
  ].join('|');
}

async function listDirectory(directory) {
  try {
    return await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return { error };
  }
}

async function listWatchdogDumps(directory) {
  const entries = await listDirectory(directory);
  if (!Array.isArray(entries)) return { files: [], error: entries.error };
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.dmp$/i.test(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = await fsp.stat(fullPath);
      files.push({ path: fullPath, name: entry.name, stat });
    } catch (_error) {
      // A dump can disappear or be locked between directory enumeration and stat.
    }
  }
  return { files, error: null };
}

async function walkFiles(root, options = {}) {
  const maxDepth = options.maxDepth || 2;
  const maxFiles = options.maxFiles || 300;
  const files = [];
  const errors = [];

  async function visit(directory, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    const entries = await listDirectory(directory);
    if (!Array.isArray(entries)) {
      errors.push({ path: directory, error: entries.error.message });
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          files.push({ path: fullPath, stat });
        } catch (error) {
          errors.push({ path: fullPath, error: error.message });
        }
      }
    }
  }

  await visit(root, 0);
  return { files, errors };
}

function isLikelyEvidenceFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (extension === '.cab') return false;
  return [
    '.wer', '.dmp', '.mdmp', '.xml', '.txt', '.log', '.json', '.data', '.tmp'
  ].includes(extension) || /report|dump|livekernel|watchdog|metadata/.test(name);
}

async function copyFileStable(sourcePath, destinationPath, options = {}) {
  const attempts = options.attempts || 8;
  const delayMs = options.delayMs || 1000;
  const temporaryPath = `${destinationPath}.partial`;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const before = await fsp.stat(sourcePath);
      await ensureDirectory(path.dirname(destinationPath));
      await fsp.copyFile(sourcePath, temporaryPath);
      const after = await fsp.stat(sourcePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        await fsp.rm(temporaryPath, { force: true });
        await sleep(delayMs);
        continue;
      }
      await fsp.rm(destinationPath, { force: true });
      await fsp.rename(temporaryPath, destinationPath);
      return {
        ok: true,
        attempts: attempt,
        size: after.size,
        mtimeMs: after.mtimeMs
      };
    } catch (error) {
      lastError = error;
      try {
        await fsp.rm(temporaryPath, { force: true });
      } catch (_cleanupError) {
        // The next attempt will clean up the same temporary path.
      }
      if (attempt < attempts) await sleep(delayMs);
    }
  }

  return {
    ok: false,
    attempts,
    error: lastError ? lastError.message : 'copy failed'
  };
}

class GpuTdrMonitor {
  constructor(config = buildConfig()) {
    this.config = config;
    this.startedAt = Date.now();
    this.statePath = path.join(config.outputDir, 'monitor-state.json');
    this.seenEvents = new Set();
    this.dumpStates = new Map();
    this.activeIncident = null;
    this.incidentSequence = 0;
    this.incidentLock = Promise.resolve();
    this.stateSavePromise = Promise.resolve();
    this.dumpCaptureInFlight = new Map();
    this.eventPollInFlight = false;
    this.dumpScanInFlight = false;
    this.eventsInitialized = false;
    this.watchdogWatcher = null;
    this.dumpScanTimer = null;
    this.eventPollTimer = null;
    this.watchdogDebounceTimer = null;
    this.stopping = false;
  }

  async loadState() {
    const state = await readJson(this.statePath, {});
    for (const key of Array.isArray(state.seenEvents) ? state.seenEvents : []) {
      this.seenEvents.add(String(key));
    }
    const dumps = state.knownDumps && typeof state.knownDumps === 'object' ? state.knownDumps : {};
    for (const [key, value] of Object.entries(dumps)) {
      if (value && typeof value === 'object') this.dumpStates.set(key, value);
    }
  }

  async saveState() {
    this.stateSavePromise = this.stateSavePromise.catch(() => undefined).then(async () => {
      const recentEvents = Array.from(this.seenEvents).slice(-1000);
      const knownDumps = {};
      for (const [key, value] of this.dumpStates.entries()) {
        knownDumps[key] = value;
      }
      const temporaryPath = `${this.statePath}.partial`;
      await writeJson(temporaryPath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        seenEvents: recentEvents,
        knownDumps
      });
      await fsp.rm(this.statePath, { force: true });
      await fsp.rename(temporaryPath, this.statePath);
    });
    await this.stateSavePromise;
  }

  async start() {
    await ensureDirectory(this.config.outputDir);
    await this.loadState();
    await this.writeMonitorInfo();

    if (!this.config.disableWatchdog) {
      await this.scanWatchdog(true);
      this.startWatchdogWatcher();
      this.dumpScanTimer = setInterval(() => {
        this.scanWatchdog(false).catch(error => log('warn', 'watchdog scan failed', { error: error.message }));
      }, this.config.dumpPollMs);
    }

    if (!this.config.disableEvents) {
      await this.pollEvents();
      this.eventPollTimer = setInterval(() => {
        this.pollEvents().catch(error => log('warn', 'event poll failed', { error: error.message }));
      }, this.config.eventPollMs);
    }

    log('info', 'monitor started', {
      outputDir: this.config.outputDir,
      watchdogDir: this.config.watchdogDir,
      eventPollMs: this.config.eventPollMs,
      dumpPollMs: this.config.dumpPollMs
    });
  }

  async startOnce() {
    await ensureDirectory(this.config.outputDir);
    await this.loadState();
    await this.writeMonitorInfo();
    if (!this.config.disableWatchdog) await this.scanWatchdog(true);
    if (!this.config.disableEvents) await this.pollEvents();
    await this.saveState();
  }

  async writeMonitorInfo() {
    await writeJson(path.join(this.config.outputDir, 'monitor-info.json'), {
      startedAt: new Date(this.startedAt).toISOString(),
      pid: process.pid,
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      cwd: process.cwd(),
      projectRoot: PROJECT_ROOT,
      config: this.config
    });
  }

  startWatchdogWatcher() {
    try {
      this.watchdogWatcher = fs.watch(this.config.watchdogDir, { persistent: true }, () => {
        if (this.watchdogDebounceTimer) return;
        this.watchdogDebounceTimer = setTimeout(() => {
          this.watchdogDebounceTimer = null;
          this.scanWatchdog(false).catch(error => log('warn', 'watchdog event scan failed', { error: error.message }));
        }, 250);
      });
      this.watchdogWatcher.on('error', error => {
        log('warn', 'watchdog directory watcher unavailable; polling remains active', { error: error.message });
      });
    } catch (error) {
      log('warn', 'watchdog directory watcher unavailable; polling remains active', { error: error.message });
    }
  }

  async scanWatchdog(initial) {
    if (this.dumpScanInFlight) return;
    this.dumpScanInFlight = true;
    try {
      const result = await listWatchdogDumps(this.config.watchdogDir);
      if (result.error) {
        log('warn', 'cannot read watchdog directory', { path: this.config.watchdogDir, error: result.error.message });
        return;
      }

      const currentKeys = new Set();
      const capturePromises = [];
      for (const item of result.files) {
        const key = path.resolve(item.path).toLowerCase();
        currentKeys.add(key);
        const previous = this.dumpStates.get(key);
        const changed = !previous || previous.size !== item.stat.size || previous.mtimeMs !== item.stat.mtimeMs;
        const isRecent = item.stat.mtimeMs >= this.startedAt - this.config.startupGraceMs;
        const shouldCapture = this.config.captureExisting || !initial || isRecent;

        if (initial && !previous && !shouldCapture) {
          this.dumpStates.set(key, {
            name: item.name,
            size: item.stat.size,
            mtimeMs: item.stat.mtimeMs,
            captured: true,
            lastSeenAt: Date.now()
          });
          continue;
        }

        if (changed) {
          this.dumpStates.set(key, {
            name: item.name,
            size: item.stat.size,
            mtimeMs: item.stat.mtimeMs,
            captured: false,
            lastSeenAt: Date.now()
          });
        }

        if (shouldCapture && (!previous || changed || !previous.captured)) {
          capturePromises.push(this.captureStandaloneDump(item, key));
        }
      }

      for (const [key, state] of this.dumpStates.entries()) {
        if (!currentKeys.has(key) && state.missingSince === undefined) {
          state.missingSince = Date.now();
        }
      }
      await Promise.allSettled(capturePromises);
      await this.saveState();
    } finally {
      this.dumpScanInFlight = false;
    }
  }

  async captureStandaloneDump(item, key) {
    if (this.dumpCaptureInFlight.has(key)) return this.dumpCaptureInFlight.get(key);
    const task = (async () => {
      const incident = await this.getOrCreateIncident('watchdog-file', {
        timeMs: item.stat.mtimeMs,
        dumpPath: item.path,
        dumpName: item.name
      });
      incident.preferredDumpPath = item.path;
      if (incident.evidencePromise) await incident.evidencePromise;
      const copyResult = await this.copyEvidenceFile(
        incident,
        item.path,
        path.join('dumps', item.name),
        { stable: true }
      );
      await appendJsonLine(path.join(incident.dir, 'triggers.jsonl'), {
        type: 'watchdog-file',
        time: new Date().toISOString(),
        path: item.path,
        name: item.name,
        size: item.stat.size,
        mtime: new Date(item.stat.mtimeMs).toISOString(),
        copyOk: copyResult.ok,
        copyAttempts: copyResult.attempts
      });
      const state = this.dumpStates.get(key) || {};
      state.captured = Boolean(copyResult.ok);
      state.lastCapturedAt = Date.now();
      this.dumpStates.set(key, state);
      await this.saveState();
      if (copyResult.ok) {
        log('info', 'watchdog dump captured', { name: item.name, incident: incident.id, size: item.stat.size });
      } else {
        log('warn', 'watchdog dump copy will be retried', { name: item.name, incident: incident.id, error: copyResult.error });
      }
    })().catch(error => {
      log('warn', 'watchdog dump capture failed', { path: item.path, error: error.message });
    }).finally(() => {
      this.dumpCaptureInFlight.delete(key);
    });
    this.dumpCaptureInFlight.set(key, task);
    return task;
  }

  async pollEvents() {
    if (this.eventPollInFlight || this.stopping) return;
    this.eventPollInFlight = true;
    try {
      const channels = ['System', 'Application'];
      const results = await Promise.all(channels.map(channel => this.queryEvents(channel)));
      const events = [];
      for (const result of results) {
        if (result.error) {
          log('warn', 'event log query failed', { channel: result.channel, error: result.error });
          continue;
        }
        for (const xml of splitEventXml(result.output)) {
          const event = await parseEventXml(xml);
          if (isInterestingEvent(event)) events.push(event);
        }
      }
      events.sort((left, right) => (left.eventTimeMs || 0) - (right.eventTimeMs || 0));

      const firstPoll = !this.eventsInitialized;
      this.eventsInitialized = true;
      for (const event of events) {
        const key = eventKey(event);
        if (this.seenEvents.has(key)) continue;
        this.seenEvents.add(key);
        const isRecentEnough = !event.eventTimeMs || event.eventTimeMs >= this.startedAt - this.config.startupGraceMs;
        if (firstPoll && !this.config.captureExisting && !isRecentEnough) continue;
        await this.handleEvent(event);
      }
      await this.saveState();
    } finally {
      this.eventPollInFlight = false;
    }
  }

  async queryEvents(channel) {
    const args = ['qe', channel, '/f:RenderedXml', `/c:${this.config.eventRecords}`, '/rd:true'];
    const result = await runNative(this.config.wevtutil, args, { timeoutMs: Math.max(10000, this.config.eventPollMs * 2) });
    if (!result.ok && !result.stdout) {
      return { channel, output: '', error: result.stderr || `exit code ${result.exitCode}` };
    }
    return { channel, output: result.stdout, error: result.ok ? null : (result.stderr || `exit code ${result.exitCode}`) };
  }

  async handleEvent(event) {
    const incident = await this.getOrCreateIncident('event', event);
    await this.recordEvent(incident, event);
    log('info', 'GPU-related event captured', {
      provider: event.provider,
      eventId: event.eventId,
      recordId: event.recordId,
      incident: incident.id
    });
  }

  async getOrCreateIncident(trigger, source) {
    const now = Date.now();
    if (this.activeIncident && now - this.activeIncident.lastSeenAt <= this.config.eventGroupMs) {
      this.activeIncident.lastSeenAt = now;
      this.activeIncident.triggers.add(trigger);
      return this.activeIncident;
    }

    this.incidentLock = this.incidentLock.then(async () => {
      const currentNow = Date.now();
      if (this.activeIncident && currentNow - this.activeIncident.lastSeenAt <= this.config.eventGroupMs) {
        this.activeIncident.lastSeenAt = currentNow;
        this.activeIncident.triggers.add(trigger);
        return this.activeIncident;
      }

      const sourceTime = source && (source.eventTimeMs || source.timeMs);
      const id = `${timestamp(sourceTime || currentNow)}-${safeName(trigger)}-${String(++this.incidentSequence).padStart(3, '0')}`;
      const dir = path.join(this.config.outputDir, 'incidents', id);
      const incident = {
        id,
        dir,
        startedAt: currentNow,
        lastSeenAt: currentNow,
        eventCount: 0,
        triggers: new Set([trigger]),
        evidenceStarted: false,
        evidenceStatus: 'running',
        preferredDumpPath: source && source.dumpPath ? source.dumpPath : null
      };
      await ensureDirectory(path.join(dir, 'events'));
      this.activeIncident = incident;
      await this.writeIncidentSummary(incident);
      incident.evidenceStarted = true;
      incident.evidencePromise = this.collectIncidentEvidence(incident).catch(error => {
        incident.evidenceStatus = 'failed';
        log('warn', 'incident evidence collection failed', { incident: incident.id, error: error.message });
      });
      return incident;
    });
    return this.incidentLock;
  }

  async writeIncidentSummary(incident) {
    await writeJson(path.join(incident.dir, 'incident.json'), {
      id: incident.id,
      startedAt: new Date(incident.startedAt).toISOString(),
      lastSeenAt: new Date(incident.lastSeenAt).toISOString(),
      eventCount: incident.eventCount,
      triggers: Array.from(incident.triggers),
      evidenceStatus: incident.evidenceStatus,
      evidenceFiles: {
        dumps: 'dumps',
        events: 'events',
        nvidia: 'nvidia-smi-q.txt',
        processes: 'processes-tasklist.csv',
        systemEvents: 'system-events-latest.xml'
      }
    });
  }

  async recordEvent(incident, event) {
    incident.eventCount += 1;
    incident.lastSeenAt = Date.now();
    const eventFileName = `${timestamp(event.eventTimeMs || Date.now())}-${safeName(event.provider)}-${event.eventId || 'unknown'}-${safeName(event.recordId || String(incident.eventCount))}.xml`;
    await writeUtf8(path.join(incident.dir, 'events', eventFileName), event.rawXml);
    await appendJsonLine(path.join(incident.dir, 'events.jsonl'), {
      provider: event.provider,
      eventId: event.eventId,
      recordId: event.recordId,
      timeCreated: event.timeCreated,
      channel: event.channel,
      computer: event.computer,
      message: event.message,
      data: event.data,
      file: path.join('events', eventFileName)
    });
    await this.writeIncidentSummary(incident);
  }

  async collectIncidentEvidence(incident) {
    const evidenceTasks = [
      this.captureCommand(incident, this.config.nvidiaSmi, ['-q'], 'nvidia-smi-q.txt'),
      this.captureCommand(incident, this.config.nvidiaSmi, ['--query-gpu=name,driver_version,pstate,temperature.gpu,utilization.gpu,memory.total,memory.used,power.draw,power.limit', '--format=csv'], 'nvidia-smi-summary.csv'),
      this.captureCommand(incident, this.config.tasklist, ['/fo', 'csv', '/nh'], 'processes-tasklist.csv'),
      this.captureCommand(incident, this.config.wevtutil, ['qe', 'System', '/f:RenderedXml', '/c:400', '/rd:true'], 'system-events-latest.xml'),
      this.captureCommand(incident, this.config.wevtutil, ['qe', 'Application', '/f:RenderedXml', '/c:200', '/rd:true'], 'application-events-latest.xml'),
      this.captureWatchdogDumps(incident),
      this.captureWerEvidence(incident),
      this.captureObsLogs(incident),
      this.captureSystemInfo(incident)
    ];

    const results = await Promise.allSettled(evidenceTasks);
    const failed = results.filter(item => item.status === 'rejected').map(item => item.reason && item.reason.message);
    incident.evidenceStatus = failed.length ? 'partial' : 'complete';
    incident.evidenceFinishedAt = Date.now();
    await this.writeIncidentSummary(incident);
    if (failed.length) log('warn', 'incident evidence is partial', { incident: incident.id, failed });
    else log('info', 'incident evidence collection complete', { incident: incident.id });
  }

  async captureCommand(incident, command, args, outputName) {
    const result = await runNative(command, args, { timeoutMs: 30000 });
    await writeUtf8(path.join(incident.dir, outputName), result.stdout || '');
    if (result.stderr) await writeUtf8(path.join(incident.dir, `${outputName}.stderr.txt`), result.stderr);
    await appendJsonLine(path.join(incident.dir, 'evidence-manifest.jsonl'), {
      type: 'command',
      command,
      args,
      output: outputName,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut)
    });
  }

  async captureSystemInfo(incident) {
    await writeJson(path.join(incident.dir, 'system-info.json'), {
      capturedAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      node: process.version,
      monitorPid: process.pid,
      config: this.config
    });
  }

  async withCopyLock(sourcePath, destinationPath, task) {
    const key = `${path.resolve(sourcePath).toLowerCase()}|${path.resolve(destinationPath).toLowerCase()}`;
    const running = this.dumpCaptureInFlight.get(key);
    if (running) return running;
    const promise = Promise.resolve().then(task).finally(() => this.dumpCaptureInFlight.delete(key));
    this.dumpCaptureInFlight.set(key, promise);
    return promise;
  }

  async copyEvidenceFile(incident, sourcePath, destinationPath, options = {}) {
    const destination = path.join(incident.dir, destinationPath);
    if (options.overwrite !== true) {
      try {
        const existing = await fsp.stat(destination);
        return {
          ok: true,
          alreadyPresent: true,
          size: existing.size,
          mtimeMs: existing.mtimeMs
        };
      } catch (_error) {
        // Continue with the copy when the destination does not exist yet.
      }
    }
    const result = options.stable
      ? await this.withCopyLock(sourcePath, destination, () => copyFileStable(sourcePath, destination, {
        attempts: this.config.dumpCopyAttempts,
        delayMs: this.config.dumpCopyDelayMs
      }))
      : await this.withCopyLock(sourcePath, destination, async () => {
        try {
          await ensureDirectory(path.dirname(destination));
          await fsp.copyFile(sourcePath, destination);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      });
    await appendJsonLine(path.join(incident.dir, 'evidence-manifest.jsonl'), {
      type: 'file',
      source: sourcePath,
      destination: destinationPath,
      ...result
    });
    return result;
  }

  async captureWatchdogDumps(incident) {
    const result = await listWatchdogDumps(this.config.watchdogDir);
    if (result.error) {
      await appendJsonLine(path.join(incident.dir, 'evidence-manifest.jsonl'), {
        type: 'watchdog-scan',
        path: this.config.watchdogDir,
        ok: false,
        error: result.error.message
      });
      return;
    }

    const referenceTime = incident.startedAt;
    const selected = result.files.filter(item => {
      if (incident.preferredDumpPath && path.resolve(item.path).toLowerCase() === path.resolve(incident.preferredDumpPath).toLowerCase()) return true;
      return Math.abs(item.stat.mtimeMs - referenceTime) <= this.config.dumpLookbackMs;
    });

    for (const item of selected) {
      await this.copyEvidenceFile(incident, item.path, path.join('dumps', item.name), { stable: true });
    }
    await writeJson(path.join(incident.dir, 'watchdog-scan.json'), {
      path: this.config.watchdogDir,
      capturedAt: new Date().toISOString(),
      files: result.files.map(item => ({
        name: item.name,
        size: item.stat.size,
        mtime: new Date(item.stat.mtimeMs).toISOString(),
        selected: selected.some(candidate => candidate.path === item.path)
      }))
    });
  }

  async captureWerEvidence(incident) {
    const roots = [
      { name: 'ReportArchive', path: this.config.werArchiveDir },
      { name: 'ReportQueue', path: this.config.werQueueDir }
    ];
    const cutoff = incident.startedAt - this.config.dumpLookbackMs;
    const manifest = [];
    for (const root of roots) {
      const result = await walkFiles(root.path, {
        maxDepth: this.config.werMaxDepth,
        maxFiles: this.config.maxEvidenceFiles
      });
      for (const item of result.files) {
        const relative = path.relative(root.path, item.path);
        const topFolder = relative.split(path.sep)[0] || '';
        const looksLikeKernelReport = /^kernel_141/i.test(topFolder) || /livekernel|watchdog/i.test(relative);
        const isRecent = item.stat.mtimeMs >= cutoff;
        if ((!isRecent && !looksLikeKernelReport) || !isLikelyEvidenceFile(item.path)) continue;
        const destination = path.join('wer', root.name, relative);
        const copyResult = await this.copyEvidenceFile(incident, item.path, destination);
        manifest.push({ source: item.path, destination, ...copyResult });
      }
      manifest.push(...result.errors.map(error => ({ source: error.path, ok: false, error: error.error })));
    }
    await writeJson(path.join(incident.dir, 'wer-scan.json'), {
      capturedAt: new Date().toISOString(),
      roots: roots.map(root => root.path),
      files: manifest
    });
  }

  async captureObsLogs(incident) {
    if (!this.config.obsLogDir) return;
    const result = await walkFiles(this.config.obsLogDir, {
      maxDepth: 2,
      maxFiles: this.config.maxEvidenceFiles
    });
    const cutoff = incident.startedAt - this.config.dumpLookbackMs;
    const copied = [];
    for (const item of result.files) {
      if (item.stat.mtimeMs < cutoff || !/\.(log|txt|json)$/i.test(item.path)) continue;
      const relative = path.relative(this.config.obsLogDir, item.path);
      const destination = path.join('obs-logs', relative);
      const copyResult = await this.copyEvidenceFile(incident, item.path, destination);
      copied.push({ source: item.path, destination, ...copyResult });
    }
    await writeJson(path.join(incident.dir, 'obs-log-scan.json'), {
      path: this.config.obsLogDir,
      capturedAt: new Date().toISOString(),
      files: copied,
      errors: result.errors
    });
  }

  async stop() {
    this.stopping = true;
    if (this.dumpScanTimer) clearInterval(this.dumpScanTimer);
    if (this.eventPollTimer) clearInterval(this.eventPollTimer);
    if (this.watchdogDebounceTimer) clearTimeout(this.watchdogDebounceTimer);
    if (this.watchdogWatcher) this.watchdogWatcher.close();
    await this.saveState().catch(error => log('warn', 'could not save monitor state during shutdown', { error: error.message }));
    if (this.activeIncident && this.activeIncident.evidencePromise) {
      await this.activeIncident.evidencePromise;
    }
    log('info', 'monitor stopped');
  }
}

function parseCliArgs(argv) {
  return {
    once: argv.includes('--once') || envBoolean('GPU_TDR_ONCE', false)
  };
}

async function main() {
  const config = buildConfig();
  const monitor = new GpuTdrMonitor(config);
  const args = parseCliArgs(process.argv.slice(2));
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    log('info', `received ${signal}; stopping monitor`);
    await monitor.stop();
    if (!args.once) process.exit(0);
  };

  process.once('SIGINT', () => { shutdown('SIGINT').catch(error => log('error', 'shutdown failed', { error: error.message })); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => log('error', 'shutdown failed', { error: error.message })); });

  if (args.once) {
    await monitor.startOnce();
    return;
  }
  await monitor.start();
}

if (require.main === module) {
  main().catch(error => {
    log('error', 'monitor failed to start', { error: error.stack || error.message });
    process.exitCode = 1;
  });
}

module.exports = {
  GpuTdrMonitor,
  buildConfig,
  copyFileStable,
  isInterestingEvent,
  parseEventXml,
  splitEventXml,
  safeName,
  timestamp
};
