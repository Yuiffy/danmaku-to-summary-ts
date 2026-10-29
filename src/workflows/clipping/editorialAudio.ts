export interface Loudness { integrated: number; truePeak: number }

export function parseLoudness(stderr: string): Loudness {
    const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
    if (!match) throw new Error('Missing measured audio loudness');
    const raw = JSON.parse(match);
    const value = { integrated: Number(raw.input_i), truePeak: Number(raw.input_tp) };
    if (!Number.isFinite(value.integrated) || !Number.isFinite(value.truePeak))
        throw new Error('Silent or invalid audio loudness');
    return value;
}

/** Attenuate the OP only. Preserve original dialogue gain and immutable OP assets. */
export function opAudioGain(body: Loudness, op: Loudness): number {
    if (![body.integrated, body.truePeak, op.integrated, op.truePeak].every(Number.isFinite))
        throw new Error('Cannot match unmeasured audio');
    return Math.min(0, body.integrated - op.integrated - 1, -1.5 - op.truePeak);
}
