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
const SCHEDULED_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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

function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function normalizeParticipants(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            streamerId: item.streamerId ? String(item.streamerId).trim() : null,
            displayName: item.displayName ? String(item.displayName).trim() : null,
            role: item.role ? String(item.role).trim() : 'participant',
            planned: item.planned !== false,
            roomIds: normalizeStringArray(item.roomIds),
            speakerLabels: normalizeStringArray(item.speakerLabels),
            aliases: normalizeStringArray(item.aliases),
            mentionLabels: normalizeStringArray(item.mentionLabels)
        }))
        .filter((item) => item.streamerId);
}

function normalizeReferencePreparation(value) {
    if (!value || typeof value !== 'object') {
        return {
            status: 'unchecked',
            missingStreamerIds: [],
            readyStreamerIds: [],
            participants: []
        };
    }
    return {
        status: value.status ? String(value.status) : 'unchecked',
        missingStreamerIds: normalizeStringArray(value.missingStreamerIds),
        readyStreamerIds: normalizeStringArray(value.readyStreamerIds),
        participants: Array.isArray(value.participants) ? value.participants : []
    };
}

function normalizeSpeakerRequest(roomId, options = {}, now = Date.now()) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const base = {
        id: options.id ? String(options.id) : `${now}-${normalizedRoomId}`,
        roomId: normalizedRoomId,
        roomName: options.roomName ? String(options.roomName) : null,
        requestedBy: options.requestedBy ? String(options.requestedBy) : 'cli',
        reason: options.reason ? String(options.reason) : '下一场直播启用说话人识别',
        createdAt: options.createdAt ? String(options.createdAt) : new Date(now).toISOString(),
        scheduledAt: options.scheduledAt ? String(options.scheduledAt) : null,
        windowHours: options.windowHours ?? null,
        expiresAt: options.expiresAt ? String(options.expiresAt) : null,
        cleanupAfter: options.cleanupAfter ? String(options.cleanupAfter) : null,
        mode: options.mode ? String(options.mode) : 'speaker_once',
        hostStreamerId: options.hostStreamerId ? String(options.hostStreamerId) : null,
        plannedParticipantIds: normalizeStringArray(options.plannedParticipantIds),
        rosterStreamerIds: normalizeStringArray(options.rosterStreamerIds),
        participants: normalizeParticipants(options.participants),
        constrainToRoster: options.constrainToRoster !== false,
        referencePreparation: normalizeReferencePreparation(options.referencePreparation)
    };
    return base;
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
            return { version: 2, requests: {}, history: [] };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            const normalizeRequestMap = (requests) => {
                const output = {};
                Object.entries(requests && typeof requests === 'object' ? requests : {}).forEach(([roomId, request]) => {
                    output[roomId] = normalizeSpeakerRequest(roomId, request || {});
                });
                return output;
            };
            return {
                version: 2,
                requests: normalizeRequestMap(parsed?.requests),
                history: Array.isArray(parsed?.history)
                    ? parsed.history
                        .filter((item) => item && typeof item === 'object')
                        .map((item) => normalizeSpeakerRequest(item.roomId, item))
                    : []
            };
        } catch (error) {
            throw new Error(`读取一次性说话人开关失败: ${error.message}`);
        }
    }

    writeState(state) {
        this.ensureParentDirectory();
        const normalized = {
            version: 2,
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
            const cleanupAt = request.cleanupAfter || request.expiresAt;
            if (cleanupAt && Date.parse(cleanupAt) <= now) {
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
            const scheduledAt = options.startAt ? Date.parse(options.startAt) : null;
            const windowHours = Number(options.windowHours ?? 24);
            if (options.startAt && !Number.isFinite(scheduledAt)) {
                throw new Error(`预约开始时间无效: ${options.startAt}`);
            }
            if (scheduledAt !== null && (!Number.isFinite(windowHours) || windowHours <= 0)) {
                throw new Error(`预约窗口时长无效: ${options.windowHours}`);
            }
            const expiresAt = scheduledAt !== null
                ? scheduledAt + windowHours * 60 * 60 * 1000
                : (Number.isFinite(expiresHours) && expiresHours > 0
                    ? now + expiresHours * 60 * 60 * 1000
                    : null);
            const request = normalizeSpeakerRequest(normalizedRoomId, {
                ...options,
                id: `${now}-${normalizedRoomId}`,
                roomId: normalizedRoomId,
                createdAt: new Date(now).toISOString(),
                scheduledAt: scheduledAt !== null ? new Date(scheduledAt).toISOString() : null,
                windowHours: scheduledAt !== null ? windowHours : null,
                expiresAt: expiresAt !== null ? new Date(expiresAt).toISOString() : null,
                cleanupAfter: scheduledAt !== null
                    ? new Date(expiresAt + SCHEDULED_CLEANUP_GRACE_MS).toISOString()
                    : null
            }, now);
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
            const request = state.requests[normalizedRoomId] || null;
            if (!request) {
                const expired = this.cleanupExpired(state);
                if (expired) this.writeState(state);
                return null;
            }
            const now = Date.now();
            const taskEndedAt = Number.isFinite(Number(task.addedTime))
                ? Number(task.addedTime)
                : now;
            const scheduledAt = request.scheduledAt ? Date.parse(request.scheduledAt) : null;
            const expiresAt = request.expiresAt ? Date.parse(request.expiresAt) : null;

            if (scheduledAt !== null && taskEndedAt < scheduledAt) {
                return null;
            }
            if (expiresAt !== null && (scheduledAt !== null ? taskEndedAt : now) > expiresAt) {
                delete state.requests[normalizedRoomId];
                state.history.push({
                    ...request,
                    status: 'expired',
                    expiredReason: scheduledAt !== null ? 'task-ended-after-window' : 'request-expired',
                    matchedTaskEndedAt: new Date(taskEndedAt).toISOString(),
                    finishedAt: new Date(now).toISOString()
                });
                this.cleanupExpired(state, now);
                this.writeState(state);
                return null;
            }
            delete state.requests[normalizedRoomId];
            const consumed = {
                ...request,
                status: 'consumed',
                taskId: task.taskId ? String(task.taskId) : null,
                mediaPath: task.mediaPath ? String(task.mediaPath) : null,
                matchedTaskEndedAt: new Date(taskEndedAt).toISOString(),
                finishedAt: new Date().toISOString()
            };
            state.history.push(consumed);
            this.cleanupExpired(state, now);
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
