interface Cue { id: string; start: number; end: number }
interface Match { start: number; end: number; text?: string; matchedKeywords?: string[] }
interface Group { start: number; end: number; cues: Cue[]; matchSegments: Match[] }
interface Config {
  contextPrePaddingSeconds?: number;
  contextPostPaddingSeconds?: number;
  editorial?: { maxGroupSeconds?: number };
}
interface BoundaryDraft {
  startCueId?: string;
  endCueId?: string;
  boundaryReview?: {
    setupCueId?: string;
    closureCueId?: string;
    unresolvedCueIds?: unknown;
    dependencies?: Array<{ cueId?: string; dependsOnCueIds?: unknown }>;
  };
}
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string') : [];

function contextCandidates<T extends Group>(group: T, earlier: Cue[], later: Cue[],
  config: Config, recallMatches: Match[] = []): T[] {
  const maxSeconds = Number(config.editorial?.maxGroupSeconds ?? 1800);
  const minimumBefore = Math.min(3, earlier.length), minimumAfter = Math.min(3, later.length);
  let preCount = earlier.length, postCount = later.length;
  const candidates: T[] = [];
  for (;;) {
    const cues = [...earlier.slice(earlier.length - preCount), ...group.cues, ...later.slice(0, postCount)];
    const start = cues[0].start, end = cues.at(-1)!.end;
    if (end - start <= maxSeconds) {
      const matches = [...group.matchSegments];
      const key = (row: Match) => `${row.start}:${row.end}:${row.text || ''}`;
      const keys = new Set(matches.map(key));
      for (const match of recallMatches) {
        if (!keys.has(key(match)) && cues.some(cue => cue.start <= match.start && cue.end >= match.end)) {
          matches.push(match);
          keys.add(key(match));
        }
      }
      candidates.push({ ...group, start, end, cues, matchSegments: matches, matchCount: matches.length,
        matchedKeywords: [...new Set(matches.flatMap(match => match.matchedKeywords || []))] });
    }
    if (preCount === minimumBefore && postCount === minimumAfter) break;
    preCount = Math.max(minimumBefore, Math.floor(preCount / 2));
    postCount = Math.max(minimumAfter, Math.floor(postCount / 2));
  }
  return candidates;
}

/** Budget only newly added recovery context; every retained row and original anchor is mandatory. */
export function preflightRecoveryContextCandidates<T extends Group>(group: T,
  retained: { start: number; end: number }, config: Config): T[] {
  const cues = group.cues.filter(cue => cue.end > retained.start && cue.start < retained.end);
  if (!cues.length || group.matchSegments.some(match => !cues.some(cue =>
    cue.start <= match.start && cue.end >= match.end))) return [group];
  const base = { ...group, start: cues[0].start, end: cues.at(-1)!.end, cues };
  return contextCandidates(base, group.cues.filter(cue => cue.end <= base.start),
    group.cues.filter(cue => cue.start >= base.end), config);
}

/** Read more source only for concrete references at/beyond an exhausted context edge. */
export function preflightContextCandidates<T extends Group>(group: T, evidence: { cues: Cue[] },
  previous: string, config: Config, recallMatches: Match[] = []): T[] {
  let draft: { clips?: BoundaryDraft[] };
  try { draft = JSON.parse(previous); } catch { return []; }
  if (!Array.isArray(draft?.clips) || !group.cues.length) return [];
  const visible = new Map(group.cues.map((cue, index) => [cue.id, index]));
  const all = new Map(evidence.cues.map(cue => [cue.id, cue]));
  let before = false, after = false;
  for (const clip of draft.clips) {
    const review = clip?.boundaryReview;
    if (!review || typeof review !== 'object') continue;
    const unresolved = new Set(strings(review.unresolvedCueIds));
    const references = [review.setupCueId, review.closureCueId, ...unresolved,
      ...(Array.isArray(review.dependencies) ? review.dependencies.flatMap(row =>
        row ? [row.cueId, ...strings(row.dependsOnCueIds)] : []) : [])];
    const start = all.get(clip.startCueId || '')?.start;
    const end = all.get(clip.endCueId || '')?.end;
    for (const id of references) {
      const cue = id && all.get(id);
      if (!cue) continue; // Unknown IDs never become invented evidence.
      if (cue.start < group.start) before = true;
      if (cue.end > group.end) after = true;
      const index = visible.get(cue.id);
      const outside = start !== undefined && end !== undefined && (cue.start < start || cue.end > end);
      if (index !== undefined && (unresolved.has(cue.id) || outside)) {
        if (index < 3) before = true;
        if (index >= group.cues.length - 3) after = true;
      }
    }
  }
  const ids = new Set(group.cues.map(cue => cue.id));
  const preSeconds = Math.max(0, Number(config.contextPrePaddingSeconds ?? 180));
  const postSeconds = Math.max(0, Number(config.contextPostPaddingSeconds ?? 300));
  const earlier = before ? evidence.cues.filter(cue => !ids.has(cue.id)
    && cue.end > group.start - preSeconds && cue.start < group.start) : [];
  const later = after ? evidence.cues.filter(cue => !ids.has(cue.id)
    && cue.start < group.end + postSeconds && cue.end > group.end) : [];
  if (!earlier.length && !later.length) return [];
  return contextCandidates(group, earlier, later, config, recallMatches);
}

/** Prior prose/copy is not evidence. Keep the failed boundaries and dependency IDs for feedback. */
export function preflightRepairFeedback(previous: string): unknown {
  let draft: { clips?: Array<(BoundaryDraft & { id?: string; status?: string; hitIds?: unknown }) | null> };
  try { draft = JSON.parse(previous); } catch { return { invalidJson: true }; }
  if (!Array.isArray(draft?.clips)) return { missingClips: true };
  return { clips: draft.clips.map(clip => ({
    id: clip?.id, status: clip?.status, startCueId: clip?.startCueId, endCueId: clip?.endCueId,
    hitIds: clip?.hitIds,
    ...(clip?.boundaryReview ? { boundaryReview: {
      setupCueId: clip.boundaryReview.setupCueId, closureCueId: clip.boundaryReview.closureCueId,
      unresolvedCueIds: clip.boundaryReview.unresolvedCueIds,
      dependencies: Array.isArray(clip.boundaryReview.dependencies)
        ? clip.boundaryReview.dependencies.map(row =>
          ({ cueId: row?.cueId, dependsOnCueIds: row?.dependsOnCueIds })) : []
    } } : {})
  })) };
}
