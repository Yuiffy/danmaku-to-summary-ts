import * as fs from 'fs/promises';
import * as path from 'path';
import { readSubtitle, recordingFolderDate, SubtitleSource, within } from './SubtitleCorpus';
import { unsafeQuestionText } from './QuestionPolicy';

export interface LiveOverview {
  scope: 'available-recordings'; limited: boolean;
  latestRecording?: { date: string; time: string };
  session?: { date: string; time: string };
  artifacts: Array<{ kind: 'live-summary' | 'goodnight-reply' | 'comic-script' | 'highlight'; text: string }>;
}
interface Artifact extends SubtitleSource { session: string; time: string; kind: LiveOverview['artifacts'][number]['kind'] }
const suffixes = [['_LIVE_CONTENT.json', 'live-summary'], ['_晚安回复.md', 'goodnight-reply'],
  ['_COMIC_SCRIPT.txt', 'comic-script'], ['_AI_HIGHLIGHT.txt', 'highlight']] as const;
const validDay = (date: string) => /^20\d{2}-\d{2}-\d{2}$/u.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const safe = (value: unknown, max = 600) => typeof value === 'string' ? value.split(/\r?\n/u)
  .map(line => line.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim())
  .filter(line => line && !unsafeQuestionText(line)).join(' ').slice(0, max) : '';

/** Fixed artifact schemas only. Generated copy is an overview, never a verbatim broadcast quote. */
export function overviewText(kind: Artifact['kind'], content: string, roomId: string): string {
  content = content.replace(/^\uFEFF/u, '');
  if (kind === 'live-summary') {
    const payload = JSON.parse(content);
    if (payload.schemaVersion !== 1 || payload.status !== 'success' || String(payload.roomId) !== roomId) return '';
    const value = payload.content;
    if (!value || typeof value !== 'object') return '';
    const parts = [safe(value.overview, 260)];
    for (const [key, label] of [['games', '游戏'], ['songs', '歌曲'], ['topics', '话题']] as const) {
      if (Array.isArray(value[key])) {
        const text = value[key].slice(0, 10).map((item: unknown) => safe(item, 45)).filter(Boolean).join('、');
        if (text) parts.push(`${label}：${text}`);
      }
    }
    return parts.filter(Boolean).join('；').slice(0, 600);
  }
  if (kind === 'goodnight-reply') {
    // Only the published body, never provider diagnostics, attempts or request IDs in YAML.
    if (/^---\r?\n/u.test(content)) {
      const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content);
      if (!header) return '';
      content = content.slice(header[0].length);
    }
    return safe(content);
  }
  if (kind === 'comic-script') {
    // Immersive scripts contain rendering instructions; retain narrative and on-image text only.
    const lines = content.trim().split(/\r?\n/u);
    if (!lines[0]?.startsWith('{')) return '';
    const first = JSON.parse(lines[0]);
    return safe([first.narrativeArc, ...(Array.isArray(first.textPlan) ? first.textPlan.slice(0, 8)
      .map((item: { text?: unknown }) => item.text) : [])].filter(item => typeof item === 'string').join('；'), 400);
  }
  return safe(content, 400);
}

/** Bounded top-level/date-folder reads; no model-supplied paths, recursion, media reads or writes. */
export async function readLiveOverview(roots: string[], roomId: string, date: string | null, at: number,
  signal: AbortSignal): Promise<LiveOverview> {
  if (date !== null && (!validDay(date) || typeof date !== 'string')) throw new Error('Expected YYYY-MM-DD or null');
  const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const result: LiveOverview = { scope: 'available-recordings', limited: false, artifacts: [] };
  const artifacts: Artifact[] = [];
  let latest = '';
  for (const configured of roots) {
    signal.throwIfAborted();
    try {
      const root = await fs.realpath(configured);
      const entries = await fs.readdir(root, { withFileTypes: true });
      const dated = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
        validDay(recordingFolderDate(entry.name) || '') && (recordingFolderDate(entry.name)! <= day) &&
        (!date || recordingFolderDate(entry.name) === date))
        .sort((a, b) => recordingFolderDate(b.name)!.localeCompare(recordingFolderDate(a.name)!));
      // Broad archives are not a complete broadcast history. Preserve this coverage limit.
      result.limited ||= dated.length > 14;
      const folders = [{ folder: root, date: null as string | null }, ...dated.slice(0, 14)
        .map(entry => ({ folder: path.join(root, entry.name), date: recordingFolderDate(entry.name) }))];
      for (const folder of folders) {
        signal.throwIfAborted();
        const resolved = await fs.realpath(folder.folder);
        if (resolved !== root && !within(root, resolved)) { result.limited = true; continue; }
        const files = folder.folder === root ? entries : await fs.readdir(resolved, { withFileTypes: true });
        result.limited ||= files.length > 10000;
        for (const file of files.slice(0, 10000)) {
          if (!file.isFile() || file.isSymbolicLink()) continue;
          const clock = /^(?:录制-([1-9]\d*)-)?(20\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/u.exec(file.name);
          const alternate = /^(20\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_/u.exec(file.name);
          if (clock?.[1] && clock[1] !== roomId) continue;
          const parts = clock?.slice(2, 8) || alternate?.slice(1, 7);
          const fileDay = parts ? parts.slice(0, 3).join('-') : folder.date;
          if (!fileDay || !validDay(fileDay) || fileDay > day || date && fileDay !== date) continue;
          const time = parts ? parts.slice(3).join(':') : '00:00:00';
          if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(time) ||
              Date.parse(`${fileDay}T${time}+08:00`) > at) continue;
          const suffix = suffixes.find(([ending]) => file.name.endsWith(ending));
          if (!suffix && !/\.(?:flv|mp4|mkv|xml|srt)$/iu.test(file.name)) continue;
          const stamp = `${fileDay}T${time}`;
          if (stamp > latest) { latest = stamp; result.latestRecording = { date: fileDay, time }; }
          if (suffix) artifacts.push({ file: path.join(resolved, file.name), root, date: fileDay, time,
            session: `${stamp}\0${file.name.slice(0, -suffix[0].length)}`, kind: suffix[1] });
        }
      }
    } catch { signal.throwIfAborted(); result.limited = true; }
  }
  artifacts.sort((a, b) => b.session.localeCompare(a.session) ||
    suffixes.findIndex(([, kind]) => kind === a.kind) - suffixes.findIndex(([, kind]) => kind === b.kind));
  let selected: string | undefined;
  for (const artifact of artifacts.slice(0, 48)) {
    signal.throwIfAborted();
    if (selected && artifact.session !== selected) continue;
    if (result.artifacts.some(item => item.kind === artifact.kind)) continue;
    try {
      const text = overviewText(artifact.kind, (await readSubtitle(artifact, signal)).content, roomId);
      if (!text) { result.limited = true; continue; }
      selected = artifact.session;
      result.session = { date: artifact.date!, time: artifact.time };
      result.artifacts.push({ kind: artifact.kind, text });
    } catch { signal.throwIfAborted(); result.limited = true; }
    if (result.artifacts.length >= 3) break;
  }
  result.limited ||= artifacts.length > 48 || !result.artifacts.length;
  return result;
}
