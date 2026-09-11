'use strict';
const crypto = require('node:crypto');
const live = require('./live_generation_context');

const MATERIAL_VERSION = 1;
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function getMaterialOptions(experiment) {
    const options = experiment?.replySummary?.sharedMaterial;
    if (options?.enabled !== true) return null;
    const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
        ? Math.max(min, Math.min(max, Number(value))) : fallback;
    return { enabled: true, maxMoments: Math.floor(bounded(options.maxMoments, 8, 4, 12)),
        contextSeconds: bounded(options.contextSeconds, 30, 20, 90),
        maxSourceChars: Math.floor(bounded(options.maxSourceChars, 45000, 8000, 80000)),
        maxSourceRatio: bounded(options.maxSourceRatio, 0.7, 0.1, 0.9) };
}

function materialSelectionPrompt(options) {
    return `\n\nShared source selection v${MATERIAL_VERSION}. Final outer JSON MUST have FOUR top-level keys: reply, content, evidence, moments. moments MUST NOT be inside content. content still has only overview, activityTypes, songs, games, topics.
All T IDs in the source are NONCONSECUTIVE group IDs. Copy the exact printed ID before a source group; NEVER infer T123 from a time, original subtitle position or a neighboring T122. If an ID is not visibly printed, it cannot be cited. Apply this to both evidence and moments. Do not list an uncertain song to fill a playlist.
moments is an array of 4-${options.maxMoments} records:
{"sourceIds":["T12","D20"],"interest":"brief reason this is a distinct, drawable moment"}.
Survey the entire stream, including its final quarter. Select source-grounded interactions, reversals, quiet funny details and distinct activities across at least three time quarters when the stream is long. Do not rank only by chat frequency. Include at least one worthwhile low-reaction or quiet moment when supported.
Each record must have 1-6 existing T/D IDs, including spoken evidence. Cite a coherent local event, never unrelated points over a long interval. Retain negation, uncertainty, guest/team attribution and whether something is performed, watched, mentioned or imagined. Song lyrics are not real actions.
These IDs let the program retrieve exact nearby original text for a later comic task. Do not write a comic script or quote/paraphrase the original evidence here. The reply may use its best moments; other selected moments should offer additional choices.`;
}

function renderRows(rows) {
    return rows.map(row => `${row.id} ${Math.floor(row.start)}-${Math.ceil(row.end)} ${row.source}${row.speaker ? ` [${row.speaker}]` : ''}: ${row.text}`).join('\n');
}

function buildMaterial(raw, accepted, source, payload, options) {
    if (!options || !Array.isArray(raw?.moments) || raw.moments.length < 4 || raw.moments.length > options.maxMoments) {
        throw new Error('Material selection requires distinct source moments');
    }
    const allRows = [...source.byId.values()].filter(row => row.source !== 'reply_dynamic');
    const duration = allRows.reduce((end, row) => Math.max(end, row.end), 0);
    const quarters = new Set();
    const seen = new Set();
    const momentRows = raw.moments.map(moment => {
        if (!Array.isArray(moment?.sourceIds) || moment.sourceIds.length < 1 || moment.sourceIds.length > 6
            || moment.sourceIds.some(id => typeof id !== 'string' || !source.byId.has(id) || id === 'P1')) {
            throw new Error('Material contains an invalid source ID');
        }
        const ids = [...new Set(moment.sourceIds)];
        const rows = ids.map(id => source.byId.get(id));
        if (!rows.some(row => row.source === 'speech')) throw new Error('Material moment has no spoken evidence');
        const start = Math.min(...rows.map(row => row.start));
        const signature = ids.slice().sort().join(',');
        if (seen.has(signature)) throw new Error('Repeated material moment');
        seen.add(signature);
        quarters.add(Math.min(3, Math.floor(start / Math.max(1, duration) * 4)));
        return rows;
    });
    if (duration >= 3600 && (quarters.size < 3 || !quarters.has(3))) throw new Error('Material selection misses stream coverage');
    // Also retain every accepted reply/activity citation, including reviewer repairs.
    const anchors = [...momentRows.flat(), ...(accepted.evidence || []).flatMap(record =>
        [...record.sources, ...(record.corroboration || [])].filter(row => row.source !== 'reply_dynamic'))];
    const intervals = anchors.map(row => ({ start: Math.max(0, row.start - options.contextSeconds), end: row.end + options.contextSeconds }));
    const rows = allRows.filter(row => intervals.some(range => row.end >= range.start && row.start <= range.end))
        .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id, 'en'));
    const sourceText = renderRows(rows);
    const sharedPrefix = [live.SHARED_PROMPT_CACHE_START, 'Original live excerpts selected from a full-stream reading.',
        'These are partial original sources, not a complete transcript. Missing material is unknown, not absent.',
        'T IDs are speech; D IDs are audience, never speaker identities. Preserve named/unknown speakers, negation and nearby context.',
        'Use only these original excerpts as event evidence. Watched videos, lyrics, imagined scenes and audience comments are not host actions.',
        'Excerpts keep their original timestamps. Across gaps, do not imply adjacent dialogue or a continuous event.',
        sourceText, live.SHARED_PROMPT_CACHE_END].join('\n');
    if (sharedPrefix.length > options.maxSourceChars || sharedPrefix.length >= payload.sharedPrefix.length * options.maxSourceRatio) {
        throw new Error('Material does not fit the complete-excerpt budget; use full source');
    }
    return { version: MATERIAL_VERSION, status: 'ready', roomId: payload.roomId,
        fullSourceSha256: payload.sourceSha256, fullPrefixSha256: payload.sharedPrefixSha256,
        sourceIds: rows.map(row => row.id), moments: momentRows.map(group => group.map(row => row.id)),
        timeQuarters: [...quarters].sort(), sourceText, sharedPrefix, sourceSha256: sha(sourceText),
        sharedPrefixSha256: sha(sharedPrefix), fullSourceChars: payload.sharedPrefix.length, selectedChars: sharedPrefix.length,
        coverage: 'selected_original_excerpts_with_context', semanticTruthProven: false };
}

module.exports = { MATERIAL_VERSION, getMaterialOptions, materialSelectionPrompt, buildMaterial, renderRows };
