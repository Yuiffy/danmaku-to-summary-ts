/** Black transitions suggest comfortable cuts; they do not prove movie chapter changes. */
export interface Span { start: number; end: number }
export interface WatchPart extends Span { duration: number; [key: string]: any }
export interface MovieCadenceSettings {
  enabled: boolean;
  bootstrapSeconds: number;
  minPeriodSeconds: number;
  maxPeriodSeconds: number;
  searchSeconds: number;
  recoverySeconds: number;
  seeds?: [number, number];
}
export interface BlackSettings {
  enabled: boolean;
  region: [number, number, number, number];
  searchSeconds: number;
  minBlackSeconds: number;
  maxBlackSeconds: number;
  pixelThreshold: number;
  pictureThreshold: number;
  minPartSeconds: number;
  cadence?: MovieCadenceSettings;
}

export function blackSettings(raw: Record<string, any> = {}): BlackSettings {
  const result: Record<string, any> = { enabled: false, region: null, searchSeconds: 300, minBlackSeconds: .35,
    maxBlackSeconds: 8, pixelThreshold: .08, pictureThreshold: .985, minPartSeconds: 900, ...raw };
  if (typeof result.enabled !== 'boolean') throw new Error('Invalid watch black alignment enabled');
  if (!result.enabled) return result as BlackSettings;
  const region = typeof result.region === 'string' ? result.region.split(',').map(Number) : result.region;
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)
    || region[0] < 0 || region[1] < 0 || region[2] <= 0 || region[3] <= 0
    || region[0] + region[2] > 1 || region[1] + region[3] > 1) {
    throw new Error('Movie region must be normalized x,y,width,height inside the frame');
  }
  result.region = region;
  for (const [field, min, max] of [['searchSeconds', 1, 900], ['minBlackSeconds', .1, 5],
    ['maxBlackSeconds', .1, 30], ['pixelThreshold', .001, .2], ['pictureThreshold', .9, 1]] as const) {
    if (!Number.isFinite(result[field]) || result[field] < min || result[field] > max) {
      throw new Error(`Invalid watch black alignment ${field}`);
    }
  }
  if (!Number.isFinite(result.minPartSeconds) || result.minPartSeconds <= 0) throw new Error('Invalid watch black alignment minPartSeconds');
  if (result.maxBlackSeconds < result.minBlackSeconds) throw new Error('Invalid black duration range');
  return result as BlackSettings;
}

export function blackScanWindows(parts: WatchPart[], settings: BlackSettings): Span[] {
  const windows: Span[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].activityId !== parts[i - 1].activityId) continue;
    const group = parts.filter(p => p.activityId === parts[i].activityId);
    const span = { start: Math.max(group[0].start, parts[i].start - settings.searchSeconds - 1),
      end: Math.min(group.at(-1)!.end, parts[i].start + settings.searchSeconds + 1) };
    const previous = windows.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else windows.push(span);
  }
  return windows;
}

export function parseBlackSpans(stderr: string, window: Span, settings: BlackSettings): Span[] {
  const result: Span[] = [];
  const pattern = /black_start:([\d.e+-]+)\s+black_end:([\d.e+-]+)\s+black_duration:([\d.e+-]+)/gi;
  for (const match of stderr.matchAll(pattern)) {
    const from = Number(match[1]), to = Number(match[2]);
    // Require visible material on both sides. Edge-truncated black/long pauses are not cuts.
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < .15 || to > window.end - window.start - .15
      || to - from < settings.minBlackSeconds || to - from > settings.maxBlackSeconds) continue;
    result.push({ start: window.start + from, end: window.start + to });
  }
  return result;
}

type Cut = { time: number; black?: Span };
type Path = { cuts: Cut[]; hits: number; cadenceHits: number; cost: number };
const better = (a: Path, b?: Path) => !b || a.hits > b.hits || a.hits === b.hits && a.cadenceHits > b.cadenceHits
  || a.hits === b.hits && a.cadenceHits === b.cadenceHits && a.cost < b.cost;

/** Joint choice prevents two individually good cuts from making an overlong/short P. */
export function alignWatchParts(parts: WatchPart[], spans: Span[], settings: BlackSettings,
  maximum: number, cadenceTimes: number[] = []): { parts: WatchPart[]; cuts: Record<string, any>[] } {
  const output: WatchPart[] = [], selected: Record<string, any>[] = [];
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('Invalid maximum viewing P');
  for (const id of new Set(parts.map(p => p.activityId))) {
    const group = parts.filter(p => p.activityId === id);
    if (group.some((p, i) => !Number.isFinite(p.start) || !Number.isFinite(p.end) || p.end <= p.start
      || p.duration !== p.end - p.start || p.duration > maximum + 1e-6 || i > 0 && p.start !== group[i - 1].end)) {
      throw new Error('Black alignment requires continuous valid viewing parts');
    }
    if (group.length < 2 || !settings.enabled) { output.push(...group); continue; }
    const start = group[0].start, end = group.at(-1)!.end;
    // A short editorial size must still leave room to align with nearby movie transitions.
    const minimum = Math.min(settings.minPartSeconds, maximum / 2, ...group.map(p => p.duration));
    let paths: Path[] = [{ cuts: [{ time: start }], hits: 0, cadenceHits: 0, cost: 0 }];
    for (let i = 1; i < group.length; i++) {
      const baseline = group[i].start;
      const candidates: Cut[] = [{ time: baseline }, ...spans.filter(span => Number.isFinite(span.start)
        && Number.isFinite(span.end) && span.end - span.start >= settings.minBlackSeconds
        && span.end - span.start <= settings.maxBlackSeconds && span.start > start && span.end < end)
        .map(black => ({ time: (black.start + black.end) / 2, black }))
        .filter(cut => Math.abs(cut.time - baseline) <= settings.searchSeconds)]
        .sort((a, b) => a.time - b.time);
      const next: Path[] = [];
      for (const candidate of candidates) {
        let winner: Path | undefined;
        for (const previous of paths) {
          const duration = candidate.time - previous.cuts.at(-1)!.time;
          if (duration < minimum - 1e-6 || duration > maximum + 1e-6) continue;
          const path = { cuts: [...previous.cuts, candidate], hits: previous.hits + Number(!!candidate.black),
            cadenceHits: previous.cadenceHits + Number(!!candidate.black && cadenceTimes.some(time => Math.abs(time - candidate.time) <= 1)),
            cost: previous.cost + (duration - group[i - 1].duration) ** 2 };
          if (better(path, winner)) winner = path;
        }
        if (winner) next.push(winner);
      }
      paths = next;
    }
    let winner: Path | undefined;
    for (const previous of paths) {
      const duration = end - previous.cuts.at(-1)!.time;
      if (duration < minimum - 1e-6 || duration > maximum + 1e-6) continue;
      const path = { ...previous, cuts: [...previous.cuts, { time: end }], cost: previous.cost + (duration - group.at(-1)!.duration) ** 2 };
      if (better(path, winner)) winner = path;
    }
    if (!winner) throw new Error('No continuous viewing split satisfies duration limits');
    output.push(...group.map((part, i) => {
      const from = winner!.cuts[i], to = winner!.cuts[i + 1];
      return { ...part, start: from.time, end: to.time, duration: to.time - from.time,
        splitBoundary: i < group.length - 1 ? { method: to.black ? 'movie_region_black' : 'balanced',
          baseline: group[i + 1].start, time: to.time, ...(to.black ? { black: to.black } : {}) } : undefined };
    }));
    selected.push(...winner.cuts.slice(1, -1).map((cut, i) => ({ activityId: id, baseline: group[i + 1].start,
      time: cut.time, method: cut.black ? 'movie_region_black' : 'balanced', ...(cut.black ? { black: cut.black } : {}) })));
  }
  return { parts: output, cuts: selected };
}
