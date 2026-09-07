'use strict';

const crypto = require('crypto');
const { collectSpokenClockValues, supportedClockSpans } = require('./clock_evidence');
const { reviewPersonEvidence } = require('./person_evidence');

function buildSubtitleEvidence(segments = [], options = {}) {
    const maxSeconds = Number(options.maxGroupSeconds) || 12;
    const gapSeconds = Number(options.gapSeconds) || 2;
    const maxChars = Number(options.maxGroupChars) || 400;
    const cues = [];
    const source = segments.map((segment, index) => ({
        index,
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text || ''),
        ...(segment.asrEvidence ? { asrEvidence: segment.asrEvidence } : {}),
        speaker: String(segment.speaker ?? segment.speaker_id ?? segment.text?.match(/^\[([^\]]+)\]/u)?.[1] ?? '')
    })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
    for (const item of source) {
        const last = cues.at(-1);
        if (options.groupSegments !== false && last && item.start >= last.start && item.start - last.end < gapSeconds
            && item.end - last.start <= maxSeconds && item.speaker === last.speaker
            && last.text.length + item.text.length + 1 <= maxChars) {
            last.end = Math.max(last.end, item.end);
            last.items.push(item);
            last.text = last.items.map(row => row.text.trim()).join(' ');
        } else {
            cues.push({ id: `G${item.index + 1}`, start: item.start, end: item.end,
                speaker: item.speaker, text: item.text.trim(), items: [item] });
        }
    }
    return {
        version: 1,
        sourceSha256: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'),
        cues,
        byId: new Map(cues.map(cue => [cue.id, cue]))
    };
}

function cuesForWindow(evidence, window) {
    return evidence.cues.filter(cue => cue.end > window.start && cue.start < window.end);
}

function formatEvidenceCues(cues) {
    // Display seconds are compact; cue IDs retain exact source boundaries.
    return cues.map(cue => `${cue.id} ${Math.floor(cue.start)}-${Math.ceil(cue.end)} ${cue.text}`).join('\n');
}

function resolveEvidenceBoundaries(raw, evidence) {
    if (!raw.startCueId && !raw.endCueId) return null;
    const start = evidence.byId.get(String(raw.startCueId));
    const end = evidence.byId.get(String(raw.endCueId));
    if (!start || !end || end.end <= start.start) throw new Error('Unknown or reversed boundary cue IDs');
    return { start: start.start, end: end.end, boundaryFromEvidence: true,
        startCueId: start.id, endCueId: end.id };
}

function linkClipEvidence(raw, clip, evidence, danmaku = [], available = {}) {
    const subtitleIds = Array.from(new Set((Array.isArray(raw.evidenceCueIds) ? raw.evidenceCueIds : []).map(String)));
    const danmakuIds = Array.from(new Set((Array.isArray(raw.evidenceDanmakuIds) ? raw.evidenceDanmakuIds : []).map(String)));
    const issues = [];
    const subtitles = subtitleIds.map(id => {
        const cue = evidence.byId.get(id);
        if (available.cueIds && !available.cueIds.has(id)) issues.push(`unseen_subtitle:${id}`);
        if (!cue) issues.push(`unknown_subtitle:${id}`);
        else if (cue.start < clip.start - 0.001 || cue.end > clip.end + 0.001) issues.push(`subtitle_outside_clip:${id}`);
        return cue ? { id, start: cue.start, end: cue.end, text: cue.text, sourceIndices: cue.items.map(item => item.index) } : null;
    }).filter(Boolean);
    const audience = danmakuIds.map(id => {
        const index = /^D[1-9]\d*$/u.test(id) ? Number(id.slice(1)) - 1 : -1;
        const row = danmaku[index];
        if (available.danmakuIds && !available.danmakuIds.has(id)) issues.push(`unseen_danmaku:${id}`);
        if (!row) issues.push(`unknown_danmaku:${id}`);
        else if (row.time < clip.start || row.time > clip.end) issues.push(`danmaku_outside_clip:${id}`);
        return row ? { id, time: row.time, text: row.text } : null;
    }).filter(Boolean);
    if (subtitles.length === 0) issues.push('missing_speech_evidence');
    const publicCopy = ['title', 'description', 'coverText'].map(field => String(raw[field] || '')).join(' ');
    if (/(?:观众|弹幕)/u.test(publicCopy) && audience.length === 0) issues.push('audience_attribution_needs_review');
    const normalize = text => String(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const sourceText = [...subtitles, ...audience].map(row => row.text).join(' ');
    const quotedEvidence = normalize(sourceText);
    const sourceNumbers = new Set(Array.from(sourceText.matchAll(/\d+(?:\.\d+)?/gu), match => match[0]));
    const clockValues = /\d{1,2}:\d{2}/u.test(publicCopy) ? collectSpokenClockValues([
        ...subtitles.filter(row => row.start >= clip.start - 0.001 && row.end <= clip.end + 0.001
            && (!available.cueIds || available.cueIds.has(row.id))),
        ...audience.filter(row => row.time >= clip.start && row.time <= clip.end
            && (!available.danmakuIds || available.danmakuIds.has(row.id)))
    ].map(row => row.text)) : null;
    for (const field of ['title', 'description', 'coverText']) {
        const copy = String(raw[field] || '');
        const clocks = clockValues?.size ? supportedClockSpans(copy, clockValues) : null;
        for (const match of copy.matchAll(/["“「]([^"”」\n]{2,80})["”」]/gu)) {
            const quote = normalize(match[1]);
            if (quote && !quotedEvidence.includes(quote)) issues.push(`unsupported_quote:${field}:${match[1]}`);
        }
        for (const match of copy.matchAll(/\d{2,}(?:\.\d+)?/gu)) {
            if (!sourceNumbers.has(match[0]) && !clocks?.some(span => span.start <= match.index && span.end >= match.index + match[0].length)) {
                issues.push(`unsupported_number:${field}:${match[0]}`);
            }
        }
    }
    const kinds = ['live_speech', 'recount', 'playback', 'audience', 'uncertain'];
    const sourceKind = kinds.includes(raw.sourceKind) ? raw.sourceKind : 'uncertain';
    if (sourceKind === 'uncertain') issues.push('uncertain_source');
    const unseen = {
        subtitleIds: subtitleIds.filter(id => available.cueIds && !available.cueIds.has(id)),
        danmakuIds: danmakuIds.filter(id => available.danmakuIds && !available.danmakuIds.has(id))
    };
    // Linking checks provenance and time bounds, not the truth of an ASR claim.
    const grounding = { version: 1, status: issues.length ? 'needs_review' : 'linked', sourceSha256: evidence.sourceSha256,
        sourceKind, subtitleIds, danmakuIds, subtitles, audience, unseen, issues };
    return reviewPersonEvidence(raw, clip, evidence, grounding, available.personContext);
}

function revalidateClipEvidence(clip, evidence, danmaku, personContext) {
    if (!clip.grounding) return clip;
    const previous = clip.grounding;
    const subtitleIds = Array.isArray(previous.subtitleIds) ? previous.subtitleIds.map(String) : [];
    const danmakuIds = Array.isArray(previous.danmakuIds) ? previous.danmakuIds.map(String) : [];
    const unseenSubtitles = new Set(Array.isArray(previous.unseen?.subtitleIds) ? previous.unseen.subtitleIds : []);
    const unseenDanmaku = new Set(Array.isArray(previous.unseen?.danmakuIds) ? previous.unseen.danmakuIds : []);
    const available = {
        cueIds: new Set(subtitleIds.filter(id => !unseenSubtitles.has(id))),
        danmakuIds: new Set(danmakuIds.filter(id => !unseenDanmaku.has(id))),
        personContext: personContext ?? (Array.isArray(previous.personEvidence?.checks)
            ? previous.personEvidence.checks.map(check => check?.person) : undefined)
    };
    const grounding = linkClipEvidence({ ...clip, evidenceCueIds: subtitleIds,
        evidenceDanmakuIds: danmakuIds, sourceKind: previous.sourceKind }, clip, evidence, danmaku, available);
    if (previous.sourceSha256 !== evidence.sourceSha256 || (Array.isArray(previous.issues) && previous.issues.includes('source_changed'))) {
        grounding.status = 'needs_review';
        grounding.issues.push('source_changed');
    }
    if (previous.reusedRecall !== undefined) grounding.reusedRecall = Boolean(previous.reusedRecall);
    return { ...clip, grounding };
}

function parseJsonResponse(text) {
    const value = String(text || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    let parsed;
    try { parsed = JSON.parse(value); } catch {
        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('Missing clips JSON');
        parsed = JSON.parse(value.slice(start, end + 1));
    }
    return parsed;
}

function parseClipResponse(text) {
    const parsed = parseJsonResponse(text);
    const clips = Array.isArray(parsed) ? parsed : parsed?.clips;
    if (!Array.isArray(clips)) throw new Error('Missing clips array');
    if (clips.some(clip => !clip || typeof clip !== 'object' || Array.isArray(clip))) {
        throw new Error('Invalid clip record');
    }
    return clips;
}

module.exports = { buildSubtitleEvidence, cuesForWindow, formatEvidenceCues,
    resolveEvidenceBoundaries, linkClipEvidence, revalidateClipEvidence, parseClipResponse, parseJsonResponse };
