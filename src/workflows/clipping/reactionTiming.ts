interface Span { start: number; end: number }
export interface ReactionHold { after: number; seconds: number; cueId: string }
export interface ReactionTimeline {
    version: number; sourceDuration: number; duration: number; keep: Span[];
    holds?: ReactionHold[]; addedSeconds?: number; [key: string]: any;
}
interface Cue extends Span { id: string; text?: string }
interface Sound { id: string; offsetSeconds?: number; levelDb?: number; durationSeconds?: number; afterCueId?: string }
interface Effect extends Span { id: string; speechIds: string[]; sound?: Sound | string; [key: string]: any }
interface Plan { duration: number; effects: Effect[]; timeline?: ReactionTimeline; [key: string]: any }
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Retained recording intervals with a bounded frozen-frame/silent-audio tail. */
export function reactionPieces(timeline: ReactionTimeline): Array<Span & { hold: number }> {
    const holds = timeline.holds || [];
    let previous = -1;
    for (const hold of holds) {
        if (!Number.isFinite(hold.after) || !Number.isFinite(hold.seconds) || hold.seconds <= 0 || hold.seconds > 1
            || !hold.cueId || hold.after <= previous || !timeline.keep.some(s => hold.after > s.start && hold.after <= s.end + .001)) {
            throw new Error('Invalid reaction pause');
        }
        previous = hold.after;
    }
    return timeline.keep.flatMap(span => {
        let start = span.start;
        const pieces: Array<Span & { hold: number }> = [];
        for (const hold of holds.filter(h => h.after > span.start && h.after <= span.end + .001)) {
            pieces.push({ start, end: Math.min(span.end, hold.after), hold: hold.seconds });
            start = Math.min(span.end, hold.after);
        }
        if (start < span.end - .0001) pieces.push({ start, end: span.end, hold: 0 });
        return pieces;
    });
}

export function reactionSourceTime(time: number, timeline: ReactionTimeline): number {
    let offset = 0;
    for (const piece of reactionPieces(timeline)) {
        const length = piece.end - piece.start;
        if (time <= offset + length + piece.hold + .00001) return Math.min(piece.end, piece.start + time - offset);
        offset += length + piece.hold;
    }
    throw new Error('Output time exceeds reaction timeline');
}

export function reactionOutputTime(time: number, timeline: ReactionTimeline, edge: 'start' | 'end' = 'start'): number {
    let offset = 0;
    for (const piece of reactionPieces(timeline)) {
        if (time >= piece.start - .001 && time <= piece.end + .001) {
            return round(offset + time - piece.start + (edge === 'start' && Math.abs(time - piece.end) < .001 ? piece.hold : 0));
        }
        offset += piece.end - piece.start + piece.hold;
    }
    throw new Error('Source time is not retained in reaction timeline');
}

export function shiftReactionTime(time: number, insertions: Array<{ time: number; seconds: number }>, edge: 'start' | 'end' = 'start'): number {
    return round(time + insertions.filter(h => h.time < time - .001 || edge === 'start' && Math.abs(h.time - time) <= .001)
        .reduce((n, h) => n + h.seconds, 0));
}

/** Laughter follows the complete cited exchange, never an arbitrary offset inside its setup. */
export function planLaughterTiming(plan: Plan, speech: Cue[], assets: Record<string, any>, profile: Record<string, any> | null) {
    const insertions: Array<{ time: number; seconds: number; after: number; cueId: string }> = [];
    const changes: Array<Record<string, any>> = [];
    const sounds = new Map<string, { sound: Sound; start: number; anchor: Cue; seconds: number } | null>();
    if (plan.timeline?.holds?.length) throw new Error('Reaction timing must start from the reviewed source timeline');
    const laughter = plan.effects.filter(effect => {
        const id = typeof effect.sound === 'string' ? effect.sound : effect.sound?.id;
        return id && assets[id]?.family === 'laughter';
    }).sort((a, b) => a.start - b.start);
    for (const effect of laughter) {
        const sound: Sound = typeof effect.sound === 'string' ? { id: effect.sound } : { ...effect.sound! };
        const cited = speech.filter(c => effect.speechIds.includes(c.id));
        if (!cited.length || cited.length !== new Set(effect.speechIds).size) throw new Error('Laughter requires current retained speech evidence');
        const anchor = [...cited].sort((a, b) => b.end - a.end)[0];
        const next = speech.filter(c => c.start >= anchor.end - .001 && c.id !== anchor.id).sort((a, b) => a.start - b.start)[0];
        const gap = Math.max(0, (next?.start ?? plan.duration) - anchor.end);
        const canHold = plan.timeline && profile?.tone === 'comic' && profile.laughter !== false && !profile.preserveContinuity;
        const holdSeconds = canHold ? round(Math.min(1, Math.max(0, 1.2 - gap))) : 0;
        const start = round(Math.max(effect.start, anchor.end - .04));
        const seconds = round(Math.min(assets[sound.id].sampleSeconds, gap + holdSeconds + anchor.end - start));
        if (anchor.end > effect.end + 1.5 || anchor.end - effect.start < .6 || seconds < .6 || profile?.laughter === false
            || speech.some(c => c.id !== anchor.id && c.start < anchor.end && c.end > anchor.end + .001)
            || insertions.some(h => Math.abs(h.time - anchor.end) < .001)) {
            sounds.set(effect.id, null);
            changes.push({ momentId: effect.id, reason: 'no_complete_unobstructed_laughter_beat' });
            continue;
        }
        if (holdSeconds > 0) insertions.push({ time: anchor.end, seconds: holdSeconds,
            after: reactionSourceTime(anchor.end, plan.timeline!), cueId: anchor.id });
        sounds.set(effect.id, { sound, start, anchor, seconds });
        changes.push({ momentId: effect.id, afterCueId: anchor.id, oldStart: round(effect.start + (sound.offsetSeconds || 0)),
            sourceEnd: anchor.end, holdSeconds, durationSeconds: seconds });
    }
    insertions.sort((a, b) => a.time - b.time);
    const addedSeconds = round(insertions.reduce((n, h) => n + h.seconds, 0));
    const effects = plan.effects.map(effect => {
        const adjusted = sounds.get(effect.id);
        // End the visual accent before a new reaction pause; don't freeze a long zoom over the next reply.
        const end = adjusted && insertions.some(h => h.cueId === adjusted.anchor.id) ? Math.min(effect.end, adjusted.anchor.end) : effect.end;
        const row: Effect = { ...effect, start: shiftReactionTime(effect.start, insertions), end: shiftReactionTime(end, insertions, 'end') };
        if (adjusted) row.sound = { ...adjusted.sound, offsetSeconds: round(shiftReactionTime(adjusted.start, insertions, 'end') - row.start),
            afterCueId: adjusted.anchor.id, durationSeconds: adjusted.seconds };
        else if (sounds.has(effect.id)) delete row.sound;
        return row;
    }).filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.filter || row.sound);
    const timeline = plan.timeline && { ...plan.timeline, duration: round(plan.duration + addedSeconds), addedSeconds,
        holds: insertions.map(({ after, seconds, cueId }) => ({ after, seconds, cueId })) };
    return { plan: { ...plan, duration: round(plan.duration + addedSeconds), effects, ...(timeline ? { timeline } : {}) }, insertions, changes };
}
