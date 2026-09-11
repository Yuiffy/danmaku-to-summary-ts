'use strict';

const fs = require('fs');
const path = require('path');
const topic = require('./topic_clipper');
const manual = require('./manual_clip_queue');
const configLoader = require('./config-loader');
const { buildPreflightEvidence } = require('./clipping/preflight_evidence');
const { ensureCandidateDraft, correctCandidateDraft, approveCandidateDraft, hasDraftApproval,
    candidateDraftEvidence, writeJsonAtomic } = require('./clipping/candidate_subtitles');
const { linkClipEvidence } = require('./clipping/subtitle_evidence');
const { topicReviewLines } = require('./clipping/topic_review_runner');
const { ensureCandidatePreview, syncPreviewSubtitles } = require('./clipping/candidate_preview');

function prepareCandidate(metadata, metadataPath, options, rootConfig) {
    if (!['pending_preflight', 'render_queued'].includes(metadata.status)) throw new Error('Not a pending preflight candidate');
    if (!String(options.reviewNote || '').trim()) throw new Error('A review note is required');
    if (metadata.source?.sourceKind !== 'video') throw new Error('Candidate requires a video recording');
    if (!Number.isSafeInteger(Number(options.candidateId)) || Number(options.candidateId) < 1) {
        throw new Error('A numeric candidate ID is required');
    }
    if (metadata.candidateId && Number(metadata.candidateId) !== Number(options.candidateId)) {
        throw new Error('Candidate ID does not match metadata');
    }
    const window = metadata.window;
    if (!Number.isFinite(window?.start) || !Number.isFinite(window?.end) || window.start < 0 || window.end <= window.start) {
        throw new Error('Invalid candidate boundaries');
    }
    const parsed = topic.parseTopicSrt(metadata.source.srtPath);
    const evidence = buildPreflightEvidence(parsed.segments);
    if (!metadata.aiReview?.sourceSha256 || evidence.sourceSha256 !== metadata.aiReview.sourceSha256) {
        throw new Error('Source evidence changed; rerun preflight before cutting');
    }
    const config = topic.getClipTopicsConfig(rootConfig);
    const draft = ensureCandidateDraft(metadata, metadataPath, evidence, config);
    const approved = hasDraftApproval(metadata, evidence, options.expectedSha256);
    if (options.requireApproval && !approved) throw new Error('Candidate subtitle revision lacks matching upload approval');
    if (metadata.aiReview.keyword?.status !== 'confirmed' && !approved) {
        throw new Error('Keyword identity still needs review; rerun preflight with verified evidence');
    }
    const remaining = (metadata.aiReview.quality?.issues || []).filter(issue => !/^unsupported_(quote|number):/.test(issue));
    if (remaining.length && !approved) throw new Error(`Preflight still blocked: ${remaining.join('; ')}`);
    const grounding = metadata.editorial?.copyGrounding;
    if (!grounding) throw new Error('Candidate has no linked source evidence');
    const corrected = candidateDraftEvidence(metadata, evidence);
    const copy = { ...metadata.copy };
    for (const field of ['title', 'description', 'coverText']) {
        if (options.requireApproval && options[field] !== undefined) throw new Error('Queued public copy cannot be overridden during rendering');
        if (options[field] !== undefined) copy[field] = String(options[field]).replace(/\\n/g, '\n').trim();
        if (!String(copy[field] || '').trim()) throw new Error(`Missing public copy: ${field}`);
    }
    const audience = [];
    for (const row of grounding.audience || []) audience[Number(row.id.slice(1)) - 1] = row;
    const reviewedGrounding = linkClipEvidence({ ...copy, sourceKind: grounding.sourceKind,
        evidenceCueIds: grounding.subtitleIds, evidenceDanmakuIds: grounding.danmakuIds }, window,
    corrected.evidence, audience, { cueIds: new Set(grounding.subtitleIds), danmakuIds: new Set(grounding.danmakuIds),
        referenceYear: Number(String(metadata.recordedAt || '').match(/^(\d{4})-/u)?.[1]) });
    if (reviewedGrounding.issues.length) throw new Error(`Public copy still needs review: ${reviewedGrounding.issues.join('; ')}`);
    const outputDir = path.dirname(metadataPath);
    const outputStem = path.basename(metadataPath, path.extname(metadataPath));
    const upload = metadata.upload;
    if (!upload?.prefix || !upload?.source || !upload.tags?.length) throw new Error('Candidate lacks upload identity');
    return {
        id: String(options.candidateId), mediaPath: metadata.source.mediaPath, srtPath: metadata.source.srtPath,
        start: window.start, end: window.end, ...copy, upload, outputDir, outputStem,
        reviewPath: path.join(outputDir, `${outputStem}_MANUAL_REVIEW.md`),
        roomId: metadata.roomId, streamerName: metadata.streamerName,
        recordedAt: metadata.recordedAt, streamTitle: metadata.streamTitle,
        subtitleSegments: corrected.segments,
        sourceMetadata: { ...metadata, candidateId: Number(options.candidateId), uploadId: Number(options.candidateId),
            humanReview: { reviewedAt: new Date().toISOString(), note: options.reviewNote.trim(),
                sourceSha256: evidence.sourceSha256, originalCopy: metadata.copy, copy,
                originalIssues: metadata.aiReview.quality?.issues || [],
                copyGrounding: reviewedGrounding, appliedSubtitleEdits: metadata.aiReview.subtitleEdits || [],
                userSubtitleEdits: draft.edits, subtitleApproval: approved ? draft.approval : null },
            aiReview: { ...metadata.aiReview, applied: true }, autoUploadEnabled: false }
    };
}

async function renderCandidate(metadataPath, options, rootConfig = configLoader.getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
        // Recover an interrupted registry import without overwriting completed media.
        if (metadata.mode === 'topic_candidate_manual_cut' && metadata.status === 'success'
            && Number(metadata.candidateId) === Number(options.candidateId) && fs.existsSync(metadata.output?.mediaPath || '')) {
            if (options.requireApproval && (metadata.candidateSubtitles?.approval?.sha256 !== options.expectedSha256
                || !metadata.output.burnedSubtitles || !fs.existsSync(metadata.output.srtPath || '')
                || !fs.existsSync(metadata.output.coverPath || ''))) throw new Error('Rendered artifact does not match queued approval');
            return metadata;
        }
        const task = prepareCandidate(metadata, metadataPath, options, rootConfig);
        const result = await manual.cutTask(task, rootConfig);
        const review = fs.readFileSync(task.reviewPath, 'utf8');
        fs.writeFileSync(task.reviewPath, `${review.trimEnd()}\n   Candidate ID: ${task.id}\n${topicReviewLines(task.sourceMetadata.aiReview, task.sourceMetadata.humanReview).join('\n')}\n`, 'utf8');
        if (options.registryPath && options.sourceReview) {
            try { refreshSourceReview(options.registryPath, options.sourceReview); }
            catch (error) { console.warn(`Source REVIEW refresh failed; isolated review retained: ${error.message}`); }
        }
        return result;
    } finally {
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
    }
}

function acquireCandidateLock(metadataPath, candidateId) {
    const lockPath = `${metadataPath}.cut.lock`;
    if (fs.existsSync(lockPath)) {
        const content = fs.readFileSync(lockPath, 'utf8');
        const previous = JSON.parse(content);
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid candidate lock owner');
        try { process.kill(previous.pid, 0); }
        catch (error) {
            if (error.code === 'ESRCH' && fs.readFileSync(lockPath, 'utf8') === content) fs.unlinkSync(lockPath);
        }
    }
    const lock = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, candidateId }), 'utf8');
    return { lock, lockPath };
}

function updateCandidate(metadataPath, options, rootConfig = configLoader.getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
        if (!['pending_preflight', 'render_queued'].includes(metadata.status) || metadata.output?.mediaPath) {
            throw new Error('Only unrendered candidates can be edited or approved');
        }
        if (!Number.isSafeInteger(Number(options.candidateId)) || Number(options.candidateId) < 1
            || (metadata.candidateId && Number(metadata.candidateId) !== Number(options.candidateId))) {
            throw new Error('Candidate ID does not match metadata');
        }
        const evidence = buildPreflightEvidence(topic.parseTopicSrt(metadata.source.srtPath).segments);
        ensureCandidateDraft(metadata, metadataPath, evidence, topic.getClipTopicsConfig(rootConfig));
        if (options.action === 'correct') correctCandidateDraft(metadata, metadataPath, evidence, options);
        for (const field of ['title', 'description', 'coverText']) {
            if (options[field] !== undefined) {
                metadata.copy[field] = String(options[field]).replace(/\\n/g, '\n').trim();
                metadata.candidateSubtitles.approval = null;
                metadata.status = 'pending_preflight';
            }
        }
        if (options.action === 'approve' || options.approveUpload === 'yes') {
            approveCandidateDraft(metadata, evidence, options.reviewNote);
        }
        metadata.candidateId = Number(options.candidateId);
        syncPreviewSubtitles(metadata, evidence);
        writeJsonAtomic(metadataPath, metadata);
        if (options.registryPath && options.sourceReview) {
            try { refreshSourceReview(options.registryPath, options.sourceReview); }
            catch (error) { console.warn(`Candidate saved; source REVIEW refresh failed: ${error.message}`); }
        }
        const draft = metadata.candidateSubtitles;
        return { candidateId: metadata.candidateId, status: metadata.status, candidateSrtPath: draft.path,
            candidateSrtSha256: draft.sha256, candidateRevision: draft.revision,
            reviewPreview: metadata.reviewPreview || null,
            edits: draft.edits, approval: draft.approval || null, copy: metadata.copy,
            cues: draft.cues.map((cue, index) => ({ number: index + 1, start: cue.start, end: cue.end, text: cue.text })) };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

async function previewCandidate(metadataPath, options, rootConfig = configLoader.getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
        if (!['pending_preflight', 'render_queued'].includes(metadata.status) || metadata.output?.mediaPath) {
            throw new Error('Only unrendered candidates can have a review preview prepared');
        }
        if (!Number.isSafeInteger(Number(options.candidateId)) || Number(options.candidateId) < 1
            || (metadata.candidateId && Number(metadata.candidateId) !== Number(options.candidateId))) {
            throw new Error('Candidate ID does not match metadata');
        }
        metadata.candidateId = Number(options.candidateId);
        const evidence = buildPreflightEvidence(topic.parseTopicSrt(metadata.source.srtPath).segments);
        ensureCandidateDraft(metadata, metadataPath, evidence, topic.getClipTopicsConfig(rootConfig));
        try {
            await ensureCandidatePreview(metadata, metadataPath, evidence, manual.buildQueueMediaConfig(rootConfig));
        } finally { writeJsonAtomic(metadataPath, metadata); }
        if (options.registryPath && options.sourceReview) {
            refreshSourceReview(options.registryPath, options.sourceReview);
        }
        const draft = metadata.candidateSubtitles;
        return { candidateId: metadata.candidateId, status: metadata.status, copy: metadata.copy,
            candidateSrtPath: draft.path, candidateSrtSha256: draft.sha256, candidateRevision: draft.revision,
            reviewPreview: metadata.reviewPreview };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

function refreshSourceReview(registryPath, reviewPath) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, ''));
    const samePath = (a, b) => a && b && (process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
    const records = Object.values(registry.clips || {}).filter(record => samePath(record.reviewPath, reviewPath)
        || samePath(record.candidateReviewPath, reviewPath));
    if (!records.length) return;
    const results = records.map(record => {
        const metadata = JSON.parse(fs.readFileSync(record.metadataPath, 'utf8').replace(/^\uFEFF/, ''));
        return { ...metadata, ...(metadata.uploadReady ? { uploadId: record.id } : { candidateId: record.id }) };
    }).sort((a, b) => a.window.start - b.window.start);
    const first = results[0];
    const outputRoot = path.dirname(reviewPath);
    const stem = topic.sanitizeFileName(path.basename(first.source.mediaPath, path.extname(first.source.mediaPath)));
    let markdown = topic.buildTopicReviewMarkdown(results, {
        streamerName: first.streamerName, streamTitle: first.streamTitle, recordedAt: first.recordedAt,
        roomId: first.roomId, outputRoot, planPath: path.join(outputRoot, `${stem}_TOPIC_PLAN.json`),
        uploadRegistry: { clipIds: results.filter(result => result.uploadReady).map(result => result.uploadId) },
        candidateIds: results.filter(result => !result.uploadReady).map(result => result.candidateId)
    });
    const oldReview = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : null;
    // Failed, unregistered candidates are absent from the registry snapshot.
    const failureHistory = oldReview?.match(/\n## \u5931\u8d25\u4e0e\u964d\u7ea7\u8bb0\u5f55\r?\n[\s\S]*$/u)?.[0];
    if (failureHistory) markdown = `${markdown.trimEnd()}\n${failureHistory}`;
    const latest = path.join(outputRoot, 'REVIEW.md');
    const updateLatest = oldReview !== null && fs.existsSync(latest) && fs.readFileSync(latest, 'utf8') === oldReview;
    fs.writeFileSync(reviewPath, markdown, 'utf8');
    if (updateLatest && !samePath(latest, reviewPath)) fs.writeFileSync(latest, markdown, 'utf8');
}

if (require.main === module) {
    const options = manual.parseArgs(process.argv.slice(2));
    if (!options.metadata) throw new Error('Missing --metadata');
    Promise.resolve().then(() => {
        if (options.action === 'preview') return previewCandidate(path.resolve(options.metadata), options);
        if (options.action && options.action !== 'render') {
            if (!['draft', 'correct', 'approve'].includes(options.action)) throw new Error('Unknown candidate action');
            return updateCandidate(options.metadata, options);
        }
        return renderCandidate(options.metadata, options);
    }).then(result => {
        console.log(`CANDIDATE_RESULT: ${JSON.stringify(result.output ? { mediaPath: result.output.mediaPath } : result)}`);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { prepareCandidate, renderCandidate, refreshSourceReview, updateCandidate, previewCandidate, acquireCandidateLock };
