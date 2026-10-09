'use strict';

/** Optional music can be removed once; the replacement render must satisfy every original gate. */
async function renderAndAuditCreative(initialPlan, { render, inspect, audit, history }) {
    let plan = initialPlan;
    for (let attempt = 0; ; attempt++) {
        const rendered = await render(plan);
        await inspect(rendered, plan);
        const audioQa = attempt > 0 || plan.music || plan.effects.some(row => row.sound) ? await audit(plan) : null;
        if (audioQa) history.push({ stage: 'audio_technical_qa', attempt: attempt + 1, result: audioQa });
        if (!audioQa || audioQa.status === 'passed') return { plan, rendered, audioQa };
        const repairable = new Set(['original_audio_changed_outside_effects', 'background_music_too_quiet']);
        if (attempt !== 0 || !plan.music || !audioQa.issues?.length || !audioQa.issues.every(issue => repairable.has(issue))) {
            throw new Error(`Audio technical QA failed: ${(audioQa.issues || []).join(',')}`);
        }
        const { music, ...withoutMusic } = plan;
        plan = { ...withoutMusic, editorialProfile: { ...plan.editorialProfile, music: 'none' },
            assetDigests: Object.fromEntries(Object.entries(plan.assetDigests || {}).filter(([id]) => id !== music.id)) };
        history.push({ stage: 'audio_mix_repair', action: 'omit_optional_music', reason: audioQa.issues,
            music, note: 'Render again and rerun original audio gates; never accept the rejected mix' });
    }
}

module.exports = { renderAndAuditCreative };
