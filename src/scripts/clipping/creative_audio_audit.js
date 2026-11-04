'use strict';
const crypto = require('crypto');
const { soundId } = require('./creative_assets');
const { SOUNDS } = require('./creative_plan');

function chooseMusicForDialogue(profile, dialogueRms) {
    if (profile.music !== 'playful') return { enabled: false, reason: 'Editorial profile does not call for music' };
    if (Number.isFinite(dialogueRms) && dialogueRms < .055) return { enabled: false, reason: `Quiet source dialogue (RMS ${dialogueRms.toFixed(4)}) takes priority over background music` };
    return { enabled: true, reason: 'Dialogue level does not block background music' };
}

function dialogueRmsFromPcm(pcm) {
    if (pcm.length % 4) throw new Error('Incomplete dialogue PCM sample');
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    let sum = 0;
    for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new Error('Invalid dialogue PCM sample');
        sum += sample * sample;
    }
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Compare decoded stereo PCM. This verifies technical preservation, not whether a joke sounds good.
 * spedSpans are output-time {start,end} intervals played through atempo chains: per-sample
 * phase there is an implementation detail of piecewise tempo filters plus the AAC round-trip,
 * so those intervals get an energy-level check instead of the strict correlation gate. */
function analyzeCreativeAudio(original, rendered, plan, assets = {}, sampleRate = 16000, spedSpans = []) {
    const channels = 2, bytesPerFrame = channels * 4;
    if (original.length % bytesPerFrame || rendered.length % bytesPerFrame) throw new Error('Incomplete decoded audio frame');
    const a = new Float32Array(original.buffer, original.byteOffset, original.length / 4);
    const b = new Float32Array(rendered.buffer, rendered.byteOffset, rendered.length / 4);
    const frames = Math.min(a.length, b.length) / channels;
    const windows = plan.effects.filter(row => row.sound).map(row => {
        const id = soundId(row.sound), start = row.start + (row.sound.offsetSeconds ?? 0);
        const seconds = row.sound.durationSeconds ?? assets[id]?.sampleSeconds ?? SOUNDS[id]?.duration;
        return { id, start, end: Math.min(plan.duration, start + seconds), count: 0, error: 0, source: 0 };
    });
    const sped = spedSpans.map(row => ({ start: Number(row.start), end: Number(row.end), aa: 0, bb: 0, env: [] }));
    let count = 0, aa = 0, bb = 0, ab = 0, error = 0, peak = 0, finite = true;
    const blocks = new Map();
    for (let frame = 0; frame < frames; frame++) {
        const time = frame / sampleRate;
        const activeEffects = windows.filter(row => time >= row.start - .05 && time < row.end + .05);
        const activeSped = sped.find(row => time >= row.start && time < row.end);
        for (let channel = 0; channel < channels; channel++) {
            const i = frame * channels + channel, x = a[i], y = b[i];
            if (!Number.isFinite(x) || !Number.isFinite(y)) { finite = false; continue; }
            peak = Math.max(peak, Math.abs(y));
            if (activeEffects.length) for (const effect of activeEffects) { effect.count++; effect.error += (x - y) ** 2; effect.source += x * x; }
            else if (activeSped) {
                activeSped.aa += x * x; activeSped.bb += y * y;
                const bucket = Math.floor((time - activeSped.start) / .02);
                const envelope = activeSped.env[bucket] || (activeSped.env[bucket] = { a: 0, b: 0 });
                envelope.a += x * x; envelope.b += y * y;
            }
            else {
                count++; aa += x * x; bb += y * y; ab += x * y; error += (x - y) ** 2;
                const key = Math.floor(time * 2), block = blocks.get(key) || { aa: 0, ab: 0 };
                block.aa += x * x; block.ab += x * y; blocks.set(key, block);
            }
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
    const activeBlocks = [...blocks.values()].filter(block => block.aa > sampleRate * channels * .5 * .000025);
    const missingDialogue = plan.music && activeBlocks.some(block => block.ab / block.aa < .75);
    if (correlation === null || (plan.music ? missingDialogue : correlation < .98)
        || (plan.music ? originalGain < .94 || originalGain > 1.06 : gain < .85 || gain > 1.15)) issues.push('original_audio_changed_outside_effects');
    // Accelerated spans: tempo chains plus the encode/decode round-trip shift phase at the
    // millisecond level, so per-sample correlation is meaningless (8x atempo can invert it).
    // Compare 20 ms energy envelopes instead: phase-insensitive, but still catches dropped or
    // replaced audio. Measured healthy range on real 8x clips is 0.92-1.00.
    const spedScores = sped.map(row => {
        let aa = 0, bb = 0, ab = 0, framesInSpan = 0;
        for (const envelope of row.env) {
            if (!envelope) continue;
            const x = Math.sqrt(envelope.a), y = Math.sqrt(envelope.b);
            aa += x * x; bb += y * y; ab += x * y; framesInSpan++;
        }
        return { row, gain: aa > 1e-12 ? Math.sqrt(bb / aa) : null,
            envelopeCorrelation: aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : null, framesInSpan };
    });
    if (spedScores.some(({ row, gain: spedGain, envelopeCorrelation, framesInSpan }) => {
        // A span wholly covered by an added sound has no samples in its own bucket; that
        // window is verified by the effect checks above, not by the envelope comparison.
        if (row.aa <= 1e-6 || !framesInSpan) return false;
        return !Number.isFinite(spedGain) || spedGain < .6 || spedGain > 1.6
            || (framesInSpan >= 3 && envelopeCorrelation !== null && envelopeCorrelation < .85);
    })) issues.push('original_audio_changed_outside_effects');
    if (effects.some(row => row.differenceRms < Math.max(.0005, outsideErrorRms * 1.4))) issues.push('added_sound_not_measurable');
    if (plan.style === 'compact' && effects.some(row => row.addedRms < .006 || (row.relativeDb !== null && row.relativeDb < -11))) issues.push('sound_effect_too_quiet');
    if (plan.music && outsideErrorRms < .004) issues.push('background_music_too_quiet');
    const digest = data => crypto.createHash('sha256').update(data).digest('hex');
    return { version: 1, status: issues.length ? 'failed' : 'passed', issues, sampleRate, channels,
        originalPcmSha256: digest(original), renderedPcmSha256: digest(rendered), peak, correlation, gain, originalGain, outsideErrorRms,
        seconds: frames / sampleRate, effects, dialogueBlocksChecked: activeBlocks.length,
        spedSpans: spedScores.map(({ row, gain: spedGain, envelopeCorrelation }) => ({ start: row.start, end: row.end,
            gain: spedGain, envelopeCorrelation })),
        listeningReview: 'pending_human_review' };
}
module.exports = { analyzeCreativeAudio, chooseMusicForDialogue, dialogueRmsFromPcm };
