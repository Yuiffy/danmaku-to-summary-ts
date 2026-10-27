import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import type { RecordingPrefix } from '../core/media/RecordingCoverage';

const localRequire = createRequire(path.resolve('package.json'));
const snapshot = localRequire('./src/core/media/RecordingSnapshot.ts');
const coverage = localRequire('./src/core/media/RecordingCoverage.ts');
const early = localRequire('./src/scripts/campaign_early.ts');

/** Read actual tail packet time, because a live recorder's metadata duration can lag or advance. */
async function snapshotDuration(file: string, lastTimestamp: number, ffprobe: string): Promise<number> {
    const result: any = await new Promise((resolve, reject) => execFile(ffprobe, ['-v', 'error', '-read_intervals',
        `${Math.max(0, lastTimestamp - 10)}%`, '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
        if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    }));
    const times = (result.packets || []).map((p: any) => Number(p.pts_time) + Number(p.duration_time || 0)).filter(Number.isFinite);
    const end = times.length ? Math.max(...times) : 0;
    if (!(end > 0) || Math.abs(end - lastTimestamp) > 5) throw new Error('Snapshot tail packet timing is unavailable or inconsistent');
    return end;
}

/** Explicit operator request only: never enable snapshots in the automatic title watcher. */
export async function triggerCampaignSnapshot(config: any, room: string, date: string, note: string, adapters: any = {}): Promise<any> {
    if (!note?.trim() || !room || !/^\d{4}_\d{2}_\d{2}$/u.test(date)) throw new Error('Snapshot requires room, date and an operator note');
    const now = Date.now();
    const campaigns = (config.ownStreamClips?.campaigns || []).filter((c: any) => c.enabled && c.earlyTrigger?.enabled
        && c.roomIds.map(String).includes(room) && now >= Date.parse(c.startsAt) && now < Date.parse(c.endsAt));
    if (campaigns.length !== 1) throw new Error('Expected one active campaign for snapshot room');
    const campaign = campaigns[0];
    const rows = early.discoverCampaignRecordings(config, [date]).filter((r: any) => r.roomId === room)
        .sort((a: any, b: any) => a.startedAt - b.startedAt);
    // Capture the most recent contiguous title group, including reconnect segments.
    const latest = rows.at(-1);
    const matches = (r: any) => campaign.earlyTrigger.titleKeywords.some((word: string) => word.trim() && r.title.includes(word));
    if (!latest || !matches(latest)) throw new Error('Latest recording does not match campaign title');
    const lastOther = rows.findLastIndex((r: any) => !matches(r));
    const sources = rows.slice(lastOther + 1).filter((r: any) => r.startedAt >= Date.parse(campaign.startsAt));
    if (!sources.length || sources.some((r: any) => !r.xmlExists || r.size <= 0)) throw new Error('Snapshot sources or XML unavailable');
    const key = createHash('sha256').update(JSON.stringify([campaign.id, room, sources.map((s: any) => path.basename(s.videoPath))])).digest('hex').slice(0, 20);
    const directory = path.join(path.dirname(latest.videoPath), 'campaign_snapshots', key);
    const manifest = path.join(directory, 'SNAPSHOT.json');
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, 'snapshot.lock');
    // Reuse process-owned admission locking, but keep it separate from the queue ledger.
    const lockOwner = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : 0;
    if (lockOwner) {
        try { process.kill(lockOwner, 0); throw new Error('Snapshot is already being prepared'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; fs.unlinkSync(lock); }
    }
    const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid));
    try {
        const ledger = adapters.ledger || path.resolve('data/runtime/campaign-early');
        const previous = fs.existsSync(ledger) ? fs.readdirSync(ledger).filter((n: string) => n.endsWith('.json'))
            .map((n: string) => JSON.parse(fs.readFileSync(path.join(ledger, n), 'utf8'))) : [];
        const reserved = previous.find((claim: any) => claim.snapshotKey === key);
        if (reserved?.queueReceipt || reserved?.completedAt) return { status: 'already_reserved', id: reserved.id, ...reserved.queueReceipt, mediaPath: reserved.mediaPath };
        let batch: any;
        if (fs.existsSync(manifest)) {
            batch = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            for (const prefix of batch.prefixReservations) coverage.resolveRecordingPrefix(prefix);
            for (const source of batch.sources) {
                if (coverage.recordingIdentity(source.videoPath) !== source.identity
                    || coverage.recordingIdentity(source.xmlPath) !== source.xmlIdentity) throw new Error('Saved snapshot changed');
            }
        } else {
            // Do not take an alternate snapshot of material already admitted by finalization/title switch.
            const originalIdentities = new Set(sources.map((s: any) => coverage.recordingIdentity(s.videoPath)));
            if (previous.some((c: any) => c.sources.some((s: any) => originalIdentities.has(s.identity)))) throw new Error('Snapshot sources already reserved by another campaign job');
            const probe = adapters.duration || ((file: string, lastTimestamp: number) => snapshotDuration(file, lastTimestamp,
                localRequire('./src/scripts/clipping/media_runtime').resolveFfprobePath(config.audio?.ffmpeg?.path || 'ffmpeg')));
            const captured = [], prefixes: RecordingPrefix[] = [];
            for (const source of sources) {
                // An interrupted partial preparation is never reused as verified input.
                const attempt = fs.mkdtempSync(path.join(directory, 'part-'));
                const videoPath = path.join(attempt, path.basename(source.videoPath)), xmlPath = videoPath.replace(/\.flv$/u, '.xml');
                const prefix = snapshot.snapshotFlv(source.videoPath, videoPath), duration = await probe(videoPath, prefix.lastTimestamp);
                if (!(duration > 0 && Number.isFinite(duration))) throw new Error('Invalid snapshot duration');
                await snapshot.snapshotDanmaku(source.xmlPath, xmlPath, duration);
                captured.push({ ...source, videoPath, xmlPath, snapshot: true, identity: coverage.recordingIdentity(videoPath), xmlIdentity: coverage.recordingIdentity(xmlPath) });
                prefixes.push({ originalPath: source.videoPath, ...prefix, duration });
            }
            batch = { campaignId: campaign.id, roomId: room, day: latest.day, sources: captured,
                sourceDirectory: path.dirname(latest.videoPath),
                snapshotKey: key, snapshotNote: note.trim(), prefixReservations: prefixes, capturedAt: new Date().toISOString() };
            coverage.atomicRecordingJson(manifest, batch);
        }
        return early.admitEarlyBatch(batch, adapters.enqueue, ledger);
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
