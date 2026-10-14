import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { alignWatchParts, blackScanWindows, blackSettings, parseBlackSpans, BlackSettings, Span, WatchPart } from './watchBlackPolicy';
import { movieCadenceSettings, trackMovieCadence } from './watchMovieCadence';

type Run = (args: string[], options: Record<string, any>) => Promise<{ stderr: string }>;
type ScanOptions = { mediaPath: string; directory: string; ffmpegPath?: string; run: Run;
  source: unknown; settings: BlackSettings; maximum: number; parts: WatchPart[] };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function blackFilter(settings: BlackSettings): string {
  const [x, y, width, height] = settings.region;
  // Crop before shrinking; constant letterboxing/host overlays must stay outside the ROI.
  return `setpts=PTS-STARTPTS,crop=iw*${width}:ih*${height}:iw*${x}:ih*${y},scale=320:-2,`
    + `blackdetect=d=${settings.minBlackSeconds}:pix_th=${settings.pixelThreshold}:pic_th=${settings.pictureThreshold}`;
}

export async function detectBlackWindow(window: Span, options: Pick<ScanOptions, 'mediaPath' | 'ffmpegPath' | 'run' | 'settings'>) {
  const common = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-ss', String(window.start), '-i', options.mediaPath,
    '-t', String(window.end - window.start), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', blackFilter(options.settings), '-f', 'null', '-'];
  const execution = { ffmpegPath: options.ffmpegPath || 'ffmpeg', stage: '视听电影区域黑场检测', threads: 1,
    timeoutMs: 600000, gpuTelemetry: true };
  let stderr: string, decoder = 'cuda', fallbackReason: string | undefined;
  try { ({ stderr } = await options.run(['-hwaccel', 'cuda', ...common], execution)); }
  catch (error) {
    decoder = 'software'; fallbackReason = error instanceof Error ? error.message : String(error);
    ({ stderr } = await options.run(common, execution));
  }
  return { ...window, decoder, ...(fallbackReason ? { fallbackReason } : {}),
    spans: parseBlackSpans(stderr, window, options.settings), logSha256: hash(stderr) };
}

/** Read-only media scanning. Cache is source/settings/boundary bound; no queues/providers. */
export async function scanWatchBlack(options: ScanOptions) {
  const settings = { ...blackSettings(options.settings), cadence: movieCadenceSettings(options.settings.cadence) };
  const binding = hash({ version: 3, source: options.source, settings, maximum: options.maximum, parts: options.parts });
  const directory = path.join(options.directory, 'temp', 'watch-black', binding.slice(0, 20));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'WATCH_SPLITS.json');
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { contentSha256, ...content } = cached;
    if (cached.binding !== binding || contentSha256 !== hash(content)) throw new Error('Watch black scan cache changed');
    return { ...cached, evidencePath: file, reused: true };
  }
  const windows = blackScanWindows(options.parts, settings), scans: any[] = [];
  const scanWindow = async (window: Span): Promise<Span[]> => {
    const covered = scans.find(scan => scan.start <= window.start && scan.end >= window.end);
    if (covered) return covered.spans.filter((span: Span) => span.start >= window.start && span.end <= window.end);
    const windowFile = path.join(directory, `window-${hash(window).slice(0, 16)}.json`);
    let scan;
    if (fs.existsSync(windowFile)) {
      const cached = JSON.parse(fs.readFileSync(windowFile, 'utf8'));
      const { contentSha256, ...content } = cached;
      if (cached.binding !== binding || contentSha256 !== hash(content)) throw new Error('Watch black window cache changed');
      scan = cached.scan;
    } else {
      scan = await detectBlackWindow(window, { ...options, settings });
      const content = { binding, scan };
      fs.writeFileSync(`${windowFile}.tmp`, JSON.stringify({ ...content, contentSha256: hash(content) }, null, 2), 'utf8');
      fs.renameSync(`${windowFile}.tmp`, windowFile);
    }
    scans.push(scan);
    return scan.spans;
  };
  const cadences: Record<string, any>[] = [];
  for (const id of new Set(options.parts.map(part => part.activityId))) {
    const group = options.parts.filter(part => part.activityId === id);
    if (group.length < 2 || !settings.cadence.enabled) continue;
    const session = { start: group[0].start, end: group.at(-1)!.end };
    const bootstrapEnd = Math.min(session.end, session.start + settings.cadence.bootstrapSeconds);
    const initial = await scanWindow({ start: session.start, end: bootstrapEnd });
    // Reviewed seeds may lie outside the ordinary bootstrap window.
    if (settings.cadence.seeds) for (const seed of settings.cadence.seeds) {
      if (seed <= session.start || seed >= session.end) throw new Error('Movie seeds must be inside this viewing session');
      if (!initial.some(span => seed >= span.start - 2 && seed <= span.end + 2)) {
        initial.push(...await scanWindow({ start: Math.max(session.start, seed - 5), end: Math.min(session.end, seed + 5) }));
      }
    }
    const tracked = await trackMovieCadence(session, initial, settings.cadence, scanWindow);
    cadences.push({ activityId: id, bootstrap: { start: session.start, end: bootstrapEnd }, ...tracked });
  }
  for (const window of windows) await scanWindow(window);
  const cadenceTimes = cadences.filter(cadence => cadence.status === 'locally_verified')
    .flatMap(cadence => [...cadence.cadence.matches, ...cadence.predictions.filter((p: any) => p.status === 'black_verified').map((p: any) => p.actual)]);
  const aligned = alignWatchParts(options.parts, scans.flatMap(scan => scan.spans), settings, options.maximum, cadenceTimes);
  const content = { version: 3, type: 'sui_watch_black_splits', binding, source: options.source, settings, maximum: options.maximum,
    scannedSeconds: scans.reduce((sum, window) => sum + window.end - window.start, 0),
    baselineParts: options.parts, scans, cadences, ...aligned, createdAt: new Date().toISOString(),
    interpretation: 'Black transitions are cut candidates, not confirmed movie chapter changes.' };
  const report = { ...content, contentSha256: hash(content) };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2), 'utf8'); fs.renameSync(`${file}.tmp`, file);
  return { ...report, evidencePath: file, reused: false };
}

/** Existing source CLIs supply their established FFmpeg/resource adapter. */
export async function applyWatchBlack(parts: WatchPart[], options: Record<string, any>, config: Record<string, any>,
  source: unknown, directory: string): Promise<WatchPart[]> {
  if (!config.watch.blackAlignment?.enabled || parts.length < 2) return parts;
  const report = await scanWatchBlack({ mediaPath: options.mediaPath, source, parts, directory,
    ffmpegPath: options.config.audio?.ffmpeg?.path, run: options.blackScanRun,
    settings: blackSettings(config.watch.blackAlignment), maximum: config.watch.maxPartSeconds });
  return report.parts.map((part: WatchPart) => ({ ...part, blackAlignmentEvidence: { path: report.evidencePath,
    binding: report.binding, contentSha256: report.contentSha256 } }));
}
