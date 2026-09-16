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

function explicitUploadTags(entry = {}) {
    return (Array.isArray(entry.uploadTags) ? entry.uploadTags : [])
        .map(tag => String(tag || '').trim())
        .filter(Boolean);
}

function postProcessAiClipMetadata({ title = '', tags = [] } = {}, config = {}) {
    let safeTitle = String(title || '');
    const blockedTags = new Set();
    const allowedUploadTags = new Set();

    for (const entry of registryEntries(config)) {
        const replacement = preferredName(entry);
        const names = officialNames(entry).sort((a, b) => b.length - a.length);
        names.forEach(name => blockedTags.add(name.toLocaleLowerCase()));
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

    return { title: safeTitle, tags: safeTags };
}

module.exports = { postProcessAiClipMetadata, officialNames, preferredName };
