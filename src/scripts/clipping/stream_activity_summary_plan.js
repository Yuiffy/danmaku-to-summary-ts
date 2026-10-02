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
const digest = plan => p.sha({ events: plan.events, parts: plan.parts, coverage: plan.coverage,
    rejectedActivities: plan.rejectedActivities || [] });

async function detectSummaryActivities(options, config, source, info, files, audience) {
    const started = Date.now();
    const duration = await (options.probe || probeMediaDuration)(options.mediaPath, resolveFfprobePath(options.config.audio?.ffmpeg?.path || 'ffmpeg'));
    const plan = { version: p.VERSION, type: 'sui_stream_activity_plan', status: 'awaiting_summary', sessionId: p.sha(source),
        ...info, source, duration, events: [], coverage: { status: 'incomplete', duration, windows: [] }, diagnostics: { requests: [] } };
    const save = () => { plan.contentSha256 = digest(plan); writeJsonAtomic(files.plan, plan); writeJsonAtomic(files.songs, p.songRecord(plan)); };
    try {
        plan.transcript = await (options.prepareTranscript || prepareActivityTranscript)({ source, root: options.config, directory: files.directory, duration, reuseOnly: true });
        const summary = await getActivitySummary({ options, source, transcript: plan.transcript, info, directory: files.directory, duration, audience });
        plan.summary = { path: summary.summaryPath, sha256: summary.sha256, sourceSha256: summary.context.sourceSha256,
            timelineVersion: summary.timeline.version, reused: summary.reused };
        plan.signature = p.sha({ version: p.VERSION, source, transcript: plan.transcript, summarySha256: summary.sha256,
            verification: config.verification, parts: { songs: config.songs.enabled, padding: config.songs.paddingSeconds,
                watch: config.watch.enabled, target: config.watch.targetPartSeconds, max: config.watch.maxPartSeconds } });
        if (fs.existsSync(files.plan)) {
            const old = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
            if (old.signature === plan.signature && ['planned', 'rendered'].includes(old.status)) {
                if (old.contentSha256 !== digest(old)) throw new Error('Activity plan changed outside the reviewed workflow');
                return old;
            }
        }
        plan.events = summary.timeline.events;
        if (plan.events.some(e => e.end > duration + .01)) throw new Error('Summary activity exceeds the source recording duration');
        plan.coverage = { status: 'complete', duration, method: 'summary_shared_input',
            windows: [{ start: 0, end: duration, status: 'inspected', evidenceRows: summary.rows.length }] };
        plan.status = 'verifying'; save();
        const checked = await (options.calibrate || calibrateBoundaries)(plan.events, { config, root: options.config, source,
            transcriptSha256: plan.transcript.sha256, info, directory: files.directory, rows: summary.rows, duration,
            diagnostics: plan.diagnostics, request: options.boundaryRequest, extract: options.extractBoundary });
        plan.events = p.mergeEvents(checked.events); plan.rejectedActivities = checked.rejected;
        if (plan.transcript.timingReliable === false) for (const event of plan.events) event.reviewIssues.push('source_transcript_timing_unreliable');
        for (let i = 1; i < plan.events.length; i++) {
            const a = plan.events[i - 1], b = plan.events[i];
            if (a.end > b.start) { a.reviewIssues.push('overlapping_activity'); b.reviewIssues.push('overlapping_activity'); }
        }
        plan.parts = p.buildParts(plan.events, duration, config);
        const current = sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } });
        if (JSON.stringify(current) !== JSON.stringify(source) || fileDigest(plan.transcript.path) !== plan.transcript.sha256
            || fileDigest(summary.summaryPath) !== summary.sha256) throw new Error('Activity source or shared summary changed during calibration');
        plan.efficiency = { detection: 'summary', summaryReused: summary.reused, fullScanRequests: 0, wholeRecordingAsrRuns: 0,
            boundaryRequests: checked.requests, boundaryCacheHits: checked.cacheHits, boundaryAudioSeconds: checked.audioSeconds,
            maxBoundaryRequests: config.verification.maxBatchRequests, elapsedMs: Date.now() - started };
        plan.status = 'planned'; plan.finishedAt = new Date().toISOString(); save(); return plan;
    } catch (error) { plan.status = 'failed'; plan.error = error.message; save(); throw error; }
}
module.exports = { digest, detectSummaryActivities };
