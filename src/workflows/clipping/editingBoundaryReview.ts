/** Build source-clock review requests. These windows never change an edit or approve media. */
export interface BoundaryRange { start: number; end: number }
export interface BoundaryCue extends BoundaryRange { id: string; text: string }
export interface BoundaryReviewWindow extends BoundaryRange {
    side: 'outgoing' | 'incoming';
    sourceTime: number;
    cues: BoundaryCue[];
}

/** Every new join needs both sides, including silent intervals absent from the transcript. */
export function buildEditingBoundaryReview(
    keep: BoundaryRange[], cues: BoundaryCue[], sourceDuration: number, radius = .75
) {
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(radius) || radius <= 0
        || !Array.isArray(keep) || !keep.length || keep.some((r, i) =>
            !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0
            || r.end <= r.start || r.end > sourceDuration + .002 || i > 0 && r.start < keep[i - 1].end)) {
        throw new Error('Invalid source-clock editing ranges');
    }
    const ids = new Set<string>();
    for (const cue of cues) {
        if (!cue.id || ids.has(cue.id) || typeof cue.text !== 'string'
            || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0
            || cue.end <= cue.start || cue.end > sourceDuration + .002) throw new Error('Invalid boundary cues');
        ids.add(cue.id);
    }
    const window = (sourceTime: number, side: BoundaryReviewWindow['side']): BoundaryReviewWindow => {
        const start = Math.max(0, sourceTime - radius), end = Math.min(sourceDuration, sourceTime + radius);
        return { sourceTime, side, start, end, cues: cues.filter(c => c.start < end && c.end > start) };
    };
    const joins = keep.slice(1).flatMap((incoming, i) => {
        const outgoing = keep[i];
        // Contiguous ranges do not introduce a source discontinuity.
        if (incoming.start - outgoing.end < .002) return [];
        return [{ index: i + 1, removedSeconds: incoming.start - outgoing.end,
            windows: [window(outgoing.end, 'outgoing'), window(incoming.start, 'incoming')] }];
    });
    return { version: 1 as const, timebase: 'source_seconds' as const, joins,
        checks: ['dialogue_tail', 'action_completion', 'reaction_hold', 'sound_continuity'] as const,
        audioReviewed: false as const, visualReviewed: false as const, publicationApproved: false as const };
}
