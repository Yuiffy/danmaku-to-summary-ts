import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { coverageSettings, CoverageSettings, PeerVideo } from './peerCoverage';
import type { PeerApi } from './peerCoverageApi';

export async function writeCoverageJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8'); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
}

/** The account/video/action receipt survives restarts. An uncertain POST is never automatically replayed. */
export async function supportPeer(video: PeerVideo, settings: CoverageSettings, api: PeerApi, file: string, now = Date.now): Promise<unknown> {
    const policy = coverageSettings(settings);
    await fs.mkdir(path.dirname(file), { recursive: true });
    let lock;
    try { lock = await fs.open(`${file}.lock`, 'wx'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'deferred', reason: '互动记录正在使用或待恢复' }; throw error; }
    try {
        const uid = await api.accountId();
        let state: any;
        try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = { version: 1, accounts: {} }; }
        if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object') throw new Error('Invalid peer support journal');
        const account = state.accounts[uid] ||= { entries: {} };
        if (account.suspendedUntil > now()) return { status: 'deferred', reason: '平台互动暂停中' };
        if (!video.complete || video.ownerId === uid) throw new Error('Invalid peer support target');
        const entry = account.entries[video.bvid] ||= { aid: video.aid, ownerId: video.ownerId, actions: {} };
        if (entry.aid !== video.aid || entry.ownerId !== video.ownerId) throw new Error('Peer receipt target changed');
        const persist = () => writeCoverageJson(file, state);
        const outcomes: Record<string, string> = {};
        let admitted = false;
        for (const action of policy.supportActions) {
            try {
                if (await api.has(action, video, entry.actions[action]?.receipt)) {
                    entry.actions[action] = { ...entry.actions[action], status: 'confirmed', at: now() }; outcomes[action] = 'already_done'; await persist(); continue;
                }
                const previous = entry.actions[action];
                if (previous) { outcomes[action] = previous.status === 'confirmed' ? 'externally_changed' : 'unknown_no_replay'; continue; }
                if (!admitted) {
                    const recent = Object.values(account.entries).filter((row: any) => row.reservedAt > now() - 86400000);
                    if (recent.length >= policy.maxSupportPerDay || account.lastSupportAt + policy.supportIntervalSeconds * 1000 > now()) {
                        outcomes[action] = 'deferred_quota'; continue;
                    }
                    entry.reservedAt = now(); account.lastSupportAt = now(); admitted = true;
                    await persist();
                }
                const folder = action === 'favorite' ? policy.favoriteFolderId || await api.defaultFolder(video) : undefined;
                entry.actions[action] = { status: 'intent', at: now(), ...(folder ? { folder } : {}) };
                await persist();
                try {
                    const receipt = await api.act(action, video, folder);
                    if (receipt) entry.actions[action].receipt = receipt;
                    entry.actions[action].status = 'acknowledged'; await persist();
                    if (await api.has(action, video, entry.actions[action].receipt)) { entry.actions[action].status = 'confirmed'; outcomes[action] = 'confirmed'; }
                    else { entry.actions[action].status = 'unknown'; outcomes[action] = 'unknown_no_replay'; }
                } catch {
                    entry.actions[action].status = 'unknown'; outcomes[action] = 'unknown_no_replay';
                    account.suspendedUntil = now() + 3600000;
                    await persist(); break;
                }
                await persist();
            } catch {
                outcomes[action] = 'unavailable'; account.suspendedUntil = now() + 3600000; await persist(); break;
            }
        }
        return { status: 'recorded', bvid: video.bvid, actions: outcomes };
    } finally { await lock.close(); await fs.rm(`${file}.lock`, { force: true }); }
}
