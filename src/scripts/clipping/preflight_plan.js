'use strict';

const { parseJsonResponse, resolveEvidenceBoundaries, linkClipEvidence } = require('./subtitle_evidence');
const { normalizeCoverText } = require('./selection_result');
const { requiresBoundaryReview, reviewPreflightBoundaries } = require('./preflight_boundaries');

const SOURCE_KINDS = ['live_speech', 'recount', 'playback', 'audience', 'uncertain'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sameSpeech = value => String(value).replace(/[\s\p{P}]/gu, '').toLowerCase();

function normalizePreflightHits(raw, input) {
    if (!Array.isArray(raw) || raw.length !== input.hits.length) throw new Error('Every keyword anchor needs an assessment');
    const pending = new Map(input.hits.map(hit => [hit.id, hit]));
    const allowed = new Set(input.subtitles.map(cue => cue.id));
    return raw.map(row => {
        const hit = pending.get(row?.id);
        if (!hit || !['mention', 'false_match', 'uncertain'].includes(row.verdict) || !nonempty(row.reason)
            || !Array.isArray(row.evidenceCueIds) || !row.evidenceCueIds.includes(hit.cueId)
            || row.evidenceCueIds.some(id => !allowed.has(id))) throw new Error('Invalid keyword assessment or citations');
        pending.delete(row.id);
        return { ...hit, verdict: row.verdict, reason: row.reason.trim(), evidenceCueIds: row.evidenceCueIds };
    });
}

function editIsCorroborated(edit, cue, input, inside, hits) {
    if ((input.verifiedEdits || []).some(verified => verified.start === cue.start && verified.end === cue.end
        && verified.original === edit.original && verified.replacement === edit.replacement)) return true;
    const replacement = sameSpeech(edit.replacement);
    if (sameSpeech(edit.original) === replacement) return true;
    const offset = cue.text.indexOf(edit.original);
    const before = sameSpeech(cue.text.slice(0, offset)).slice(-3);
    const after = sameSpeech(cue.text.slice(offset + edit.original.length)).slice(0, 3);
    const phrase = before + replacement + after;
    const mentionsTarget = hits.some(hit => hit.verdict === 'mention' && edit.evidenceCueIds.includes(hit.cueId));
    const normalizedReference = text => {
        let value = sameSpeech(text);
        if (mentionsTarget) for (const form of [...input.target.possibleAsrForms, ...input.target.names]
            .map(sameSpeech).sort((a, b) => b.length - a.length)) value = value.split(form).join('@target@');
        return value;
    };
    const aligned = text => before || after
        ? sameSpeech(text).includes(phrase) || normalizedReference(text).includes(normalizedReference(phrase))
        : sameSpeech(text) === replacement;
    const raw = input.originalAsrSpans.find(span => span.id === cue.rawRef);
    if (raw && aligned(raw.rawText)) return true;
    if (input.unpromptedChecks.some(check => (check.segments || []).some(segment =>
        segment.end > cue.start && segment.start < cue.end && aligned(segment.text)))) return true;
    const targetAlias = input.target.names.some(name => sameSpeech(name) === replacement)
        && input.target.possibleAsrForms.some(form => sameSpeech(form) === sameSpeech(edit.original))
        && hits.some(hit => hit.cueId === cue.id && hit.verdict === 'mention');
    if (targetAlias) return true;
    if (input.target.names.some(name => sameSpeech(name) === replacement || sameSpeech(name) === sameSpeech(edit.original))) return false;
    const sensitive = /[不没未无别0-9零一二三四五六七八九十百千万]/u.test(edit.original + edit.replacement)
        || /^(我|你|他|她|它|我们|你们|他们|她们|它们)$/u.test(edit.original)
        || /^(我|你|他|她|它|我们|你们|他们|她们|它们)$/u.test(edit.replacement);
    if (sensitive) return false;
    if (edit.evidenceCueIds.some(id => id !== cue.id && inside.has(id)
        && (replacement.length > 1 ? sameSpeech(input.subtitles.find(row => row.id === id).text).includes(replacement)
            : aligned(input.subtitles.find(row => row.id === id).text)))) return true;
    return false;
}

function applyPreflightSubtitleEdits(rawEdits, bounds, evidence, input, hits) {
    if (!Array.isArray(rawEdits)) throw new Error('Missing subtitleEdits array');
    const inside = new Set(evidence.cues.filter(cue => cue.start >= bounds.start && cue.end <= bounds.end).map(cue => cue.id));
    const patches = new Map();
    const accepted = [];
    for (const edit of rawEdits) {
        const cue = input.subtitles.find(row => row.id === edit?.cueId);
        if (!cue || !inside.has(cue.id) || !nonempty(edit.original) || !nonempty(edit.replacement)
            || Array.from(edit.original).length > 16 || Array.from(edit.replacement).length > 16
            || /[\r\n\x00-\x1f]/u.test(edit.original + edit.replacement) || !nonempty(edit.reason)
            || !Array.isArray(edit.evidenceCueIds) || !edit.evidenceCueIds.includes(cue.id)
            || edit.evidenceCueIds.some(id => !inside.has(id))) throw new Error('Invalid or out-of-clip subtitle edit');
        const start = cue.text.indexOf(edit.original);
        if (start < 0 || start !== cue.text.lastIndexOf(edit.original)) throw new Error('Subtitle edit is stale or ambiguous');
        if (!editIsCorroborated(edit, cue, input, inside, hits)) throw new Error('Subtitle replacement lacks source corroboration');
        const end = start + edit.original.length;
        const previous = patches.get(cue.id) || [];
        if (previous.some(patch => start < patch.end && end > patch.start)) throw new Error('Overlapping subtitle edits');
        previous.push({ start, end, replacement: edit.replacement });
        patches.set(cue.id, previous);
        accepted.push({ ...edit, start: cue.start, end: cue.end });
    }
    const cues = evidence.cues.map(cue => {
        let text = cue.text;
        for (const patch of (patches.get(cue.id) || []).sort((a, b) => b.start - a.start)) {
            text = text.slice(0, patch.start) + patch.replacement + text.slice(patch.end);
        }
        return { ...cue, text, items: cue.items.map(item => ({ ...item, text })) };
    });
    return { edits: accepted, evidence: { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) },
        segments: cues.filter(cue => inside.has(cue.id)).map(cue => ({ ...cue.items[0], text: cue.text })) };
}

function reviewSubtitleEdits(rawEdits, bounds, evidence, input, hits) {
    if (!Array.isArray(rawEdits)) throw new Error('Missing subtitleEdits array');
    const accepted = (input.verifiedEdits || []).flatMap(verified => {
        const cue = input.subtitles.find(cue => cue.start === verified.start && cue.end === verified.end
            && cue.start >= bounds.start && cue.end <= bounds.end && cue.text.includes(verified.original));
        return cue ? [{ cueId: cue.id, original: verified.original, replacement: verified.replacement,
            reason: 'User-confirmed source correction', evidenceCueIds: [cue.id], authority: 'user' }] : [];
    }).filter((edit, index, all) => all.findIndex(item => item.cueId === edit.cueId
        && item.original === edit.original && item.replacement === edit.replacement) === index);
    const rejected = [];
    let prepared = applyPreflightSubtitleEdits(accepted, bounds, evidence, input, hits);
    for (const edit of rawEdits) {
        if (accepted.some(item => item.cueId === edit?.cueId && item.original === edit.original && item.replacement === edit.replacement)) continue;
        try { prepared = applyPreflightSubtitleEdits([...accepted, edit], bounds, evidence, input, hits); accepted.push(edit); }
        catch (error) { rejected.push({ ...edit, validationError: error.message, applied: false }); }
    }
    return { ...prepared, rejected };
}

function normalizePreflightResponse(text, input, evidence, config, options = {}) {
    if (evidence.cues.some(cue => cue.items.length !== 1)) throw new Error('Preflight requires per-subtitle evidence');
    const data = parseJsonResponse(text);
    const hits = options.lockedHits || normalizePreflightHits(data?.hits, input);
    if (!Array.isArray(data?.clips)) throw new Error('Missing preflight clips array');
    const allowed = new Set(input.subtitles.map(cue => cue.id));
    const ids = new Set();
    const clips = data.clips.map(raw => {
        const bounds = resolveEvidenceBoundaries(raw, evidence);
        if (!bounds || !allowed.has(bounds.startCueId) || !allowed.has(bounds.endCueId)
            || !nonempty(raw.id) || !raw.id.startsWith(`${input.groupId}-`) || ids.has(raw.id)
            || !['ready', 'needs_review'].includes(raw.status) || !SOURCE_KINDS.includes(raw.sourceKind)
            || !nonempty(raw.event) || !nonempty(raw.reason) || typeof raw.score !== 'number'
            || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100
            || !Array.isArray(raw.warnings) || raw.warnings.some(value => !nonempty(value))
            || !Array.isArray(raw.evidenceCueIds) || !raw.evidenceCueIds.length
            || !Array.isArray(raw.evidenceDanmakuIds) || !Array.isArray(raw.hitIds) || !raw.hitIds.length) {
            throw new Error('Invalid preflight clip schema or boundaries');
        }
        ids.add(raw.id);
        const duration = bounds.end - bounds.start;
        if (duration < config.minClipSeconds || duration > config.maxClipSeconds) throw new Error('Preflight duration outside limits');
        if (duration > config.preferredClipSeconds && !nonempty(raw.extensionReason)) throw new Error('Long event lacks completeness reason');
        const selectedHits = raw.hitIds.map(id => hits.find(hit => hit.id === id));
        if (selectedHits.some(hit => !hit || hit.start < bounds.start || hit.end > bounds.end)
            || selectedHits.every(hit => hit.verdict === 'false_match')) throw new Error('Clip has no eligible in-clip anchor');
        const locked = options.lockedClip;
        if (locked && (raw.id !== locked.id || bounds.start !== locked.start || bounds.end !== locked.end
            || JSON.stringify([...raw.hitIds].sort()) !== JSON.stringify([...locked.hitIds].sort()))) {
            throw new Error('Finishing changed the locked edit');
        }
        const issues = [];
        const boundary = reviewPreflightBoundaries(locked ? locked.boundaryReview : raw.boundaryReview,
            bounds, input, requiresBoundaryReview(config));
        issues.push(...boundary.issues);
        if (locked?.status === 'needs_review') issues.push(...locked.issues, 'The locked plan still requires human review');
        if (raw.status === 'needs_review' || raw.sourceKind === 'uncertain'
            || !selectedHits.some(hit => hit.verdict === 'mention')) issues.push('Model requests human review or identity remains uncertain');
        let subtitle = { edits: [], rejected: [], segments: evidence.cues.filter(cue => cue.start >= bounds.start && cue.end <= bounds.end)
            .map(cue => ({ ...cue.items[0] })), evidence };
        let copy = null;
        const finalizing = options.phase !== 'plan';
        try {
            if (options.phase === 'finish' && raw.subtitleEdits?.length) throw new Error('Final writer changed locked subtitles');
            subtitle = reviewSubtitleEdits(raw.subtitleEdits, bounds, evidence, input, hits);
            if (finalizing) {
                if (['title', 'description', 'coverText'].some(key => !nonempty(raw[key]))
                    || Array.from(raw.title).length > 52 || Array.from(raw.description).length > 50
                    || raw.coverText.replace(/\\n/g, '\n').trim().split(/\r?\n/).length !== 2
                    || !normalizeCoverText(raw.coverText)) throw new Error('Invalid final public copy');
                copy = { title: raw.title.trim(), description: raw.description.trim(), coverText: normalizeCoverText(raw.coverText) };
            }
        } catch (error) { issues.push(error.message); }
        const audience = [];
        for (const row of input.audience) audience[Number(row.id.slice(1)) - 1] = row;
        const grounding = linkClipEvidence(finalizing && copy ? { ...raw, ...copy } : {
            evidenceCueIds: raw.evidenceCueIds, evidenceDanmakuIds: raw.evidenceDanmakuIds, sourceKind: raw.sourceKind
        }, bounds, subtitle.evidence, audience, { cueIds: allowed, danmakuIds: new Set(input.audience.map(row => row.id)),
            referenceYear: Number(String(input.source?.recordedAt || '').match(/^(\d{4})-/u)?.[1]) });
        issues.push(...grounding.issues);
        return { ...bounds, id: raw.id, status: issues.length ? 'needs_review' : 'ready', event: raw.event,
            reason: raw.reason, score: raw.score, sourceKind: raw.sourceKind, extensionReason: raw.extensionReason || '',
            hitIds: raw.hitIds, hits: selectedHits, warnings: raw.warnings, issues, grounding,
            copy, subtitleEdits: subtitle.edits, rejectedSubtitleEdits: subtitle.rejected, subtitleSegments: subtitle.segments,
            boundaryReview: boundary.review,
            sourceSha256: evidence.sourceSha256, raw };
    }).sort((a, b) => a.start - b.start);
    if (clips.some((clip, index) => index && clip.start < clips[index - 1].end)) throw new Error('Preflight clips overlap');
    if (options.lockedClip && clips.length !== 1) throw new Error('Finishing must return the one locked clip');
    return { version: 1, groupId: input.groupId, sourceSha256: evidence.sourceSha256, hits, clips };
}

module.exports = { normalizePreflightHits, applyPreflightSubtitleEdits, normalizePreflightResponse };
