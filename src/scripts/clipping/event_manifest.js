'use strict';

const fs = require('fs');

const EVENT_MANIFEST_VERSION = 1;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
    for (const value of values) {
        const number = finiteNumber(value);
        if (number !== null) return number;
    }
    return null;
}

function normalizeSource(source = {}) {
    const mediaPath = String(source.mediaPath || source.media || '').trim();
    if (!mediaPath) throw new Error('event manifest source.mediaPath is required');
    return {
        id: String(source.id || 'source-1'),
        mediaPath,
        srtPath: source.srtPath ? String(source.srtPath) : null,
        xmlPath: source.xmlPath ? String(source.xmlPath) : null,
        recordedAt: source.recordedAt ? String(source.recordedAt) : null,
        metadata: source.metadata && typeof source.metadata === 'object'
            ? { ...source.metadata }
            : {}
    };
}

function normalizeEvent(raw = {}, index = 0, sourceId = 'source-1') {
    const start = firstFinite(raw.start, raw.sourceStart, raw.firstHit, raw.peak);
    const end = firstFinite(raw.end, raw.sourceEnd, raw.lastHit);
    const duration = firstFinite(raw.duration);
    const resolvedEnd = end === null && start !== null && duration !== null
        ? start + duration
        : end;
    if (start === null || resolvedEnd === null || resolvedEnd <= start) {
        throw new Error(`event ${index + 1} requires start < end`);
    }

    const evidence = Array.isArray(raw.evidence)
        ? raw.evidence.map(value => String(value)).filter(Boolean)
        : raw.evidence
            ? [String(raw.evidence)]
            : [];
    const metadata = raw.metadata && typeof raw.metadata === 'object'
        ? { ...raw.metadata }
        : {};
    const score = firstFinite(raw.score, raw.peakScore, raw.confidence);
    return {
        id: String(raw.id || raw.eventId || `event-${String(index + 1).padStart(4, '0')}`),
        sourceId: String(raw.sourceId || sourceId),
        start,
        end: resolvedEnd,
        duration: resolvedEnd - start,
        score,
        label: raw.label ? String(raw.label) : null,
        evidence,
        metadata
    };
}

function normalizeEventManifest(input = {}, options = {}) {
    const source = normalizeSource(input.source || input);
    const eventKey = String(options.eventKey || 'events');
    const rawEvents = Array.isArray(input[eventKey])
        ? input[eventKey]
        : Array.isArray(input.selectedEvents)
            ? input.selectedEvents
            : [];
    const events = rawEvents
        .map((event, index) => normalizeEvent(event, index, source.id))
        .sort((first, second) => first.start - second.start || first.id.localeCompare(second.id));
    return {
        version: EVENT_MANIFEST_VERSION,
        type: 'clip-event-manifest',
        source,
        events,
        metadata: input.metadata && typeof input.metadata === 'object'
            ? { ...input.metadata }
            : {}
    };
}

function mergeOverlappingEvents(events = [], toleranceSeconds = 0) {
    const sorted = events
        .map((event, index) => normalizeEvent(event, index, event.sourceId || 'source-1'))
        .sort((first, second) => first.start - second.start || first.id.localeCompare(second.id));
    const merged = [];
    for (const event of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || previous.sourceId !== event.sourceId
            || event.start > previous.end + Math.max(0, Number(toleranceSeconds) || 0)) {
            merged.push({ ...event, evidence: [...event.evidence], metadata: { ...event.metadata } });
            continue;
        }
        previous.end = Math.max(previous.end, event.end);
        previous.duration = previous.end - previous.start;
        previous.evidence = Array.from(new Set([...previous.evidence, ...event.evidence]));
        previous.metadata = { ...previous.metadata, ...event.metadata };
        if ((event.score ?? -Infinity) > (previous.score ?? -Infinity)) {
            previous.id = event.id;
            previous.label = event.label;
            previous.score = event.score;
        }
    }
    return merged;
}

function selectNonOverlappingEvents(events = [], options = {}) {
    const maxEvents = Number.isFinite(Number(options.maxEvents))
        ? Math.max(1, Math.floor(Number(options.maxEvents)))
        : Infinity;
    const minScore = finiteNumber(options.minScore);
    const gap = Math.max(0, Number(options.minGapSeconds) || 0);
    const candidates = events
        .map((event, index) => normalizeEvent(event, index, event.sourceId || 'source-1'))
        .filter(event => minScore === null || (event.score !== null && event.score >= minScore))
        .sort((first, second) => (second.score ?? -Infinity) - (first.score ?? -Infinity)
            || first.start - second.start);
    const selected = [];
    for (const candidate of candidates) {
        if (selected.some(event => event.sourceId === candidate.sourceId
            && candidate.start < event.end + gap
            && event.start < candidate.end + gap)) continue;
        selected.push(candidate);
        if (selected.length >= maxEvents) break;
    }
    return selected.sort((first, second) => first.start - second.start || first.id.localeCompare(second.id));
}

function readEventManifest(filePath, options = {}) {
    return normalizeEventManifest(
        JSON.parse(fs.readFileSync(filePath, 'utf8')),
        options
    );
}

function writeEventManifest(filePath, manifest) {
    const normalized = normalizeEventManifest(manifest);
    fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
}

module.exports = {
    EVENT_MANIFEST_VERSION,
    normalizeSource,
    normalizeEvent,
    normalizeEventManifest,
    mergeOverlappingEvents,
    selectNonOverlappingEvents,
    readEventManifest,
    writeEventManifest
};
