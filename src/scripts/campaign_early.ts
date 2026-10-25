import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const localRequire = createRequire(path.resolve('package.json'));
const coverage = localRequire('./src/core/media/RecordingCoverage.ts');
const policy = localRequire('./src/core/media/CampaignEarlyPolicy.ts');
const ledger = path.resolve('data/runtime/campaign-early');

export function discoverCampaignRecordings(config: any, dates: string[]): any[] {
    const root = config.webhook?.endpoints?.mikufans?.basePath || config.storage?.basePath;
    if (!root || !fs.existsSync(root)) throw new Error('Campaign recording root unavailable');
    const rooms = new Set((config.ownStreamClips?.campaigns || []).filter((c: any) => c.enabled).flatMap((c: any) => c.roomIds.map(String)));
    const rows: any[] = [];
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory() || !rooms.has(dir.name.split('_')[0])) continue;
        for (const date of dates) {
            const directory = path.join(root, dir.name, date);
            if (!fs.existsSync(directory)) continue;
            for (const name of fs.readdirSync(directory)) {
                const file = path.join(directory, name), parsed = policy.parseCampaignRecording(file, name);
                if (!parsed) continue;
                const stat = fs.statSync(file), xmlPath = file.replace(/\.flv$/u, '.xml');
                rows.push({ ...parsed, xmlPath, size: stat.size, modifiedAt: stat.mtimeMs, xmlExists: fs.existsSync(xmlPath) });
            }
        }
    }
    return rows;
}

export function admitEarlyBatch(batch: any, enqueue = (payload: any) => localRequire('./src/scripts/background_clip_support').spawnBackgroundClipProcess(payload), ledgerRoot = ledger): any {
    return coverage.withRecordingAdmissionLock(ledgerRoot, () => {
        const sources = batch.sources.map((source: any) => ({ ...source, identity: coverage.recordingIdentity(source.videoPath) }));
        const id = createHash('sha256').update(JSON.stringify([batch.campaignId, batch.roomId, sources.map((s: any) => s.identity)])).digest('hex').slice(0, 20);
        const claimPath = path.join(ledgerRoot, `${id}.json`);
        for (const file of fs.readdirSync(ledgerRoot).filter(name => name.endsWith('.json') && name !== `${id}.json`)) {
            const previous = JSON.parse(fs.readFileSync(path.join(ledgerRoot, file), 'utf8'));
            if (previous.sources.some((old: any) => sources.some((source: any) => source.identity === old.identity))) {
                return { status: 'already_reserved', id: previous.id, mediaPath: previous.mediaPath };
            }
        }
        const directory = path.join(path.dirname(sources[0].videoPath), 'campaign_early', id);
        fs.mkdirSync(directory, { recursive: true });
        const mediaPath = path.join(directory, path.basename(sources[0].videoPath));
        const claim = { version: 1, id, campaignId: batch.campaignId, roomId: batch.roomId, day: batch.day,
            mediaPath, sources, transitionAt: batch.transitionAt, admittedAt: new Date().toISOString() };
        if (!fs.existsSync(claimPath)) coverage.atomicRecordingJson(claimPath, claim);
        const saved = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
        if (saved.queueReceipt || saved.completedAt) return { status: 'already_reserved', id, mediaPath, ...saved.queueReceipt };
        const receipt = enqueue({ originalMediaPath: mediaPath, roomId: batch.roomId,
            earlyCampaign: { id, claimPath }, videoPathToDelete: null });
        coverage.atomicRecordingJson(claimPath, { ...JSON.parse(fs.readFileSync(claimPath, 'utf8')),
            queueReceipt: { jobId: receipt.jobId, queued: receipt.queued } });
        return { ...receipt, id, status: receipt.reused ? 'already_reserved' : 'queued' };
    });
}

/** Executed only by the existing serialized background media worker. */
export async function runEarlyCampaign(payload: any, adapters: any = {}): Promise<void> {
    const claim = JSON.parse(fs.readFileSync(payload.earlyCampaign.claimPath, 'utf8'));
    if (claim.id !== payload.earlyCampaign.id || path.resolve(claim.mediaPath) !== path.resolve(payload.originalMediaPath)) throw new Error('Campaign claim mismatch');
    const config = localRequire('./src/scripts/config-loader').getConfig();
    const active = config.ownStreamClips?.campaigns?.find((campaign: any) => campaign.id === claim.campaignId && campaign.enabled && campaign.roomIds.map(String).includes(claim.roomId));
    if (!active || Date.now() >= Date.parse(active.endsAt)) throw new Error('Campaign expired or room disabled');
    const media = claim.mediaPath, xml = media.replace(/\.flv$/u, '.xml');
    if (!fs.existsSync(`${media}.sources.json`) || !fs.existsSync(xml)) {
        const Merger = adapters.FileMerger || localRequire('./dist/services/webhook/FileMerger').FileMerger;
        const merger = new Merger();
        const segments = claim.sources.map((source: any) => {
            const resolved = fs.existsSync(source.videoPath) ? source.videoPath : path.join(path.dirname(source.videoPath), 'bak', path.basename(source.videoPath));
            if (coverage.recordingIdentity(resolved) !== source.identity || Date.now() - fs.statSync(resolved).mtimeMs < 90000) throw new Error('Campaign source changed or still active');
            const xmlPath = fs.existsSync(source.xmlPath) ? source.xmlPath : path.join(path.dirname(source.xmlPath), 'bak', path.basename(source.xmlPath));
            const opened = new Date(source.startedAt);
            // Early snapshots concatenate without synthetic reconnect gaps, including XML.
            return { videoPath: resolved, xmlPath, fileOpenTime: opened, fileCloseTime: opened, eventTimestamp: opened };
        });
        await merger.mergeVideos(segments, media, { fillGaps: false });
        await coverage.writeRecordingMap(segments.map((s: any) => s.videoPath), media,
            (file: string) => merger.getVideoDuration(file), () => 0);
        // mergeDanmaku has the historical fill-gap policy; equal clocks disable gaps here.
        for (const segment of segments) { segment.fileOpenTime = new Date(0); segment.fileCloseTime = new Date(0); }
        await merger.mergeXmlFiles(segments, xml);
    }
    coverage.readRecordingMap(media);
    const asr = adapters.processMedia || localRequire('./src/scripts/enhanced_auto_summary').processMedia;
    const result = await asr(media, null, { bypassQueueTurn: true, asrContext: { roomId: claim.roomId, room_id: claim.roomId, sourceMediaPath: media, xmlPath: xml } });
    if (!result?.srtPath || !fs.existsSync(result.srtPath)) throw new Error('Early campaign ASR did not produce subtitles');
    const run = adapters.generateOwn || localRequire('./src/scripts/background_clip_support').generateOwnStreamClipsForMedia;
    await run(media, result.srtPath, xml, claim.roomId, { roomId: claim.roomId, earlyCampaign: claim.id });
    coverage.atomicRecordingJson(payload.earlyCampaign.claimPath,
        { ...JSON.parse(fs.readFileSync(payload.earlyCampaign.claimPath, 'utf8')), completedAt: new Date().toISOString() });
}
