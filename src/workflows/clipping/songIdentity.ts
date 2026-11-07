import { createHash } from 'crypto';

export interface SongRow { index: number; start: number; end: number; text: string }
export interface SongEvent { id: string; start: number; end: number; name?: string | null }
export interface CatalogSong { id: string; name: string; artists: string[]; lyrics: string; url: string; lyricUrl: string; fetchedAt: string }
export interface LyricMatch { segmentIndices: number[]; lyric: string; quote: string; matchedCharacters: number }
export const lyricText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const lyricDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
/** Compare spoken/summary song hints with catalog work names without a global ASR replacement. */
export function songWorkKey(name: string): string {
  return lyricText(songWorkName(name)).replace(/[ノの]/gu, '之').replace(/幹/gu, '干').replace(/若/gu, '弱');
}
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
function titleContextRows(event: SongEvent, rows: SongRow[], hint: string): SongRow[] {
  const key = songWorkKey(hint);
  if (!key || key.length < 2) return [];
  return rows.filter(row => row.end >= event.start - 180 && row.start <= event.end + 60
    && !(row.start >= event.start && row.end <= event.end)
    && songWorkKey(row.text).includes(key)
    && /歌|唱|听|首|这首|点/u.test(row.text));
}
export interface SongIdentityOptions { hints?: string[] }
export function identifySongFromCatalog(event: SongEvent, rows: SongRow[], songs: CatalogSong[], transcript: { path: string; sha256: string }, options: SongIdentityOptions = {}) {
  const candidates = songs.map(song => ({ song, matches: matchSongLyrics(event, rows, song.lyrics) }));
  const supported = candidates.filter(item => sufficientLyricMatches(event, item.matches, rows));
  const workName = (item: { song: CatalogSong }) => lyricText(songWorkName(item.song.name, item.song.artists));
  // Versions of the same work (e.g. "Love Story" vs "Love Story (Taylor's Version)") only need the shared work title.
  const normalizeWorkTitle = (value: string) => value.replace(/\s*[(（\[【][^)）\]】]*[)）\]】]\s*$/u, '').trim() || value;
  const matchedCharacters = (item: { matches: LyricMatch[] }) => item.matches.reduce((total, match) => total + match.matchedCharacters, 0);
  if (!supported.length) {
    const hinted = (options.hints || []).map(value => String(value).trim()).filter(Boolean).flatMap(hint => {
      const context = titleContextRows(event, rows, hint);
      return context.length ? candidates.filter(item => songWorkKey(item.song.name) === songWorkKey(hint)).map(item => ({ item, hint, context })) : [];
    });
    const works = new Map<string, typeof hinted>();
    for (const candidate of hinted) works.set(songWorkKey(candidate.item.song.name), [...(works.get(songWorkKey(candidate.item.song.name)) || []), candidate]);
    if (works.size === 1) {
      const group = [...works.values()][0];
      const best = [...group].sort((a, b) => a.item.song.name.length - b.item.song.name.length)[0];
      const catalogName = songWorkName(best.item.song.name, best.item.song.artists);
      return { status: 'identified' as const, item: { activityId: event.id, name: best.hint,
        titleAlias: { value: best.hint, matchedWorkKey: songWorkKey(catalogName), source: 'recording_summary_hint' },
        method: 'catalog_title_context_match', transcriptPath: transcript.path, transcriptSha256: transcript.sha256,
        segments: best.context, catalog: { ...best.item.song, provider: 'netease', lyricSha256: lyricDigest(best.item.song.lyrics) },
        matches: [], note: '本场摘要候选与演唱前后原字幕报幕相互印证，并绑定到音乐目录作品；未使用歌名文字作为唯一证据' } };
    }
    return { status: 'unresolved' as const,
    reason: '尚无三句独立歌词支持同一首歌',
    candidates: candidates.map(({ song, matches }) => ({ id: song.id, name: song.name, artists: song.artists, matchedLines: matches.length })) };
  }
  const groupChars = (items: Array<{ matches: LyricMatch[] }>) => items.reduce((total, item) => total + matchedCharacters(item), 0);
  const groups = new Map<string, Array<{ song: CatalogSong; matches: LyricMatch[] }>>();
  for (const item of supported) {
    const title = normalizeWorkTitle(songWorkKey(item.song.name));
    const group = groups.get(title);
    if (group) group.push(item); else groups.set(title, [item]);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || groupChars(b[1]) - groupChars(a[1]));
  const [, group] = ranked[0];
  // One shared work title resolves directly; a competing medley/cover loses when the
  // same-title family holds a strict majority of candidates and lyric evidence.
  const majority = ranked.length === 1
    || (group.length > supported.length / 2 && groupChars(group) > groupChars(ranked.slice(1).flatMap(([, items]) => items)));
  if (!majority) return { status: 'unresolved' as const,
    reason: '多首不同歌曲均有歌词支持，需继续排查串歌或边界',
    candidates: candidates.map(({ song, matches }) => ({ id: song.id, name: song.name, artists: song.artists, matchedLines: matches.length })) };
  // Prefer the plainest catalog entry (no version suffix) so publication binds to the canonical work title.
  const best = [...group].sort((a, b) => workName(a).length - workName(b).length || matchedCharacters(b) - matchedCharacters(a))[0];
  const indices = new Set(best.matches.flatMap(match => match.segmentIndices));
  const catalogName = songWorkName(best.song.name, best.song.artists);
  const hint = (options.hints || []).map(value => String(value).trim()).filter(Boolean)
    .find(value => songWorkKey(value) === songWorkKey(catalogName));
  return { status: 'identified' as const, item: { activityId: event.id, name: hint || catalogName,
    ...(hint && hint !== catalogName ? { titleAlias: { value: hint, matchedWorkKey: songWorkKey(catalogName), source: 'recording_summary_hint' } } : {}),
    method: 'catalog_lyric_match', transcriptPath: transcript.path, transcriptSha256: transcript.sha256,
    segments: rows.filter(row => indices.has(row.index)), catalog: { ...best.song, provider: 'netease', lyricSha256: lyricDigest(best.song.lyrics) },
    matches: best.matches, note: '目录歌曲信息与本活动中的多句歌词交叉核对；摘要候选仅用于同一作品的规范化命名，不代表演唱者或边界已通过审核' } };
}

/** Revalidate cached research against current transcript rows before packaging or publication. */
export function validateCatalogTitle(item: any, event: SongEvent, rows: SongRow[], transcript: { path: string; sha256: string }): void {
  const catalog = item?.catalog;
  if (!event || item.activityId !== event.id || !['catalog_lyric_match', 'catalog_title_context_match'].includes(item.method) || !item.note?.trim()
    || item.transcriptPath !== transcript.path || item.transcriptSha256 !== transcript.sha256
    || catalog?.provider !== 'netease' || !/^[1-9]\d{0,14}$/u.test(catalog?.id || '')
    || typeof catalog.name !== 'string' || !Array.isArray(catalog.artists)
    || typeof catalog.lyrics !== 'string' || catalog.lyrics.length > 50000 || catalog.lyricSha256 !== lyricDigest(catalog.lyrics)
    || catalog.url !== `https://music.163.com/song?id=${catalog.id}`
    || !Array.isArray(item.matches) || item.matches.length > 300 || !Array.isArray(item.segments)) throw new Error('Invalid catalog title evidence');
  const expectedName = songWorkName(catalog.name, catalog.artists);
  if (item.name !== expectedName && !(item.titleAlias?.source === 'recording_summary_hint'
    && item.titleAlias.value === item.name && item.titleAlias.matchedWorkKey === songWorkKey(expectedName)
    && songWorkKey(item.name) === songWorkKey(expectedName))) throw new Error('Invalid catalog title evidence');
  const lines = new Set(catalogLines(catalog.lyrics)), indices = new Set<number>();
  if (item.method === 'catalog_title_context_match') {
    if (!Array.isArray(item.matches) || item.matches.length !== 0 || !Array.isArray(item.segments) || !item.segments.length
      || item.segments.some((row: SongRow) => !rows.some(current => JSON.stringify(current) === JSON.stringify(row)))) throw new Error('Invalid catalog title context evidence');
    const context = titleContextRows(event, rows, item.name);
    if (!context.length || JSON.stringify(item.segments) !== JSON.stringify(context)) throw new Error('Catalog title context differs from current source');
    return;
  }
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
