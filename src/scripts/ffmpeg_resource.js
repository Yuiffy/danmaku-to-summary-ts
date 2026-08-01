const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_THREADS = 2;
const DEFAULT_PRIORITY = 'belowNormal';

const WINDOWS_PRIORITY_CLASSES = {
    idle: 'Idle',
    belownormal: 'BelowNormal',
    below_normal: 'BelowNormal',
    belowNormal: 'BelowNormal',
    normal: 'Normal',
    abovenormal: 'AboveNormal',
    above_normal: 'AboveNormal',
    aboveNormal: 'AboveNormal',
    high: 'High'
};

function normalizeThreads(value, fallback = DEFAULT_THREADS) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, Math.floor(parsed));
}

function getFfmpegResourceConfig(config = {}) {
    const ffmpeg = config.audio?.ffmpeg || {};
    const cpuGuard = ffmpeg.cpuGuard || {};
    return {
        threads: normalizeThreads(process.env.FFMPEG_THREADS ?? ffmpeg.threads, DEFAULT_THREADS),
        priority: String(process.env.FFMPEG_PRIORITY || ffmpeg.priority || DEFAULT_PRIORITY),
        cpuGuard: {
            enabled: normalizeBoolean(process.env.FFMPEG_CPU_GUARD_ENABLED ?? cpuGuard.enabled, false),
            busyPercentThreshold: normalizeNumber(cpuGuard.busyPercentThreshold, 80, 1),
            resumePercentThreshold: normalizeNumber(cpuGuard.resumePercentThreshold, 60, 0),
            sampleIntervalMs: normalizeNumber(cpuGuard.sampleIntervalMs, 750, 50),
            waitMs: normalizeNumber(cpuGuard.waitMs, 5000, 50),
            maxWaitMs: normalizeNumber(cpuGuard.maxWaitMs, 0, 0),
            consecutiveBusySamples: normalizeNumber(cpuGuard.consecutiveBusySamples, 2, 1),
            consecutiveIdleSamples: normalizeNumber(cpuGuard.consecutiveIdleSamples, 2, 1)
        }
    };
}

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeNumber(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
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

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sampleCpuPercent(sampleIntervalMs = 750, dependencies = {}) {
    const snapshot = dependencies.snapshot || readCpuSnapshot;
    const sleep = dependencies.sleep || delay;
    const before = snapshot();
    await sleep(sampleIntervalMs);
    const after = snapshot();
    const idleDelta = Number(after.idle) - Number(before.idle);
    const totalDelta = Number(after.total) - Number(before.total);
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

async function waitForCpuAvailability(stage, resourceConfig = {}, dependencies = {}) {
    const guard = resourceConfig.cpuGuard || {};
    if (!guard.enabled) return { waitedMs: 0, lastCpuPercent: null };

    const sample = dependencies.sampleCpuPercent
        || (() => sampleCpuPercent(guard.sampleIntervalMs, dependencies));
    const sleep = dependencies.sleep || delay;
    const log = dependencies.log || console.log;
    const busyThreshold = normalizeNumber(guard.busyPercentThreshold, 80, 1);
    const resumeThreshold = Math.min(
        busyThreshold,
        normalizeNumber(guard.resumePercentThreshold, 60, 0)
    );
    const busySamplesRequired = Math.floor(normalizeNumber(guard.consecutiveBusySamples, 2, 1));
    const idleSamplesRequired = Math.floor(normalizeNumber(guard.consecutiveIdleSamples, 2, 1));
    const waitMs = normalizeNumber(guard.waitMs, 5000, 50);
    const maxWaitMs = normalizeNumber(guard.maxWaitMs, 0, 0);
    let busySamples = 0;
    let idleSamples = 0;
    let waitedMs = 0;
    let announced = false;
    let lastCpuPercent = null;

    while (true) {
        lastCpuPercent = Number(await sample());
        if (!Number.isFinite(lastCpuPercent)) {
            return { waitedMs, lastCpuPercent: null };
        }

        if (!announced) {
            if (lastCpuPercent < busyThreshold) {
                return { waitedMs, lastCpuPercent };
            }
            busySamples += 1;
            if (busySamples < busySamplesRequired) continue;
            announced = true;
            log(`[resource] CPU 繁忙，暂停 ${stage}: 当前=${lastCpuPercent.toFixed(0)}%，阈值=${busyThreshold}%`);
        } else if (lastCpuPercent <= resumeThreshold) {
            idleSamples += 1;
            if (idleSamples >= idleSamplesRequired) {
                log(`[resource] CPU 已恢复，继续 ${stage}: 当前=${lastCpuPercent.toFixed(0)}%，已等待=${(waitedMs / 1000).toFixed(1)}s`);
                return { waitedMs, lastCpuPercent };
            }
            continue;
        } else {
            idleSamples = 0;
        }

        if (maxWaitMs > 0 && waitedMs >= maxWaitMs) {
            log(`[resource] CPU 等待达到上限，继续 ${stage}: ${(maxWaitMs / 1000).toFixed(1)}s`);
            return { waitedMs, lastCpuPercent };
        }
        const currentWaitMs = maxWaitMs > 0 ? Math.min(waitMs, maxWaitMs - waitedMs) : waitMs;
        await sleep(currentWaitMs);
        waitedMs += currentWaitMs;
    }
}

function withFfmpegResourceLimits(args, resourceConfig = {}) {
    const threads = normalizeThreads(resourceConfig.threads, DEFAULT_THREADS);
    if (threads <= 0 || args.includes('-threads')) {
        return [...args];
    }

    const limitedArgs = [...args];
    const outputIndex = Math.max(limitedArgs.length - 1, 0);
    limitedArgs.splice(outputIndex, 0, '-threads', String(threads));
    return limitedArgs;
}

function applyFfmpegProcessPriority(pid, priority = DEFAULT_PRIORITY) {
    if (process.platform !== 'win32' || !pid) {
        return;
    }

    const priorityClass = WINDOWS_PRIORITY_CLASSES[String(priority)] || WINDOWS_PRIORITY_CLASSES[String(priority).toLowerCase()];
    if (!priorityClass || priorityClass === 'Normal') {
        return;
    }

    const safePid = Number(pid);
    if (!Number.isFinite(safePid)) {
        return;
    }

    const command = `$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue; if ($p) { $p.PriorityClass = '${priorityClass}' }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
}

module.exports = {
    getFfmpegResourceConfig,
    withFfmpegResourceLimits,
    applyFfmpegProcessPriority,
    sampleCpuPercent,
    waitForCpuAvailability
};
