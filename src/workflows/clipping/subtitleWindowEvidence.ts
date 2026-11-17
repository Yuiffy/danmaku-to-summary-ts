type Data = Record<string, any>;

/** Project a rendered numeric revision without changing its source IDs or voice evidence. */
export function projectRenderedSubtitleEvidence<T extends { sourceSha256?: string; cues?: Data[] }>(evidence: T,
    artifact: Data): T {
    const draft = artifact.renderedSubtitles;
    const edits = draft?.edits || [];
    if (!edits.length) return evidence;
    if (draft.version !== 1 || draft.renderedRevision !== draft.revision || draft.renderedSha256 !== draft.sha256
        || draft.sourceSha256 !== evidence.sourceSha256 || draft.window?.start !== artifact.window?.start
        || draft.window?.end !== artifact.window?.end) throw new Error('Rendered subtitle evidence is stale');
    const textKey = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
    const changes = edits.flatMap((edit: Data) => (edit.changes || []).map((change: Data) => ({ ...change, authority: edit.authority })));
    if (!changes.length || changes.some((row: Data) => row.authority !== 'user'
        || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end <= row.start
        || typeof row.before !== 'string' || typeof row.after !== 'string')) throw new Error('Invalid rendered subtitle corrections');
    const matched = new Set<Data>();
    const cues = (evidence.cues || []).map(cue => {
        const items = (cue.items || []).map((item: Data) => {
            const local = changes.filter((row: Data) => Math.abs(Math.max(item.start, artifact.window.start) - row.start) <= .003
                && Math.abs(Math.min(item.end, artifact.window.end) - row.end) <= .003);
            if (!local.length) return item;
            let text = item.text;
            for (const row of local) {
                if (matched.has(row) || textKey(text) !== textKey(row.before)) throw new Error('Rendered correction no longer matches source cue');
                matched.add(row); text = row.after;
            }
            const current = draft.cues?.filter((row: Data) => Math.abs(artifact.window.start + row.start - local[0].start) <= .003
                && Math.abs(artifact.window.start + row.end - local[0].end) <= .003);
            if (current?.length !== 1 || textKey(current[0].text) !== textKey(text)) throw new Error('Rendered correction differs from current captions');
            return { ...item, text, renderedSubtitleCorrections: local };
        });
        return items.every((item: Data, index: number) => item === cue.items[index]) ? cue
            : { ...cue, items, text: items.map((item: Data) => item.text.trim()).join(' ') };
    });
    if (matched.size !== changes.length) throw new Error('Rendered subtitle correction has no unique source cue');
    return { ...evidence, cues, byId: new Map(cues.map(cue => [cue.id, cue])) };
}

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
