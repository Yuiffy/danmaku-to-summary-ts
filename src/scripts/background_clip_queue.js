const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_QUEUE_DIRECTORY = path.join(os.tmpdir(), 'danmaku-to-summary-background-clip-queue');
const DEFAULT_POLL_MS = 500;
const DEFAULT_IDLE_GRACE_MS = 1000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const WORKER_LOCK_NAME = 'worker.lock';
const WORKER_LAUNCH_NAME = 'worker.launch';

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeInteger(value, fallback, minimum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.floor(parsed));
}

function getQueueConfig(rawConfig = {}, env = process.env) {
    const raw = rawConfig || {};
    const configuredDirectory = env.DANMAKU_BACKGROUND_CLIP_QUEUE_DIR
        || raw.directory
        || DEFAULT_QUEUE_DIRECTORY;
    return {
        enabled: normalizeBoolean(
            env.DANMAKU_BACKGROUND_CLIP_QUEUE_ENABLED ?? raw.enabled,
            true
        ),
        directory: path.resolve(String(configuredDirectory)),
        pollMs: normalizeInteger(env.DANMAKU_BACKGROUND_CLIP_QUEUE_POLL_MS ?? raw.pollMs, DEFAULT_POLL_MS, 100),
        idleGraceMs: normalizeInteger(
            env.DANMAKU_BACKGROUND_CLIP_QUEUE_IDLE_GRACE_MS ?? raw.idleGraceMs,
            DEFAULT_IDLE_GRACE_MS,
            0
        ),
        staleLockMs: normalizeInteger(
            env.DANMAKU_BACKGROUND_CLIP_QUEUE_STALE_LOCK_MS ?? raw.staleLockMs,
            DEFAULT_STALE_LOCK_MS,
            1000
        )
    };
}

function ensureQueueDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function createJobId() {
    return `${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function enqueueJob(job, config = {}) {
    if (!job || !job.payloadPath) {
        throw new Error('background clip queue job requires payloadPath');
    }

    const queueConfig = getQueueConfig(config);
    if (!queueConfig.enabled) {
        throw new Error('background clip queue is disabled');
    }

    ensureQueueDirectory(queueConfig.directory);
    const jobId = String(job.jobId || createJobId()).replace(/[^a-zA-Z0-9._-]/g, '_');
    const pendingPath = path.join(queueConfig.directory, `${jobId}.pending.json`);
    const temporaryPath = path.join(
        queueConfig.directory,
        `.${jobId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    const entry = {
        version: 1,
        jobId,
        enqueuedAt: new Date().toISOString(),
        payloadPath: path.resolve(String(job.payloadPath)),
        logPath: job.logPath ? path.resolve(String(job.logPath)) : null,
        roomId: job.roomId === undefined || job.roomId === null ? null : String(job.roomId)
    };

    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(entry, null, 2), 'utf8');
        fs.renameSync(temporaryPath, pendingPath);
    } catch (error) {
        try {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        } catch {
            // Preserve the original enqueue failure.
        }
        throw error;
    }

    return {
        ...entry,
        queueDirectory: queueConfig.directory,
        pendingPath
    };
}

function countQueueEntries(directory) {
    try {
        return fs.readdirSync(directory).filter(file => /\.(pending|working)\.json$/i.test(file)).length;
    } catch {
        return 0;
    }
}

function readLockMetadata(lockPath) {
    try {
        return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        return null;
    }
}

function isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function removeStaleLock(lockPath, staleLockMs) {
    let stats;
    try {
        stats = fs.statSync(lockPath);
    } catch {
        return false;
    }

    const ageMs = Date.now() - Number(stats.mtimeMs || 0);
    if (ageMs < staleLockMs) return false;

    const metadata = readLockMetadata(lockPath);
    if (metadata?.pid && isProcessAlive(metadata.pid)) {
        return false;
    }

    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch (error) {
        return error?.code === 'ENOENT';
    }
}

function isWorkerLockActive(directory, staleLockMs) {
    const lockPath = path.join(directory, WORKER_LOCK_NAME);
    if (!fs.existsSync(lockPath)) return false;
    if (removeStaleLock(lockPath, staleLockMs)) return false;
    return fs.existsSync(lockPath);
}

function claimWorkerLaunch(directory, staleLockMs) {
    ensureQueueDirectory(directory);
    if (isWorkerLockActive(directory, staleLockMs)) return null;

    const launchPath = path.join(directory, WORKER_LAUNCH_NAME);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (isWorkerLockActive(directory, staleLockMs)) return null;
        let fd;
        const token = crypto.randomBytes(12).toString('hex');
        try {
            fd = fs.openSync(launchPath, 'wx');
            fs.writeSync(fd, JSON.stringify({
                pid: process.pid,
                token,
                startedAt: new Date().toISOString()
            }));
            fs.fsyncSync(fd);
            if (isWorkerLockActive(directory, staleLockMs)) {
                fs.closeSync(fd);
                try {
                    fs.unlinkSync(launchPath);
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
                return null;
            }

            const closeDescriptor = () => {
                if (fd === undefined) return;
                try {
                    fs.closeSync(fd);
                } catch {
                    // The descriptor may already have been closed during shutdown.
                }
                fd = undefined;
            };

            return {
                launchPath,
                commit() {
                    closeDescriptor();
                },
                release() {
                    const metadata = readLockMetadata(launchPath);
                    const ownsLaunch = metadata?.token === token && Number(metadata?.pid) === process.pid;
                    closeDescriptor();
                    if (ownsLaunch) {
                        try {
                            fs.unlinkSync(launchPath);
                        } catch (error) {
                            if (error?.code !== 'ENOENT') throw error;
                        }
                    }
                }
            };
        } catch (error) {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                } catch {
                    // Preserve the original launch error.
                }
            }
            if (error?.code !== 'EEXIST') throw error;

            let stats;
            try {
                stats = fs.statSync(launchPath);
            } catch {
                continue;
            }
            if (Date.now() - Number(stats.mtimeMs || 0) < staleLockMs) return null;
            try {
                fs.unlinkSync(launchPath);
            } catch (unlinkError) {
                if (unlinkError?.code !== 'ENOENT') return null;
            }
        }
    }

    return null;
}

function clearWorkerLaunchMarker(directory) {
    try {
        fs.unlinkSync(path.join(directory, WORKER_LAUNCH_NAME));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function acquireWorkerLock(directory, staleLockMs, log = () => {}) {
    ensureQueueDirectory(directory);
    const lockPath = path.join(directory, WORKER_LOCK_NAME);

    for (let attempt = 0; attempt < 3; attempt += 1) {
        let fd;
        const token = crypto.randomBytes(12).toString('hex');
        try {
            fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({
                pid: process.pid,
                token,
                startedAt: new Date().toISOString()
            }));
            fs.fsyncSync(fd);

            const heartbeatMs = Math.max(1000, Math.min(10_000, Math.floor(staleLockMs / 3)));
            const heartbeat = setInterval(() => {
                try {
                    const now = new Date();
                    fs.futimesSync(fd, now, now);
                } catch {
                    // The worker will still be protected by the live PID check.
                }
            }, heartbeatMs);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();

            return {
                lockPath,
                release() {
                    clearInterval(heartbeat);
                    let ownsLock = false;
                    const metadata = readLockMetadata(lockPath);
                    ownsLock = metadata?.token === token && Number(metadata?.pid) === process.pid;
                    try {
                        fs.closeSync(fd);
                    } catch {
                        // The descriptor may already have been closed during shutdown.
                    }
                    if (ownsLock) {
                        try {
                            fs.unlinkSync(lockPath);
                        } catch (error) {
                            if (error?.code !== 'ENOENT') {
                                log(`[background-clip-queue] 删除 worker 锁失败: ${error.message}`);
                            }
                        }
                    }
                }
            };
        } catch (error) {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                } catch {
                    // Ignore cleanup errors while another worker owns the lock.
                }
            }
            if (error?.code !== 'EEXIST') throw error;
            if (!removeStaleLock(lockPath, staleLockMs)) return null;
        }
    }

    return null;
}

function recoverWorkingEntries(directory) {
    ensureQueueDirectory(directory);
    for (const file of fs.readdirSync(directory)) {
        if (!/\.working\.json$/i.test(file)) continue;
        const workingPath = path.join(directory, file);
        const pendingPath = workingPath.replace(/\.working\.json$/i, '.pending.json');
        try {
            fs.renameSync(workingPath, pendingPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function claimNextEntry(directory) {
    const pendingFiles = fs.readdirSync(directory)
        .filter(file => /\.pending\.json$/i.test(file))
        .sort();

    for (const file of pendingFiles) {
        const pendingPath = path.join(directory, file);
        const workingPath = pendingPath.replace(/\.pending\.json$/i, '.working.json');
        try {
            fs.renameSync(pendingPath, workingPath);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }

        try {
            return {
                entryPath: workingPath,
                entry: JSON.parse(fs.readFileSync(workingPath, 'utf8'))
            };
        } catch (error) {
            return { entryPath: workingPath, error };
        }
    }

    return null;
}

function removeEntry(entryPath) {
    try {
        fs.unlinkSync(entryPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function appendQueueLog(logPath, message) {
    if (!logPath) return;
    try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] [ERROR] ${message}\n`, 'utf8');
    } catch {
        // A missing or unwritable per-job log must not stop the queue worker.
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runQueueWorker(config, processJob, options = {}) {
    if (typeof processJob !== 'function') {
        throw new TypeError('background clip queue worker requires processJob');
    }

    const queueConfig = getQueueConfig(config);
    if (!queueConfig.enabled) {
        return { acquired: false, processed: 0, disabled: true, queueDirectory: queueConfig.directory };
    }

    const log = options.log || console.log;
    const lock = acquireWorkerLock(queueConfig.directory, queueConfig.staleLockMs, log);
    if (!lock) {
        return { acquired: false, processed: 0, disabled: false, queueDirectory: queueConfig.directory };
    }

    let processed = 0;
    try {
        clearWorkerLaunchMarker(queueConfig.directory);
        recoverWorkingEntries(queueConfig.directory);
        let emptySince = null;

        while (true) {
            const claimed = claimNextEntry(queueConfig.directory);
            if (!claimed) {
                if (emptySince === null) emptySince = Date.now();
                if (Date.now() - emptySince >= queueConfig.idleGraceMs) break;
                await delay(queueConfig.pollMs);
                continue;
            }

            emptySince = null;
            try {
                if (claimed.error) {
                    throw new Error(`无法读取队列任务: ${claimed.error.message}`);
                }
                await processJob(claimed.entry);
                processed += 1;
            } catch (error) {
                const logMessage = `后台切片队列任务失败: ${error?.stack || error?.message || error}`;
                appendQueueLog(claimed.entry?.logPath, logMessage);
                log(`[background-clip-queue] ${logMessage}`);
            } finally {
                removeEntry(claimed.entryPath);
            }
        }
    } finally {
        lock.release();
    }

    return {
        acquired: true,
        processed,
        disabled: false,
        queueDirectory: queueConfig.directory,
        remaining: countQueueEntries(queueConfig.directory)
    };
}

module.exports = {
    DEFAULT_QUEUE_DIRECTORY,
    getQueueConfig,
    enqueueJob,
    countQueueEntries,
    claimWorkerLaunch,
    runQueueWorker
};
