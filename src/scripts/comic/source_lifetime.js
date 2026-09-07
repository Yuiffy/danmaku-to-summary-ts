'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VIDEO_EXTENSION = /^\.(?:flv|mp4|mkv|webm|mov|ts)$/iu;
const DIRECTORY_NAME = /^comic-source-[a-z0-9]+$/iu;

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function fileIdentity(stat) {
    return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameFile(stat, identity) {
    return stat.isFile() && String(stat.dev) === identity?.dev && String(stat.ino) === identity?.ino;
}

async function removeAlias(directory, owner, options = {}) {
    const io = options.io || fs.promises;
    const alive = options.processIsAlive || processIsAlive;
    if (!owner || owner.version !== 1 || !/^source\.(?:flv|mp4|mkv|webm|mov|ts)$/iu.test(owner.file || '')) return false;
    if (owner.host !== os.hostname()) return false;
    if (typeof owner.readerPending !== 'boolean'
        || (owner.readerPid !== null && (!Number.isInteger(owner.readerPid) || owner.readerPid <= 0))) return false;
    if ((await io.lstat(directory)).isSymbolicLink()) return false;
    if (owner.readerPending && !options.explicitRelease) return false;
    if (owner.readerPid && alive(owner.readerPid)) return false;
    const aliasPath = path.join(directory, owner.file);
    try {
        const stat = await io.lstat(aliasPath, { bigint: true });
        if (stat.isSymbolicLink() || !sameFile(stat, owner.identity)) return false;
        await io.unlink(aliasPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await io.unlink(path.join(directory, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await io.rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    return true;
}

async function cleanupAbandonedSourceAliases(tempRoot, options = {}) {
    const io = options.io || fs.promises;
    const alive = options.processIsAlive || processIsAlive;
    const log = options.log || console.warn;
    let entries;
    try { entries = await io.readdir(tempRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !DIRECTORY_NAME.test(entry.name)) continue;
        const directory = path.join(tempRoot, entry.name);
        try {
            const owner = JSON.parse(await io.readFile(path.join(directory, 'owner.json'), 'utf8'));
            if (!Number.isInteger(owner.parentPid) || owner.parentPid <= 0 || alive(owner.parentPid)) continue;
            if (owner.readerPending) log(`Source alias retained after an unconfirmed reader launch: ${entry.name}`);
            if (await removeAlias(directory, owner, options)) removed += 1;
        } catch (error) { log(`Source alias recovery retained ${entry.name}: ${error.message}`); }
    }
    return removed;
}

async function retainComicSource(sourceVideoPath, tempRoot, options = {}) {
    if (!sourceVideoPath || !VIDEO_EXTENSION.test(path.extname(sourceVideoPath))) return null;
    const io = options.io || fs.promises;
    const log = options.log || console.warn;
    let directory;
    let aliasPath;
    try {
        const before = await io.lstat(sourceVideoPath, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || !Number(before.ino)) return null;
        await io.mkdir(tempRoot, { recursive: true });
        await cleanupAbandonedSourceAliases(tempRoot, options);
        directory = await io.mkdtemp(path.join(tempRoot, 'comic-source-'));
        aliasPath = path.join(directory, `source${path.extname(sourceVideoPath).toLowerCase()}`);
        const owner = { version: 1, host: os.hostname(), parentPid: process.pid, readerPid: null, readerPending: false,
            file: path.basename(aliasPath), identity: fileIdentity(before) };
        const ownerPath = path.join(directory, 'owner.json');
        // Hard links protect a closed recording against name deletion, not in-place edits.
        await io.writeFile(ownerPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        await io.link(sourceVideoPath, aliasPath);
        const linked = await io.lstat(aliasPath, { bigint: true });
        if (!sameFile(linked, owner.identity) || linked.size !== before.size || linked.mtimeMs !== before.mtimeMs) {
            throw new Error('Source changed while retaining comic input');
        }
        let released = false;
        return {
            path: aliasPath,
            originalPath: sourceVideoPath,
            readerStarting() {
                owner.readerPending = true;
                fs.writeFileSync(ownerPath, JSON.stringify(owner), 'utf8');
            },
            registerReader(pid) {
                if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid comic reader process');
                owner.readerPid = pid;
                owner.readerPending = false;
                // The wrapper calls this synchronously immediately after spawning Python.
                try { fs.writeFileSync(ownerPath, JSON.stringify(owner), 'utf8'); }
                catch (error) {
                    owner.readerPending = true;
                    log(`Comic reader registration was not persisted; keep its source until completion: ${error.message}`);
                }
            },
            async release() {
                if (released) return;
                released = true;
                try { await removeAlias(directory, owner, { ...options, explicitRelease: true }); }
                catch (error) { log(`Comic source alias retained for recovery: ${error.message}`); }
            }
        };
    } catch (error) {
        log(`Cannot retain comic source; keep sequential clipping: ${error.message}`);
        if (aliasPath) await io.unlink(aliasPath).catch(() => {});
        if (directory) {
            await io.unlink(path.join(directory, 'owner.json')).catch(() => {});
            await io.rmdir(directory).catch(() => {});
        }
        return null;
    }
}

module.exports = { retainComicSource, cleanupAbandonedSourceAliases, processIsAlive };
