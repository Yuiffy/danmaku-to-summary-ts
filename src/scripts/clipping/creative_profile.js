'use strict';

function editorialProfile(value, { legacy = false } = {}) {
    if (!value && legacy) return { kind: 'mixed', tone: 'comic', density: 'dense', preserveContinuity: false,
        music: 'playful', laughter: true, reason: 'Reuse the previously approved comic edit', basis: 'approved_legacy_edit' };
    if (!value || !['gameplay', 'conversation', 'story', 'tutorial', 'performance', 'mixed'].includes(value.kind)
        || !['comic', 'neutral', 'serious'].includes(value.tone) || !['dense', 'moderate', 'light'].includes(value.density)
        || typeof value.preserveContinuity !== 'boolean' || !['playful', 'none'].includes(value.music)
        || typeof value.laughter !== 'boolean' || !String(value.reason || '').trim()) throw new Error('A content-specific editorial profile is required');
    if (value.tone !== 'comic' && (value.laughter || value.music === 'playful')) throw new Error('Neutral/serious material cannot inherit comic laughter or playful music');
    if (value.kind === 'performance' && (!value.preserveContinuity || value.music !== 'none' || value.laughter)) {
        throw new Error('Continuous performance must preserve its phrases and original music');
    }
    return { kind: value.kind, tone: value.tone, density: value.density, preserveContinuity: value.preserveContinuity,
        music: value.music, laughter: value.laughter, reason: value.reason };
}

function isLaughter(id, assets) {
    return ['audience_laugh', 'sitcom_laugh'].includes(id) || assets[id]?.family === 'laughter';
}

function sameEditorialProfile(a, b) {
    const key = value => {
        const p = value || editorialProfile(null, { legacy: true });
        return JSON.stringify(['kind', 'tone', 'density', 'preserveContinuity', 'music', 'laughter'].map(field => p[field]));
    };
    return key(a) === key(b);
}

/** Deterministic, content-aware rotation. Different IDs for the same excerpt do not count as variety. */
function rotateLaughter(raw, assets, settings = {}, moments = [], profile = null) {
    const { soundId } = require('./creative_assets');
    const ids = settings.laughAssets?.length ? settings.laughAssets : settings.laughAsset ? [settings.laughAsset] : [];
    if (!ids.length && profile?.laughter !== false) return raw;
    const pool = ids.map(id => assets[id]).filter(asset => asset?.kind === 'sound');
    const key = asset => `${asset.sha256}:${asset.sampleStart}:${asset.sampleSeconds}`;
    const counts = new Map(), assigned = new Map(); let previous = null;
    const rows = [...(raw.effects || [])].sort((a, b) => (moments.find(m => m.id === a.momentId)?.start || 0) - (moments.find(m => m.id === b.momentId)?.start || 0));
    for (const row of rows) {
        if (!isLaughter(soundId(row.sound), assets)) continue;
        if (profile?.laughter === false) { assigned.set(row.momentId, null); continue; }
        if (!pool.length) throw new Error('No configured laugh variations are installed');
        const alternatives = pool.filter(asset => key(asset) !== previous);
        const eligible = alternatives.length ? alternatives : pool;
        const requested = row.sound?.intensity;
        const ordered = [...eligible].sort((a, b) => (counts.get(key(a)) || 0) - (counts.get(key(b)) || 0)
            || Number(b.intensity === requested) - Number(a.intensity === requested));
        const chosen = ordered[0]; previous = key(chosen); counts.set(previous, (counts.get(previous) || 0) + 1);
        assigned.set(row.momentId, { ...(typeof row.sound === 'object' ? row.sound : {}), id: chosen.id });
    }
    return { ...raw, effects: raw.effects?.map(row => assigned.has(row.momentId) ? { ...row, sound: assigned.get(row.momentId) } : row) };
}
module.exports = { editorialProfile, rotateLaughter, isLaughter, sameEditorialProfile };
