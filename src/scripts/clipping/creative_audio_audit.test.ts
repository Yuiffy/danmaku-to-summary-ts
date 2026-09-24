export {};
const { analyzeCreativeAudio, chooseMusicForDialogue, dialogueRmsFromPcm } = require('./creative_audio_audit');
const rate = 1000;
const plan = { duration: 6, effects: [{ start: 1, end: 2, sound: { id: 'laugh', offsetSeconds: .2 } }] };
const assets = { laugh: { sampleSeconds: .5 } };
function pcm(mix = false, drop = false) {
    const samples = new Float32Array(6 * rate * 2);
    for (let i = 0; i < samples.length; i++) {
        const time = Math.floor(i / 2) / rate;
        samples[i] = drop && time >= 4 && time < 5 ? 0 : .2 * Math.sin(2 * Math.PI * 37 * time);
        if (mix && time >= 1.2 && time < 1.7) samples[i] += .04 * Math.sin(2 * Math.PI * 151 * time);
    }
    return Buffer.from(samples.buffer);
}
test('actual decoded samples demonstrate added sound and preservation elsewhere, leaving listening review explicit', () => {
    const result = analyzeCreativeAudio(pcm(), pcm(true), plan, assets, rate);
    expect(result.status).toBe('passed'); expect(result.correlation).toBeCloseTo(1);
    expect(result.effects[0].differenceRms).toBeGreaterThan(.01);
    expect(result.listeningReview).toBe('pending_human_review');
});
test('silent additions, dropped original audio, and truncated audio are rejected', () => {
    expect(analyzeCreativeAudio(pcm(), pcm(), plan, assets, rate).issues).toContain('added_sound_not_measurable');
    expect(analyzeCreativeAudio(pcm(), pcm(true, true), plan, assets, rate).issues).toContain('original_audio_changed_outside_effects');
    expect(analyzeCreativeAudio(pcm(), pcm(true).subarray(0, 40000), plan, assets, rate).issues).toContain('audio_duration_changed');
});

test('compact mode rejects measurable but masked laughter instead of claiming audibility', () => {
    const normal = pcm(), tooQuiet = pcm();
    const samples = new Float32Array(tooQuiet.buffer, tooQuiet.byteOffset, tooQuiet.length / 4);
    for (let i = 0; i < samples.length; i++) {
        const t = Math.floor(i / 2) / rate;
        if (t >= 1.2 && t < 1.7) samples[i] += .015 * Math.sin(2 * Math.PI * 151 * t);
    }
    expect(analyzeCreativeAudio(normal, tooQuiet, plan, assets, rate).status).toBe('passed');
    const audited = analyzeCreativeAudio(normal, tooQuiet, { ...plan, style: 'compact' }, assets, rate);
    expect(audited.issues).toContain('sound_effect_too_quiet');
    expect(audited.effects[0].relativeDb).toBeLessThan(-20);
});

test('music may lower correlation while original dialogue remains, but a missing half-second is rejected', () => {
    const original = pcm(), withMusic = pcm();
    const samples = new Float32Array(withMusic.buffer, withMusic.byteOffset, withMusic.length / 4);
    for (let i = 0; i < samples.length; i++) samples[i] += .22 * Math.sin(2 * Math.PI * 113 * Math.floor(i / 2) / rate);
    const musicPlan = { duration: 6, effects: [], music: { id: 'music' } };
    const preserved = analyzeCreativeAudio(original, withMusic, musicPlan, {}, rate);
    expect(preserved.correlation).toBeLessThan(.75);
    expect(preserved.status).toBe('passed');
    for (let i = 4 * rate * 2; i < 4.5 * rate * 2; i++) samples[i] -= new Float32Array(original.buffer)[i];
    expect(analyzeCreativeAudio(original, withMusic, musicPlan, {}, rate).issues).toContain('original_audio_changed_outside_effects');
});

test('weak source dialogue suppresses optional music without suppressing sound effects', () => {
    const profile = { music: 'playful' };
    expect(chooseMusicForDialogue(profile, .036).enabled).toBe(false);
    expect(chooseMusicForDialogue(profile, .08).enabled).toBe(true);
    expect(chooseMusicForDialogue({ music: 'none' }, .08).enabled).toBe(false);
    expect(dialogueRmsFromPcm(Buffer.from(new Float32Array([.03, -.03]).buffer))).toBeCloseTo(.03);
});
