'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_FACTS_FILE = path.resolve(__dirname, '../../../data/runtime/topic_verified_facts.json');

function loadVerifiedTopicFacts(srtPath, window, registryPath = DEFAULT_FACTS_FILE) {
    if (!srtPath || !fs.existsSync(registryPath)) return { status: 'missing', verifiedFacts: [], verifiedEdits: [] };
    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        if (registry.version !== 1 || !Array.isArray(registry.entries)) throw new Error('Invalid verified topic facts registry');
        const normalized = path.resolve(srtPath).toLowerCase();
        const entries = registry.entries.filter(entry => typeof entry.srtPath === 'string'
            && path.resolve(entry.srtPath).toLowerCase() === normalized
            && Number.isFinite(entry.start) && Number.isFinite(entry.end)
            && entry.end > window.start && entry.start < window.end);
        if (!entries.length) return { status: 'missing', verifiedFacts: [], verifiedEdits: [] };
        const hash = crypto.createHash('sha256').update(fs.readFileSync(srtPath)).digest('hex');
        const valid = entries.filter(entry => entry.sourceSha256 === hash && entry.authority === 'user');
        const facts = valid.flatMap(entry => Array.isArray(entry.facts)
            ? entry.facts.filter(fact => typeof fact === 'string' && fact.trim())
                .map(text => ({ text, start: entry.start, end: entry.end })) : []);
        const edits = valid.flatMap(entry => Array.isArray(entry.edits) ? entry.edits.filter(edit =>
            Number.isFinite(edit.start) && Number.isFinite(edit.end) && edit.end > edit.start
            && edit.start >= entry.start && edit.end <= entry.end && edit.start >= window.start && edit.end <= window.end
            && typeof edit.original === 'string' && edit.original && typeof edit.replacement === 'string' && edit.replacement) : []);
        return { status: valid.length ? 'matched' : 'stale', verifiedFacts: facts, verifiedEdits: edits };
    } catch (error) { return { status: 'invalid', reason: error.message, verifiedFacts: [], verifiedEdits: [] }; }
}

module.exports = { loadVerifiedTopicFacts, DEFAULT_FACTS_FILE };
