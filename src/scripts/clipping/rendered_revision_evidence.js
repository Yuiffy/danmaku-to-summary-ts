'use strict';

const { readCandidateDraft } = require('./candidate_subtitles');
const { buildSubtitleEvidence } = require('./subtitle_evidence');

function publicDescription(metadata, value) {
    if (metadata.mode !== 'own_stream_fun_review') return value;
    for (const emotionEvidence of [metadata.candidate?.emotionEvidence, []]) {
        const prefix = require('../own_stream_clipper').buildClipDescription({ streamerName: metadata.streamerName,
            streamTitle: metadata.streamTitle, recordedAt: metadata.recordedAt,
            start: metadata.window.start, end: metadata.window.end, description: '', emotionEvidence });
        if (String(value || '').startsWith(prefix + '\n\n')) return String(value).slice(prefix.length + 2);
        const parts = String(value || '').split(/\r?\n\s*\r?\n/u);
        if (parts.length > 1 && parts[0].replace(/\s/gu, '') === prefix.replace(/\s/gu, '')) return parts.slice(1).join('\n\n');
    }
    return value;
}

function adapter(metadata) {
    return { ...metadata, output: { ...metadata.output }, copy: { ...metadata.copy,
        description: publicDescription(metadata, metadata.copy?.description) },
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

module.exports = { publicDescription, adapter, checkedDraft, revisionEvidence };
