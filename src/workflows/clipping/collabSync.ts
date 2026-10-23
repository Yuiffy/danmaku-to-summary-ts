/** Bounded energy-envelope search: a sync suggestion, never speaker or visual confirmation. */
export function speechEnvelope(pcm: Float32Array, sampleRate = 8000, fps = 50): number[] {
    const step = sampleRate / fps;
    if (!Number.isInteger(step) || step < 1) throw new Error('Invalid envelope rate');
    const result: number[] = [];
    for (let i = 0; i + step <= pcm.length; i += step) {
        let energy = 0;
        for (let j = i; j < i + step; j++) {
            if (!Number.isFinite(pcm[j])) throw new Error('Invalid PCM sample');
            energy += pcm[j] * pcm[j];
        }
        result.push(Math.log10(1e-8 + energy / step));
    }
    return result;
}
export function suggestSync(reference: number[], search: number[], fps = 50) {
    if (reference.length < fps * 5 || search.length < reference.length || search.length > fps * 100
        || ![...reference, ...search].every(Number.isFinite)) throw new Error('Sync needs 5–100 seconds of finite envelope data');
    const mean = reference.reduce((s, x) => s + x, 0) / reference.length;
    const centered = reference.map(x => x - mean), energy = centered.reduce((s, x) => s + x * x, 0);
    if (energy < 1e-6) return { status: 'ambiguous', reason: 'silent_or_constant_reference', reviewed: false };
    const scores: Array<{ offset: number; score: number }> = [];
    for (let offset = 0; offset <= search.length - reference.length; offset++) {
        let sum = 0, squares = 0, cross = 0;
        for (let i = 0; i < reference.length; i++) {
            const x = search[offset + i]; sum += x; squares += x * x; cross += centered[i] * x;
        }
        const variance = Math.max(0, squares - sum * sum / reference.length);
        scores.push({ offset, score: variance < 1e-6 ? -1 : cross / Math.sqrt(energy * variance) });
    }
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0], second = scores.find(s => Math.abs(s.offset - best.offset) >= fps * .5);
    const margin = second ? best.score - second.score : 0;
    const edge = best.offset === 0 || best.offset === search.length - reference.length;
    return { status: best.score >= .65 && margin >= .08 && !edge ? 'candidate' : 'ambiguous',
        offsetSeconds: best.offset / fps, score: best.score, runnerUpScore: second?.score ?? null, margin,
        atSearchEdge: edge, reviewed: false,
        interpretation: 'Check shared game/action frames and the original audio at two distant anchors. Broadcaster microphone lead and remote-call latency may differ from visual timing. This proposal cannot create reviewed sync windows.' };
}
