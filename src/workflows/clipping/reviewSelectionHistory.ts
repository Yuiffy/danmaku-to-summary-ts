type Data = Record<string, any>;
const pathKey = (value: unknown): string => String(value || '').replace(/\\/gu, '/').toLowerCase();
const placeholder = (value: unknown): boolean => !value || /^(?:被剔除候选|待复核候选|初选话题)\s*[\d?]+$/u.test(String(value));

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
    for (const row of rows) if (row.selectionKey && !unique.has(row.selectionKey)) unique.set(row.selectionKey, row);
    return [...unique.values()];
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
