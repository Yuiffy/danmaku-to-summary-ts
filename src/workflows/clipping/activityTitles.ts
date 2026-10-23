import { identifySongFromCatalog, validateCatalogTitle } from './songIdentity';
type Data = Record<string, any>;
const norm = (s: any) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

export function songDate(recordedAt: string): string {
  const match = String(recordedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > 31) throw new Error('Song title requires the recording date');
  return `${match[1]}.${+match[2]}.${+match[3]}`;
}

export function titleItems(evidence: Data | null): Data[] {
  return evidence ? evidence.items || [evidence] : [];
}

export function bindTranscriptTitles(items: Data[], events: Data[], rows: Data[], transcript: Data): Data {
  if (!Array.isArray(items) || !items.length || new Set(items.map(i => i.activityId)).size !== items.length) throw new Error('Title evidence must bind distinct source activities');
  return { version: 1, items: items.map(item => {
    const event = events.find(e => e.id === item.activityId);
    if (item.method === 'catalog_lyric_match') {
      if (!event || !Array.isArray(item.segments) || !item.segments.length) throw new Error('Invalid catalog title evidence');
      // A boundary edit may discard old citations. Check their original content before
      // rematching the same catalog work using only the newly retained performance.
      const previousSpan = { ...event, start: Math.min(event.start, ...item.segments.map((r: Data) => r.start)),
        end: Math.max(event.end, ...item.segments.map((r: Data) => r.end)) };
      validateCatalogTitle(item, previousSpan as any, rows as any, transcript as any);
      const refreshed = identifySongFromCatalog(event as any, rows as any, [item.catalog], transcript as any);
      if (refreshed.status !== 'identified' || refreshed.item.name !== item.name) throw new Error('Current performance no longer supports its catalog title');
      validateCatalogTitle(refreshed.item, event as any, rows as any, transcript as any);
      return refreshed.item;
    }
    const selected = (item.segmentIndices || item.segments?.map((row: Data) => row.index))?.map((i: number) => rows[i-1]);
    const alias = String(item.sourceAlias || item.name || '').trim();
    if (!event || !String(item.name || '').trim() || !String(item.note || '').trim() || norm(alias).length < 2
      || !Array.isArray(selected) || !selected.length || selected.some((r: Data) => !r || r.end < event.start - 300 || r.start > event.end + 60)
      || !norm(selected.map((r: Data) => r.text).join(' ')).includes(norm(alias))) throw new Error('Song title is absent from its nearby original transcript evidence');
    return { activityId: event.id, name: String(item.name).trim(), sourceAlias: alias, method: 'source_transcript_reading',
      transcriptPath: transcript.path, transcriptSha256: transcript.sha256, segments: selected, note: item.note };
  }) };
}

export function namedEvents(events: Data[], evidence: Data | null): Data[] {
  const items = titleItems(evidence);
  if (items.some(item => !events.some(event => event.id === item.activityId)) || new Set(items.map(i => i.activityId)).size !== items.length) {
    throw new Error('Reviewed content names must refer to specific source activities');
  }
  return events.map(event => ({ ...event, name: items.find(item => item.activityId === event.id)?.name || event.name }));
}

export function songTitle(name: string, date: string): string {
  return `${name || '待确认歌名'}-${date}`;
}

/** Prioritize the submitted performances over generic labels within the SDK's ten-tag limit. */
export function songSubmissionTags(parts: Data[], baseTags: string[]): string[] {
  const names = parts.map(part => typeof part.name === 'string' ? part.name.trim() : '')
    .filter(name => name && name !== '待确认歌名');
  return [...new Set([...names, ...baseTags].map(tag => tag.trim()).filter(Boolean))].slice(0, 10);
}

export function songCoverSubject(events: Data[]): string {
  const names = [...new Set(events.map(event => event.name || '待确认歌名'))];
  return names.slice(0, 3).join('\n');
}

export function songSubmissionTitle(events: Data[], date: string, limit: number): string {
  const names = [...new Set(events.map(e => e.name).filter(Boolean))];
  const title = songTitle(names.join(' / '), date);
  if (Array.from(title).length <= limit) return title;
  const abbreviated = songTitle(`${names[0]}等${names.length}首`, date);
  if (Array.from(abbreviated).length > limit) throw new Error('Song name and recording date exceed the public title limit');
  return abbreviated;
}

const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** Restore summary-known titles only from this candidate's cited selection speech. */
export function recoverSongNames(events: Data[], names: unknown, rows: Data[]): Data[] {
  const candidates = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name.trim()) : [];
  return events.map(event => {
    if (event.kind !== 'song' || event.name) return event;
    const nearby = rows.filter(row => row.source === 'audio_transcript'
      && row.end >= event.start - 180 && row.start <= event.end + 180);
    const cited = nearby.filter(row => event.evidenceIds?.includes(row.id));
    const matches = [...new Set(candidates)].map(name => {
      const mentions = cited.filter(row => row.text.includes(name) && (row.end <= event.start || row.start >= event.end));
      const context = nearby.filter(row => mentions.some(mention => row.start <= mention.end + 3 && row.end >= mention.start - 3));
      return { name, context, valid: mentions.length && context.some(row => /歌|唱|听|伴奏|点歌|《/u.test(row.text)) };
    }).filter(match => match.valid);
    if (matches.length !== 1) return event;
    const { name, context } = matches[0], titleEvidenceIds = context.map(row => row.id);
    return { ...event, name, titleEvidenceIds, evidenceIds: [...new Set([...(event.evidenceIds || []), ...titleEvidenceIds])] };
  });
}
export function watchTitleAppears(name: string, text: string): boolean {
  const normalized = norm(name);
  if (!normalized) return false;
  const pattern = normalized.replace(/\d+/gu, digits => {
    const n = Number(digits);
    const chinese = n < 10 ? chineseDigits[n] : n < 100
      ? `${n >= 20 ? chineseDigits[Math.floor(n / 10)] : ''}十${n % 10 ? chineseDigits[n % 10] : ''}` : '';
    return `(?:${digits}${chinese ? `|${chinese}` : ''})(?![\\d零一二三四五六七八九十百千万])`;
  });
  return new RegExp(pattern, 'u').test(norm(text));
}

/** Recover only summary-supplied work names supported by this session's existing citations. */
export function recoverWatchNames(events: Data[], overview: string, rows: Data[]): Data[] {
  const candidates = [...new Set([...String(overview || '').matchAll(/《([^《》]+)》/gu)].map(match => match[1]))];
  const byId = new Map(rows.map(row => [row.id, row]));
  return events.map(event => {
    if (event.kind !== 'watch' || event.name) return event;
    const cited = (event.evidenceIds || []).map((id: string) => byId.get(id)).filter((row: Data) => row
      && row.end >= event.start - 180 && row.start <= event.end + 180);
    const matches = candidates.map(name => ({ name, ids: cited.filter((row: Data) => watchTitleAppears(name, row.text)).map((row: Data) => row.id) }))
      .filter(candidate => candidate.ids.length);
    return matches.length === 1 ? { ...event, name: matches[0].name, titleEvidenceIds: matches[0].ids } : event;
  });
}

export function watchCoverSubject(events: Data[]): string {
  const names = [...new Set(events.map(event => event.name || '待确认片名'))];
  return names.slice(0, 3).map(name => `《${name}》`).join(' / ');
}

export function watchSubmissionTitle(events: Data[], date: string, limit: number): string {
  const names = [...new Set(events.map(event => event.name || '待确认片名'))];
  const title = `${names.map(name => `《${name}》`).join(' / ')}｜${date}`;
  if (Array.from(title).length <= limit) return title;
  const abbreviated = `《${names[0]}》等${names.length}部｜${date}`;
  if (Array.from(abbreviated).length > limit) throw new Error('Watched title and recording date exceed the public title limit');
  return abbreviated;
}
