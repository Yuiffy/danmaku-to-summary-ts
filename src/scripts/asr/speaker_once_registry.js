const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_FILE = path.join(
    process.cwd(),
    'data',
    'runtime',
    'asr-speaker-once.json'
);
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeRoomId(roomId) {
    const normalized = String(roomId ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error(`直播间 ID 无效: ${roomId}`);
    }
    return normalized;
}

class SpeakerOnceRegistry {
    constructor(stateFile = process.env.ASR_SPEAKER_ONCE_STATE_FILE || DEFAULT_STATE_FILE) {
        this.stateFile = path.resolve(stateFile);
        this.lockFile = `${this.stateFile}.lock`;
    }

    ensureParentDirectory() {
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    }

    readState() {
        if (!fs.existsSync(this.stateFile)) {
            return { version: 1, requests: {}, history: [] };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            return {
                version: 1,
                requests: parsed && typeof parsed.requests === 'object' ? parsed.requests : {},
                history: Array.isArray(parsed?.history) ? parsed.history : []
            };
        } catch (error) {
            throw new Error(`读取一次性说话人开关失败: ${error.message}`);
        }
    }

    writeState(state) {
        this.ensureParentDirectory();
        const normalized = {
            version: 1,
            updatedAt: new Date().toISOString(),
            requests: state.requests || {},
            history: (state.history || []).slice(-100)
        };
        fs.writeFileSync(this.stateFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    }

    withLock(callback) {
        this.ensureParentDirectory();
        const startedAt = Date.now();
        let fd = null;
        while (fd === null) {
            try {
                fd = fs.openSync(this.lockFile, 'wx');
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                try {
                    const age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
                    if (age > STALE_LOCK_MS) {
                        fs.unlinkSync(this.lockFile);
                        continue;
                    }
                } catch (statError) {
                    if (statError.code !== 'ENOENT') throw statError;
                    continue;
                }
                if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
                    throw new Error(`等待一次性说话人开关锁超时: ${this.lockFile}`);
                }
                sleepSync(LOCK_WAIT_MS);
            }
        }

        try {
            return callback();
        } finally {
            try { fs.closeSync(fd); } catch {}
            try { fs.unlinkSync(this.lockFile); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }

    cleanupExpired(state, now = Date.now()) {
        let changed = false;
        for (const [roomId, request] of Object.entries(state.requests || {})) {
            if (request.expiresAt && Date.parse(request.expiresAt) <= now) {
                delete state.requests[roomId];
                state.history.push({
                    ...request,
                    roomId,
                    status: 'expired',
                    finishedAt: new Date(now).toISOString()
                });
                changed = true;
            }
        }
        return changed;
    }

    arm(roomId, options = {}) {
        const normalizedRoomId = normalizeRoomId(roomId);
        return this.withLock(() => {
            const state = this.readState();
            this.cleanupExpired(state);
            const now = Date.now();
            const expiresHours = Number(options.expiresHours ?? 24);
            const request = {
                id: `${now}-${normalizedRoomId}`,
                roomId: normalizedRoomId,
                roomName: options.roomName ? String(options.roomName) : null,
                requestedBy: options.requestedBy ? String(options.requestedBy) : 'cli',
                reason: options.reason ? String(options.reason) : '下一场直播启用说话人识别',
                createdAt: new Date(now).toISOString(),
                expiresAt: Number.isFinite(expiresHours) && expiresHours > 0
                    ? new Date(now + expiresHours * 60 * 60 * 1000).toISOString()
                    : null
            };
            state.requests[normalizedRoomId] = request;
            this.writeState(state);
            return request;
        });
    }

    cancel(roomId, options = {}) {
        const normalizedRoomId = normalizeRoomId(roomId);
        return this.withLock(() => {
            const state = this.readState();
            this.cleanupExpired(state);
            const request = state.requests[normalizedRoomId] || null;
            if (request) {
                delete state.requests[normalizedRoomId];
                state.history.push({
                    ...request,
                    status: 'cancelled',
                    cancelledBy: options.requestedBy ? String(options.requestedBy) : 'cli',
                    finishedAt: new Date().toISOString()
                });
                this.writeState(state);
            }
            return request;
        });
    }

    consume(roomId, task = {}) {
        const normalizedRoomId = normalizeRoomId(roomId);
        return this.withLock(() => {
            const state = this.readState();
            const expired = this.cleanupExpired(state);
            const request = state.requests[normalizedRoomId] || null;
            if (!request) {
                if (expired) this.writeState(state);
                return null;
            }
            delete state.requests[normalizedRoomId];
            const consumed = {
                ...request,
                status: 'consumed',
                taskId: task.taskId ? String(task.taskId) : null,
                mediaPath: task.mediaPath ? String(task.mediaPath) : null,
                finishedAt: new Date().toISOString()
            };
            state.history.push(consumed);
            this.writeState(state);
            return consumed;
        });
    }

    list() {
        return this.withLock(() => {
            const state = this.readState();
            if (this.cleanupExpired(state)) this.writeState(state);
            return Object.values(state.requests).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        });
    }
}

module.exports = new SpeakerOnceRegistry();
module.exports.SpeakerOnceRegistry = SpeakerOnceRegistry;
module.exports.normalizeRoomId = normalizeRoomId;
module.exports.DEFAULT_STATE_FILE = DEFAULT_STATE_FILE;
