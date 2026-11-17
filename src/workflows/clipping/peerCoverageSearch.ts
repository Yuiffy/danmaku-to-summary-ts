interface SearchCandidate { roomId: string; host: string; title: string; cues: Array<{ text: string }> }

export interface CoverageSearchOptions { page?: number; order?: 'totalrank' | 'pubdate' }
export interface CoverageSearch extends CoverageSearchOptions { query: string; limit: number }
export type CoverageStreamerRegistry = Record<string, {
    roomIds?: string[]; displayName?: string; searchTags?: string[]; aiClipName?: string;
    aliases?: string[]; mentionLabels?: string[]; speakerLabels?: string[];
}>;

export const compactCoverageQuery = (value: unknown): string => typeof value === 'string'
    ? value.replace(/<[^>]*>/gu, '').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80) : '';

/** The recording's room selects its host, never a person mentioned in its title. */
export function coverageHostQuery(candidate: Pick<SearchCandidate, 'roomId' | 'host'>,
    registry: CoverageStreamerRegistry = {}): string {
    const entries = Object.values(registry).filter(Boolean);
    const entry = entries.find(row => row.roomIds?.map(String).includes(candidate.roomId))
        || entries.find(row => [row.displayName, row.aiClipName, ...(row.searchTags || []), ...(row.aliases || []),
            ...(row.mentionLabels || []), ...(row.speakerLabels || [])].includes(candidate.host));
    const query = compactCoverageQuery(entry?.searchTags?.find(value => compactCoverageQuery(value).length >= 2)
        || entry?.displayName || candidate.host);
    return query === '小岁' ? '岁己' : query;
}

/** Preserve compatibility for callers using only the targeted keyword queries. */
export function buildCoverageQueries(candidate: SearchCandidate, modelQueries: unknown, limit = 4): string[] {
    const values: string[] = [];
    const add = (value: unknown) => {
        const query = compactCoverageQuery(value);
        if (query.length >= 3 && !values.includes(query)) values.push(query);
    };
    if (Array.isArray(modelQueries)) for (const query of modelQueries) add(query);
    add(candidate.title);
    add(candidate.host && candidate.title ? `${candidate.host} ${candidate.title}` : candidate.title);
    const cues = candidate.cues.map(cue => cue.text.replace(/^(?:\s*\[[^\]\r\n]+\])+\s*/u, ''))
        .sort((a, b) => b.length - a.length);
    for (const text of cues.slice(0, 3)) add(candidate.host ? `${candidate.host} ${text}` : text);
    return values.slice(0, Math.max(1, limit));
}

/** Reserve bounded recall for rewritten titles before more restrictive keyword searches. */
export function buildCoverageSearchPlan(candidate: SearchCandidate, modelQueries: unknown,
    maxQueries: number, maxResults: number, registry?: CoverageStreamerRegistry): CoverageSearch[] {
    const query = coverageHostQuery(candidate, registry), plan: CoverageSearch[] = [];
    // Two platform pages cover at least three desktop rows. Each rerank receives
    // at most twenty results; never truncate a larger pool inside the AI prompt.
    if (query.length >= 2) for (let page = 1; page <= Math.min(2, maxQueries); page++) {
        plan.push({ query, limit: 20, order: 'pubdate', page });
    }
    const targeted = buildCoverageQueries({ ...candidate, host: query || candidate.host }, modelQueries, maxQueries);
    for (const keyword of targeted) {
        if (plan.length >= maxQueries) break;
        plan.push({ query: keyword, limit: maxResults });
    }
    return plan;
}
