'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSubtitleEvidence, parseClipResponse } = require('./subtitle_evidence');
const { chronologicalResults } = require('./own_review_report');

function prepareReviewResults(results, plan, parsed, outputRoot) {
    const topic = require('../topic_clipper');
    const evidence = buildSubtitleEvidence(parsed.segments);
    const rejected = [...(plan.aiStatus?.validation?.rejected || []), ...(plan.aiStatus?.rejectedAfterAlignment || [])];
    const requestId = plan.aiStatus?.requests?.find(request => request.phase === 'global-rerank')?.requestId;
    if (requestId && rejected.some(item => !item.title)) {
        for (const directory of [path.join(outputRoot, '.selection-cache'), path.join(outputRoot, '.selection-cache/.attempt-outcomes')]) {
            if (!fs.existsSync(directory)) continue;
            for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
                try {
                    const cached = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).result;
                    const ids = [cached?.meta?.requestId, ...(cached?.meta?.attempts || []).map(attempt => attempt.requestId)];
                    if (!ids.includes(requestId)) continue;
                    const clips = parseClipResponse(cached.text);
                    for (const item of rejected) {
                        const original = clips.find(clip => String(clip.candidateIndex) === String(item.candidateIndex)
                            && clip.startCueId === item.startCueId && clip.endCueId === item.endCueId);
                        if (original && !item.title) { item.title = original.title; item.score = original.score; }
                    }
                } catch { /* A corrupt/unrelated cache entry is not recovery evidence. */ }
            }
        }
    }
    const held = rejected.map(rejection => {
        const source = plan.source || {};
        const key = crypto.createHash('sha256').update(JSON.stringify({
            source: source.mediaPath, candidateIndex: rejection.candidateIndex, reason: rejection.reason,
            startCueId: rejection.startCueId, endCueId: rejection.endCueId,
            startTime: rejection.startTime, endTime: rejection.endTime
        })).digest('hex').slice(0, 20);
        const directory = path.join(outputRoot, 'rejected_candidates');
        const metadataPath = path.join(directory, `rejected-${key}.json`);
        if (fs.existsSync(metadataPath)) {
            const existing = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (!existing.selectionSource) {
                existing.selectionSource = rejection.selectionSource || 'model_global_rerank';
                fs.writeFileSync(metadataPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
            }
            return existing;
        }
        const start = Number.isFinite(rejection.start) ? rejection.start : evidence.byId.get(rejection.startCueId)?.start;
        const end = Number.isFinite(rejection.end) ? rejection.end : evidence.byId.get(rejection.endCueId)?.end;
        const validWindow = Number.isFinite(start) && Number.isFinite(end) && end > start;
        const index = parseInt(key.slice(0, 8), 16) + 1000000;
        const window = { index, start: start ?? null, end: end ?? null, duration: validWindow ? end - start : null };
        fs.mkdirSync(directory, { recursive: true });
        const srtPath = validWindow ? path.join(directory, `rejected-${key}.srt`) : null;
        if (srtPath) topic.writeClipSrt(parsed.segments, window, srtPath);
        const metadata = {
            version: 1, mode: 'own_stream_fun_review', status: 'selection_rejected', reviewIndex: index,
            generatedAt: new Date().toISOString(), source, window,
            selectionSource: rejection.selectionSource || 'model_global_rerank',
            copy: { title: rejection.title || `\u88ab\u5254\u9664\u5019\u9009 ${rejection.candidateIndex ?? rejection.index ?? '?'}`, description: '', coverText: '' },
            recommendationScore: rejection.score ?? null, publicCopyPending: true, uploadReady: false,
            selectionRejection: { minClipSeconds: plan.config?.minClipSeconds, maxClipSeconds: plan.config?.maxClipSeconds,
                ...rejection, sourceSha256: evidence.sourceSha256 },
            grounding: { sourceSha256: evidence.sourceSha256, issues: [`selection_rejected:${rejection.reason}`],
                subtitles: validWindow ? evidence.cues.filter(cue => cue.start >= start && cue.end <= end).slice(0, 3)
                    .map(({ id, start, end, text }) => ({ id, start, end, text })) : [] },
            output: { metadataPath, mediaPath: null, srtPath, coverPath: null, burnedSubtitles: false }
        };
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        return metadata;
    });
    return chronologicalResults([...results, ...held]);
}

function saveReviewState(reviewPath, results, metadata) {
    const own = require('../own_stream_clipper');
    fs.writeFileSync(reviewPath, own.buildReviewMarkdown(results, metadata), 'utf8');
    fs.writeFileSync(reviewPath.replace(/\.md$/i, '_STATE.json'), `${JSON.stringify({
        version: 1, type: 'own_stream_review_state', metadata,
        entries: results.map(result => ({ reviewIndex: result.reviewIndex ?? result.window?.index,
            metadataPath: result.output.metadataPath }))
    }, null, 2)}\n`, 'utf8');
}

async function refreshReviewUnlocked(planPath, options = {}) {
    const own = require('../own_stream_clipper');
    const topic = require('../topic_clipper');
    planPath = path.resolve(planPath);
    const outputRoot = path.dirname(planPath);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const inputBase = path.basename(planPath) === 'PLAN.json' ? '' : path.basename(planPath).replace(/_ALIGNED\.json$/i, '');
    if (inputBase && !/_ALIGNED\.json$/i.test(planPath)) throw new Error('Use the generated PLAN.json or *_ALIGNED.json');
    const reviewPath = path.join(outputRoot, inputBase ? `REVIEW_${inputBase}.md` : 'REVIEW.md');
    const manifestPath = path.join(outputRoot, inputBase ? `${inputBase}_UPLOAD_MANIFEST.json` : 'UPLOAD_MANIFEST.json');
    const statePath = reviewPath.replace(/\.md$/i, '_STATE.json');
    const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    const metadataFiles = previous?.entries?.map(entry => entry.metadataPath)
        || fs.readdirSync(outputRoot).filter(name => /_fun_.*\.json$/i.test(name)).map(name => path.join(outputRoot, name));
    const results = metadataFiles.map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
        .filter(result => !result.selectionRejection && !result.originalSelectionRejection
            && path.resolve(result.source?.mediaPath || '.') === path.resolve(plan.source.mediaPath));
    const byIndex = new Map();
    for (const result of results) {
        const index = result.reviewIndex ?? result.window.index;
        if (byIndex.has(index)) throw new Error(`Ambiguous saved clip metadata for review index ${index}`);
        byIndex.set(index, result);
    }
    if (results.length !== plan.clips.length) throw new Error(`Expected ${plan.clips.length} saved clip records; found ${results.length}. Refusing to rerender automatically.`);
    const parsed = topic.parseTopicSrt(plan.source.srtPath);
    const all = prepareReviewResults(results, plan, parsed, outputRoot);
    const first = results[0] || {};
    const starts = results.map(result => Date.parse(result.processing?.startedAt)).filter(Number.isFinite);
    const ends = results.map(result => Date.parse(result.processing?.finishedAt)).filter(Number.isFinite);
    const metadata = { ...(previous?.metadata || {}),
        roomId: first.roomId, streamerName: first.streamerName, recordedAt: first.recordedAt,
        streamTitle: first.streamTitle, sourceFileName: path.basename(plan.source.mediaPath),
        source: plan.source, outputRoot, reviewPath, planPath, uploadManifestPath: manifestPath,
        aiStatus: plan.aiStatus,
        ...(plan.precisionExperiment ? { precisionExperiment: plan.precisionExperiment } : {}),
        ...(starts.length && ends.length ? { processingStats: own.buildClipProcessingStats(results,
            Math.max(...ends) - Math.min(...starts), new Date(Math.min(...starts)).toISOString(), new Date(Math.max(...ends)).toISOString()) } : {})
    };
    delete metadata.registrationError;
    const registered = own.registerReviewForUpload(reviewPath, all, metadata);
    if (!registered || registered.clipIds.length !== all.length) throw new Error(metadata.registrationError || 'Incomplete ID registration');
    metadata.uploadRegistry = registered;
    saveReviewState(reviewPath, all, metadata);
    const notification = own.buildNotifyMarkdown(all, metadata);
    const detail = metadata.precisionExperiment || all.some(result => result.precisionExperiment?.selected)
        ? require('../workflow-runtime').loadWorkflow('clipping/experiment').experimentDetailMarkdown(all, metadata) : null;
    const digest = crypto.createHash('sha256').update(detail ? JSON.stringify([notification, detail]) : notification).digest('hex');
    const receiptPath = reviewPath.replace(/\.md$/i, '_NOTIFICATION.json');
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    let notified = false;
    if (options.notify && receipt?.status === 'sending') throw new Error('Previous notification outcome is unresolved; inspect before resending');
    if (options.notify && (receipt?.status !== 'sent' || receipt?.digest !== digest)) {
        fs.writeFileSync(receiptPath, JSON.stringify({ status: 'sending', digest, startedAt: new Date().toISOString() }, null, 2));
        notified = await own.notifyResults(all, metadata, options.config || require('../config-loader').getConfig());
        fs.writeFileSync(receiptPath, JSON.stringify({ status: notified ? 'sent' : 'disabled', digest, completedAt: new Date().toISOString() }, null, 2));
    }
    return { reviewPath, planPath, clipIds: registered.clipIds, totalEntries: all.length,
        rendered: all.filter(result => result.output?.mediaPath && !result.output?.mediaError).length,
        rejected: all.filter(result => result.selectionRejection).length, notified };
}

async function refreshReview(planPath, options = {}) {
    const lockPath = `${path.resolve(planPath)}.review.lock`;
    if (fs.existsSync(lockPath)) {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid review lock owner');
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') fs.unlinkSync(lockPath); else throw error; }
    }
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    try { return await refreshReviewUnlocked(planPath, options); }
    finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

module.exports = { prepareReviewResults, saveReviewState, refreshReview };
