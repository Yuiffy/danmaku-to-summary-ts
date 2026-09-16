'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asr = require('../asr/asr_backends');
const { buildPreflightInput } = require('./preflight_evidence');
const { applyPreflightSubtitleEdits } = require('./preflight_plan');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const copyDigest = copy => digest(JSON.stringify(['title', 'description', 'coverText'].map(key => copy?.[key] || '')));

function writeJsonAtomic(file, data) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
}

function writeRevision(file, cues) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        asr.writeSrt({ segments: cues }, temporary, { strip_punctuation: false, max_chars_per_line: 100000,
            corrections: { enabled: false }, write_evidence: false });
        const content = fs.readFileSync(temporary);
        if (fs.existsSync(file)) {
            if (!fs.readFileSync(file).equals(content)) throw new Error('Subtitle revision already exists with different content');
        } else fs.renameSync(temporary, file);
        const segments = asr.parseSrt(file).segments;
        if (segments.length !== cues.length) throw new Error('Candidate subtitle serialization lost cues');
        return { sha256: digest(content), cues: cues.map((cue, index) => ({ ...cue, ...segments[index] })) };
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function readCandidateDraft(metadata, evidence) {
    const draft = metadata.candidateSubtitles;
    if (!draft || draft.sourceSha256 !== evidence.sourceSha256
        || path.resolve(draft.sourceSrtPath) !== path.resolve(metadata.source.srtPath)
        || draft.window.start !== metadata.window.start || draft.window.end !== metadata.window.end) {
        throw new Error('Candidate subtitle source or boundaries changed');
    }
    if (digest(fs.readFileSync(draft.path)) !== draft.sha256) {
        throw new Error('Candidate SRT changed outside the correction command; approval is invalid');
    }
    const segments = asr.parseSrt(draft.path).segments;
    if (segments.length !== draft.cues.length || segments.some((cue, index) => {
        const saved = draft.cues[index];
        return cue.start !== saved.start || cue.end !== saved.end || cue.text !== saved.text;
    })) throw new Error('Candidate subtitle cues or timing changed');
    return draft;
}

function ensureCandidateDraft(metadata, metadataPath, evidence, config = {}) {
    if (metadata.candidateSubtitles) return readCandidateDraft(metadata, evidence);
    if (metadata.aiReview?.sourceSha256 !== evidence.sourceSha256) throw new Error('Source evidence changed; cannot prepare candidate SRT');
    const window = metadata.window;
    const input = buildPreflightInput({ ...window, cues: evidence.cues, matchSegments: window.matchSegments || [] },
        evidence, config, { streamerName: metadata.streamerName });
    const corrected = applyPreflightSubtitleEdits(metadata.aiReview.subtitleEdits || [], window, evidence,
        input, metadata.aiReview.keyword?.hits || []);
    const cues = corrected.evidence.cues.filter(cue => cue.end > window.start && cue.start < window.end).map(cue => ({
        cueId: cue.id, sourceStart: cue.start, sourceEnd: cue.end,
        start: Math.max(0, cue.start - window.start), end: Math.min(window.end, cue.end) - window.start, text: cue.text
    }));
    if (!cues.length) throw new Error('Candidate has no subtitle cues');
    const file = path.join(path.dirname(metadataPath), `${path.basename(metadataPath, '.json')}_candidate.srt`);
    const written = writeRevision(file, cues);
    metadata.candidateSubtitles = { version: 1, path: file, revision: 0, ...written,
        sourceSha256: evidence.sourceSha256, sourceSrtPath: metadata.source.srtPath,
        window: { start: window.start, end: window.end }, edits: [] };
    metadata.output.srtPath = file;
    metadata.output.srtSegmentCount = cues.length;
    return metadata.candidateSubtitles;
}

function correctCandidateDraft(metadata, metadataPath, evidence, options) {
    const draft = readCandidateDraft(metadata, evidence);
    const original = String(options.from || '');
    const replacement = String(options.to || '');
    if (!original || !replacement || original === replacement || /[\r\n\x00-\x1f]/u.test(original + replacement)) {
        throw new Error('Correction needs distinct nonempty literal words without control characters');
    }
    const cueIndex = options.cue == null ? null : Number(options.cue);
    if (cueIndex !== null && (!Number.isSafeInteger(cueIndex) || cueIndex < 1 || cueIndex > draft.cues.length)) {
        throw new Error('Unknown candidate subtitle cue number');
    }
    const changes = [];
    const cues = draft.cues.map((cue, index) => {
        if ((cueIndex !== null && cueIndex !== index + 1) || !cue.text.includes(original)) return cue;
        const text = cue.text.split(original).join(replacement);
        changes.push({ cue: index + 1, cueId: cue.cueId, before: cue.text, after: text,
            start: cue.sourceStart, end: cue.sourceEnd });
        return { ...cue, text };
    });
    if (!changes.length) {
        const previous = draft.edits.at(-1);
        if (previous?.original === original && previous?.replacement === replacement && previous?.cue === cueIndex) return draft;
        throw new Error(`No literal subtitle match for ${JSON.stringify(original)}; nothing changed or queued`);
    }
    const revision = draft.revision + 1;
    const file = path.join(path.dirname(metadataPath), `${path.basename(metadataPath, '.json')}_candidate_r${String(revision).padStart(4, '0')}.srt`);
    const written = writeRevision(file, cues);
    const copyChanges = {};
    for (const key of ['title', 'description', 'coverText']) {
        const before = metadata.copy?.[key];
        if (typeof before === 'string' && before.includes(original)) {
            metadata.copy[key] = before.split(original).join(replacement);
            copyChanges[key] = { before, after: metadata.copy[key] };
        }
    }
    metadata.candidateSubtitles = { ...draft, path: file, revision, ...written, approval: null,
        edits: [...draft.edits, { authority: 'user', at: new Date().toISOString(), note: options.reviewNote,
            original, replacement, cue: cueIndex, changes, copyChanges, sourceSha256: evidence.sourceSha256 }] };
    metadata.status = 'pending_preflight';
    metadata.output.srtPath = file;
    return metadata.candidateSubtitles;
}

function approveCandidateDraft(metadata, evidence, note) {
    const draft = readCandidateDraft(metadata, evidence);
    if (!String(note || '').trim()) throw new Error('Upload authorization note is required');
    draft.approval = { authority: 'user', at: new Date().toISOString(), note,
        sourceSha256: evidence.sourceSha256, sha256: draft.sha256, revision: draft.revision, copySha256: copyDigest(metadata.copy) };
    metadata.status = 'render_queued';
    return draft;
}

function hasDraftApproval(metadata, evidence, expectedSha256 = null) {
    const draft = readCandidateDraft(metadata, evidence);
    const approval = draft.approval;
    return approval?.authority === 'user' && approval.sourceSha256 === evidence.sourceSha256
        && approval.sha256 === draft.sha256 && approval.revision === draft.revision
        && approval.copySha256 === copyDigest(metadata.copy) && (!expectedSha256 || expectedSha256 === draft.sha256);
}

function candidateDraftEvidence(metadata, evidence) {
    const draft = readCandidateDraft(metadata, evidence);
    const byId = new Map(draft.cues.map(cue => [cue.cueId, cue]));
    const cues = evidence.cues.map(cue => {
        const row = byId.get(cue.id);
        return row ? { ...cue, text: row.text, items: cue.items.map(item => ({ ...item, text: row.text })) } : cue;
    });
    return { evidence: { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) },
        segments: draft.cues.map(cue => ({ start: cue.sourceStart, end: cue.sourceEnd, text: cue.text })) };
}

module.exports = { ensureCandidateDraft, readCandidateDraft, correctCandidateDraft, approveCandidateDraft,
    hasDraftApproval, candidateDraftEvidence, writeJsonAtomic, digest };
