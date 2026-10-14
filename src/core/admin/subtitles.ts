/** Convert a display copy of SRT to WebVTT; never modify the reviewed source. */
export function srtToVtt(srt: string): string {
  return 'WEBVTT\n\n' + srt.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/gu, '$1.$2');
}

export interface SubtitleRow { id: string; at: number; end: number; time: string; text: string }
export function timeSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  const match = /^(\d+):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/u.exec(String(value || '').trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '').padEnd(3, '0')) / 1000;
}
export function subtitleRows(text: string): SubtitleRow[] {
  return text.replace(/^\uFEFF/u, '').replace(/\r/gu, '').trim().split(/\n\s*\n/gu).flatMap(block => {
    const rows = block.split('\n'), line = rows.findIndex(row => row.includes('-->'));
    const [start, finish] = (rows[line] || '').split('-->').map(value => value.trim());
    const at = timeSeconds(start), end = timeSeconds(finish);
    return at === undefined || end === undefined || end <= at ? [] : [{ id: line ? rows[0] : '', at, end, time: start, text: rows.slice(line + 1).join('\n') }];
  });
}
export function sourceWindowSubtitles(text: string, start: number, end: number): string {
  return subtitleRows(text).filter(row => row.end > start && row.at < end)
    .map(row => `${row.id}\n${row.time} --> ${formatSubtitleTime(row.end)}\n${row.text}\n`).join('\n');
}
export function formatSubtitleTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
