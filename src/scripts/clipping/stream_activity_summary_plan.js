'use strict';
const fs = require('fs');
const { sourceSnapshot, fileDigest } = require('./source_snapshot');
const { probeMediaDuration } = require('./video_probe');
const { resolveFfprobePath } = require('./media_runtime');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { prepareActivityTranscript } = require('./stream_activity_transcript');
const { getActivitySummary } = require('./stream_activity_summary');
const { calibrateBoundaries } = require('./stream_activity_boundaries');
const p = require('./stream_activity_plan');
const stages = require('../workflow-runtime').loadWorkflow('clipping/activityStages');
const digest = plan => p.sha({ events: plan.events, parts: plan.parts, coverage: plan.coverage,
    rejectedActivities: plan.rejectedActivities || [], ...(plan.calibratedKinds ? { calibratedKinds: plan.calibratedKinds, rawEvents: plan.rawEvents } : {}),
    ...(plan.verificationSignature ? { verificationSignature: plan.verificationSignature, verificationSettings: plan.verificationSettings,
        boundaryBudget: plan.boundaryBudget, verifierRevisions: plan.verifierRevisions } : {}),
    ...(plan.timingSignature ? { timingSignature: plan.timingSignature, timingRevisions: plan.timingRevisions } : {}) });

async function detectSummaryActivities(options, config, source, info, files, audience) {
    const started = Date.now();
    const previous = fs.existsSync(files.plan) ? JSON.parse(fs.readFileSync(files.plan, 'utf8')) : null;
    if (previous && previous.contentSha256 !== digest(previous)) throw new Error('Activity plan changed outside the reviewed workflow');
    const duration = await (options.probe || probeMediaDuration)(options.mediaPath, resolveFfprobePath(options.config.audio?.ffmpeg?.path || 'ffmpeg'));
    let plan = { version: p.VERSION, type: 'sui_stream_activity_plan', status: 'awaiting_summary', sessionId: p.sha(source),
        ...info, source, duration, events: [], coverage: { status: 'incomplete', duration, windows: [] }, diagnostics: { requests: [] } };
    const selected = stages.activityKinds(options.kind).filter(kind => config[kind].enabled);
    const save = () => { plan.contentSha256 = digest(plan); writeJsonAtomic(files.plan, plan); writeJsonAtomic(files.songs, p.songRecord(plan)); };
    try {
        plan.transcript = options.transcriptRecordPath
            ? require('./stream_activity_transcript').readTimingTranscript(options.transcriptRecordPath, source, options.config, true)
            : await (options.prepareTranscript || prepareActivityTranscript)({ source, root: options.config, directory: require('path').dirname(source.mediaPath),
                duration, reuseOnly: true, speakerEvidence: true });
        const summary = await getActivitySummary({ options, source, transcript: plan.transcript, info, directory: files.directory, duration, audience });
        plan.summary = { path: summary.summaryPath, sha256: summary.sha256, sourceSha256: summary.context.sourceSha256,
            timelineVersion: summary.timeline.version, reused: summary.reused };
        const signatureFor = verification => p.sha({ version: p.VERSION, source, transcript: plan.transcript, summarySha256: summary.sha256,
            verification, parts: { songs: config.songs.enabled, padding: config.songs.paddingSeconds,
                watch: config.watch.enabled, target: config.watch.targetPartSeconds, max: config.watch.maxPartSeconds,
                ...(config.watch.blackAlignment?.enabled ? { blackAlignment: config.watch.blackAlignment } : {}) } });
        plan.signature = signatureFor(config.verification);
        plan.verificationSettings = config.verification;
        const currentSignature = previous?.timingSignature || previous?.verificationSignature || previous?.signature;
        if (options.timingRevision) {
            plan = stages.activityTimingRevision(previous, plan, options.timingRevision);
        } else if (options.reviseVerifier) {
            const oldSettings = previous?.verificationSettings || p.LEGACY_NATIVE_VERIFICATION;
            if (!previous?.uploadManifestPath || !options.boundaryRetry || currentSignature !== signatureFor(oldSettings)
                || currentSignature === plan.signature || previous.verifierRevisions?.some(r => r.toSignature === plan.signature)) {
                throw Object.assign(new Error('Verifier revision must change only a pending, source-bound route once; source, summary and parts must match'), { preserveActivityPlan: true });
            }
            const nextSignature = plan.signature;
            plan = { ...previous, verificationSignature: nextSignature, verificationSettings: config.verification,
                boundaryBudget: { limit: (previous.boundaryBudget?.limit || config.verification.maxBatchRequests) + config.verification.maxBatchRequests },
                verifierRevisions: [...(previous.verifierRevisions || []), { id: options.boundaryRetry.id, kind: options.kind,
                    note: options.revisionNote, fromSignature: currentSignature, toSignature: nextSignature, fromSettings: oldSettings,
                    toSettings: config.verification, spentRequests: previous.efficiency?.boundaryRequests || 0,
                    additionalRequests: config.verification.maxBatchRequests, createdAt: new Date().toISOString() }] };
        } else if (previous?.uploadManifestPath && currentSignature !== plan.signature) {
            throw Object.assign(new Error('Rendered activity plan parameters or shared summary changed; use an explicit reviewed revision'), { preserveActivityPlan: true });
        }
        if (fs.existsSync(files.plan)) {
            const old = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
            if (!options.timingRevision && !options.reviseVerifier && (old.timingSignature || old.verificationSignature || old.signature) === plan.signature) {
                if (JSON.stringify(old.source) !== JSON.stringify(source)) {
                    throw Object.assign(new Error('Activity plan source differs from its signature'), { preserveActivityPlan: true });
                }
                if (old.contentSha256 !== digest(old)) throw new Error('Activity plan changed outside the reviewed workflow');
                if (!options.retryBoundaries && !stages.pendingKinds(old, selected).length) return old;
                plan = old;
            }
        }
        const pending = options.retryBoundaries ? selected : stages.pendingKinds(plan, selected);
        plan.calibratedKinds = stages.calibratedKinds(plan);
        plan.rawEvents ||= summary.timeline.events;
        if (plan.rawEvents.some(e => e.end > duration + .01)) throw new Error('Summary activity exceeds the source recording duration');
        plan.coverage = { status: 'complete', duration, method: 'summary_shared_input',
            windows: [{ start: 0, end: duration, status: 'inspected', evidenceRows: summary.rows.length }] };
        const retryEvents = options.retryBoundaries ? stages.retryBoundaryEvents(plan.rawEvents, plan.events, pending, plan.rejectedActivities || [], options.boundaryFeedback) : null;
        const retriedIds = retryEvents?.map(event => event.id);
        plan.status = 'verifying'; save();
        const candidates = retryEvents || stages.selectEvents(plan.rawEvents, pending);
        const checked = !candidates.length ? { events: [], rejected: [], requests: 0, cacheHits: 0, audioSeconds: 0 }
            : await (options.calibrate || calibrateBoundaries)(candidates, { config, root: options.config, source,
            transcriptSha256: plan.transcript.sha256, info, directory: files.directory, rows: summary.rows, duration,
            diagnostics: plan.diagnostics, request: options.boundaryRequest, extract: options.extractBoundary,
            usedRequests: plan.efficiency?.boundaryRequests || 0, retryId: options.boundaryRetry?.id,
            maxRequests: plan.boundaryBudget?.limit, localDecode: options.localDecode, reviewPrelude: options.reviewPrelude, reviewAudio: options.reviewAudio,
            reusableEvidence: plan.events?.map(event => event.verification).filter(Boolean), contextEvents: [...plan.rawEvents, ...plan.events] });
        if (plan.transcript.timingReliable === false) for (const event of checked.events) event.reviewIssues.push('source_transcript_timing_unreliable');
        plan.events = p.mergeEvents(retriedIds ? stages.replaceRetriedEvents(plan.events, checked.events, retriedIds)
            : stages.combineEvents(plan.events, checked.events, pending), true);
        plan.rejectedActivities = retriedIds ? stages.replaceRetriedEvents(plan.rejectedActivities || [], checked.rejected, retriedIds)
            : stages.combineEvents(plan.rejectedActivities || [], checked.rejected, pending);
        for (let i = 1; i < plan.events.length; i++) {
            const a = plan.events[i - 1], b = plan.events[i];
            if (a.end > b.start) { a.reviewIssues.push('overlapping_activity'); b.reviewIssues.push('overlapping_activity'); }
        }
        const parts = p.buildParts(plan.events, duration, config);
        if (options.retryBoundaries && pending.includes('watch')) {
            parts.watch = require('../workflow-runtime').loadWorkflow('clipping/activityRecovery')
                .retainWatchPartBoundaries(parts.watch, plan.parts?.watch || [], config.watch.targetPartSeconds, config.watch.maxPartSeconds);
        }
        if (pending.includes('watch') && config.watch.blackAlignment?.enabled && (!options.retryBoundaries || !previous?.uploadManifestPath)) {
            parts.watch = await require('../workflow-runtime').loadWorkflow('clipping/watchBlackRuntime').applyWatchBlack(parts.watch,
                { ...options, blackScanRun: options.blackScanRun || require('./media_runtime').runFfmpeg }, config, source, files.directory);
        }
        plan.parts ||= { songs: [], watch: [] };
        for (const kind of pending) plan.parts[kind] = parts[kind];
        const current = sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } });
        if (JSON.stringify(current) !== JSON.stringify(source) || fileDigest(plan.transcript.path) !== plan.transcript.sha256
            || fileDigest(summary.summaryPath) !== summary.sha256) throw new Error('Activity source or shared summary changed during calibration');
        plan.efficiency = { detection: 'summary', summaryReused: summary.reused, fullScanRequests: 0, wholeRecordingAsrRuns: 0,
            boundaryRequests: (plan.efficiency?.boundaryRequests || 0) + checked.requests,
            boundaryCacheHits: (plan.efficiency?.boundaryCacheHits || 0) + checked.cacheHits,
            boundaryAudioSeconds: (plan.efficiency?.boundaryAudioSeconds || 0) + checked.audioSeconds,
            maxBoundaryRequests: plan.boundaryBudget?.limit || config.verification.maxBatchRequests, elapsedMs: (plan.efficiency?.elapsedMs || 0) + Date.now() - started };
        plan.calibratedKinds = stages.completeKinds(plan, pending);
        if (options.boundaryRetry) plan.boundaryRetry = options.boundaryRetry;
        delete plan.error;
        plan.status = 'planned'; plan.finishedAt = new Date().toISOString(); save(); return plan;
    } catch (error) {
        if (error.preserveActivityPlan) throw error;
        if (previous && !plan.calibratedKinds && JSON.stringify(previous.source) === JSON.stringify(source)) plan = previous;
        if (plan.calibratedKinds || ['planned', 'rendered'].includes(plan.status)) plan.calibratedKinds = stages.calibratedKinds(plan);
        plan.status = 'failed'; plan.error = error.message; save(); throw error;
    }
}
module.exports = { digest, detectSummaryActivities };
