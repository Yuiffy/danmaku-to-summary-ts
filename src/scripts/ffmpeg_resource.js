const { spawn } = require('child_process');

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
    return {
        threads: normalizeThreads(process.env.FFMPEG_THREADS ?? ffmpeg.threads, DEFAULT_THREADS),
        priority: String(process.env.FFMPEG_PRIORITY || ffmpeg.priority || DEFAULT_PRIORITY)
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
    getFfmpegResourceConfig,
    withFfmpegResourceLimits,
    applyFfmpegProcessPriority
};
