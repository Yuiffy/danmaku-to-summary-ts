import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const localRequire = createRequire(path.resolve(process.env.DANMAKU_PROJECT_ROOT || '.', 'package.json'));
const { atomicRecordingJson } = localRequire('./src/core/media/RecordingCoverage.ts');

/** Keep the original job/payload identities and stage receipts; never approve or rebuild uploaded clips. */
export function retryFailedBackgroundJob(directory: string, jobId: string, note: string): Record<string, any> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(jobId) || !note.trim()) throw new Error('A valid job ID and recovery note are required');
    const failed = path.join(directory, `${jobId}.failed.json`), pending = path.join(directory, `${jobId}.pending.json`);
    const locked = path.join(directory, `${jobId}.recovering.json`);
    if (fs.existsSync(pending) || fs.existsSync(path.join(directory, `${jobId}.working.json`))
        || fs.existsSync(path.join(directory, `${jobId}.done.json`))) throw new Error('Job is already active or completed');
    fs.renameSync(failed, locked);
    try {
        const entry = JSON.parse(fs.readFileSync(locked, 'utf8'));
        if (entry.jobId !== jobId || entry.status !== 'failed' || !fs.existsSync(entry.payloadPath)) throw new Error('Failed job or payload is invalid');
        const progress = `${entry.payloadPath}.progress.json`;
        if (fs.existsSync(progress) && JSON.parse(fs.readFileSync(progress, 'utf8')).status === 'completed') {
            throw new Error('Payload has already completed; inspect the old queue receipt');
        }
        const recoveredAt = new Date().toISOString();
        const history = { attempts: entry.attempts, lastError: entry.lastError, updatedAt: entry.updatedAt, recoveredAt, note };
        atomicRecordingJson(path.join(directory, 'recovery-history', `${jobId}-${Date.now()}.json`), entry);
        const next = { ...entry, attempts: 0, status: 'pending', nextAttemptAt: 0, updatedAt: recoveredAt,
            recoveryHistory: [...(entry.recoveryHistory || []), history] };
        delete next.lastError;
        atomicRecordingJson(pending, next);
        fs.unlinkSync(locked);
        return next;
    } catch (error) {
        if (fs.existsSync(locked) && !fs.existsSync(pending)) fs.renameSync(locked, failed);
        throw error;
    }
}

/** Revisit only an evidenced false skip, leaving all successful non-own stages intact. */
export function recheckSkippedCampaignJob(directory: string, jobId: string, note: string,
    admitsCurrentSource: (payload: Record<string, any>) => boolean): Record<string, any> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(jobId) || !note.trim()) throw new Error('A valid job ID and recovery note are required');
    const done = path.join(directory, `${jobId}.done.json`), locked = path.join(directory, `${jobId}.recovering.json`);
    const pending = path.join(directory, `${jobId}.pending.json`);
    if (fs.existsSync(pending) || fs.existsSync(path.join(directory, `${jobId}.working.json`))) throw new Error('Job is already active');
    fs.renameSync(done, locked);
    let originalProgress: string | undefined, progressPath: string | undefined;
    try {
        const entry = JSON.parse(fs.readFileSync(locked, 'utf8'));
        if (entry.jobId !== jobId) throw new Error('Completed job identity is invalid');
        const payload = JSON.parse(fs.readFileSync(entry.payloadPath, 'utf8'));
        progressPath = `${entry.payloadPath}.progress.json`;
        originalProgress = fs.readFileSync(progressPath, 'utf8');
        const progress = JSON.parse(originalProgress);
        if (payload.activityOptions || payload.earlyCampaign || progress.completed?.recordingJob
            || progress.status !== 'completed' || !Array.isArray(progress.completed?.own) || progress.completed.own.length !== 0) {
            throw new Error('Recheck requires a completed empty own stage, not rendered or managed jobs');
        }
        const media = payload.originalMediaPath || payload.processedMediaPath;
        if (!media || !fs.statSync(media).isFile() || !admitsCurrentSource(payload)) {
            throw new Error('Current campaign evidence does not admit this recording');
        }
        const recoveredAt = new Date().toISOString(), history = { recoveredAt, note, kind: 'campaign-content-recheck' };
        atomicRecordingJson(path.join(directory, 'recovery-history', `${jobId}-${Date.now()}.json`), { entry, progress });
        delete progress.completed.own;
        delete progress.lastError;
        Object.assign(progress, { status: 'pending', stage: 'own', updatedAt: recoveredAt,
            recoveryHistory: [...(progress.recoveryHistory || []), history] });
        const next = { ...entry, status: 'pending', attempts: 0, nextAttemptAt: 0, updatedAt: recoveredAt,
            recoveryHistory: [...(entry.recoveryHistory || []), history] };
        delete next.lastError;
        atomicRecordingJson(progressPath, progress);
        atomicRecordingJson(pending, next);
        fs.unlinkSync(locked);
        return next;
    } catch (error) {
        if (!fs.existsSync(pending)) {
            if (originalProgress !== undefined && progressPath) atomicRecordingJson(progressPath, JSON.parse(originalProgress));
            if (fs.existsSync(locked)) fs.renameSync(locked, done);
        }
        throw error;
    }
}

export function runBackgroundRecovery(args: string[]): void {
    if (!process.env.NODE_ENV && !process.env.CONFIG_PATH) Object.assign(process.env, { NODE_ENV: 'production' });
    const raw = localRequire('./src/scripts/config-loader').getConfig();
    const queue = localRequire('./src/scripts/background_clip_queue');
    const config = localRequire('./src/scripts/background_clip_runner').getBackgroundClipQueueConfig(raw);
    const directory = queue.getQueueConfig(config).directory;
    const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    if (args[0] === 'retry' || args[0] === 'recheck-campaign') {
        const ids = option('--ids')?.split(',').filter(Boolean) || [];
        if (!ids.length) throw new Error('retry requires --ids and --note');
        const admitsCurrentSource = (payload: Record<string, any>) => {
            const own = localRequire('./src/scripts/own_stream_clipper');
            const mediaPath = payload.originalMediaPath || payload.processedMediaPath;
            const info = own.parseRecordingInfo(mediaPath, { ...payload.context, roomId: payload.roomId });
            const settings = own.getOwnStreamClipsConfig(raw, payload.roomId, info.recordedAt);
            if (!settings.enabled || !settings.campaignContentGate) return false;
            return localRequire('./src/scripts/workflow-runtime').loadWorkflow('clipping/ownCampaign')
                .checkCampaignContent(settings, { ...payload, mediaPath }).allowed;
        };
        for (const id of ids) console.log(JSON.stringify(args[0] === 'retry'
            ? retryFailedBackgroundJob(directory, id, option('--note') || '')
            : recheckSkippedCampaignJob(directory, id, option('--note') || '', admitsCurrentSource)));
        return;
    }
    if (args.length && args[0] !== 'list') throw new Error('Usage: background_clip_recovery.ts list | retry/recheck-campaign --ids <job,...> --note <reason>');
    for (const name of fs.readdirSync(directory).filter((name: string) => name.endsWith('.failed.json'))) {
        const entry = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        console.log(JSON.stringify({ jobId: entry.jobId, roomId: entry.roomId, attempts: entry.attempts, lastError: entry.lastError, payloadPath: entry.payloadPath }));
    }
}

if (/background_clip_recovery\.(?:ts|js)$/u.test(path.basename(process.argv[1] || ''))) {
    try { runBackgroundRecovery(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
