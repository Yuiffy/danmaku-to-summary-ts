export interface Span { start: number; end: number }
export interface Subtitle extends Span { text: string; [key: string]: any }
export interface AudioEvidence extends Span {
    id: string; kind: 'silence' | 'cough' | 'throat_clear'; precisionSeconds: number;
    verified: boolean; sourceId: string;
}
export interface EditPlan {
    version: 1; sourceId: string; sourceWindow: Span; keep: Span[];
    removed: Array<Span & { reason: AudioEvidence['kind']; evidenceIds: string[] }>;
}
const valid = (span: Span) => Number.isFinite(span?.start) && Number.isFinite(span?.end) && span.start >= 0 && span.end > span.start;
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

export function continuousPlan(sourceId: string, window: Span): EditPlan {
    if (!sourceId || !valid(window)) throw new Error('Invalid source window');
    return { version: 1, sourceId, sourceWindow: { ...window }, keep: [{ start: window.start, end: window.end }], removed: [] };
}

export function validateEditPlan(plan: EditPlan, sourceId: string, window: Span, speech: Subtitle[], evidence: AudioEvidence[]): EditPlan {
    if (plan?.version !== 1 || plan.sourceId !== sourceId || plan.sourceWindow.start !== window.start
        || plan.sourceWindow.end !== window.end || !valid(window) || !Array.isArray(plan.keep) || !plan.keep.length
        || plan.keep.length > 12 || !Array.isArray(plan.removed)) throw new Error('Invalid edit plan identity/schema');
    const all = [...plan.keep.map(span => ({ ...span, kept: true })), ...plan.removed.map(span => ({ ...span, kept: false }))]
        .sort((a, b) => a.start - b.start);
    let cursor = window.start;
    for (const span of all) {
        if (!valid(span) || Math.abs(span.start - cursor) > 0.0001 || span.end > window.end) throw new Error('Edit plan overlaps, gaps or out-of-window intervals');
        cursor = span.end;
    }
    if (Math.abs(cursor - window.end) > 0.0001 || plan.keep.some((span, i) => i > 0 && span.start < plan.keep[i - 1].end)) {
        throw new Error('Edit plan reorders or truncates the source');
    }
    if (plan.keep[0].start !== window.start || plan.keep.at(-1)!.end !== window.end) throw new Error('Preserve setup and closing boundaries');
    for (const deletion of plan.removed) {
        if (speech.some(row => overlaps(row, window) && !valid(row.asrEvidence?.sourceSpan))) {
            throw new Error('Original ASR timing provenance required for automatic edits');
        }
        if (!['silence', 'cough', 'throat_clear'].includes(deletion.reason) || !deletion.evidenceIds?.length) throw new Error('Unsupported removal reason');
        const proof = deletion.evidenceIds.map(id => evidence.find(item => item.id === id));
        if (proof.some(item => !item || !item.verified || item.sourceId !== sourceId || !valid(item)
            || !Number.isFinite(item.precisionSeconds) || item.precisionSeconds < 0 || item.precisionSeconds > 0.05
            || item.kind !== deletion.reason)
            || !proof.some(item => item!.start <= deletion.start && item!.end >= deletion.end)) throw new Error('Insufficient precise audio evidence');
        if (deletion.reason === 'silence' && deletion.end - deletion.start < 3) throw new Error('Normal breathing and short pauses are protected');
        if (speech.some(row => {
            const source = row.asrEvidence?.sourceSpan;
            const rawSpan = valid(source) ? source : row;
            return overlaps(rawSpan, { start: deletion.start - 0.2, end: deletion.end + 0.2 });
        })) throw new Error('Cannot remove dialogue, including display-interpolated source spans');
    }
    return plan;
}

export function planFromEvidenceIds(sourceId: string, window: Span, ids: string[], speech: Subtitle[], evidence: AudioEvidence[]): EditPlan {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('Invalid removal evidence IDs');
    const removed = ids.map(id => {
        const item = evidence.find(row => row.id === id);
        if (!item) throw new Error(`Unknown audio evidence: ${id}`);
        // Leave transitions around an otherwise long, verified silent interval.
        return { start: item.start + (item.kind === 'silence' ? 0.3 : 0), end: item.end - (item.kind === 'silence' ? 0.3 : 0),
            reason: item.kind, evidenceIds: [id] };
    }).sort((a, b) => a.start - b.start);
    const plan = continuousPlan(sourceId, window);
    if (!removed.length) return plan;
    plan.keep = [];
    let start = window.start;
    for (const item of removed) { plan.keep.push({ start, end: item.start }); start = item.end; }
    plan.keep.push({ start, end: window.end });
    plan.removed = removed;
    return validateEditPlan(plan, sourceId, window, speech, evidence);
}

export function mapSubtitles(segments: Subtitle[], plan: EditPlan): Subtitle[] {
    let offset = 0;
    return plan.keep.flatMap(span => {
        const mapped = segments.filter(row => overlaps(row, span)).map(row => ({ ...row,
            start: offset + Math.max(row.start, span.start) - span.start,
            end: offset + Math.min(row.end, span.end) - span.start }));
        offset += span.end - span.start;
        return mapped;
    });
}

export function buildEditFilter(plan: EditPlan, sourceOrigin: number, escapedAssPath: string): string {
    if (!Number.isFinite(sourceOrigin) || plan.keep.some(span => span.start < sourceOrigin)) throw new Error('Invalid rough-cut origin');
    const streams = plan.keep.flatMap((span, index) => {
        const start = span.start - sourceOrigin, end = span.end - sourceOrigin;
        return [`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
            `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`];
    });
    streams.push(`${plan.keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${plan.keep.length}:v=1:a=1[sub_v][sub_a]`);
    streams.push(`[sub_v]subtitles='${escapedAssPath}'[vout]`);
    return streams.join(';');
}
