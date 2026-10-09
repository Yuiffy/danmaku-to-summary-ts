'use strict';
const { validateCreativePlan, assertRenderPlan } = require('./creative_plan');
const { anchorSpatialPlan, validateAnchoredFaceInsets, focusBounds, layoutSubtitleAss } = require('./creative_layout');

/** Check every node, including the actual burn layout, before spending time on a render. */
function prepareCreativeDraft(raw, { moments, sourceId, duration, settings, assets, resolution, subtitleAss, subtitleStyle }) {
    if (!Array.isArray(raw?.effects)) throw new Error('Invalid creative effects');
    const issues = [], normalized = [];
    for (const row of raw.effects) {
        try {
            // Placement changes only follow schema validation; raw sticker positions use a different range.
            const anchored = validateAnchoredFaceInsets({ effects: [{ ...row, sticker: null }] }, resolution, settings).effects[0];
            const draft = { ...anchored, sticker: row.sticker };
            const checked = validateCreativePlan({ effects: [draft] }, moments, sourceId, duration, settings, assets);
            const spatial = anchorSpatialPlan(checked, resolution, settings, assets);
            for (const effect of spatial.effects) focusBounds(effect, resolution.width, resolution.height);
            layoutSubtitleAss(subtitleAss, spatial, subtitleStyle);
            normalized.push(draft);
        } catch (error) {
            const id = row?.momentId || 'unknown';
            issues.push(error.message.startsWith(`${id}:`) ? error.message : `${id}: ${error.message}`);
        }
    }
    if (issues.length) throw new Error(`Creative preflight failed:\n${issues.join('\n')}`);
    const plan = anchorSpatialPlan(validateCreativePlan({ ...raw, effects: normalized }, moments, sourceId, duration, settings, assets), resolution, settings, assets);
    // A sticker can be omitted when there is no room near its subject.
    plan.effects = plan.effects.filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.sound || row.filter);
    assertRenderPlan(plan, duration, settings, assets, true);
    layoutSubtitleAss(subtitleAss, plan, subtitleStyle);
    return plan;
}

function shouldConvertAvatarZoom(row, settings, profile, resolution) {
    if (row.zoom?.target !== 'avatar') return false;
    if (settings.avatarMode === 'circle') return true;
    if (settings.avatarMode !== 'auto' || settings.focusPlacement !== 'source'
        || !['gameplay', 'mixed', 'tutorial'].includes(profile?.kind)) return false;
    const box = row.zoom.targetBox;
    if (!box) return false;
    const side = Math.round(Math.max(box.width * resolution.width, box.height * resolution.height) * 1.55 / 2) * 2;
    const size = Math.round(Math.min(resolution.height * (settings.faceInsetDiameter || .46), resolution.width * .5) / 2) * 2;
    return size / side >= 1.2;
}

module.exports = { prepareCreativeDraft, shouldConvertAvatarZoom };
