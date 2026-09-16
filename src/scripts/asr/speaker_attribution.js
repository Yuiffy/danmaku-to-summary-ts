'use strict';

// A structured local rejection must win over a legacy name embedded in SRT text.
function speakerForSegment(segment = {}) {
    const evidence = segment.speakerEvidence || segment.speaker_evidence;
    if (evidence) return evidence.status === 'row_supported' && evidence.label ? String(evidence.label) : 'UNKNOWN';
    const embedded = String(segment.text || '').match(/^\[([^\]\n]+)\]\s*/u);
    return String(segment.speaker || embedded?.[1] || 'UNKNOWN').replace(/\s+\d*\.?\d+$/u, '').trim() || 'UNKNOWN';
}

function prepareSpeakerSegments(segments = []) {
    return segments.map(segment => ({ ...segment, speaker: speakerForSegment(segment),
        text: String(segment.text || '').replace(/^\[[^\]\n]+\]\s*/u, '') }));
}

function loadSrtWithSpeakerEvidence(srtPath, parseSrt, backend) {
    const parsed = parseSrt(srtPath, backend);
    const provenance = require('./evidence_sidecar').loadAsrEvidence(srtPath, parsed.segments);
    return { ...parsed, segments: provenance.segments, asrEvidenceStatus: provenance.status };
}

module.exports = { speakerForSegment, prepareSpeakerSegments, loadSrtWithSpeakerEvidence };
