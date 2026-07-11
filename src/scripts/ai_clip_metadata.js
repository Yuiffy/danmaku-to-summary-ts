'use strict';

function registryEntries(config = {}) {
    return Object.values(config.ai?.streamerRegistry || {}).filter(Boolean);
}

function officialNames(entry = {}) {
    return Array.from(new Set([
        entry.displayName,
        ...(entry.searchTags || []),
        ...(entry.mentionLabels || [])
    ].map(value => String(value || '').trim()).filter(Boolean)));
}

function preferredName(entry = {}) {
    return String(entry.aiClipName || entry.uploadPrefix || '').replace(/[【】]/g, '').trim();
}

function postProcessAiClipMetadata({ title = '', tags = [] } = {}, config = {}) {
    let safeTitle = String(title || '');
    const blockedTags = new Set();

    for (const entry of registryEntries(config)) {
        const replacement = preferredName(entry);
        const names = officialNames(entry).sort((a, b) => b.length - a.length);
        names.forEach(name => blockedTags.add(name.toLocaleLowerCase()));
        if (replacement) {
            for (const name of names) {
                if (name === replacement) continue;
                safeTitle = safeTitle.split(name).join(replacement);
            }
        }
    }

    const safeTags = Array.from(new Set((Array.isArray(tags) ? tags : [])
        .map(tag => String(tag || '').trim())
        .filter(tag => tag && !blockedTags.has(tag.toLocaleLowerCase()))));

    return { title: safeTitle, tags: safeTags };
}

module.exports = { postProcessAiClipMetadata, officialNames, preferredName };
