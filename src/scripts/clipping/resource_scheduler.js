'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORED_GPU_PROCESS_NAMES = [
    'applicationframehost',
    'browser',
    'chrome',
    'chatgpt',
    'conhost',
    'cursor',
    'desktopwindowmanager',
    'docker desktop',
    'dwm',
    'explorer',
    'ffmpeg',
    'ffprobe',
    'firefox',
    'msedge',
    'msedgewebview2',
    'node',
    'nvidia-smi',
    'oopz',
    'phoneexperiencehost',
    'powertoys',
    'powershell',
    'pwsh',
    'qq',
    'searchhost',
    'shellexperiencehost',
    'shellhost',
    'snippingtool',
    'startmenuexperiencehost',
    'steamwebhelper',
    'systemsettings',
    'textinputhost',
    'telegram',
    'windowsterminal',
    'wechat',
    'wechatappex',
    'wxwork'
];

const FOREGROUND_PROCESS_SCRIPT = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class ForegroundWindowProbe {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '}',
    '"@',
    '$windowHandle = [ForegroundWindowProbe]::GetForegroundWindow()',
    '$foregroundProcessId = [uint32]0',
    '[void][ForegroundWindowProbe]::GetWindowThreadProcessId($windowHandle, [ref]$foregroundProcessId)',
    '$foregroundProcess = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue',
    'if ($foregroundProcess) {',
    '  [pscustomobject]@{',
    '    pid = [int]$foregroundProcess.Id',
    '    name = [string]$foregroundProcess.ProcessName',
    '    title = [string]$foregroundProcess.MainWindowTitle',
    '  } | ConvertTo-Json -Compress',
    '}'
].join('\n');

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeNumber(value, fallback, minimum = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function normalizeInteger(value, fallback, minimum = 0) {
    return Math.floor(normalizeNumber(value, fallback, minimum));
}

function normalizeProcessName(value) {
    const text = String(value || '').trim().toLowerCase().replace(/\\/g, '/');
    if (!text) return '';
    const baseName = text.slice(text.lastIndexOf('/') + 1);
    return baseName.replace(/\.exe$/i, '');
}

function normalizeProcessNameSet(values) {
    const list = Array.isArray(values) ? values : (values ? [values] : []);
    return new Set(list.map(normalizeProcessName).filter(Boolean));
}

function readCpuSnapshot() {
    return os.cpus().reduce((totals, cpu) => {
        const times = cpu.times || {};
        const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
        totals.idle += Number(times.idle || 0);
        totals.total += total;
        return totals;
    }, { idle: 0, total: 0 });
}

function cpuPercentFromSnapshots(previous, current) {
    if (!previous || !current) return null;
    const idleDelta = Number(current.idle) - Number(previous.idle);
    const totalDelta = Number(current.total) - Number(previous.total);
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
    return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

function parseTasklistProcessNames(output) {
    const names = [];
    for (const line of String(output || '').split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)"/);
        if (match?.[1]) names.push(normalizeProcessName(match[1]));
    }
    return names.filter(Boolean);
}

function parseForegroundProcess(output) {
    const text = String(output || '').trim();
    if (!text) return null;
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object') return null;
        return {
            pid: Number(value.pid) || null,
            name: String(value.name || ''),
            title: String(value.title || '')
        };
    } catch {
        return null;
    }
}

function parseMetric(value) {
    const text = String(value ?? '').trim();
    if (!text || text === '-') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseGpuProcessMonitor(output) {
    const processes = [];
    for (const line of String(output || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 4) continue;
        const pid = Number(parts[1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        processes.push({
            pid,
            type: parts[2] || '',
            sm: parseMetric(parts[3]),
            mem: parseMetric(parts[4]),
            enc: parseMetric(parts[5]),
            dec: parseMetric(parts[6]),
            fbMb: parseMetric(parts[9]),
            name: parts.slice(11).join(' ') || 'unknown'
        });
    }
    return processes;
}

function parseGpuSummary(output) {
    const line = String(output || '')
        .split(/\r?\n/)
        .map(value => value.trim())
        .find(Boolean);
    if (!line) return null;
    const values = line.split(',').map(parseMetric);
    if (values.length < 3 || values.slice(0, 3).some(value => value === null)) return null;
    return {
        utilization: values[0],
        memoryUsedMb: values[1],
        memoryTotalMb: values[2]
    };
}

async function execText(file, args, timeoutMs = 1500) {
    const result = await execFileAsync(file, args, {
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
    });
    return result.stdout || '';
}

async function readForegroundProcess(powerShellPath = 'powershell.exe') {
    if (process.platform !== 'win32') return null;
    try {
        return parseForegroundProcess(await execText(
            powerShellPath,
            [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle',
                'Hidden',
                '-Command',
                FOREGROUND_PROCESS_SCRIPT
            ],
            1500
        ));
    } catch {
        return null;
    }
}

async function readProcessNames(tasklistPath = 'tasklist.exe') {
    if (process.platform !== 'win32') return [];
    try {
        const output = await execText(tasklistPath, ['/FO', 'CSV', '/NH'], 2000);
        return parseTasklistProcessNames(output);
    } catch {
        return [];
    }
}

async function readGpuSnapshot(nvidiaSmiPath = 'nvidia-smi') {
    if (process.platform !== 'win32' && process.platform !== 'linux') {
        return { available: false, utilization: null, processes: [] };
    }

    const [summaryResult, processResult] = await Promise.allSettled([
        execText(nvidiaSmiPath, [
            '--query-gpu=utilization.gpu,memory.used,memory.total',
            '--format=csv,noheader,nounits'
        ], 2500),
        execText(nvidiaSmiPath, ['pmon', '-c', '1', '-s', 'um'], 2500)
    ]);
    const summary = summaryResult.status === 'fulfilled'
        ? parseGpuSummary(summaryResult.value)
        : null;
    const processes = processResult.status === 'fulfilled'
        ? parseGpuProcessMonitor(processResult.value)
        : [];
    return {
        available: Boolean(summary || processes.length),
        utilization: summary?.utilization ?? null,
        memoryUsedMb: summary?.memoryUsedMb ?? null,
        memoryTotalMb: summary?.memoryTotalMb ?? null,
        processes
    };
}

function resolveClipResourceAdaptiveConfig(ownConfig = {}, rootConfig = {}) {
    const rootAdaptive = rootConfig.clipResourceAdaptive || {};
    const ownAdaptive = ownConfig.clipResourceAdaptive || {};
    const raw = { ...rootAdaptive, ...ownAdaptive };
    const resourceGuard = rootConfig.asr?.paraformer?.resource_guard
        || rootConfig.asr?.sensevoice?.resource_guard
        || {};
    const gameProcessNames = raw.gameProcessNames
        ?? resourceGuard.game_process_names
        ?? resourceGuard.process_names
        ?? [];
    const idleConcurrency = normalizeInteger(
        raw.idleConcurrency,
        normalizeInteger(ownConfig.clipConcurrency, 1, 1),
        1
    );
    const idleFfmpegThreads = normalizeInteger(
        raw.idleFfmpegThreads,
        normalizeInteger(ownConfig.clipFfmpegThreads, 2, 0),
        0
    );
    return {
        enabled: normalizeBoolean(raw.enabled, true),
        idleConcurrency,
        busyConcurrency: normalizeInteger(raw.busyConcurrency, 1, 1),
        idleFfmpegThreads,
        busyFfmpegThreads: normalizeInteger(raw.busyFfmpegThreads, 1, 0),
        pollIntervalMs: normalizeInteger(raw.pollIntervalMs, 3000, 1000),
        busyCpuPercentThreshold: normalizeNumber(raw.busyCpuPercentThreshold, 70, 1),
        busyGpuUtilizationThreshold: normalizeNumber(raw.busyGpuUtilizationThreshold, 35, 1),
        foregroundGpuUtilizationThreshold: normalizeNumber(raw.foregroundGpuUtilizationThreshold, 20, 1),
        externalGpuActivityThreshold: normalizeNumber(raw.externalGpuActivityThreshold, 25, 1),
        busySamples: normalizeInteger(raw.busySamples, 2, 1),
        idleSamples: normalizeInteger(raw.idleSamples, 3, 1),
        gameProcessNames: Array.isArray(gameProcessNames) ? gameProcessNames : [gameProcessNames],
        ignoredGpuProcessNames: [
            ...DEFAULT_IGNORED_GPU_PROCESS_NAMES,
            ...(Array.isArray(raw.ignoredGpuProcessNames) ? raw.ignoredGpuProcessNames : [])
        ],
        nvidiaSmiPath: String(raw.nvidiaSmiPath || 'nvidia-smi'),
        powerShellPath: String(raw.powerShellPath || 'powershell.exe'),
        tasklistPath: String(raw.tasklistPath || 'tasklist.exe')
    };
}

function detectBusySignals(environment = {}, config = {}, selfPids = new Set()) {
    const gameProcessNames = normalizeProcessNameSet(config.gameProcessNames);
    const ignoredGpuProcessNames = new Set([
        ...normalizeProcessNameSet(DEFAULT_IGNORED_GPU_PROCESS_NAMES),
        ...normalizeProcessNameSet(config.ignoredGpuProcessNames)
    ]);
    const runningProcessNames = new Set(
        (environment.processNames || []).map(normalizeProcessName).filter(Boolean)
    );
    const foreground = environment.foreground || {};
    const foregroundName = normalizeProcessName(foreground.name);
    const gpu = environment.gpu || {};
    const gpuProcesses = Array.isArray(gpu.processes) ? gpu.processes : [];
    const isIgnored = item => (
        selfPids.has(Number(item.pid))
        || ignoredGpuProcessNames.has(normalizeProcessName(item.name))
    );
    const externalGpuProcesses = gpuProcesses.filter(item => !isIgnored(item));
    const foregroundGpuProcess = gpuProcesses.find(item => Number(item.pid) === Number(foreground.pid));
    const configuredGameRunning = Array.from(gameProcessNames).some(name => runningProcessNames.has(name));
    const foregroundConfiguredGame = gameProcessNames.has(foregroundName);
    const foregroundGpuActive = Boolean(
        foregroundGpuProcess
        && !isIgnored(foregroundGpuProcess)
        && (
            Number(gpu.utilization) >= config.foregroundGpuUtilizationThreshold
            || Number(foregroundGpuProcess.sm) >= config.externalGpuActivityThreshold
            || Number(foregroundGpuProcess.mem) >= config.externalGpuActivityThreshold
        )
    );
    const activeExternalGpu = externalGpuProcesses.some(item => (
        Number(item.sm) >= config.externalGpuActivityThreshold
        || Number(item.mem) >= config.externalGpuActivityThreshold
        || Number(item.enc) >= config.externalGpuActivityThreshold
        || Number(item.dec) >= config.externalGpuActivityThreshold
    ));
    const totalGpuBusy = externalGpuProcesses.length > 0
        && Number(gpu.utilization) >= config.busyGpuUtilizationThreshold;
    const cpuBusy = Number.isFinite(Number(environment.cpuPercent))
        && Number(environment.cpuPercent) >= config.busyCpuPercentThreshold;
    const reasons = [];
    if (configuredGameRunning) reasons.push(`游戏进程运行: ${foregroundConfiguredGame ? foreground.name : 'configured'}`);
    if (foregroundGpuActive) reasons.push(`前台 GPU 进程: ${foreground.name || foreground.pid}`);
    if (activeExternalGpu) reasons.push('外部 GPU 进程活跃');
    if (totalGpuBusy) reasons.push(`GPU 总利用率 ${Number(gpu.utilization).toFixed(0)}%`);
    if (cpuBusy) reasons.push(`主机 CPU ${Number(environment.cpuPercent).toFixed(0)}%`);
    return {
        busy: reasons.length > 0,
        reasons,
        configuredGameRunning,
        foregroundGpuActive,
        activeExternalGpu,
        totalGpuBusy,
        cpuBusy,
        foreground,
        externalGpuProcessCount: externalGpuProcesses.length
    };
}

class ClipResourceAdaptiveScheduler {
    constructor(options = {}) {
        this.config = options.config?.idleConcurrency !== undefined
            ? options.config
            : resolveClipResourceAdaptiveConfig(options.ownConfig || {}, options.rootConfig || {});
        this.dependencies = options.dependencies || {};
        this.log = options.log || console.log;
        this.now = this.dependencies.now || Date.now;
        this.mode = 'idle';
        this.busySamples = 0;
        this.idleSamples = 0;
        this.inFlight = 0;
        this.lastRefreshAt = 0;
        this.lastEnvironment = null;
        this.lastSignals = null;
        this.refreshPromise = null;
        this.lastCpuSnapshot = null;
        this.sampleFailureWarned = false;
        this.selfPids = new Set([process.pid]);
        try {
            this.selfPids.add(process.ppid);
        } catch {
            // The parent PID is only an optional GPU-process exclusion.
        }
    }

    get enabled() {
        return this.config.enabled !== false;
    }

    get maxConcurrency() {
        return Math.max(this.config.idleConcurrency, this.config.busyConcurrency, 1);
    }

    getProfile() {
        const busy = this.mode === 'busy';
        return {
            mode: this.mode,
            concurrency: busy ? this.config.busyConcurrency : this.config.idleConcurrency,
            ffmpegThreads: busy ? this.config.busyFfmpegThreads : this.config.idleFfmpegThreads,
            reason: this.lastSignals?.reasons?.join('；') || ''
        };
    }

    async sampleEnvironment() {
        if (typeof this.dependencies.sampleEnvironment === 'function') {
            return this.dependencies.sampleEnvironment();
        }
        const currentCpuSnapshot = readCpuSnapshot();
        const cpuPercent = cpuPercentFromSnapshots(this.lastCpuSnapshot, currentCpuSnapshot);
        this.lastCpuSnapshot = currentCpuSnapshot;
        const [foreground, processNames, gpu] = await Promise.all([
            this.dependencies.readForegroundProcess
                ? this.dependencies.readForegroundProcess()
                : readForegroundProcess(this.config.powerShellPath),
            this.dependencies.readProcessNames
                ? this.dependencies.readProcessNames()
                : readProcessNames(this.config.tasklistPath),
            this.dependencies.readGpuSnapshot
                ? this.dependencies.readGpuSnapshot()
                : readGpuSnapshot(this.config.nvidiaSmiPath)
        ]);
        return { cpuPercent, foreground, processNames, gpu };
    }

    async refresh(force = false) {
        if (!this.enabled) return this.getProfile();
        const now = this.now();
        if (!force && this.lastRefreshAt > 0 && now - this.lastRefreshAt < this.config.pollIntervalMs) {
            return this.getProfile();
        }
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = (async () => {
            let environment;
            try {
                environment = await this.sampleEnvironment();
                this.sampleFailureWarned = false;
            } catch (error) {
                environment = {
                    cpuPercent: null,
                    foreground: null,
                    processNames: [],
                    gpu: { available: false, utilization: null, processes: [] }
                };
                if (!this.sampleFailureWarned) {
                    this.log(`[resource] 自动切片资源探测失败，按空闲档继续: ${error.message}`);
                    this.sampleFailureWarned = true;
                }
            }
            const signals = detectBusySignals(environment, this.config, this.selfPids);
            this.lastEnvironment = environment;
            this.lastSignals = signals;
            this.lastRefreshAt = this.now();

            const previousMode = this.mode;
            if (signals.busy) {
                this.busySamples += 1;
                this.idleSamples = 0;
                if (this.mode !== 'busy' && this.busySamples >= this.config.busySamples) {
                    this.mode = 'busy';
                }
            } else {
                this.idleSamples += 1;
                this.busySamples = 0;
                if (this.mode !== 'idle' && this.idleSamples >= this.config.idleSamples) {
                    this.mode = 'idle';
                }
            }

            if (previousMode !== this.mode) {
                const profile = this.getProfile();
                this.log(
                    `[resource] 自动切片资源档位: ${previousMode} -> ${this.mode}; `
                    + `concurrency=${profile.concurrency}, threads=${profile.ffmpegThreads}`
                    + (signals.reasons.length ? `; reason=${signals.reasons.join('；')}` : '')
                );
            }
            return this.getProfile();
        })().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }

    async acquire() {
        if (!this.enabled) {
            this.inFlight += 1;
            return this._lease(this.getProfile());
        }
        while (true) {
            const profile = await this.refresh();
            if (this.inFlight < profile.concurrency) {
                this.inFlight += 1;
                return this._lease(profile);
            }
            await (this.dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(
                Math.min(this.config.pollIntervalMs, 1000)
            );
        }
    }

    _lease(profile) {
        let released = false;
        return {
            profile,
            release: () => {
                if (released) return;
                released = true;
                this.inFlight = Math.max(0, this.inFlight - 1);
            }
        };
    }

    getStatus() {
        return {
            ...this.getProfile(),
            enabled: this.enabled,
            inFlight: this.inFlight,
            signals: this.lastSignals,
            environment: this.lastEnvironment
        };
    }
}

function createClipResourceAdaptiveScheduler(options = {}) {
    return new ClipResourceAdaptiveScheduler(options);
}

module.exports = {
    DEFAULT_IGNORED_GPU_PROCESS_NAMES,
    ClipResourceAdaptiveScheduler,
    createClipResourceAdaptiveScheduler,
    resolveClipResourceAdaptiveConfig,
    detectBusySignals,
    parseForegroundProcess,
    parseGpuProcessMonitor,
    parseGpuSummary,
    parseTasklistProcessNames,
    readForegroundProcess,
    readGpuSnapshot,
    readProcessNames
};
