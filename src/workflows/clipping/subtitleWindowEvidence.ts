type Data = Record<string, any>;

/** Split only existing source groups at retained ASR row boundaries; never crop or invent a word. */
export function projectRetainedSubtitleEvidence<T extends { cues?: Data[] }>(evidence: T,
    window: { start: number; end: number }): T {
    if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start) {
        throw new Error('A valid retained subtitle window is required');
    }
    let changed = false;
    const cues = (evidence.cues || []).flatMap(cue => {
        const rows = cue.items;
        if (!Array.isArray(rows) || rows.length < 2 || cue.end <= window.start || cue.start >= window.end
            || cue.start >= window.start - .001 && cue.end <= window.end + .001
            || cue.id !== `G${rows[0].index + 1}`) return [cue];
        if (rows.some(row => !Number.isSafeInteger(row.index) || row.index < 0 || !Number.isFinite(row.start)
            || !Number.isFinite(row.end) || row.end <= row.start || typeof row.text !== 'string')) return [cue];
        const retained = (row: Data) => row.start >= window.start - .001 && row.end <= window.end + .001;
        const groups: Data[][] = [];
        for (const row of rows) {
            const previous = groups.at(-1);
            if (previous && retained(previous[0]) === retained(row)) previous.push(row);
            else groups.push([row]);
        }
        if (groups.length === 1) return [cue];
        changed = true;
        return groups.map(items => ({ ...cue, id: `G${items[0].index + 1}`, originalGroupId: cue.id,
            start: items[0].start, end: Math.max(...items.map(row => row.end)),
            text: items.map(row => row.text.trim()).join(' '), items }));
    });
    if (!changed) return evidence;
    if (new Set(cues.map(cue => cue.id)).size !== cues.length) throw new Error('Retained source cue identities conflict');
    return { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) };
}
