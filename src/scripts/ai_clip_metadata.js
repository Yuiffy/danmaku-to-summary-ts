'use strict';

function registryEntries(config = {}) {
    return Object.values(config.ai?.streamerRegistry || {}).filter(Boolean);
}

function officialNames(entry = {}) {
    return Array.from(new Set([
        entry.displayName,
        ...(entry.searchTags || []),
        ...(entry.mentionLabels || []),
        ...(entry.speakerLabels || [])
    ].map(value => String(value || '').trim()).filter(Boolean)));
}

function preferredName(entry = {}) {
    return String(entry.aiClipName || entry.uploadPrefix || '').replace(/[【】]/g, '').trim();
}

function resolveAiStreamerName(config = {}, roomId = null, fallback = '主播') {
    const key = roomId ? String(roomId) : null;
    const entry = registryEntries(config).find(item => Array.isArray(item.roomIds)
        && item.roomIds.map(value => String(value)).includes(key));
    return preferredName(entry || {}) || String(fallback || '主播').replace(/[【】]/g, '').trim() || '主播';
}

function explicitUploadTags(entry = {}) {
    return (Array.isArray(entry.uploadTags) ? entry.uploadTags : [])
        .map(tag => String(tag || '').trim())
        .filter(Boolean);
}

function resolvePublicTagCandidates(entry = {}, roomSettings = {}) {
    const configured = [
        roomSettings.clipTitlePrefix,
        roomSettings.anchorName,
        entry.aiClipName,
        entry.uploadPrefix,
        ...(Array.isArray(entry.aiUploadTags) ? entry.aiUploadTags : []),
    ];
    const official = new Set(officialNames(entry).map(value => value.toLocaleLowerCase()));
    return Array.from(new Set(configured
        .map(value => String(value || '').replace(/[【】]/g, '').trim())
        .filter(value => value && !official.has(value.toLocaleLowerCase()))));
}

/**
 * Convert formal streamer names that triggered a topic clip into the public
 * nickname used by AI uploads. This keeps search evidence useful while the
 * automatic pipeline is still barred from publishing formal names such as
 * 岁己 and 栞栞.
 */
function deriveMentionedStreamerTags({ matchedKeywords = [], text = '' } = {}, config = {}) {
    const haystack = [
        ...(Array.isArray(matchedKeywords) ? matchedKeywords : []),
        String(text || ''),
    ].map(value => String(value || '')).filter(Boolean).join('\n');
    if (!haystack) return [];
    const tags = [];
    for (const entry of registryEntries(config)) {
        const names = Array.from(new Set([
            ...officialNames(entry),
            ...(Array.isArray(entry.aliases) ? entry.aliases : [])
        ])).sort((a, b) => b.length - a.length);
        if (!names.some(name => haystack.includes(name))) continue;
        const candidate = resolvePublicTagCandidates(entry)[0];
        if (candidate) tags.push(candidate);
    }
    return Array.from(new Set(tags));
}

function postProcessAiClipMetadata({ title = '', tags = [], requiredTags = [] } = {}, config = {}) {
    let safeTitle = String(title || '');
    const blockedTags = new Set();
    const allowedUploadTags = new Set();

    for (const entry of registryEntries(config)) {
        const replacement = preferredName(entry);
        const names = officialNames(entry).sort((a, b) => b.length - a.length);
        names.forEach(name => {
            // The configured AI clip name may also appear in mentionLabels;
            // keep that safe nickname available as a tag while blocking the
            // formal/ASR names from automatic AI uploads.
            if (!replacement || name !== replacement) {
                blockedTags.add(name.toLocaleLowerCase());
            }
        });
        explicitUploadTags(entry).forEach(tag => allowedUploadTags.add(tag.toLocaleLowerCase()));
        if (replacement) {
            for (const name of names) {
                if (name === replacement) continue;
                safeTitle = safeTitle.split(replacement).map(part => part.split(name).join(replacement)).join(replacement);
            }
        }
    }

    const safeTags = Array.from(new Set((Array.isArray(tags) ? tags : [])
        .map(tag => String(tag || '').trim())
        .filter(tag => tag && (
            allowedUploadTags.has(tag.toLocaleLowerCase())
            || !blockedTags.has(tag.toLocaleLowerCase())
        ))));

    // Reserve existing safe defaults before filling the SDK's ten tag slots.
    // Keep the original order and never add a tag absent from the reviewed input.
    const required = new Set(['AI切片', ...requiredTags]);
    const reserved = Array.from(required).filter(tag => safeTags.includes(tag)).slice(0, 10);
    const selected = new Set([...reserved, ...safeTags.filter(tag => !required.has(tag))
        .slice(0, 10 - reserved.length)]);
    return { title: safeTitle, tags: safeTags.filter(tag => selected.has(tag)) };
}

module.exports = {
    postProcessAiClipMetadata,
    officialNames,
    preferredName,
    resolveAiStreamerName,
    deriveMentionedStreamerTags,
    resolvePublicTagCandidates
};
