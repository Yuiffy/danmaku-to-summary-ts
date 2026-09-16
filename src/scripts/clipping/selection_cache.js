'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasIncompleteTextGeneration } = require('../text_attempt_diagnostics');
const { publishGenerationOutcome, readGenerationOutcome, consumeGenerationOutcome, serializeGenerationError } = require('./selection_outcome');
const inFlight = new Map();

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function waitForCacheChange(file) {
    return new Promise(resolve => {
        let watcher;
        const finish = () => { clearTimeout(timer); watcher?.close(); resolve(); };
        const timer = setTimeout(finish, 250);
        try {
            watcher = fs.watch(path.dirname(file), (_event, name) => {
                const changed = String(name || '');
                if (changed === path.basename(file) || changed === `${path.basename(file)}.lock`) finish();
            });
            watcher.on('error', finish);
        } catch { /* The polling deadline also covers filesystems without watch support. */ }
    });
}

async function withSelectionCache(options, generate) {
    if (!options.directory) return generate();
    const key = crypto.createHash('sha256').update(JSON.stringify({
        version: 1, phase: options.phase, signature: options.signature, prompt: options.prompt
    })).digest('hex');
    const file = path.join(options.directory, `${key}.json`);
    if (inFlight.has(file)) {
        try {
            const result = await inFlight.get(file);
            return { ...result, meta: { ...result.meta, selectionCache: {
                ...result.meta?.selectionCache, hit: true, joined: true
            } } };
        } catch (error) {
            const joined = Object.assign(new Error(String(error?.message || error), { cause: error }), error,
                { name: error?.name || 'Error', selectionCache: { hit: false, joined: true, key } });
            throw joined;
        }
    }
    const run = async () => {
        const reusable = () => {
            try {
                const value = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (value.version !== 1 || value.key !== key || hasIncompleteTextGeneration(value.result?.meta) || !options.validate(value.result)) return null;
                return { ...value.result, meta: { ...value.result.meta,
                    selectionCache: { hit: true, key, generatedAt: value.generatedAt } } };
            } catch { return null; }
        };
        const existing = reusable();
        if (existing) return existing;
        const lock = `${file}.lock`;
        const generationId = crypto.randomUUID();
        let ownsLock = false;
        let followedOwner = null;
        let joinedOutcome = null;
        try {
            fs.mkdirSync(options.directory, { recursive: true });
            while (!ownsLock) {
                if (followedOwner) {
                    joinedOutcome = readGenerationOutcome(file, followedOwner.generationId);
                    if (joinedOutcome) break;
                    const available = reusable();
                    if (available) return available;
                    try {
                        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
                        if (!processAlive(owner.pid) || owner.pid !== followedOwner.pid
                            || owner.generationId !== followedOwner.generationId || owner.createdAt !== followedOwner.createdAt) break;
                    } catch { break; }
                    await waitForCacheChange(file);
                    continue;
                }
                try {
                    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), generationId }), { flag: 'wx' });
                    ownsLock = true;
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    const available = reusable();
                    if (available) return available;
                    try {
                        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
                        if (!processAlive(owner.pid)) { fs.unlinkSync(lock); continue; }
                        followedOwner = owner;
                    } catch {
                        // Another writer may still be writing its lock metadata.
                        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch { /* raced release */ }
                    }
                    await waitForCacheChange(file);
                }
            }
        } catch (error) {
            (options.log || console.warn)(`Selection cache unavailable: ${error.message}`);
            if (!followedOwner) return generate();
        }
        try {
            // A concurrent consumer must not turn its owner's failed attempt into a new submission.
            if (followedOwner) {
                joinedOutcome ||= readGenerationOutcome(file, followedOwner.generationId);
                if (joinedOutcome) return consumeGenerationOutcome(joinedOutcome, key, followedOwner.generationId);
                const available = reusable();
                if (available) return available;
                return consumeGenerationOutcome(null, key, followedOwner.generationId);
            }
            const available = reusable();
            if (available) return available;
            let result;
            try { result = await generate(); } catch (error) {
                publishGenerationOutcome(file, generationId, { kind: 'failure', error: serializeGenerationError(error) }, options.log);
                throw error;
            }
            let persisted = false;
            if (!hasIncompleteTextGeneration(result?.meta) && options.validate(result)) {
                const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
                try {
                    fs.writeFileSync(temporary, JSON.stringify({ version: 1, key,
                        generatedAt: new Date().toISOString(), result }), 'utf8');
                    fs.renameSync(temporary, file);
                    persisted = true;
                } catch (error) {
                    (options.log || console.warn)(`Selection cache write failed: ${error.message}`);
                } finally {
                    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
                }
            }
            if (!persisted) publishGenerationOutcome(file, generationId, { kind: 'result', result }, options.log);
            return { ...result, meta: { ...result.meta, selectionCache: { hit: false, key } } };
        } finally {
            if (ownsLock) { try { fs.unlinkSync(lock); } catch { /* already removed */ } }
        }
    };
    const promise = run();
    inFlight.set(file, promise);
    try { return await promise; } finally { inFlight.delete(file); }
}

module.exports = { withSelectionCache };
