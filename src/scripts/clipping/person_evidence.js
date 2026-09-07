'use strict';

const { officialNames, preferredName } = require('../ai_clip_metadata');

function buildPersonEvidenceContext(config = {}, roomId) {
    return Object.entries(config.ai?.streamerRegistry || {}).filter(([, entry]) => entry && typeof entry === 'object')
        .map(([id, entry]) => ({
            id,
            label: String(entry.displayName || id),
            names: Array.from(new Set([...officialNames({ displayName: entry.displayName,
                searchTags: Array.isArray(entry.searchTags) ? entry.searchTags : [] }), preferredName(entry)]))
                .filter(name => name.length > 1),
            sourceHost: roomId != null && Array.isArray(entry.roomIds) && entry.roomIds.map(String).includes(String(roomId))
        })).filter(person => person.names.length);
}

function nameMatcher(names) {
    const patterns = names.map(name => {
        const normalized = name.normalize('NFKC').toLowerCase();
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp((/^[a-z0-9_]/u.test(normalized) ? '(?<![a-z0-9_])' : '') + escaped
            + (/[a-z0-9_]$/u.test(normalized) ? '(?![a-z0-9_])' : ''), 'u');
    });
    return value => {
        const text = String(value || '').normalize('NFKC').toLowerCase();
        return patterns.some(pattern => pattern.test(text));
    };
}

function reviewPersonEvidence(raw, clip, evidence, grounding, people) {
    if (!Array.isArray(people) || !people.length) return grounding;
    const checks = [];
    const issues = [...grounding.issues];
    const unseenSubtitles = new Set(grounding.unseen?.subtitleIds || []);
    const unseenDanmaku = new Set(grounding.unseen?.danmakuIds || []);
    const subtitles = grounding.subtitles.filter(row => row.start >= clip.start - 0.001 && row.end <= clip.end + 0.001
        && !unseenSubtitles.has(row.id));
    const audience = grounding.audience.filter(row => row.time >= clip.start && row.time <= clip.end && !unseenDanmaku.has(row.id));
    for (const person of people) {
        if (!person || !Array.isArray(person.names) || !person.names.length || person.names.some(name => typeof name !== 'string' || !name)) continue;
        const matches = nameMatcher(person.names);
        const fields = ['title', 'description', 'coverText'].filter(field => matches(raw[field]));
        if (!fields.length) continue;
        // Speaker prefixes and ASR aliases are not independent evidence of a name.
        const subtitleIds = subtitles.filter(row => evidence.byId.get(row.id)?.items.some(item =>
            matches(String(item.text || '').replace(/^(?:\s*\[[^\]\n]+\])+\s*/u, '')))).map(row => row.id);
        const danmakuIds = audience.filter(row => matches(row.text)).map(row => row.id);
        const basis = subtitleIds.length ? 'cited_subtitle_mention' : danmakuIds.length ? 'cited_audience_mention'
            : person.sourceHost ? 'source_host_metadata' : 'unreferenced';
        if (basis === 'unreferenced' || basis === 'cited_audience_mention') {
            const issue = basis === 'unreferenced' ? 'unreferenced_person' : 'person_only_in_danmaku';
            fields.forEach(field => issues.push(`${issue}:${field}:${person.label}`));
        }
        checks.push({ person, fields, basis, subtitleIds, danmakuIds });
    }
    if (!checks.length) return grounding;
    // Mention presence does not verify the speaker, action, relationship, or ASR text.
    return { ...grounding, issues, status: issues.length ? 'needs_review' : 'linked',
        personEvidence: { version: 1, scope: 'configured_names_only', identityVerified: false, checks } };
}

module.exports = { buildPersonEvidenceContext, reviewPersonEvidence };
