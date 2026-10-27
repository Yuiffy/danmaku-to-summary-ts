import * as fs from 'fs';
import * as path from 'path';
import { CampaignCandidate, CampaignCandidateDetail, CampaignCandidateSort, campaignCandidateSorts } from '../../core/admin/contracts';
import { deferredSelectionRows } from '../../workflows/clipping/reviewSelectionHistory';
import { AdminClipStore } from './AdminClipStore';
import { AdminError, digest, readJson, readText } from './AdminFiles';
import { sourceWindowSubtitles } from '../../core/admin/subtitles';
import { campaignShortlistPolicy, shortlistCampaignCandidates } from '../../core/admin/campaignCandidates';
import { campaignCandidatePath } from '../../workflows/clipping/campaignCandidate';

type Data = Record<string, any>;
type Entry = { summary: CampaignCandidate; media: string; srt: string; state: string; row: Data };
const mediaExtensions = ['.flv', '.mp4', '.mkv', '.ts', '.webm'];
const normalize = (file: string) => path.resolve(file).toLowerCase();

/** Read-only browsing of deferred campaign selections, including sessions with no upload IDs. */
export class AdminCampaignCandidates {
  private cached?: { at: number; entries: Map<string, Entry> };
  constructor(private readonly clips: AdminClipStore, private readonly roots: () => string[], private readonly campaigns: () => Data[]) {}

  private checked(file: string, extensions: string[]): string | undefined {
    try { return this.clips.checkedInput(file, extensions); } catch { return undefined; }
  }
  private directories(directory: string): string[] {
    try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(directory, entry.name)); }
    catch { return []; }
  }
  private states(): string[] {
    const files = new Set<string>();
    const collect = (directory: string) => {
      try {
        for (const name of fs.readdirSync(directory)) if (/^REVIEW.*_STATE\.json$/iu.test(name)) {
          const file = this.checked(path.join(directory, name), ['.json']);
          if (file) files.add(file);
        }
      } catch { /* An absent/archived batch does not hide the remaining sessions. */ }
    };
    // Fixed room/date/batch layout only; never recursively scan recording media or arbitrary paths.
    for (const campaign of this.campaigns().filter(item => item.requiredGames?.includes('芙娅之魂'))) {
      const rooms = new Set((campaign.roomIds || []).map(String));
      const first = String(campaign.startsAt || '').slice(0, 10).replace(/-/gu, '_');
      const last = String(campaign.endsAt || '').slice(0, 10).replace(/-/gu, '_');
      if (!/^\d{4}_\d{2}_\d{2}$/u.test(first) || !/^\d{4}_\d{2}_\d{2}$/u.test(last)) continue;
      for (const root of this.roots()) {
        const roomDirectories = rooms.has(path.basename(root).split('_')[0]) ? [root] : this.directories(root);
        for (const room of roomDirectories.filter(file => rooms.has(path.basename(file).split('_')[0]))) {
          for (const day of this.directories(room).filter(file => /^\d{4}_\d{2}_\d{2}$/u.test(path.basename(file)) && path.basename(file) >= first && path.basename(file) <= last)) {
            collect(path.join(day, 'own_stream_fun_clips'));
            for (const batch of this.directories(path.join(day, 'campaign_early'))) collect(path.join(batch, 'own_stream_fun_clips'));
          }
        }
      }
    }
    return [...files].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  }
  private entries(): Map<string, Entry> {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached.entries;
    const entries = new Map<string, Entry>();
    for (const file of this.states()) {
      let metadata: Data;
      try {
        const state = readJson(file);
        if (state.type !== 'own_stream_review_state') continue;
        metadata = state.metadata || {};
      } catch { continue; }
      const campaigns = this.campaigns().filter(item => item.requiredGames?.includes('芙娅之魂'));
      const namedGame = campaigns.some(item => [...(item.requiredGames || []), ...(item.earlyTrigger?.titleKeywords || [])]
        .some(name => String(metadata.streamTitle || '').includes(name)));
      const planFile = !namedGame && this.checked(metadata.planPath, ['.json']);
      const plan = planFile ? readJson(planFile, {}) : {};
      if (!namedGame && !campaigns.some(item => plan.config?.campaignContentGate?.id === item.id)) continue;
      for (const row of deferredSelectionRows(metadata)) {
        const media = String(row.sourceMediaPath || ''), srt = String(row.sourceSrtPath || '');
        if (!media || !srt) continue;
        const session = digest(normalize(media)), id = digest(`${session}:${row.selectionKey}`);
        if (entries.has(id)) continue;
        const start = row.start ?? row.candidate?.start, end = row.end ?? row.candidate?.end;
        const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
        entries.set(id, { media, srt, state: file, row, summary: { id, session, label: row.label,
          streamerName: String(metadata.streamerName || ''), roomId: String(metadata.roomId || ''),
          recordedAt: String(metadata.recordedAt || ''), streamTitle: String(metadata.streamTitle || ''),
          title: String(row.title || row.topic || row.candidate?.event || row.label), reason: String(row.reason || ''),
          ...(Number.isFinite(row.score) ? { score: row.score } : {}),
          ...(valid ? { start, end } : {}), previewAvailable: valid } });
      }
    }
    this.cached = { at: Date.now(), entries }; return entries;
  }
  list(query: { room?: string; session?: string; search?: string; page?: string; sort?: string; view?: string }) {
    const all = [...this.entries().values()].map(entry => entry.summary);
    const view = query.view === 'all' ? 'all' : 'curated';
    const visible = view === 'all' ? all : shortlistCampaignCandidates(all);
    const rooms = [...new Map(all.map(row => [row.roomId, { id: row.roomId, name: row.streamerName || row.roomId }])).values()];
    const sessions = [...new Map(all.filter(row => !query.room || query.room === row.roomId).map(row => [row.session,
      { id: row.session, title: `${row.recordedAt} · ${row.streamerName} · ${row.streamTitle}` }])).values()];
    const sort = campaignCandidateSorts.includes(query.sort as CampaignCandidateSort) ? query.sort as CampaignCandidateSort : 'session';
    const byNumber = (a: CampaignCandidate, b: CampaignCandidate) => a.label.localeCompare(b.label, 'en', { numeric: true });
    const bySession = (a: CampaignCandidate, b: CampaignCandidate) => b.recordedAt.localeCompare(a.recordedAt)
      || a.streamerName.localeCompare(b.streamerName) || a.session.localeCompare(b.session) || byNumber(a, b) || a.id.localeCompare(b.id);
    const matches = (row: CampaignCandidate) => (!query.room || row.roomId === query.room) && (!query.session || row.session === query.session)
      && (!query.search || `${row.label} ${row.title} ${row.streamerName} ${row.recordedAt}`.toLowerCase().includes(query.search.toLowerCase()));
    const filtered = visible.filter(matches)
      .sort((a, b) => {
        if (sort === 'number-asc' || sort === 'number-desc') return (sort === 'number-asc' ? 1 : -1) * byNumber(a, b) || bySession(a, b);
        if (sort === 'score-asc' || sort === 'score-desc') {
          // Unscored recalls stay at the end in either direction; zero is a real score.
          if (a.score === undefined || b.score === undefined) return a.score === b.score ? bySession(a, b) : a.score === undefined ? 1 : -1;
          return (sort === 'score-asc' ? a.score - b.score : b.score - a.score) || bySession(a, b);
        }
        return bySession(a, b);
      });
    const page = Math.max(1, Math.min(10000, Math.floor(Number(query.page) || 1)));
    return { candidates: filtered.slice((page - 1) * 40, page * 40), total: filtered.length,
      unfilteredTotal: all.filter(matches).length, view, shortlistPolicy: campaignShortlistPolicy, page, sort, rooms, sessions };
  }
  private entry(id: string): Entry {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new AdminError('候选 ID 无效');
    const entry = this.entries().get(id);
    if (!entry) throw new AdminError('候选不存在，请刷新列表', 404);
    return entry;
  }
  source(id: string) {
    const entry = this.entry(id), { start, end } = entry.summary;
    const file = this.checked(entry.media, mediaExtensions);
    if (!file || start === undefined || end === undefined) throw new AdminError('原片或候选时间不可用', 404);
    return { file, window: { start, end } };
  }
  registration(id: string, revision: string) {
    this.cached = undefined;
    if (this.detail(id).revision !== revision) throw new AdminError('候选或原片已变化，请刷新后再提交', 409);
    const entry = this.entry(id);
    this.source(id);
    const srt = this.clips.checkedInput(entry.srt, ['.srt']);
    return { state: entry.state, selectionDigest: digest(JSON.stringify(entry.row)), sourceDigest: digest(readText(srt)),
      metadataPath: campaignCandidatePath(entry.media, id) };
  }
  detail(id: string): CampaignCandidateDetail {
    const entry = this.entry(id), { start, end } = entry.summary;
    const srt = this.checked(entry.srt, ['.srt']), media = this.checked(entry.media, mediaExtensions);
    const text = srt ? readText(srt) : '';
    const subtitles = start !== undefined && end !== undefined ? sourceWindowSubtitles(text, start, end) : '';
    const stat = media ? fs.statSync(media) : undefined;
    return { candidate: { ...entry.summary, previewAvailable: !!media && entry.summary.previewAvailable }, subtitles,
      revision: digest(JSON.stringify({ summary: entry.summary, row: entry.row, media, size: stat?.size, mtime: stat?.mtimeMs, sourceDigest: digest(text) })) };
  }
}
