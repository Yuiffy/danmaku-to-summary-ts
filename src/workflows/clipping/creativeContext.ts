export interface ContextQuestion {
    version: 1; kind: 'audience_question'; time: number; text: string; end: number;
}

/** Resolve an explicit original comment, never infer a streamer quote from chat. */
export function contextQuestion(at: number, rows: Array<{ time: number; text: string }>, window: { start: number; end: number }): ContextQuestion {
    if (!Number.isFinite(at) || at < Math.max(0, window.start - 120) || at > window.start)
        throw new Error('Context question must precede the clip within 120 seconds');
    const matches = rows.filter(row => Math.abs(row.time - at) < .005);
    if (matches.length !== 1) throw new Error('Context timestamp must identify exactly one original audience comment');
    const text = matches[0].text;
    if (!text.trim() || Array.from(text).length > 64 || /[\r\n\x00-\x1f]/.test(text))
        throw new Error('Context question must be a short original comment');
    return { version: 1, kind: 'audience_question', time: matches[0].time, text, end: Math.min(6, window.end - window.start) };
}

export function contextAss(context: ContextQuestion, width: number, height: number): string {
    if (context.version !== 1 || context.kind !== 'audience_question' || !Number.isFinite(context.end)
        || context.end <= 0 || context.end > 6 || !context.text?.trim() || Array.from(context.text).length > 64)
        throw new Error('Invalid context overlay');
    // ASS override syntax is never accepted from the original audience text.
    const safe = context.text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/[\r\n\x00-\x1f]/g, ' ');
    const lines = safe.match(/.{1,22}/gu) || [];
    const font = Math.round(height * .034);
    return `Dialogue: 2,0:00:00.00,0:00:${context.end.toFixed(2).padStart(5, '0')},Accent,,0,0,0,,{\\an8\\pos(${Math.round(width / 2)},${Math.round(height * .04)})\\fs${font}\\1c&HFFFFFF&\\3c&H201820&\\bord${Math.round(font * .18)}\\shad0}前情提要 · 观众弹幕\\N${lines.join('\\N')}`;
}
