'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('node:util');
const topic = require('./topic_clipper');
const { buildSubtitleEvidence, linkClipEvidence } = require('./clipping/subtitle_evidence');
const { copyDigest } = require('./clipping/actor_review');
const { writeJsonAtomic } = require('./clipping/candidate_subtitles');

const RENDERED_CLIP_MODES = new Set(['own_stream_fun_review', 'local_review', 'topic_candidate_manual_cut']);

function sourceEvidenceHash(metadata) {
    return metadata.attributionReview?.sourceSha256 || metadata.grounding?.sourceSha256
        || metadata.selectionRejection?.sourceSha256 || metadata.aiReview?.sourceSha256
        || metadata.editorial?.copyGrounding?.sourceSha256;
}

function fileDigest(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

function sourceSnapshot(metadata) {
    const source = metadata.source;
    const stat = fs.statSync(source.mediaPath, { bigint: true });
    return { mediaPath: path.resolve(source.mediaPath), mediaBytes: String(stat.size), mediaMtimeNs: String(stat.mtimeNs),
        srtPath: path.resolve(source.srtPath), srtSha256: fileDigest(source.srtPath),
        xmlPath: source.xmlPath ? path.resolve(source.xmlPath) : null,
        xmlSha256: source.xmlPath ? fileDigest(source.xmlPath) : null };
}

function publicDescription(metadata, value) {
    if (metadata.mode !== 'own_stream_fun_review') return value;
    const prefix = require('./own_stream_clipper').buildClipDescription({ streamerName: metadata.streamerName,
        streamTitle: metadata.streamTitle, recordedAt: metadata.recordedAt,
        start: metadata.window.start, end: metadata.window.end, description: '' });
    return String(value || '').startsWith(prefix + '\n\n') ? String(value).slice(prefix.length + 2) : value;
}

function assertRenderedRevision(metadata) {
    const draft = metadata.renderedSubtitles;
    if (draft && (metadata.rebuildRequired || draft.renderedSha256 !== draft.sha256
        || draft.renderedRevision !== draft.revision || fileDigest(draft.path) !== draft.sha256
        || fileDigest(metadata.output.srtPath) !== draft.sha256)) {
        throw new Error('Current subtitle revision must be rendered before approving the video');
    }
}

async function reviewCopy(metadata, options, evidence) {
    const window = metadata.window;
    const sourceKind = options.sourceKind || metadata.grounding?.sourceKind;
    if (!['live_speech', 'recount', 'playback', 'audience'].includes(sourceKind)) throw new Error('Confirm --source-kind before approving uncertain attribution');
    const originalCopy = metadata.attributionReview?.originalCopy || metadata.copy || {};
    const copy = {
        title: options.title ?? metadata.copy?.title,
        description: publicDescription(metadata, options.description ?? originalCopy.description),
        coverText: options.coverText ?? metadata.copy?.coverText
    };
    for (const key of Object.keys(copy)) {
        copy[key] = String(copy[key] || '').replace(/\\n/g, '\n').trim();
        if (!copy[key]) throw new Error(`Missing publishing copy: ${key}`);
    }
    const own = require('./own_stream_clipper');
    const audience = metadata.source.xmlPath ? await own.parseDanmakuXml(metadata.source.xmlPath) : [];
    // Earlier topic manifests retained the reviewed audience rows without an XML path.
    // Keep their original IDs and timestamps; they can only support the new window if included.
    if (!metadata.source.xmlPath) {
        for (const row of metadata.editorial?.copyGrounding?.audience || []) {
            const index = /^D[1-9]\d*$/.test(row.id) ? Number(row.id.slice(1)) - 1 : -1;
            if (Number.isSafeInteger(index) && index >= 0 && Number.isFinite(row.time)) audience[index] = row;
        }
    }
    const cues = evidence.cues.filter(cue => cue.start >= window.start - 0.001 && cue.end <= window.end + 0.001);
    const danmakuIds = audience.flatMap((row, index) => row.time >= window.start && row.time <= window.end ? [`D${index + 1}`] : []);
    const grounding = linkClipEvidence({ ...copy, sourceKind, evidenceCueIds: cues.map(cue => cue.id), evidenceDanmakuIds: danmakuIds }, window, evidence, audience);
    if (grounding.issues.length) throw new Error(`Public copy still lacks source support: ${grounding.issues.join('; ')}`);
    return { copy, grounding, sourceKind };
}

async function approveRenderedClip(metadataPath, options, config = require('./config-loader').getConfig()) {
    metadataPath = path.resolve(metadataPath);
    const before = fs.readFileSync(metadataPath, 'utf8');
    const metadata = JSON.parse(before);
    if (!RENDERED_CLIP_MODES.has(metadata.mode) || metadata.selectionRejection) throw new Error('Only supported rendered clips can be approved here; rejected candidates must first be re-planned and rendered');
    if (!Number.isSafeInteger(options.id) || options.id < 1 || !String(options.reviewNote || '').trim()) throw new Error('Numeric ID and explicit human review note are required');
    const output = metadata.output || {};
    assertRenderedRevision(metadata);
    if (output.mediaError || !output.burnedSubtitles || !fs.statSync(output.mediaPath).size || !fs.statSync(output.srtPath).size) throw new Error('Complete burned video and subtitles are required; rerender failed media first');
    const window = metadata.window;
    if (!Number.isFinite(window?.start) || !Number.isFinite(window?.end) || window.start < 0 || window.end <= window.start) throw new Error('Invalid clip window');
    const snapshot = sourceSnapshot(metadata);
    const parsed = topic.parseTopicSrt(metadata.source.srtPath);
    const evidence = buildSubtitleEvidence(parsed.segments);
    const expected = sourceEvidenceHash(metadata);
    if (!expected || expected !== evidence.sourceSha256) throw new Error('Original subtitle evidence changed; re-plan/review against the current source first');
    const reviewedEvidence = metadata.renderedSubtitles
        ? require('./render_own_revision').revisionEvidence(metadata, evidence) : evidence;
    const { copy, grounding, sourceKind } = await reviewCopy(metadata, options, reviewedEvidence);
    const own = require('./own_stream_clipper');
    const videoHash = fileDigest(output.mediaPath);
    const subtitleHash = fileDigest(output.srtPath);
    const coverKey = crypto.createHash('sha256').update(videoHash + copyDigest(copy)).digest('hex').slice(0, 16);
    const coverDirectory = path.join(path.dirname(metadataPath), 'reviewed_covers', `${options.id}-${coverKey}`);
    fs.mkdirSync(coverDirectory, { recursive: true });
    const cover = options.preparedCover || await topic.generateClipCover(output.mediaPath, own.buildCoverTitle(copy.title, copy.coverText), coverDirectory,
        { streamerName: metadata.streamerName, clipDuration: window.duration });
    if (!cover || !fs.statSync(cover).size) throw new Error('A valid cover is required before approval');
    if (fs.readFileSync(metadataPath, 'utf8') !== before || JSON.stringify(sourceSnapshot(metadata)) !== JSON.stringify(snapshot)
        || fileDigest(output.mediaPath) !== videoHash || fileDigest(output.srtPath) !== subtitleHash) throw new Error('Source or metadata changed during review; no approval saved');
    const updated = { ...metadata, reviewIndex: options.reviewIndex || metadata.reviewIndex || window.index,
        publicCopyPending: false, uploadReady: true, grounding,
        copy: { ...metadata.copy, ...copy, description: metadata.mode === 'own_stream_fun_review'
            ? own.buildClipDescription({ streamerName: metadata.streamerName, streamTitle: metadata.streamTitle,
                recordedAt: metadata.recordedAt, start: window.start, end: window.end, description: copy.description })
            : copy.description },
        output: { ...output, coverPath: cover, coverError: null } };
    updated.ownStreamHumanReview = { version: 1, status: 'approved', authority: 'human', clipId: options.id,
        reviewedAt: new Date().toISOString(), note: options.reviewNote.trim(), sourceKind,
        source: snapshot, artifactWindow: { start: window.start, end: window.end },
        originalIssues: metadata.attributionReview?.issues || metadata.grounding?.issues || [], originalCopy: metadata.copy,
        previousReview: metadata.ownStreamHumanReview || null,
        digests: { video: videoHash, subtitles: subtitleHash, cover: fileDigest(cover), copy: copyDigest(updated.copy) } };
    writeJsonAtomic(metadataPath, updated);
    return { metadataPath, id: options.id, uploadAuthorized: false };
}

module.exports = { approveRenderedClip, sourceSnapshot, fileDigest, reviewCopy, publicDescription, assertRenderedRevision,
    RENDERED_CLIP_MODES, sourceEvidenceHash };
if (require.main === module) {
    const { values } = parseArgs({ options: { metadata: { type: 'string' }, id: { type: 'string' },
        'review-index': { type: 'string' }, 'review-note': { type: 'string' }, title: { type: 'string' },
        description: { type: 'string' }, 'cover-text': { type: 'string' }, 'source-kind': { type: 'string' } } });
    approveRenderedClip(values.metadata, { id: Number(values.id), reviewIndex: Number(values['review-index']),
        reviewNote: values['review-note'], title: values.title, description: values.description,
        coverText: values['cover-text'], sourceKind: values['source-kind'] })
        .then(result => console.log('REVIEW_RESULT: ' + JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
