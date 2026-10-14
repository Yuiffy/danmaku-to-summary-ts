import { Span, MovieCadenceSettings } from './watchBlackPolicy';
export interface MovieCadence { period: number; anchor: number; matches: number[]; origin: 'inferred' | 'reviewed_seeds' }
const midpoint = (span: Span) => (span.start + span.end) / 2;

export function movieCadenceSettings(raw: Record<string, any> = {}): MovieCadenceSettings {
  const result: MovieCadenceSettings = { enabled: true, bootstrapSeconds: 2400, minPeriodSeconds: 120,
    maxPeriodSeconds: 1200, searchSeconds: 45, recoverySeconds: 240, ...raw };
  if (typeof result.enabled !== 'boolean') throw new Error('Invalid movie cadence enabled');
  for (const [field, min, max] of [['bootstrapSeconds', 600, 3600], ['minPeriodSeconds', 60, 1800],
    ['maxPeriodSeconds', 60, 1800], ['searchSeconds', 1, 180], ['recoverySeconds', 1, 900]] as const) {
    if (!Number.isFinite(result[field]) || result[field] < min || result[field] > max) throw new Error(`Invalid movie cadence ${field}`);
  }
  if (result.maxPeriodSeconds < result.minPeriodSeconds || result.recoverySeconds < result.searchSeconds) {
    throw new Error('Invalid movie cadence ranges');
  }
  if (result.seeds && (result.seeds.length !== 2 || !result.seeds.every(Number.isFinite)
    || result.seeds[0] < 0 || result.seeds[1] <= result.seeds[0]
    || result.seeds[1] - result.seeds[0] < result.minPeriodSeconds
    || result.seeds[1] - result.seeds[0] > result.maxPeriodSeconds)) throw new Error('Invalid movie part seeds');
  return result;
}

/** A pair is only a hypothesis. Future local black evidence must verify each prediction. */
export function inferMovieCadence(spans: Span[], settings: MovieCadenceSettings): MovieCadence | null {
  const times = [...new Set(spans.map(midpoint))].sort((a, b) => a - b);
  if (settings.seeds) {
    const anchors = settings.seeds.map(seed => times.find(time => Math.abs(time - seed) <= 2));
    if (anchors.some(time => time === undefined)) throw new Error('Movie part seeds have no local black-frame evidence');
    return { period: anchors[1]! - anchors[0]!, anchor: anchors[1]!, matches: anchors as number[], origin: 'reviewed_seeds' };
  }
  let best: { cadence: MovieCadence; residual: number; support: number } | undefined;
  for (let i = 0; i < times.length; i++) for (let j = i + 1; j < times.length; j++) {
    const period = times[j] - times[i];
    if (period < settings.minPeriodSeconds || period > settings.maxPeriodSeconds) continue;
    const matches = [times[i], times[j]]; let residual = 0, skipped = 0;
    for (const time of times.slice(j + 1)) {
      const elapsed = time - matches.at(-1)!;
      const cycles = Math.max(1, Math.round(elapsed / period));
      if (Math.abs(elapsed - cycles * period) <= Math.min(5, period * .01)) {
        matches.push(time); residual += Math.abs(elapsed - cycles * period); skipped += cycles - 1;
      }
    }
    // Missing transitions are allowed, but sparse harmonic coincidences score lower.
    const support = matches.length - skipped * .5;
    if (!best || support > best.support || support === best.support && matches.length > best.cadence.matches.length
      || support === best.support && matches.length === best.cadence.matches.length && residual < best.residual) {
      best = { cadence: { period, anchor: matches.at(-1)!, matches, origin: 'inferred' }, residual, support };
    }
  }
  return best?.cadence || null;
}

export async function trackMovieCadence(session: Span, initial: Span[], settings: MovieCadenceSettings,
  scan: (window: Span) => Promise<Span[]>) {
  const cadence = inferMovieCadence(initial, settings);
  const predictions: Record<string, any>[] = [], found: Span[] = [];
  if (!cadence) return { status: 'no_pattern', cadence: null, predictions, spans: found };
  const initialCadence = { ...cadence, matches: [...cadence.matches] };
  let misses = 0;
  // Three missing predictions abandon the rule; balanced-window scanning still runs.
  while (cadence.anchor + cadence.period < session.end - .2 && predictions.length < 120) {
    const predicted = cadence.anchor + cadence.period;
    const search = async (radius: number) => {
      const window = { start: Math.max(session.start, predicted - radius - 1),
        end: Math.min(session.end, predicted + radius + 1) };
      const spans = await scan(window);
      return spans.filter(span => Math.abs(midpoint(span) - predicted) <= radius)
        .sort((a, b) => Math.abs(midpoint(a) - predicted) - Math.abs(midpoint(b) - predicted))[0];
    };
    let matched = await search(settings.searchSeconds), recovered = false;
    if (!matched) { matched = await search(settings.recoverySeconds); recovered = !!matched; }
    if (matched && midpoint(matched) > cadence.anchor + settings.minPeriodSeconds * .5) {
      const actual = midpoint(matched);
      predictions.push({ predicted, actual, deviation: actual - predicted, recovered, status: 'black_verified' });
      found.push(matched); cadence.matches.push(actual); cadence.anchor = actual; misses = 0;
    } else {
      predictions.push({ predicted, status: 'missing', fallback: 'balanced_window' });
      // Re-anchor to a later observed black when a longer pause shifted the timeline.
      const later = initial.map(midpoint).filter(time => time > predicted + settings.recoverySeconds)
        .sort((a, b) => a - b)[0];
      if (later !== undefined) {
        predictions.at(-1)!.reanchoredAt = later; cadence.anchor = later; misses = 0;
      } else { cadence.anchor = predicted; if (++misses >= 3) break; }
    }
  }
  return { status: predictions.length >= 120 ? 'prediction_limit' : misses >= 3 ? 'lost_pattern'
    : cadence.matches.length >= 3 ? 'locally_verified' : 'tentative_pair',
    cadence: initialCadence, finalAnchor: cadence.anchor, predictions, spans: found };
}
