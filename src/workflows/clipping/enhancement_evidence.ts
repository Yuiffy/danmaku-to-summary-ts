import { EditPlan, Subtitle, Span, mapSubtitles } from './editPlan';

/** All evidence survives; repeated provenance is interned once and retained rows reference source rows. */
export function compactEnhancementEvidence(input: { window: Span; speech: Subtitle[];
    audience: Array<{ time: number; text: string; id?: string }> }, plan: EditPlan): string {
    const provenance: Record<string, unknown> = {};
    const keys = new Map<string, string>();
    const intern = (value: unknown): { ref: string } => {
        const key = JSON.stringify(value);
        const existing = keys.get(key);
        if (existing) return { ref: existing };
        const id = `P${keys.size + 1}`;
        keys.set(key, id);
        provenance[id] = value;
        return { ref: id };
    };
    const source = input.speech.map((row, index): Subtitle & { id: string } => ({ ...row, id: `S${index + 1}` }))
        .filter(row => row.end > input.window.start - 30 && row.start < input.window.end + 30)
        .map(row => {
            const { asrEvidence, speakerEvidence, ...rest } = row;
            const asr = asrEvidence ? { ...asrEvidence, ...(asrEvidence.sourceSpan ? { sourceSpan: intern(asrEvidence.sourceSpan) } : {}) } : null;
            const voice = speakerEvidence ? { ...speakerEvidence,
                ...(speakerEvidence.observations ? { observations: speakerEvidence.observations.map(intern) } : {}) } : null;
            return { ...rest, ...(asr ? { asrEvidence: intern(asr) } : {}), ...(voice ? { speakerEvidence: intern(voice) } : {}) };
        });
    const retainedSpeech = mapSubtitles(input.speech.map((row, index) => ({ ...row, id: `S${index + 1}` })), plan)
        .map(row => ({ id: row.id, start: row.start, end: row.end }));
    let offset = 0;
    const retainedAudience = plan.keep.flatMap(span => {
        const rows = input.audience.filter(row => row.time >= span.start && row.time < span.end)
            .map(row => ({ ...row, outputTime: offset + row.time - span.start }));
        offset += span.end - span.start;
        return rows;
    });
    const window = { start: input.window.start, end: input.window.end };
    return JSON.stringify({ version: 2,
        referenceGuide: 'retainedSpeech IDs resolve to complete text/evidence in sourceSpeech; start/end there are output times. P refs resolve in provenance. Source-only rows cannot support copy. Unknown/mixed acoustic matches remain unknown; never propagate a neighboring match.',
        sourceWindow: window, sourceSpeech: source, retainedSpeech, provenance, retainedAudience,
        sourceAudience: input.audience.filter(row => row.time >= window.start - 30 && row.time <= window.end + 30),
        editPlan: { ...plan, sourceWindow: window } });
}
