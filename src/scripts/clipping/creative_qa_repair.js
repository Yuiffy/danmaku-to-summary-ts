'use strict';

/** A final-review repair may remove decoration, never rewrite evidence or crop safety. */
function applyVisualQaRepair(raw, response) {
    if (!Array.isArray(response?.repairs) || !response.repairs.length) throw new Error('No removable visual QA issue');
    const effects = raw.effects.map(row => ({ ...row })), seen = new Set();
    for (const repair of response.repairs) {
        const effect = effects.find(row => row.momentId === repair.momentId);
        if (!effect || seen.has(repair.momentId) || !Array.isArray(repair.remove) || !repair.remove.length
            || Object.keys(repair).some(key => !['momentId', 'remove', 'reason'].includes(key))
            || new Set(repair.remove).size !== repair.remove.length
            || repair.remove.some(key => !['filter', 'sticker'].includes(key) || !effect[key])) {
            throw new Error('Invalid visual QA removal');
        }
        seen.add(repair.momentId);
        for (const key of repair.remove) effect[key] = null;
    }
    return { ...raw, effects: effects.filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.sound || row.filter) };
}

module.exports = { applyVisualQaRepair };
