type Data = Record<string, any>;

/** A middle-of-film still cannot show a later credits-to-search transition. */
export function watchContextFrameTimes(event: Data, intervals: Data[]): number[] {
  const middle = (event.start + event.end) / 2;
  if (event.boundaryFeedback) return [...new Set([middle, event.end,
    Math.max(event.start, event.boundaryFeedback.previousEnd - .25), intervals.at(-1)!.end - .25])];
  const later = intervals.filter(span => span.end > event.end + 90);
  if (!later.length) return [middle];
  const first = later[0], last = later.at(-1)!;
  return [...new Set([middle, Math.max(event.end, first.start), (last.start + last.end) / 2, last.end - .01])];
}

/** Mixed subtitles locate extra evidence, never establish an approved boundary. */
export function watchContextIntervals(event: Data, intervals: Data[], rows: Data[], duration: number,
  activities: Data[] = []): Data[] {
  if (event.kind !== 'watch' || intervals.length !== 2) return intervals;
  if (event.boundaryFeedback) intervals = [intervals[0], { ...intervals[1],
    start: Math.max(event.start, Math.min(intervals[1].start, event.end - 45)) }];
  const next = activities.filter(e => e.id !== event.id && e.start > event.end)
    .reduce((end, e) => Math.min(end, e.start), duration);
  const limit = Math.min(duration, next, event.end + 900);
  const transitions = rows.filter(row => row.source === 'audio_transcript' && row.start > intervals[1].end
    && row.end <= limit && /看完了|结束了|没有彩蛋|没(?:有)?彩蛋|下一个看|接下来.{0,8}看|现在.{0,8}搜|先看.{0,8}预告/u.test(row.text))
    .sort((a, b) => a.start - b.start);
  const spans = intervals.map(span => ({ ...span }));
  // Two short transition windows at most; keep the rough ending for comparison.
  for (const row of transitions) {
    if (spans.some(span => row.start >= span.start && row.end <= span.end)) continue;
    if (spans.length >= 4) break;
    spans.push({ start: Math.max(intervals[1].start, row.start - 30), end: Math.min(limit, row.end + 45) });
  }
  const merged: Data[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push(span);
  }
  return merged;
}

/** Rendering cannot resolve an explicitly unconfirmed watching enclosure. */
export function assertWatchBoundaries(events: Data[]): void {
  const held = events.filter(event => event.kind === 'watch' && (event.verification?.decision === 'uncertain'
    || (event.reviewIssues || []).some((issue: string) => ['media_verification_unconfirmed', 'watch_boundary_provisional',
      'overlapping_activity'].includes(issue))));
  if (held.length) throw new Error(`Viewing boundaries remain unresolved before rendering: ${held.map(e => `${e.id}: ${e.verification?.reason || 'incomplete context'}`).join('; ')}`);
}
