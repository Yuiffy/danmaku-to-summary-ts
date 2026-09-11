'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const topic = require('./topic_clipper');
const manual = require('./manual_clip_queue');
const asr = require('./asr/asr_backends');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { readCandidateDraft, correctCandidateDraft, approveCandidateDraft, hasDraftApproval,
    writeJsonAtomic, digest } = require('./clipping/candidate_subtitles');
const { acquireCandidateLock } = require('./render_topic_candidate');
const { sourceSnapshot, fileDigest, RENDERED_CLIP_MODES, sourceEvidenceHash } = require('./review_rendered_clip');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pending = metadata => Boolean(metadata.rebuildRequired);

function checkedSource(metadata) {
    const window = metadata.window;
    if (!Number.isFinite(window?.start) || !Number.isFinite(window?.end) || window.start < 0 || window.end <= window.start) {
        throw new Error('Invalid existing source window');
    }
    const evidence = buildSubtitleEvidence(topic.parseTopicSrt(metadata.source.srtPath).segments);
    const expected = sourceEvidenceHash(metadata);
    if (!expected || expected !== evidence.sourceSha256) throw new Error('Original source evidence changed; review the source first');
    const snapshot = sourceSnapshot(metadata);
    const previous = metadata.renderedSubtitles?.sourceSnapshot || metadata.ownStreamHumanReview?.source;
    if (previous && !same(previous, snapshot)) throw new Error('Original recording or sidecars changed since review');
    const exception = metadata.durationApproval;
    if (exception && (exception.authority !== 'user' || !String(exception.note || '').trim()
        || exception.start !== metadata.window.start || exception.end !== metadata.window.end)) {
        throw new Error('Long-clip approval no longer matches this window');
    }
    return { evidence, snapshot };
}

function adapter(metadata) {
    return { ...metadata, output: { ...metadata.output }, copy: { ...metadata.copy,
        description: require('./review_rendered_clip').publicDescription(metadata, metadata.copy?.description) },
        candidateSubtitles: metadata.renderedSubtitles };
}

function checkedDraft(metadata, evidence) {
    const draft = readCandidateDraft(adapter(metadata), evidence);
    if (draft.clipId !== metadata.uploadId) throw new Error('Subtitle revision belongs to a different clip ID');
    return draft;
}

function revisionEvidence(metadata, evidence) {
    const draft = checkedDraft(metadata, evidence);
    const revised = buildSubtitleEvidence(draft.cues.map(cue => ({
        start: metadata.window.start + cue.start, end: metadata.window.start + cue.end, text: cue.text
    })), { groupSegments: false });
    const cues = revised.cues.map((cue, index) => ({ ...cue, id: `R${index + 1}` }));
    return { ...revised, sourceSha256: evidence.sourceSha256, cues, byId: new Map(cues.map(cue => [cue.id, cue])) };
}

function revisionDirectory(metadataPath, id) {
    return path.join(path.dirname(metadataPath), 'subtitle_revisions', String(id));
}

function persist(metadataPath, before, metadata) {
    if (fs.readFileSync(metadataPath, 'utf8') !== before) throw new Error('Metadata changed concurrently; no revision saved');
    const directory = path.join(revisionDirectory(metadataPath, metadata.uploadId), 'history');
    fs.mkdirSync(directory, { recursive: true });
    const history = path.join(directory, `${digest(before)}.json`);
    if (!fs.existsSync(history)) fs.writeFileSync(history, before, { encoding: 'utf8', flag: 'wx' });
    writeJsonAtomic(metadataPath, metadata);
}

function identity(metadata, metadataPath, options) {
    const id = Number(options.candidateId);
    if (!RENDERED_CLIP_MODES.has(metadata.mode) || !Number.isSafeInteger(id) || id < 1) {
        throw new Error('A numeric rendered own-stream or topic clip ID is required');
    }
    if (metadata.mode !== 'own_stream_fun_review' && (metadata.status !== 'success' || !metadata.output?.mediaPath)) {
        throw new Error('Unrendered keyword candidates must use cut before revision');
    }
    if ((metadata.uploadId && metadata.uploadId !== id) || (metadata.renderedSubtitles && metadata.renderedSubtitles.clipId !== id)) {
        throw new Error('Clip ID does not match revision metadata');
    }
    if (options.registryPath) {
        const registry = JSON.parse(fs.readFileSync(options.registryPath, 'utf8'));
        const record = registry.clips?.[String(id)];
        if (!record || path.resolve(record.metadataPath) !== metadataPath) throw new Error('Registry ID does not identify this metadata');
        if (metadata.reviewIndex && Number(metadata.reviewIndex) !== Number(record.reviewIndex)) throw new Error('Registry review index does not match revision metadata');
        metadata.reviewIndex = record.reviewIndex;
        metadata.upload ||= { source: record.source, prefix: record.prefix, tags: record.tags, tid: record.tid,
            roomId: record.roomId, streamerName: record.streamerName };
        metadata.roomId ||= record.roomId;
        metadata.streamerName ||= record.streamerName;
        if (record.manifestPath && fs.existsSync(record.manifestPath)) {
            const context = JSON.parse(fs.readFileSync(record.manifestPath, 'utf8'));
            metadata.recordedAt ||= context.recordedAt;
            metadata.streamTitle ||= context.streamTitle;
        }
    }
    metadata.uploadId = id;
    metadata.reviewIndex ||= metadata.window?.index;
    return id;
}

function ensureDraft(metadata, metadataPath, id, evidence, snapshot, regenerated = false) {
    if (metadata.renderedSubtitles) return checkedDraft(metadata, evidence);
    const file = metadata.output?.srtPath;
    if (!file || !fs.statSync(file).size) throw new Error('An existing clip-relative SRT is required');
    const previousHash = metadata.ownStreamHumanReview?.digests?.subtitles
        || metadata.attributionReview?.artifactDigests?.subtitles || metadata.qaResult?.digests?.subtitles;
    if (!regenerated && previousHash && fileDigest(file) !== previousHash) {
        throw new Error('Existing clip SRT changed since review; do not adopt unapproved subtitle edits');
    }
    const duration = metadata.window.end - metadata.window.start;
    const segments = asr.parseSrt(file).segments;
    if (!segments.length || segments.some(cue => cue.start < 0 || cue.end <= cue.start || cue.end > duration + 0.001)) {
        throw new Error('Clip subtitles exceed the source window');
    }
    metadata.renderedSubtitles = { version: 1, clipId: id, path: file, revision: 0, sha256: fileDigest(file),
        sourceSnapshot: snapshot, sourceSha256: evidence.sourceSha256, sourceSrtPath: metadata.source.srtPath,
        window: { start: metadata.window.start, end: metadata.window.end }, edits: [],
        cues: segments.map((cue, index) => ({ ...cue, cueId: `R${index + 1}`,
            sourceStart: metadata.window.start + cue.start, sourceEnd: metadata.window.start + cue.end })),
        review: metadata.ownStreamHumanReview?.status === 'approved' ? {
            note: metadata.ownStreamHumanReview.note, sourceKind: metadata.ownStreamHumanReview.sourceKind
        } : null };
    return metadata.renderedSubtitles;
}

function prepareWindow(metadata, metadataPath, options, config, evidence) {
    const rejection = metadata.selectionRejection || metadata.originalSelectionRejection;
    if (rejection && rejection.reason !== 'duration_out_of_bounds') throw new Error('This rejection needs a new editorial plan, not a duration override');
    if ((options.start === undefined) !== (options.end === undefined)) throw new Error('Supply both --start and --end');
    const start = Number(options.start ?? metadata.window.start);
    const end = Number(options.end ?? metadata.window.end);
    const limits = metadata.mode === 'own_stream_fun_review'
        ? require('./own_stream_clipper').getOwnStreamClipsConfig(config) : topic.getClipTopicsConfig(config);
    const minimum = Number(rejection?.minClipSeconds ?? limits.minClipSeconds);
    const maximum = Number(rejection?.maxClipSeconds ?? limits.maxClipSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < minimum
        || end > Math.max(...evidence.cues.map(cue => cue.end)) + 0.001) throw new Error('Invalid or out-of-source clip window');
    if (end - start > maximum + 0.001) {
        if (!(options.allowLong === true || options.allowLong === 'yes') || !String(options.durationNote || '').trim()) throw new Error('Long clips require --allow-long and an editorial --duration-note');
        metadata.durationApproval = { authority: 'user', at: new Date().toISOString(),
            note: options.durationNote.trim(), start, end, automaticMaxSeconds: maximum };
    } else delete metadata.durationApproval;
    const changed = start !== metadata.window.start || end !== metadata.window.end;
    if (changed && (metadata.renderedSubtitles?.edits?.length || metadata.candidateSubtitles?.edits?.length)) throw new Error('Choose the window before correcting subtitles; existing corrections must not be discarded');
    if (changed) {
        const directory = revisionDirectory(metadataPath, metadata.uploadId);
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `window-${crypto.randomUUID()}.srt`);
        metadata.copy.description = require('./review_rendered_clip').publicDescription(metadata, metadata.copy.description);
        metadata.window = { ...metadata.window, start, end, duration: end - start };
        topic.writeClipSrt(topic.parseTopicSrt(metadata.source.srtPath).segments, metadata.window, file);
        metadata.output = { ...metadata.output, srtPath: file };
        delete metadata.renderedSubtitles;
    }
    if (rejection) {
        metadata.originalSelectionRejection = rejection;
        delete metadata.selectionRejection;
    }
    metadata.window.duration = end - start;
    return changed;
}

function result(metadata) {
    const draft = metadata.renderedSubtitles;
    return { candidateSrtPath: draft.path, candidateSrtSha256: draft.sha256, candidateRevision: draft.revision,
        pendingRebuild: pending(metadata), publicCopyPending: Boolean(metadata.publicCopyPending),
        copy: metadata.copy, cues: draft.cues.map((cue, index) => ({ ...cue, number: index + 1 })) };
}

async function validateCopy(metadata, sourceKind, evidence) {
    return require('./review_rendered_clip').reviewCopy(metadata, { sourceKind,
        title: metadata.copy.title, description: metadata.copy.description, coverText: metadata.copy.coverText }, evidence);
}

async function updateRevision(metadataPath, options, config = require('./config-loader').getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const before = fs.readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(before);
        const id = identity(metadata, metadataPath, options);
        const checked = checkedSource(metadata);
        const evidence = checked.evidence;
        let snapshot = checked.snapshot;
        if (options.xml !== undefined) {
            if (options.action !== 'prepare' || !String(options.reviewNote || '').trim()) throw new Error('Attach XML with an explicit rebuild review');
            const xmlPath = path.resolve(options.xml);
            if (metadata.source.xmlPath && path.resolve(metadata.source.xmlPath) !== xmlPath) throw new Error('Cannot replace an existing source XML path');
            metadata.source = { ...metadata.source, xmlPath };
            snapshot = sourceSnapshot(metadata);
            if (metadata.renderedSubtitles) metadata.renderedSubtitles.sourceSnapshot = snapshot;
        }
        let regenerated = false;
        if (options.action === 'prepare') regenerated = prepareWindow(metadata, metadataPath, options, config, evidence);
        else if (metadata.selectionRejection) throw new Error('Use rebuild to review the rejected window and publishing copy first');
        ensureDraft(metadata, metadataPath, id, evidence, snapshot, regenerated);
        if (options.action === 'correct') {
            const editable = adapter(metadata);
            const directory = revisionDirectory(metadataPath, id);
            fs.mkdirSync(directory, { recursive: true });
            const oldHash = editable.candidateSubtitles.sha256;
            correctCandidateDraft(editable, path.join(directory, 'subtitles.json'), evidence, options);
            metadata.renderedSubtitles = editable.candidateSubtitles;
            metadata.copy = editable.copy;
            if (oldHash !== editable.candidateSubtitles.sha256) metadata.rebuildRequired = true;
        }
        if (options.action === 'prepare') {
            for (const field of ['title', 'description', 'coverText']) {
                if (options[field] !== undefined) metadata.copy[field] = String(options[field]).replace(/\\n/g, '\n').trim();
            }
            if (!String(options.reviewNote || '').trim()) throw new Error('An explicit editorial review note is required');
            const sourceKind = options.sourceKind || metadata.renderedSubtitles.review?.sourceKind;
            const reviewed = await validateCopy(metadata, sourceKind, revisionEvidence(metadata, evidence));
            metadata.copy = { ...metadata.copy, ...reviewed.copy };
            metadata.grounding = reviewed.grounding;
            metadata.renderedSubtitles.review = { note: options.reviewNote.trim(), sourceKind };
            metadata.renderedSubtitles.approval = null;
            metadata.rebuildRequired = true;
            metadata.publicCopyPending = false;
        }
        if (pending(metadata)) metadata.uploadReady = false;
        if (options.action === 'approve') {
            const review = metadata.renderedSubtitles.review;
            if (!review?.note || !review.sourceKind) throw new Error('Confirm public copy and attribution with rebuild --source-kind before enqueueing');
            await validateCopy(metadata, review.sourceKind, revisionEvidence(metadata, evidence));
            approveCandidateDraft(adapter(metadata), evidence, options.reviewNote || review.note);
        }
        if (!same(sourceSnapshot(metadata), snapshot)) throw new Error('Source changed while preparing revision');
        if (options.action !== 'draft') persist(metadataPath, before, metadata);
        return result(metadata);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

async function renderRevision(metadataPath, options, config = require('./config-loader').getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const before = fs.readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(before);
        const id = identity(metadata, metadataPath, options);
        const { evidence, snapshot } = checkedSource(metadata);
        const draft = checkedDraft(metadata, evidence);
        if (options.requireApproval && !hasDraftApproval(adapter(metadata), evidence, options.expectedSha256)) {
            throw new Error('Subtitle revision or public copy does not match queued approval');
        }
        if (!pending(metadata)) {
            require('./review_rendered_clip').assertRenderedRevision(metadata);
            return result(metadata);
        }
        const review = draft.review;
        if (!review?.note || !review.sourceKind) throw new Error('Confirm copy and source-kind with rebuild before rendering');
        await validateCopy(metadata, review.sourceKind, revisionEvidence(metadata, evidence));
        const upload = metadata.upload;
        if (!upload?.source || !upload.prefix || !upload.tags?.length) throw new Error('Missing upload identity');
        const outputDir = path.join(revisionDirectory(metadataPath, id), `render-r${draft.revision}-${crypto.randomUUID()}`);
        const task = { id: String(id), mediaPath: metadata.source.mediaPath, srtPath: metadata.source.srtPath,
            start: metadata.window.start, end: metadata.window.end, ...metadata.copy, upload, outputDir,
            outputStem: path.basename(metadataPath, '.json'), reviewPath: path.join(outputDir, 'REVIEW.md'),
            roomId: metadata.roomId, streamerName: metadata.streamerName, recordedAt: metadata.recordedAt,
            streamTitle: metadata.streamTitle, sourceMetadata: metadata,
            approvedSubtitlePath: draft.path, approvedSubtitleSha256: draft.sha256 };
        const rendered = await manual.cutTask(task, config);
        if (!rendered.output.burnedSubtitles || fileDigest(rendered.output.srtPath) !== draft.sha256
            || !fs.statSync(rendered.output.coverPath).size) throw new Error('Rebuilt media does not contain the approved subtitle revision');
        const staging = rendered.output.metadataPath;
        const updated = { ...metadata, rebuildRequired: false, status: 'success', publicCopyPending: false,
            output: { ...rendered.output, metadataPath, mediaError: null, coverError: null },
            renderedSubtitles: { ...draft, renderedSha256: draft.sha256, renderedRevision: draft.revision } };
        writeJsonAtomic(staging, updated);
        const audit = childProcess.spawnSync('python', [path.join(__dirname, 'audit_bilibili_clip.py'),
            '--video', updated.output.mediaPath, '--srt', updated.output.srtPath, '--metadata', staging,
            '--cover', updated.output.coverPath, '--strict-warnings'],
        { encoding: 'utf8', windowsHide: true, timeout: 120000 });
        if (audit.error || audit.status !== 0) throw new Error(`Rebuilt media audit failed: ${audit.error?.message || audit.stdout || audit.stderr}`);
        await require('./review_rendered_clip').approveRenderedClip(staging, { id,
            reviewIndex: metadata.reviewIndex, reviewNote: options.reviewNote || review.note,
            sourceKind: review.sourceKind, ...metadata.copy, preparedCover: rendered.output.coverPath }, config);
        const approved = JSON.parse(fs.readFileSync(staging, 'utf8'));
        if (!same(sourceSnapshot(metadata), snapshot) || fileDigest(draft.path) !== draft.sha256) {
            throw new Error('Source or approved subtitles changed during rendering');
        }
        persist(metadataPath, before, approved);
        return result(approved);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

module.exports = { updateRevision, renderRevision, revisionEvidence, checkedSource, checkedDraft };
if (require.main === module) {
    const options = manual.parseArgs(process.argv.slice(2));
    Promise.resolve().then(() => options.action === 'render'
        ? renderRevision(options.metadata, options) : updateRevision(options.metadata, options))
        .then(value => console.log(`CANDIDATE_RESULT: ${JSON.stringify(value)}`))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
