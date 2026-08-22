const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const DEFAULT_THREADS = 2;
const DEFAULT_PRIORITY = 'belowNormal';
const DEFAULT_ASR_CLAIM_FILE = require('path').join(os.tmpdir(), 'danmaku-to-summary-asr.claim');

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
        },
        asrGuard: {
            enabled: normalizeBoolean(
                process.env.DANMAKU_ASR_GUARD_ENABLED ?? ffmpeg.asrGuard?.enabled,
                false
            ),
            claimFile: String(
                process.env.DANMAKU_RESOURCE_STATE_FILE
                || ffmpeg.asrGuard?.claimFile
                || DEFAULT_ASR_CLAIM_FILE
            ),
            staleMs: normalizeNumber(ffmpeg.asrGuard?.staleMs, 15000, 1000),
            pollMs: normalizeNumber(ffmpeg.asrGuard?.pollMs, 1000, 100),
            maxWaitMs: normalizeNumber(ffmpeg.asrGuard?.maxWaitMs, 15000, 0),
            overlapThreads: normalizeThreads(ffmpeg.asrGuard?.overlapThreads, 1)
        },
        resourcePeak: {
            enabled: normalizeBoolean(ffmpeg.resourcePeak?.enabled, true),
            sampleIntervalMs: normalizeNumber(ffmpeg.resourcePeak?.sampleIntervalMs, 1000, 250)
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

function isAsrClaimActive(resourceConfig = {}, dependencies = {}) {
    const guard = resourceConfig.asrGuard || {};
    if (!guard.enabled) return false;
    const stat = dependencies.stat || fs.statSync;
    try {
        const metadata = stat(guard.claimFile);
        const ageMs = Date.now() - Number(metadata.mtimeMs || 0);
        return ageMs >= 0 && ageMs <= normalizeNumber(guard.staleMs, 15000, 1000);
    } catch {
        return false;
    }
}

async function waitForAsrAvailability(stage, resourceConfig = {}, dependencies = {}) {
    const guard = resourceConfig.asrGuard || {};
    if (!guard.enabled) {
        return { waitedMs: 0, asrActive: false };
    }

    const sleep = dependencies.sleep || delay;
    const active = dependencies.isActive || (() => isAsrClaimActive(resourceConfig, dependencies));
    const pollMs = normalizeNumber(guard.pollMs, 1000, 100);
    const maxWaitMs = normalizeNumber(guard.maxWaitMs, 15000, 0);
    const log = dependencies.log || console.log;
    let waitedMs = 0;
    let announced = false;

    while (active()) {
        if (!announced) {
            announced = true;
            log(`[resource] ASR 正在使用资源，延后 ${stage} 启动`);
        }
        if (maxWaitMs > 0 && waitedMs >= maxWaitMs) {
            log(`[resource] ASR 租约等待达到上限，继续 ${stage}: ${(waitedMs / 1000).toFixed(1)}s`);
            break;
        }
        const currentWaitMs = maxWaitMs > 0
            ? Math.min(pollMs, maxWaitMs - waitedMs)
            : pollMs;
        await sleep(currentWaitMs);
        waitedMs += currentWaitMs;
    }

    const asrActive = Boolean(active());
    if (announced && !asrActive) {
        log(`[resource] ASR 租约已释放，继续 ${stage}: 已等待 ${(waitedMs / 1000).toFixed(1)}s`);
    }
    return { waitedMs, asrActive };
}

function startResourcePeakMonitor(stage, options = {}) {
    const resourceConfig = options.resourceConfig || {};
    const peakConfig = resourceConfig.resourcePeak || {};
    if (peakConfig.enabled === false) {
        return { stop: () => null };
    }

    const intervalMs = normalizeNumber(peakConfig.sampleIntervalMs, 1000, 250);
    const cpuCount = Math.max(1, os.cpus().length || 1);
    let lastSnapshot = readCpuSnapshot();
    let lastUsage = process.cpuUsage();
    let lastAt = process.hrtime.bigint();
    let hostPeak = null;
    let nodePeak = null;
    let nodeCorePeak = null;
    let samples = 0;
    let stopped = false;

    const sample = () => {
        if (stopped) return;
        const currentSnapshot = readCpuSnapshot();
        const idleDelta = currentSnapshot.idle - lastSnapshot.idle;
        const totalDelta = currentSnapshot.total - lastSnapshot.total;
        if (totalDelta > 0) {
            const hostPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
            hostPeak = hostPeak === null ? hostPercent : Math.max(hostPeak, hostPercent);
        }
        lastSnapshot = currentSnapshot;

        const currentAt = process.hrtime.bigint();
        const elapsedMs = Math.max(0.1, Number(currentAt - lastAt) / 1e6);
        const usage = process.cpuUsage(lastUsage);
        const nodeCorePercent = ((usage.user + usage.system) / 1000) / elapsedMs * 100;
        const nodePercent = nodeCorePercent / cpuCount;
        nodeCorePeak = nodeCorePeak === null ? nodeCorePercent : Math.max(nodeCorePeak, nodeCorePercent);
        nodePeak = nodePeak === null ? nodePercent : Math.max(nodePeak, nodePercent);
        lastUsage = process.cpuUsage();
        lastAt = currentAt;
        samples += 1;
    };

    const timer = setInterval(sample, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        stop: () => {
            if (stopped) return null;
            clearInterval(timer);
            sample();
            stopped = true;
            const result = {
                stage: String(stage || 'ffmpeg'),
                hostCpuPeakPct: hostPeak === null ? null : Number(hostPeak.toFixed(2)),
                nodeCpuPeakPct: nodePeak === null ? null : Number(nodePeak.toFixed(2)),
                nodeCorePeakPct: nodeCorePeak === null ? null : Number(nodeCorePeak.toFixed(2)),
                samples
            };
            const parts = [
                `host_cpu_peak=${result.hostCpuPeakPct === null ? 'n/a' : `${result.hostCpuPeakPct}%`}`,
                `node_cpu_peak=${result.nodeCpuPeakPct === null ? 'n/a' : `${result.nodeCpuPeakPct}%`}`,
                `node_core_peak=${result.nodeCorePeakPct === null ? 'n/a' : `${result.nodeCorePeakPct}%`}`
            ];
            (options.log || console.log)(`[resource] 峰值 ${result.stage}: ${parts.join(', ')}, samples=${samples}`);
            return result;
        }
    };
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
    DEFAULT_ASR_CLAIM_FILE,
    getFfmpegResourceConfig,
    withFfmpegResourceLimits,
    applyFfmpegProcessPriority,
    sampleCpuPercent,
    waitForCpuAvailability,
    isAsrClaimActive,
    waitForAsrAvailability,
    startResourcePeakMonitor
};
