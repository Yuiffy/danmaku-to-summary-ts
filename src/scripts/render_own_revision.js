'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const topic = require('./topic_clipper');
const manual = require('./manual_clip_queue');
const asr = require('./asr/asr_backends');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { correctCandidateDraft, approveCandidateDraft, hasDraftApproval,
    writeJsonAtomic, digest } = require('./clipping/candidate_subtitles');
const { acquireCandidateLock } = require('./render_topic_candidate');
const { sourceSnapshot, fileDigest, RENDERED_CLIP_MODES, sourceEvidenceHash, readRenderedSourceEvidence } = require('./review_rendered_clip');

const { adapter, checkedDraft, revisionEvidence } = require('./clipping/rendered_revision_evidence');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pending = metadata => Boolean(metadata.rebuildRequired);

function checkedSource(metadata, options = {}) {
    const window = metadata.window;
    const missingDetail = metadata.mode === 'own_stream_fun_review'
        && (metadata.selectionRejection?.reason === 'missing_selected_candidate_detail'
            || options.feedbackAuthorized === 'yes' && metadata.selectionRejection)
        && options.action === 'prepare' && (options.replan === true || options.replan === 'yes')
        && !metadata.output?.mediaPath && !metadata.output?.burnedSubtitles
        && options.start !== undefined && options.end !== undefined
        && Number.isFinite(Number(options.start)) && Number.isFinite(Number(options.end));
    if (!missingDetail && (!Number.isFinite(window?.start) || !Number.isFinite(window?.end) || window.start < 0 || window.end <= window.start)) {
        throw new Error('Invalid existing source window');
    }
    const evidence = readRenderedSourceEvidence(metadata);
    const expected = sourceEvidenceHash(metadata);
    if (!expected || expected !== evidence.sourceSha256) throw new Error('Original source evidence changed; review the source first');
    const snapshot = sourceSnapshot(metadata);
    const previous = metadata.renderedSubtitles?.sourceSnapshot || metadata.ownStreamHumanReview?.source
        || metadata.manualRevisionSource?.snapshot || metadata.preRenderSource;
    if (previous && !same(previous, snapshot)) throw new Error('Original recording or sidecars changed since review');
    const exception = metadata.durationApproval;
    if (exception && (exception.authority !== 'user' || !String(exception.note || '').trim()
        || exception.start !== metadata.window.start || exception.end !== metadata.window.end)) {
        throw new Error('Long-clip approval no longer matches this window');
    }
    require('./clipping/rejected_replan').validateEditorialReplan(metadata, options, evidence);
    return { evidence, snapshot };
}

// Legacy manual cuts did not store a source evidence hash. Adopt them only during
// an explicit rebuild, after matching the source projection to the saved clip SRT.
function bindLegacyManualSource(metadata, options) {
    if (metadata.mode !== 'manual_clip_queue' || sourceEvidenceHash(metadata)) return;
    if (metadata.manualRevisionSource || metadata.renderedSubtitles || options.action !== 'prepare'
        || !String(options.reviewNote || '').trim() || !options.sourceKind) {
        throw new Error('Legacy manual clips require rebuild with an explicit source review');
    }
    if (!metadata.output?.burnedSubtitles || !fs.statSync(metadata.output.mediaPath).size) {
        throw new Error('An existing burned manual clip is required');
    }
    const { start, end } = metadata.window || {};
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid existing source window');
    const snapshot = sourceSnapshot(metadata);
    const segments = topic.parseTopicSrt(metadata.source.srtPath).segments;
    const projected = segments.filter(cue => cue.end > start && cue.start < end).map(cue => ({
        start: Math.max(cue.start, start) - start, end: Math.min(cue.end, end) - start, text: cue.text
    }));
    const existing = asr.parseSrt(metadata.output.srtPath).segments;
    const text = value => asr.stripSubtitlePunctuation(String(value)).replace(/\s/g, '');
    if (!existing.length || existing.length !== projected.length || existing.some((cue, index) =>
        Math.abs(cue.start - projected[index].start) > 0.003 || Math.abs(cue.end - projected[index].end) > 0.003
        || text(cue.text) !== text(projected[index].text))) {
        throw new Error('Manual source subtitles no longer match the existing clip; review the source first');
    }
    if (!same(snapshot, sourceSnapshot(metadata))) throw new Error('Source changed during manual source review');
    metadata.manualRevisionSource = { version: 1, sourceSha256: buildSubtitleEvidence(segments).sourceSha256,
        snapshot, note: options.reviewNote.trim(), at: new Date().toISOString() };
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
    const output = metadata.output || {};
    // A topic can retain complete burned media while a later review leaves the
    // overall result partial. Revisions still invalidate approval and rerender.
    const renderedPartial = metadata.status === 'partial' && output.burnedSubtitles && !output.mediaError
        && ['mediaPath', 'srtPath'].every(key => {
            if (typeof output[key] !== 'string' || !fs.existsSync(output[key])) return false;
            const stat = fs.statSync(output[key]);
            return stat.isFile() && stat.size > 0;
        });
    if (metadata.mode !== 'own_stream_fun_review' && (metadata.status !== 'success' && !renderedPartial || !output.mediaPath)) {
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
    if ((options.start === undefined) !== (options.end === undefined)) throw new Error('Supply both --start and --end');
    const start = Number(options.start ?? metadata.window.start);
    const end = Number(options.end ?? metadata.window.end);
    const ordinary = options.ordinary === true || options.ordinary === 'yes';
    if (metadata.editorialTimeline && !ordinary) throw new Error('Editorial timeline rebuild requires --ordinary to restore source order before correcting subtitles');
    const changed = Boolean(options.transcriptRecord) || Boolean(ordinary && metadata.editorialTimeline)
        || start !== metadata.window.start || end !== metadata.window.end;
    const editorialPlan = rejection && rejection.reason !== 'duration_out_of_bounds'
        ? require('./clipping/rejected_replan').reviewEditorialReplan(metadata, options, evidence, start, end) : null;
    const limits = metadata.mode === 'own_stream_fun_review'
        ? require('./own_stream_clipper').getOwnStreamClipsConfig(config) : topic.getClipTopicsConfig(config);
    const minimum = Number(rejection?.minClipSeconds ?? limits.minClipSeconds);
    const maximum = Number(rejection?.maxClipSeconds ?? limits.maxClipSeconds);
    const existingRenderedWindow = !rejection && !changed && metadata.output?.burnedSubtitles
        && metadata.output.mediaPath && fs.existsSync(metadata.output.mediaPath);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
        || end > Math.max(...evidence.cues.map(cue => cue.end)) + 0.001) throw new Error('Invalid or out-of-source clip window');
    const short = !existingRenderedWindow && end - start < minimum;
    if (short || end - start > maximum + 0.001) {
        const allowed = short ? options.allowShort : options.allowLong;
        if (!(allowed === true || allowed === 'yes') || !String(options.durationNote || '').trim()) throw new Error(short
            ? 'Short clips require --allow-short and an editorial --duration-note' : 'Long clips require --allow-long and an editorial --duration-note');
        metadata.durationApproval = { authority: 'user', at: new Date().toISOString(),
            note: options.durationNote.trim(), start, end, automaticMaxSeconds: maximum,
            ...(short ? { kind: 'short', automaticMinSeconds: minimum } : {}) };
    } else delete metadata.durationApproval;
    if (changed && (metadata.renderedSubtitles?.edits?.length || metadata.candidateSubtitles?.edits?.length)) throw new Error('Choose the window before correcting subtitles; existing corrections must not be discarded');
    if (changed) {
        const directory = revisionDirectory(metadataPath, metadata.uploadId);
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `window-${crypto.randomUUID()}.srt`);
        metadata.copy.description = require('./review_rendered_clip').publicDescription(metadata, metadata.copy.description);
        metadata.window = { ...metadata.window, start, end, duration: end - start };
        const parsed = topic.parseTopicSrt(metadata.source.srtPath).segments;
        topic.writeClipSrt(parsed, metadata.window, file);
        const sourceRows = require('./asr/evidence_sidecar').loadAsrEvidence(metadata.source.srtPath, parsed).segments;
        const proofreading = require('./asr/subtitle_proofreading');
        const summary = proofreading.summarizeSubtitleProofreading(sourceRows, metadata.window);
        const checks = [...(metadata.subtitleProofreading?.reviewGroups || []), ...summary.reviewGroups]
            .flatMap(group => (group.occurrences || []).map(occurrence => ({ ...group, ...occurrence })));
        summary.reviewGroups = proofreading.groupSubtitleChecks(checks, metadata.window);
        metadata.subtitleProofreading = summary;
        metadata.output = { ...metadata.output, srtPath: file };
        delete metadata.renderedSubtitles;
        if (ordinary) {
            delete metadata.editorialTimeline;
            delete metadata.editorialStyle;
            metadata.style = 'ordinary';
        }
    }
    if (rejection) {
        metadata.originalSelectionRejection = rejection;
        delete metadata.selectionRejection;
    }
    if (editorialPlan) metadata.editorialReplan = editorialPlan;
    metadata.window.duration = end - start;
    return changed;
}

function result(metadata) {
    const draft = metadata.renderedSubtitles;
    return { candidateSrtPath: draft.path, candidateSrtSha256: draft.sha256, candidateRevision: draft.revision,
        pendingRebuild: pending(metadata), publicCopyPending: Boolean(metadata.publicCopyPending),
        copy: metadata.copy, cues: draft.cues.map((cue, index) => ({ ...cue, number: index + 1 })) };
}

async function validateCopy(metadata, sourceKind, evidence, feedbackAuthorized = false) {
    return require('./review_rendered_clip').reviewCopy(metadata, { sourceKind,
        feedbackAuthorized,
        title: metadata.copy.title, description: metadata.copy.description, coverText: metadata.copy.coverText }, evidence);
}

async function updateRevision(metadataPath, options, config = require('./config-loader').getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const { lock, lockPath } = acquireCandidateLock(metadataPath, options.candidateId);
    try {
        const before = fs.readFileSync(metadataPath, 'utf8');
        let metadata = JSON.parse(before);
        const id = identity(metadata, metadataPath, options);
        bindLegacyManualSource(metadata, options);
        const checked = checkedSource(metadata, options);
        let evidence = checked.evidence;
        let snapshot = checked.snapshot;
        if (options.transcriptRecord) {
            if (options.action !== 'prepare') throw new Error('Timing transcript requires rebuild');
            const descriptor = JSON.parse(fs.readFileSync(options.transcriptRecord, 'utf8').replace(/^\uFEFF/u, ''));
            // A later editorial revision may already use this bound aligned transcript.
            const originalSnapshot = path.resolve(metadata.source.srtPath) === path.resolve(descriptor.path)
                ? sourceSnapshot({ source: { ...metadata.source, srtPath: descriptor.originalSrtPath } }) : snapshot;
            const transcript = require('./clipping/stream_activity_transcript').readTimingTranscript(options.transcriptRecord, originalSnapshot, config, true);
            metadata = require('./workflow-runtime').loadWorkflow('clipping/ownTimingRecovery')
                .prepareRenderedTimingRevision(metadata, transcript, originalSnapshot, options.reviewNote);
            evidence = buildSubtitleEvidence(topic.parseTopicSrt(metadata.source.srtPath).segments);
            metadata.grounding = { sourceSha256: evidence.sourceSha256 };
            snapshot = sourceSnapshot(metadata);
            metadata.preRenderSource = snapshot;
        }
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
            if (oldHash !== editable.candidateSubtitles.sha256 || options.confirmCurrent) metadata.rebuildRequired = true;
        }
        if (options.action === 'prepare') {
            // A rebuild starts a fresh artifact review. Keep old diagnostic receipts
            // in revision history; they must not bind a different window or copy.
            delete metadata.automaticSubtitleRepairAttempt;
            delete metadata.automaticSubtitleRepairError;
            for (const field of ['title', 'description', 'coverText']) {
                if (options[field] !== undefined) metadata.copy[field] = String(options[field]).replace(/\\n/g, '\n').trim();
            }
            if (!String(options.reviewNote || '').trim()) throw new Error('An explicit editorial review note is required');
            const sourceKind = options.sourceKind || metadata.renderedSubtitles.review?.sourceKind;
            const reviewed = await validateCopy(metadata, sourceKind, revisionEvidence(metadata, evidence), options.feedbackAuthorized === 'yes');
            metadata.copy = { ...metadata.copy, ...reviewed.copy };
            metadata.grounding = reviewed.grounding;
            metadata.renderedSubtitles.review = { note: options.reviewNote.trim(), sourceKind, copy: { ...metadata.copy },
                ...(options.feedbackAuthorized === 'yes' ? { acceptanceMode: 'feedback' } : {}) };
            metadata.renderedSubtitles.approval = null;
            metadata.rebuildRequired = true;
            metadata.publicCopyPending = false;
        }
        if (pending(metadata)) metadata.uploadReady = false;
        if (options.action === 'approve') {
            const review = metadata.renderedSubtitles.review;
            if (!review?.note || !review.sourceKind) throw new Error('Confirm public copy and attribution with rebuild --source-kind before enqueueing');
            await validateCopy(metadata, review.sourceKind, revisionEvidence(metadata, evidence), review.acceptanceMode === 'feedback');
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
        const { evidence, snapshot } = checkedSource(metadata, options);
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
        await validateCopy(metadata, review.sourceKind, revisionEvidence(metadata, evidence), options.feedbackAuthorized === 'yes');
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
        delete updated.preRenderHold;
        if (updated.renderedTimingRepair) updated.renderedTimingRepair = { ...updated.renderedTimingRepair,
            rendered: { window: { start: updated.window.start, end: updated.window.end },
                video: fileDigest(updated.output.mediaPath), subtitles: fileDigest(updated.output.srtPath) } };
        writeJsonAtomic(staging, updated);
        const audit = childProcess.spawnSync('python', [path.join(__dirname, 'audit_bilibili_clip.py'),
            '--video', updated.output.mediaPath, '--srt', updated.output.srtPath, '--metadata', staging,
            '--cover', updated.output.coverPath, '--strict-warnings'],
        { encoding: 'utf8', windowsHide: true, timeout: 120000 });
        if (audit.error || audit.status !== 0) throw new Error(`Rebuilt media audit failed: ${audit.error?.message || audit.stdout || audit.stderr}`);
        let approved;
        if (options.automaticReview === 'yes') {
            const publication = require('./clipping/own_automatic_publication');
            const context = require('./clipping/own_publication_context').reviewContext(updated, config);
            updated.generatedAt = new Date().toISOString();
            updated.uploadReady = true;
            delete updated.ownStreamHumanReview;
            approved = updated;
            if (updated.renderedTimingRepair) {
                const settings = asr.getAsrConfig(config), backend = settings.fun_asr_nano;
                if (backend.python_path_map?.length) throw new Error('Final timing audio requires native Python paths');
                approved = await require('./workflow-runtime').loadWorkflow('clipping/ownTimingRecovery').verifyRenderedTimingAudio(updated, {
                    python: asr.resolvePythonCommand(backend), scriptPath: path.join(__dirname, 'python/ordinary_subtitle_audio.py'),
                    settings: { model: backend.model, sensevoiceModel: settings.sensevoice.model, vadModel: backend.vad_model || 'fsmn-vad',
                        device: backend.device, use_itn: false, resource_guard: { ...backend.resource_guard, torch_num_threads: 2 },
                        gpu_throttle: backend.gpu_throttle, ffmpeg: config.audio?.ffmpeg?.path || 'ffmpeg', ffmpegThreads: 2 } });
            }
            const keywordTopic = updated.publicationKind === 'keyword_topic';
            if (!keywordTopic || updated.attributionRequired) {
                // A mandatory review cannot be skipped by the optional room allowlist.
                const requiredContext = updated.attributionRequired ? { ...context, config: { ...context.config,
                    attribution: { ...context.config.attribution, enabled: true,
                        roomIds: [...new Set([...(context.config.attribution?.roomIds || []), String(updated.roomId)])] } } } : context;
                approved = await publication.reviewArtifactCopy(approved,
                    [...(updated.publicationReview?.issues || []), '重建后重新核对原话及人物归属'], requiredContext);
            }
            if (approved.copy.title !== updated.copy.title || approved.copy.coverText !== updated.copy.coverText) {
                approved.output = { ...approved.output, coverPath: await publication.renderCopyCover(approved, context) };
            }
            approved = keywordTopic
                ? await require('./clipping/topic_automatic_publication').reviewCandidateFinal(approved, config,
                    { ...topic, buildPreflightEvidence: require('./clipping/preflight_evidence').buildPreflightEvidence,
                        buildQueueMediaConfig: manual.buildQueueMediaConfig }, { finalOnly: true })
                : (await publication.reviewFinals([approved], context))[0];
        } else {
            if (updated.renderedTimingRepair && options.feedbackAuthorized !== 'yes') throw new Error('Timing repair requires --automatic-review or explicit feedback acceptance');
            await require('./review_rendered_clip').approveRenderedClip(staging, { id,
                reviewIndex: metadata.reviewIndex, reviewNote: options.reviewNote || review.note,
                sourceKind: review.sourceKind, ...metadata.copy, preparedCover: rendered.output.coverPath,
                feedbackAuthorized: options.feedbackAuthorized === 'yes' }, config);
            approved = JSON.parse(fs.readFileSync(staging, 'utf8'));
        }
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
