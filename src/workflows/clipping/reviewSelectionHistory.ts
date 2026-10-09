type Data = Record<string, any>;
const pathKey = (value: unknown): string => String(value || '').replace(/\\/gu, '/').toLowerCase();
const placeholder = (value: unknown): boolean => !value || /^(?:被剔除候选|待复核候选|初选话题)\s*[\d?]+$/u.test(String(value));

/** Sort display rows by their durable upload ID, without renumbering source/review identities. */
export function numberedReviewRows(rows: Data[], metadata: Data): Data[] {
    const id = (row: Data): number => {
        const value = Number(metadata.uploadRegistry?.clipIdsByReviewIndex?.[row.reviewIndex]);
        return Number.isSafeInteger(value) && value > 0 ? value : Infinity;
    };
    return [...rows].sort((a, b) => id(a) - id(b) || a.reviewIndex - b.reviewIndex);
}

/** Keep the original P/R namespaces together and compare their numeric portions numerically. */
export function numberedDeferredRows(rows: Data[]): Data[] {
    return [...rows].sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'en', { numeric: true })
        || String(a.selectionKey || '').localeCompare(String(b.selectionKey || '')));
}

/** Repeated validation attempts may refer to the same persisted rejection, including a recovered clip. */
export function uniqueRejectedArtifacts(rows: Data[]): Data[] {
    const seen = new Set<string>();
    return rows.filter(row => {
        const key = pathKey(row.output?.metadataPath);
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Recall summaries are review labels, never approved public copy or final boundaries. */
export function recoverRejectedPresentation(rejection: Data, candidates: Data[]): Data {
    const candidate = candidates.find(row => String(row.index) === String(rejection.candidateIndex));
    const title = !placeholder(rejection.title) ? rejection.title : candidate?.event || candidate?.title;
    const exact = Number.isFinite(rejection.start) && Number.isFinite(rejection.end);
    const start = exact ? rejection.start : candidate?.start;
    const end = exact ? rejection.end : candidate?.end;
    return { title: title || null, score: rejection.score ?? candidate?.globalSelection?.score ?? null,
        recallSubtitles: (candidate?.grounding?.subtitles || []).filter((row: Data) => row.text)
            .map((row: Data) => ({ id: row.id, text: row.text })),
        ...(Number.isFinite(start) && Number.isFinite(end) && end > start ? {
            window: { start, end, duration: end - start }, windowAuthority: exact ? 'rejected_draft' : 'recall_context'
        } : {}) };
}

export function reviewDisplayRows(results: Data[]): Data[] {
    return results.map(result => {
        const presentation = result.reviewPresentation;
        if (!result.selectionRejection || result.output?.mediaPath || !presentation) return result;
        return { ...result, copy: { ...result.copy, title: placeholder(result.copy?.title) && presentation.title
            ? presentation.title : result.copy?.title },
        window: Number.isFinite(result.window?.start) && Number.isFinite(result.window?.end)
            ? result.window : { ...result.window, ...presentation.window } };
    });
}

function currentDeferredRows(metadata: Data): Data[] {
    const source = metadata.source || {}, ranking = metadata.aiStatus?.ranking;
    const srt = pathKey(source.srtPath), media = pathKey(source.mediaPath);
    return [
        ...(ranking?.skipped || []).map((row: Data) => ({ ...row, phase: 'ranking', label: `R${row.candidateIndex}`,
            selectionKey: `R:${ranking.sourceSha256 || srt}:${row.candidateIndex}`, sourceSha256: ranking.sourceSha256,
            sourceSrtPath: source.srtPath, sourceMediaPath: source.mediaPath })),
        ...(metadata.publication?.decisions || []).filter((row: Data) => !row.selected && metadata.publication.policy?.mode !== 'shadow')
            .map((row: Data) => ({ ...row, phase: 'publication', label: `P${row.index}`,
                selectionKey: `P:${media}:${srt}:${row.index}:${row.start}:${row.end}`,
                sourceSrtPath: source.srtPath, sourceMediaPath: source.mediaPath }))
    ];
}

export function deferredSelectionRows(metadata: Data): Data[] {
    const rows = [...currentDeferredRows(metadata), ...(metadata.deferredSelectionHistory?.rows || [])];
    const unique = new Map<string, Data>();
    for (const row of rows) {
        if (!row.selectionKey) continue;
        const previous = unique.get(row.selectionKey);
        if (!previous) unique.set(row.selectionKey, row);
        else if (row.selectionAliases?.length) unique.set(row.selectionKey, { ...previous,
            selectionAliases: [...new Set([...(previous.selectionAliases || []), ...row.selectionAliases])] });
    }
    const values = [...unique.values()];
    // Early progressive notifications used to omit source, producing P:::... keys.
    // Match the complete decision, never just a P/R number or overlapping window.
    const fingerprint = (row: Data) => JSON.stringify([row.phase, row.index, row.candidateIndex,
        row.start, row.end, row.title, row.score, row.reason, row.sourceSha256]);
    const bound = (row: Data) => Boolean(row.sourceMediaPath && row.sourceSrtPath);
    const aliases = new Map<string, string[]>();
    const retained = values.filter(row => {
        if (row.sourceMediaPath || row.sourceSrtPath) return true;
        const matches = values.filter(other => bound(other) && fingerprint(other) === fingerprint(row));
        if (matches.length !== 1) return true;
        const key = matches[0].selectionKey;
        aliases.set(key, [...(aliases.get(key) || []), row.selectionKey, ...(row.selectionAliases || [])]);
        return false;
    });
    return retained.map(row => aliases.has(row.selectionKey) ? { ...row,
        selectionAliases: [...new Set([...(row.selectionAliases || []), ...aliases.get(row.selectionKey)!])] } : row);
}

/** Progressive reports can obtain source from their results before saving history. */
export function withReviewSource(metadata: Data, results: Data[]): Data {
    if (metadata.source?.mediaPath && metadata.source?.srtPath) return metadata;
    const sources = results.map(row => row.source).filter(source => source?.mediaPath && source?.srtPath);
    const keys = new Set(sources.map(source => `${pathKey(source.mediaPath)}|${pathKey(source.srtPath)}`));
    if (keys.size !== 1) return metadata;
    const source = sources[0];
    if (['mediaPath', 'srtPath'].some(key => metadata.source?.[key] && pathKey(metadata.source[key]) !== pathKey(source[key]))) return metadata;
    return { ...metadata, source: { ...source, ...metadata.source, mediaPath: source.mediaPath, srtPath: source.srtPath } };
}

/** Retain earlier selection decisions separately from current QA and publication authority. */
export function preserveDeferredSelection(previous: Data | null, current: Data): Data {
    const sameSource = previous && pathKey(previous.source?.mediaPath)
        && pathKey(previous.source.mediaPath) === pathKey(current.source?.mediaPath);
    const rows = [...deferredSelectionRows(current), ...(sameSource ? deferredSelectionRows(previous!) : [])];
    const unique = new Map<string, Data>();
    for (const row of rows) if (!unique.has(row.selectionKey)) unique.set(row.selectionKey, row);
    return unique.size ? { ...current, deferredSelectionHistory: { version: 1, rows: [...unique.values()] } } : current;
}

export function enrichSkippedRanking(ranking: Data, candidates: Data[]): Data {
    return { ...ranking, skipped: (ranking.skipped || []).map((row: Data) => {
        const candidate = candidates.find(candidate => String(candidate.index) === String(row.candidateIndex));
        return candidate ? { ...row, start: row.start ?? candidate.start, end: row.end ?? candidate.end,
            title: !placeholder(row.title) ? row.title : row.topic || candidate.event || candidate.title || candidate.subtitleHitText || `初选话题 ${row.candidateIndex}`,
            candidate: row.candidate || candidate } : row;
    }) };
}
