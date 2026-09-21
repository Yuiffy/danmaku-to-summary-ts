'use strict';
const crypto = require('crypto');
const { soundId } = require('./creative_assets');
const { SOUNDS } = require('./creative_plan');

/** Compare decoded stereo PCM. This verifies technical preservation, not whether a joke sounds good. */
function analyzeCreativeAudio(original, rendered, plan, assets = {}, sampleRate = 16000) {
    const channels = 2, bytesPerFrame = channels * 4;
    if (original.length % bytesPerFrame || rendered.length % bytesPerFrame) throw new Error('Incomplete decoded audio frame');
    const a = new Float32Array(original.buffer, original.byteOffset, original.length / 4);
    const b = new Float32Array(rendered.buffer, rendered.byteOffset, rendered.length / 4);
    const frames = Math.min(a.length, b.length) / channels;
    const windows = plan.effects.filter(row => row.sound).map(row => {
        const id = soundId(row.sound), start = row.start + (row.sound.offsetSeconds ?? 0);
        const seconds = assets[id]?.sampleSeconds ?? SOUNDS[id]?.duration;
        return { id, start, end: Math.min(plan.duration, start + seconds), count: 0, error: 0, source: 0 };
    });
    let count = 0, aa = 0, bb = 0, ab = 0, error = 0, peak = 0, finite = true;
    for (let frame = 0; frame < frames; frame++) {
        const time = frame / sampleRate;
        const activeEffects = windows.filter(row => time >= row.start - .05 && time < row.end + .05);
        for (let channel = 0; channel < channels; channel++) {
            const i = frame * channels + channel, x = a[i], y = b[i];
            if (!Number.isFinite(x) || !Number.isFinite(y)) { finite = false; continue; }
            peak = Math.max(peak, Math.abs(y));
            if (activeEffects.length) for (const effect of activeEffects) { effect.count++; effect.error += (x - y) ** 2; effect.source += x * x; }
            else { count++; aa += x * x; bb += y * y; ab += x * y; error += (x - y) ** 2; }
        }
    }
    const correlation = aa > 1e-8 && bb > 1e-8 ? ab / Math.sqrt(aa * bb) : null;
    const gain = aa > 1e-8 ? Math.sqrt(bb / aa) : null;
    const outsideErrorRms = count ? Math.sqrt(error / count) : 0;
    const effects = windows.map(row => {
        const sourceRms = Math.sqrt(row.source / Math.max(1, row.count)), differenceRms = Math.sqrt(row.error / Math.max(1, row.count));
        const addedRms = Math.sqrt(Math.max(0, differenceRms ** 2 - (plan.music ? outsideErrorRms ** 2 : 0)));
        return { id: row.id, start: row.start, end: row.end, sourceRms, differenceRms, addedRms,
            relativeDb: sourceRms > 1e-6 ? 20 * Math.log10(Math.max(1e-9, addedRms) / sourceRms) : null };
    });
    const issues = [];
    if (!finite || peak > 1.02) issues.push('invalid_or_clipped_audio_samples');
    if (Math.abs(a.length - b.length) / channels / sampleRate > .08 || Math.abs(frames / sampleRate - plan.duration) > .08) issues.push('audio_duration_changed');
    // Music intentionally lowers correlation; regression gain still checks that dialogue was retained at its original level.
    const originalGain = aa > 1e-8 ? ab / aa : null;
    if (correlation === null || correlation < (plan.music ? .75 : .98)
        || (plan.music ? originalGain < .94 || originalGain > 1.06 : gain < .85 || gain > 1.15)) issues.push('original_audio_changed_outside_effects');
    if (effects.some(row => row.differenceRms < Math.max(.0005, outsideErrorRms * 1.4))) issues.push('added_sound_not_measurable');
    if (plan.style === 'compact' && effects.some(row => row.addedRms < .006 || (row.relativeDb !== null && row.relativeDb < -11))) issues.push('sound_effect_too_quiet');
    if (plan.music && outsideErrorRms < .004) issues.push('background_music_too_quiet');
    const digest = data => crypto.createHash('sha256').update(data).digest('hex');
    return { version: 1, status: issues.length ? 'failed' : 'passed', issues, sampleRate, channels,
        originalPcmSha256: digest(original), renderedPcmSha256: digest(rendered), peak, correlation, gain, originalGain, outsideErrorRms,
        seconds: frames / sampleRate, effects, listeningReview: 'pending_human_review' };
}
module.exports = { analyzeCreativeAudio };
