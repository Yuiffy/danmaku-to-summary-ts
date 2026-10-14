import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { lyricDigest, SongRow } from './songIdentity';
import { createSongCatalog, SongCatalog } from './songIdentityCatalog';
import { researchSong, SongAudienceRow } from './songResearch';
import { titleItems } from './activityTitles';

interface SongResearchAdapters {
  parse(file: string): SongRow[];
  audience(file: string): Promise<SongAudienceRow[]>;
  propose(prompt: string): Promise<string>;
  catalog?: SongCatalog;
}

/** Best-effort naming on first creation only; failures remain visible and cannot grant approval. */
export async function researchNewSongPresentation(row: Record<string, any>, io: {
  identify(): Promise<{ status: string; evidencePath: string; identified: unknown[]; unresolved: unknown[] }>;
  apply(evidencePath: string): Promise<Record<string, any>>;
}): Promise<Record<string, any>> {
  if (row.kind !== 'songs' || row.activityReview?.status === 'approved' || row.uploadReady) return row;
  try {
    const result = await io.identify();
    const updated = result.identified.length ? await io.apply(result.evidencePath) : row;
    return { ...updated, songResearch: { status: result.status, identified: result.identified, unresolved: result.unresolved } };
  } catch {
    return { ...row, songResearch: { status: 'needs_review', reason: '歌曲检索或证据绑定未完成，可通过 identify-songs 重试' } };
  }
}
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(staged, JSON.stringify(value, null, 2), { flag: 'wx' }); fs.renameSync(staged, file); }
  finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
}
/** Read/research only. A later supported restyle binds accepted evidence to the existing package. */
export async function identifyActivitySongs(metadataPath: string, options: { activityId?: string; hint?: string }, io: SongResearchAdapters) {
  const original = fs.readFileSync(metadataPath, 'utf8'), metadata = JSON.parse(original);
  if (metadata.type !== 'stream_activity_submission' || metadata.kind !== 'songs') throw new Error('Song research requires a registered song submission');
  const events = metadata.activities.filter((event: any) => event.kind === 'song' && (!options.activityId || event.id === options.activityId));
  if (!events.length || events.length > 12) throw new Error('Select between one and twelve existing song activities');
  const transcript = metadata.transcript;
  if (!transcript?.path || lyricDigest(fs.readFileSync(transcript.path, 'utf8')) !== transcript.sha256) throw new Error('Song research transcript changed');
  const rows = io.parse(transcript.path);
  const xml = metadata.source?.xmlPath, xmlHash = xml ? lyricDigest(fs.readFileSync(xml, 'utf8')) : null;
  const audience = xml ? await io.audience(xml) : [];
  const results = [];
  for (const event of events) results.push({ activityId: event.id, ...await researchSong({ event, rows, audience, transcript, hint: options.hint },
    { propose: io.propose, catalog: io.catalog || createSongCatalog() }) });
  if (fs.readFileSync(metadataPath, 'utf8') !== original || lyricDigest(fs.readFileSync(transcript.path, 'utf8')) !== transcript.sha256
    || xml && lyricDigest(fs.readFileSync(xml, 'utf8')) !== xmlHash) throw new Error('Song source changed during research');
  const items = titleItems(metadata.presentation?.titleEvidence || null).map(item => ({ ...item }));
  for (const result of results) if (result.status === 'identified') {
    const at = items.findIndex(item => item.activityId === result.activityId);
    if (at >= 0) items[at] = result.item; else items.push(result.item);
  }
  const directory = path.join(path.dirname(metadataPath), 'temp', 'song-research', lyricDigest(original).slice(0, 16), randomUUID());
  const evidencePath = path.join(directory, 'title-evidence.json');
  write(path.join(directory, 'research.json'), { version: 1, transcript, xml: { path: xml, sha256: xmlHash }, results });
  write(evidencePath, { version: 2, items });
  return { status: results.every(result => result.status === 'identified') ? 'identified' : 'needs_review', evidencePath,
    identified: results.filter(result => result.status === 'identified').map(result => ({ activityId: result.activityId,
      name: result.status === 'identified' ? result.item.name : '', matchedLines: result.status === 'identified' ? result.item.matches.length : 0 })),
    unresolved: results.filter(result => result.status === 'unresolved').map(result => ({ activityId: result.activityId,
      reason: result.status === 'unresolved' ? result.reason : '', candidates: result.status === 'unresolved' ? result.candidates : [] })) };
}
