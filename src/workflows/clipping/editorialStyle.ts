/** Editorial decisions use seconds on the rendered baseline, never recording time. */
export type ClipStyle = 'ordinary' | 'highlight_first' | 'precision';
export interface Span { start: number; end: number }
export interface Cue extends Span { text: string }
export interface HookPlan {
    version: 1;
    highlights: Span[];
    repetition?: 'auto' | 'keep' | 'omit_prefix';
    reason: string;
    baselineMediaSha256?: string;
    baselineSubtitlesSha256?: string;
    baselineMetadataSha256?: string;
}
export interface Piece extends Span { kind: 'highlight' | 'op' | 'body'; outputStart: number }
export const STYLE_LABELS: Record<ClipStyle, string> = {
    ordinary: '普通', highlight_first: '重点前置', precision: '精切'
};
export function clipStyle(value: string): ClipStyle {
    const aliases: Record<string, ClipStyle> = { 普通: 'ordinary', 前置: 'highlight_first', 重点前置: 'highlight_first', 精切: 'precision' };
    const style = aliases[value] || value;
    if (!Object.hasOwn(STYLE_LABELS, style)) throw new Error('Style must be ordinary, highlight_first or precision');
    return style as ClipStyle;
}
const valid = (s: Span, duration: number) => Number.isFinite(s.start) && Number.isFinite(s.end)
    && s.start >= 0 && s.end > s.start && s.end <= duration + .001;

/** Admission for new renders only; historical timelines remain verifiable. */
export function validateHookBudget(duration: number, plan: HookPlan, cues: Cue[]): void {
    const timeline = composeTimeline(duration, 3.2, plan, cues);
    if (timeline.repetition === 'keep' && timeline.hookSeconds > Math.min(6, duration * .15) + .001)
        throw new Error('Repeated teaser exceeds 6 seconds or 15% of the body; use a shorter complete line, a chronological opening, ordinary or precision');
}

export function composeTimeline(duration: number, opDuration: number, plan: HookPlan, cues: Cue[]): {
    pieces: Piece[]; duration: number; repetition: 'keep' | 'omit_prefix'; hookSeconds: number;
} {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(opDuration) || opDuration <= 0 || opDuration > 10)
        throw new Error('Invalid baseline or OP duration (OP must be <=10 seconds)');
    if (plan.version !== 1 || !plan.reason?.trim() || !Array.isArray(plan.highlights)
        || !plan.highlights.length || plan.highlights.length > 6) throw new Error('A reason and 1–6 highlight spans are required');
    if (plan.repetition && !['auto', 'keep', 'omit_prefix'].includes(plan.repetition)) throw new Error('Invalid repetition policy');
    let prior = -1;
    let hookSeconds = 0;
    for (const span of plan.highlights) {
        if (!valid(span, duration) || span.start < prior) throw new Error('Highlights must be chronological, disjoint and inside baseline');
        if (cues.some(c => c.end > span.start + .04 && c.start < span.start - .04
            || c.end > span.end + .04 && c.start < span.end - .04)) throw new Error('Highlight boundary splits a subtitle sentence');
        if (!cues.some(c => c.end > span.start && c.start < span.end)) throw new Error('Highlight needs baseline subtitle evidence');
        prior = span.end; hookSeconds += span.end - span.start;
    }
    if (hookSeconds < 2 || hookSeconds > 20) throw new Error('Highlight total must be 2–20 seconds');
    const prefix = plan.highlights[0].start <= .001 && plan.highlights.every((s, i, all) => !i || Math.abs(s.start - all[i - 1].end) <= .001);
    if (plan.repetition === 'omit_prefix' && !prefix) throw new Error('Only a contiguous opening can be omitted from body');
    const repetition = plan.repetition === 'keep' || !prefix ? 'keep' : 'omit_prefix';
    const bodyStart = repetition === 'omit_prefix' ? prior : 0;
    if (duration - bodyStart < 1) throw new Error('Keep a substantive body after the opening');
    let cursor = 0;
    const pieces: Piece[] = [];
    const add = (kind: Piece['kind'], span: Span) => {
        pieces.push({ kind, ...span, outputStart: cursor }); cursor += span.end - span.start;
    };
    plan.highlights.forEach(s => add('highlight', s));
    add('op', { start: 0, end: opDuration });
    add('body', { start: bodyStart, end: duration });
    return { pieces, duration: cursor, repetition, hookSeconds };
}

export function projectCues(pieces: Piece[], baseline: Cue[], op: Cue[]): Cue[] {
    return pieces.flatMap(p => (p.kind === 'op' ? op : baseline)
        .filter(c => c.end > p.start && c.start < p.end)
        .map(c => ({ text: c.text, start: p.outputStart + Math.max(c.start, p.start) - p.start,
            end: p.outputStart + Math.min(c.end, p.end) - p.start })));
}

export function parseSrt(text: string): Cue[] {
    const seconds = (s: string) => { const v = s.replace(',', '.').split(':').map(Number); return v[0] * 3600 + v[1] * 60 + v[2]; };
    return text.replace(/^\uFEFF/, '').trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map(block => {
        const lines = block.split(/\r?\n/);
        const at = lines.findIndex(line => line.includes(' --> '));
        const match = lines[at]?.match(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3}) --> (\d{2,}:\d{2}:\d{2}[,.]\d{3})$/);
        if (!match) throw new Error('Invalid SRT cue');
        const cue = { start: seconds(match[1]), end: seconds(match[2]), text: lines.slice(at + 1).join('\n') };
        if (!valid(cue, Infinity) || !cue.text) throw new Error('Invalid SRT times or text');
        return cue;
    });
}
export function writeSrt(cues: Cue[]): string {
    const stamp = (time: number) => {
        const ms = Math.round(time * 1000);
        return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    };
    return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}
