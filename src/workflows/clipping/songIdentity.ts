import { createHash } from 'crypto';

export interface SongRow { index: number; start: number; end: number; text: string }
export interface SongEvent { id: string; start: number; end: number; name?: string | null }
export interface CatalogSong { id: string; name: string; artists: string[]; lyrics: string; url: string; lyricUrl: string; fetchedAt: string }
export interface LyricMatch { segmentIndices: number[]; lyric: string; quote: string; matchedCharacters: number }
export const lyricText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const lyricDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export function songWorkName(name: string, artists: string[] = []): string {
  let value = name.trim();
  const prefix = value.match(/^【([^】]+)】/u);
  if (prefix && prefix[1].split(/[/、&]/u).every(label => artists.some(artist => lyricText(artist) === lyricText(label)))) value = value.slice(prefix[0].length).trim();
  const cover = value.match(/^《([^《》]+)》\s*(?:(?:\d+[pP])?多人)?(?:翻唱|合唱|cover)$/iu);
  if (cover) return cover[1];
  return value.replace(/\s*[（(](?:[^）)]*\b(?:cover|live)\b[^）)]*|现场版|翻唱)[）)]\s*$/iu, '').trim();
}
export function catalogLines(lyrics: string): string[] {
  return [...new Set(lyrics.split(/\r?\n/u).map(line => line.replace(/\[[^\]]*\]/gu, '').trim())
    .filter(line => lyricText(line).length >= 6 && !/^(?:作词|作曲|编曲|制作|演唱|词|曲|lyricist|composer)\s*[:：]/iu.test(line)))];
}
function commonLength(left: string, right: string): number {
  const previous = new Uint16Array(right.length + 1); let best = 0;
  for (const char of left) {
    for (let i = right.length; i > 0; i--) {
      previous[i] = char === right[i - 1] ? previous[i - 1] + 1 : 0;
      best = Math.max(best, previous[i]);
    }
  }
  return best;
}
export function lyricMatchLength(quote: string, lyric: string): number {
  const left = lyricText(quote), right = lyricText(lyric);
  if (left.length < 6 || right.length < 6 || left.length > 500 || right.length > 500) return 0;
  const common = commonLength(left, right);
  return common >= 6 && common / Math.min(left.length, right.length) >= .85 ? common : 0;
}

/** Lyrics identify the work only. No name match establishes who sang or the performance boundaries. */
export function matchSongLyrics(event: SongEvent, rows: SongRow[], lyrics: string): LyricMatch[] {
  const inside = rows.filter(row => row.start >= event.start && row.end <= event.end && row.text.length <= 500);
  const matches: LyricMatch[] = [];
  for (const lyric of catalogLines(lyrics)) {
    let best: LyricMatch | undefined;
    for (let i = 0; i < inside.length; i++) for (let count = 1; count <= 3 && i + count <= inside.length; count++) {
      const group = inside.slice(i, i + count);
      if (group.at(-1)!.end - group[0].start > 25 || group.some((row, j) => j && row.start - group[j - 1].end > 3)) continue;
      const quote = group.map(row => row.text).join(' '), matchedCharacters = lyricMatchLength(quote, lyric);
      if (matchedCharacters && (!best || matchedCharacters > best.matchedCharacters)) best = { segmentIndices: group.map(row => row.index), lyric, quote, matchedCharacters };
    }
    if (best) matches.push(best);
  }
  return matches;
}
export function sufficientLyricMatches(event: SongEvent, matches: LyricMatch[], rows: SongRow[]): boolean {
  const unique = new Map(matches.map(match => [lyricText(match.lyric), match]));
  const indices = new Set([...unique.values()].flatMap(match => match.segmentIndices));
  const cited = rows.filter(row => indices.has(row.index));
  return unique.size >= 3 && new Set(matches.map(match => lyricText(match.quote))).size >= 3 && indices.size >= 3
    && [...unique.values()].reduce((total, match) => total + match.matchedCharacters, 0) >= 30
    && cited.length > 0 && Math.max(...cited.map(row => row.end)) - Math.min(...cited.map(row => row.start)) >= Math.min(15, (event.end - event.start) / 3);
}
export function identifySongFromCatalog(event: SongEvent, rows: SongRow[], songs: CatalogSong[], transcript: { path: string; sha256: string }) {
  const candidates = songs.map(song => ({ song, matches: matchSongLyrics(event, rows, song.lyrics) }));
  const supported = candidates.filter(item => sufficientLyricMatches(event, item.matches, rows));
  const names = [...new Set(supported.map(item => lyricText(songWorkName(item.song.name, item.song.artists))))];
  if (names.length !== 1) return { status: 'unresolved' as const,
    reason: names.length ? '多首不同歌曲均有歌词支持，需继续排查串歌或边界' : '尚无三句独立歌词支持同一首歌',
    candidates: candidates.map(({ song, matches }) => ({ id: song.id, name: song.name, artists: song.artists, matchedLines: matches.length })) };
  const best = supported.sort((a, b) => b.matches.reduce((sum, match) => sum + match.matchedCharacters, 0)
    - a.matches.reduce((sum, match) => sum + match.matchedCharacters, 0))[0];
  const indices = new Set(best.matches.flatMap(match => match.segmentIndices));
  return { status: 'identified' as const, item: { activityId: event.id, name: songWorkName(best.song.name, best.song.artists),
    method: 'catalog_lyric_match', transcriptPath: transcript.path, transcriptSha256: transcript.sha256,
    segments: rows.filter(row => indices.has(row.index)), catalog: { ...best.song, provider: 'netease', lyricSha256: lyricDigest(best.song.lyrics) },
    matches: best.matches, note: '目录歌曲信息与本活动原字幕中的多句歌词交叉核对；不代表演唱者或边界已通过审核' } };
}

/** Revalidate cached research against current transcript rows before packaging or publication. */
export function validateCatalogTitle(item: any, event: SongEvent, rows: SongRow[], transcript: { path: string; sha256: string }): void {
  const catalog = item?.catalog;
  if (!event || item.activityId !== event.id || item.method !== 'catalog_lyric_match' || !item.note?.trim()
    || item.transcriptPath !== transcript.path || item.transcriptSha256 !== transcript.sha256
    || catalog?.provider !== 'netease' || !/^[1-9]\d{0,14}$/u.test(catalog?.id || '')
    || typeof catalog.name !== 'string' || !Array.isArray(catalog.artists) || item.name !== songWorkName(catalog.name, catalog.artists)
    || typeof catalog.lyrics !== 'string' || catalog.lyrics.length > 50000 || catalog.lyricSha256 !== lyricDigest(catalog.lyrics)
    || catalog.url !== `https://music.163.com/song?id=${catalog.id}`
    || !Array.isArray(item.matches) || item.matches.length > 300 || !Array.isArray(item.segments)) throw new Error('Invalid catalog title evidence');
  const lines = new Set(catalogLines(catalog.lyrics)), indices = new Set<number>();
  for (const match of item.matches as LyricMatch[]) {
    if (!Array.isArray(match.segmentIndices) || !match.segmentIndices.length || match.segmentIndices.length > 3
      || !lines.has(match.lyric)) throw new Error('Invalid catalog lyric citation');
    const selected = match.segmentIndices.map(index => rows[index - 1]);
    if (selected.some((row, i) => !row || row.index !== match.segmentIndices[i] || row.start < event.start || row.end > event.end
      || i > 0 && (row.index !== selected[i - 1].index + 1 || row.start - selected[i - 1].end > 3))
      || selected.at(-1)!.end - selected[0].start > 25 || selected.map(row => row.text).join(' ') !== match.quote
      || lyricMatchLength(match.quote, match.lyric) !== match.matchedCharacters || !match.matchedCharacters) throw new Error('Catalog lyric match differs from current source');
    match.segmentIndices.forEach(index => indices.add(index));
  }
  if (JSON.stringify(item.segments) !== JSON.stringify(rows.filter(row => indices.has(row.index)))
    || !sufficientLyricMatches(event, item.matches, rows)) throw new Error('Insufficient independent lyric evidence');
}
