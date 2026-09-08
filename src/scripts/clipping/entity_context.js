'use strict';
const crypto = require('crypto');
const { nameMatcher } = require('./person_evidence');

const normalizeName = value => String(value || '').normalize('NFKC').trim().toLowerCase();
function matchesNameMention(mention, name) {
    const value = normalizeName(mention), base = normalizeName(name);
    if (!base) return false;
    if (value === base) return true;
    const suffixes = ['前辈', '老师', '先生', '女士', '同学', '小姐', '姐', '哥'];
    if (suffixes.some(suffix => value === base + suffix || value === `${base} ${suffix}`)) return true;
    return value.replace(/^(?:mr|mrs|ms|dr)\.?\s+/u, '') === base;
}
const bounded = (value, fallback, maximum) => Number.isFinite(Number(value))
    ? Math.max(0, Math.min(maximum, Number(value))) : fallback;
const rawCueText = cue => (cue.items || [cue]).map(item => String(item.text || '')
    .replace(/^(?:\s*\[[^\]\n]+\])+\s*/u, '')).join(' ');
const entityDigest = context => {
    const { digest, ...data } = context;
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
};

function referenceHintsFor(entry, rootConfig, names = []) {
    const known = new Set(names.map(normalizeName));
    const hints = new Map();
    const add = (value, kind, source) => {
        if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 60 || known.has(normalizeName(value))) return;
        const key = normalizeName(value);
        if (!hints.has(key)) hints.set(key, { name: value.trim(), kind, source });
    };
    for (const room of entry.roomIds || []) add(rootConfig.ai?.roomSettings?.[String(room)]?.anchorName,
        'nickname', `ai.roomSettings.${room}.anchorName`);
    for (const name of entry.mentionLabels || []) add(name, 'nickname', 'streamerRegistry.mentionLabels');
    for (const name of entry.aliases || []) add(name, 'asr_variant', 'streamerRegistry.aliases');
    return [...hints.values()];
}

function referenceNames(person) {
    return [...new Set([...(person.names || []), ...(person.referenceHints || []).map(hint => hint.name)])];
}

function buildEntityContext(clip, evidence, danmaku, context, settings) {
    if (settings?.enabled !== true) return null;
    const seconds = bounded(settings.contextSeconds, 90, 180);
    const maxRows = Math.floor(bounded(settings.maxContextRows, 24, 48));
    const maxChars = Math.floor(bounded(settings.maxContextChars, 6000, 12000));
    const nearby = evidence.cues.filter(cue => cue.end > clip.start - seconds && cue.start < clip.end + seconds);
    const localText = nearby.filter(cue => cue.start >= clip.start - .001 && cue.end <= clip.end + .001).map(rawCueText).join('\n');
    const comments = danmaku.map((row, index) => ({ sourceId: `D${index + 1}`, kind: 'audience', start: row.time, end: row.time, text: row.text }))
        .filter(row => row.start >= clip.start - seconds && row.start <= clip.end + seconds);
    const surroundingText = [...nearby.map(rawCueText), ...comments.map(row => row.text)].join('\n');
    const people = (context?.people || []).map(person => ({ person, match: nameMatcher(referenceNames(person)) }))
        .filter(({ person, match }) => person.sourceHost || match(surroundingText))
        .sort((a, b) => Number(b.match(localText)) - Number(a.match(localText)))
        .map(({ person }) => ({ id: person.id, name: person.label, copyName: person.preferredName || person.label,
            names: person.names, hints: person.referenceHints || [], presence: person.presence || 'mentioned_only' }));
    const matches = people.map(person => ({ canonical: nameMatcher(person.names), hints: person.hints.map(hint => nameMatcher([hint.name])) }));
    const rows = [...nearby.filter(cue => cue.start < clip.start - .001 || cue.end > clip.end + .001)
        .map(cue => ({ sourceId: cue.id, kind: 'speech', start: cue.start, end: cue.end, text: rawCueText(cue) })), ...comments];
    const ranked = rows.map(row => ({ row, score: matches.reduce((sum, item) => sum
        + (item.canonical(row.text) ? 4 : 0) + item.hints.filter(match => match(row.text)).length
        + (item.canonical(row.text) && item.hints.some(match => match(row.text)) ? 20 : 0), 0),
    distance: Math.max(0, clip.start - row.end, row.start - clip.end) }))
        .filter(item => item.score || item.row.kind === 'speech')
        .sort((a, b) => b.score - a.score || a.distance - b.distance || a.row.start - b.row.start);
    let chars = 0;
    const selected = [];
    for (const { row } of ranked) {
        if (selected.length >= maxRows) break;
        if (chars + row.text.length > maxChars) continue;
        selected.push(row);
        chars += row.text.length;
    }
    const result = { version: 1, sourceSha256: evidence.sourceSha256, start: clip.start, end: clip.end,
        purpose: 'name_resolution_only', contextSeconds: seconds,
        maxReferenceGapSeconds: bounded(settings.maxReferenceGapSeconds, 120, 300), people,
        rows: selected.sort((a, b) => a.start - b.start || a.sourceId.localeCompare(b.sourceId))
            .map((row, index) => ({ id: `N${index + 1}`, ...row })),
        omittedRows: ranked.length - selected.length };
    return { ...result, digest: entityDigest(result) };
}

module.exports = { normalizeName, matchesNameMention, referenceHintsFor, referenceNames, buildEntityContext, entityDigest, rawCueText };
