import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AdminClipStore } from './AdminClipStore';
import { AdminError, atomicJson, digest, readJson, readText } from './AdminFiles';
import { subtitleRows } from '../../core/admin/subtitles';
import { CoverageCandidate, CoverageDecision, CoverageSettings, coverageSettings } from '../../workflows/clipping/peerCoverage';
import { createPeerApi, PeerApi } from '../../workflows/clipping/peerCoverageApi';
import { runPeerCuration } from '../../workflows/clipping/peerCoverageRuntime';

export type PreUploadPeerCoverageStatus = 'disabled' | 'original' | 'covered' | 'needs_review';
export interface PreUploadPeerCoverageResult {
  status: PreUploadPeerCoverageStatus;
  reason: string;
  cached: boolean;
  decision?: CoverageDecision;
  evidencePath?: string;
  evidenceSha256?: string;
  checkedAt?: string;
  searchIndexCheckedAt?: string;
}

export interface PreUploadPeerCoverageGate {
  check(id: string, detail: any, output: (text: string) => void,
    update: (value: { phase: string }) => void): Promise<PreUploadPeerCoverageResult>;
}

interface CacheEntry {
  key: string;
  id: string;
  checkedAt: string;
  expiresAt: number;
  sourceSrtSha256: string;
  sourceWindow: { start: number; end: number };
  evidencePath?: string;
  evidenceSha256?: string;
  decision: CoverageDecision;
}
interface GateState {
  version: 1;
  entries: Record<string, CacheEntry>;
  searchIndex?: { query: string; fetchedAt: number; results: any[] };
  rate: { lastSearchAt?: number; queries: Record<string, number>; daily: Record<string, number> };
}

const CACHE_VERSION = 1;
const COVERED_TTL_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_TTL_MS = 24 * 60 * 60 * 1000;
const REVIEW_TTL_MS = 30 * 60 * 1000;
const QUERY_COOLDOWN_MS = 2 * 60 * 1000;
const GLOBAL_SEARCH_COOLDOWN_MS = 30 * 1000;
const DAILY_SEARCH_BUDGET = 30;
const MAX_SEARCHES_PER_CHECK = 1;
const RECENT_INDEX_TTL_MS = 2 * 60 * 1000;

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
const clone = <T>(value: T): T => structuredClone(value);

export class AdminPreUploadPeerCoverage implements PreUploadPeerCoverageGate {
  private readonly cachePath: string;
  private readonly evidenceDir: string;
  private readonly supportPath: string;
  private readonly now: () => number;
  private readonly apiFactory: (cookie: string) => PeerApi;
  constructor(private readonly root: string, private readonly clips: AdminClipStore,
    private readonly loadConfig: () => Promise<any> | any,
    private readonly request: (prompt: string) => Promise<string>, options: {
      now?: () => number;
      apiFactory?: (cookie: string) => PeerApi;
      cachePath?: string;
      evidenceDir?: string;
      supportPath?: string;
    } = {}) {
    this.now = options.now || Date.now;
    this.apiFactory = options.apiFactory || ((cookie: string) => createPeerApi(cookie));
    this.cachePath = options.cachePath || path.join(root, 'data/runtime/clip_peer_coverage_cache.json');
    this.evidenceDir = options.evidenceDir || path.join(root, 'data/runtime/peer_coverage/pre-upload');
    this.supportPath = options.supportPath || path.join(root, 'data/runtime/clip_peer_support.json');
  }

  private state(): GateState {
    let saved: any = null;
    try { saved = readJson(this.cachePath, null); } catch { saved = null; }
    if (!saved || saved.version !== CACHE_VERSION || !saved.entries || !saved.rate) {
      return { version: CACHE_VERSION, entries: {}, rate: { queries: {}, daily: {} } };
    }
    return { version: CACHE_VERSION, entries: saved.entries, searchIndex: saved.searchIndex, rate: {
      lastSearchAt: saved.rate.lastSearchAt,
      queries: saved.rate.queries || {}, daily: saved.rate.daily || {}
    } };
  }
  private saveState(state: GateState): void {
    const cutoff = this.now() - 2 * 24 * 60 * 60 * 1000;
    for (const [key, value] of Object.entries(state.entries)) if (value.expiresAt < cutoff) delete state.entries[key];
    for (const [query, at] of Object.entries(state.rate.queries)) if (at < cutoff) delete state.rate.queries[query];
    for (const [day, count] of Object.entries(state.rate.daily)) if (count <= 0 || day < dayKey(cutoff)) delete state.rate.daily[day];
    atomicJson(this.cachePath, state);
  }

  private async candidate(id: string, detail: any): Promise<{ candidate: CoverageCandidate; sourceSrtSha256: string; key: string }> {
    const record = this.clips.record(id), metadata = this.clips.metadata(record);
    const window = this.clips.sourceWindow(record, metadata);
    if (!window) throw new AdminError('投稿前同题核查缺少有效源窗口，已暂停投稿');
    const srtPath = this.clips.checkedInput(metadata.source?.srtPath || record.sourceSrtPath, ['.srt']);
    const source = this.clips.checkedInput(metadata.source?.mediaPath || record.sourceMediaPath,
      ['.flv', '.mp4', '.mkv', '.ts', '.webm']);
    const text = readText(srtPath, 32 * 1024 * 1024);
    const rows = subtitleRows(text).filter(row => row.at >= window.start - .001 && row.end <= window.end + .001);
    const cues = rows.map((row, index) => ({ id: `S${index + 1}`, start: row.at, end: row.end, text: row.text }));
    const candidate: CoverageCandidate = { id: String(id), roomId: String(record.roomId || ''),
      host: String(record.streamerName || ''), source, start: window.start, end: window.end,
      title: String(detail.title || record.title || ''), cues };
    const sourceSrtSha256 = createHash('sha256').update(text).digest('hex');
    const policyVersion = 'pre-upload-peer-v1';
    const key = digest(JSON.stringify({ policyVersion, sourceSrtSha256,
      sourceWindow: window, roomId: candidate.roomId, host: candidate.host,
      title: candidate.title, description: String(detail.description || '').slice(0, 1000),
      coverText: String(detail.coverText || '').slice(0, 300) }));
    return { candidate, sourceSrtSha256, key };
  }

  private result(entry: CacheEntry, cached: boolean, searchIndexCheckedAt?: number): PreUploadPeerCoverageResult {
    const decision = clone(entry.decision);
    const status: PreUploadPeerCoverageStatus = decision.status === 'covered' ? 'covered'
      : decision.status === 'original' ? 'original' : 'needs_review';
    return { status, reason: decision.reason, cached, decision, evidencePath: entry.evidencePath,
      evidenceSha256: entry.evidenceSha256, checkedAt: entry.checkedAt,
      ...(searchIndexCheckedAt ? { searchIndexCheckedAt: new Date(searchIndexCheckedAt).toISOString() } : {}) };
  }

  private broadQuery(candidate: CoverageCandidate, raw: CoverageSettings): string {
    const configured = raw.preUploadSearchQuery;
    if (typeof configured === 'string' && configured.trim().length >= 3) return configured.trim().slice(0, 80);
    if (/岁己|sui/iu.test(candidate.host)) return candidate.host.slice(0, 80);
    if (/小岁/iu.test(candidate.host)) return '岁己';
    return '岁己';
  }

  async check(id: string, detail: any, output: (text: string) => void,
    update: (value: { phase: string }) => void): Promise<PreUploadPeerCoverageResult> {
    const config = await this.loadConfig();
    const raw = config?.clipCuration as CoverageSettings | undefined;
    if (!raw?.enabled) return { status: 'disabled', reason: '投稿前同题核查未启用', cached: false };
    const { candidate, sourceSrtSha256, key } = await this.candidate(id, detail);
    const policy = coverageSettings(raw);
    const cookie = String(config?.bilibili?.cookie || '');
    const query = this.broadQuery(candidate, raw);
    const state = this.state(), current = this.now(), hit = state.entries[key];
    const indexFresh = state.searchIndex?.query === query && current - state.searchIndex.fetchedAt < RECENT_INDEX_TTL_MS;
    if (hit && hit.expiresAt > current && indexFresh) {
      const cached = this.result(hit, true, state.searchIndex!.fetchedAt);
      this.clips.savePreUploadPeerCoverage(id, { ...cached, cacheKey: key, sourceSrtSha256,
        sourceWindow: { start: candidate.start, end: candidate.end }, expiresAt: hit.expiresAt });
      output(`\n投稿前同题核查：命中缓存（${cached.status}）\n`);
      return cached;
    }

    if (!cookie.trim()) {
      const decision: CoverageDecision = { candidateId: candidate.id, inputDigest: digest(JSON.stringify(candidate)),
        status: 'needs_review', reason: 'B站登录态不可用，不能认定没有同题切片' };
      const entry = await this.persistDecision(key, id, candidate, sourceSrtSha256, decision, undefined);
      return this.result(entry, false);
    }
    update({ phase: '正在进行投稿前 B 站同题核查' });
    output('\n投稿前 B 站同题核查（有缓存和限频保护）\n');
    const evidencePath = path.join(this.evidenceDir, `${id}-${key.slice(0, 16)}.json`);
    const baseApi = this.apiFactory(cookie);
    let searches = 0;
    const limitedApi: PeerApi = { ...baseApi, search: async (searchQuery, limit) => {
      const cachedState = this.state(), cachedAt = this.now();
      if (cachedState.searchIndex?.query === query && cachedAt - cachedState.searchIndex.fetchedAt < RECENT_INDEX_TTL_MS) {
        return clone(cachedState.searchIndex.results) as any;
      }
      const latest = this.state(), at = this.now(), today = dayKey(at);
      if (searches >= MAX_SEARCHES_PER_CHECK) throw new Error('投稿前同题核查本次只刷新一个近期结果索引，请稍后重试');
      if (!searches && latest.rate.lastSearchAt && at - latest.rate.lastSearchAt < GLOBAL_SEARCH_COOLDOWN_MS) {
        throw new Error('B站查询冷却中，请稍后重试');
      }
      if (latest.rate.queries[searchQuery] && at - latest.rate.queries[searchQuery] < QUERY_COOLDOWN_MS) {
        throw new Error('相同搜索词仍在冷却中，请稍后重试');
      }
      if ((latest.rate.daily[today] || 0) >= DAILY_SEARCH_BUDGET) throw new Error('今日 B 站搜索预算已用尽，请明日或人工重试');
      latest.rate.lastSearchAt = at;
      latest.rate.queries[searchQuery] = at;
      latest.rate.daily[today] = (latest.rate.daily[today] || 0) + 1;
      searches++;
      const results = await baseApi.search(searchQuery, Math.max(20, limit), { order: 'pubdate', page: 1 });
      latest.searchIndex = { query, fetchedAt: at, results: clone(results) as any[] };
      this.saveState(latest);
      return results;
    } };
    const decisions = await runPeerCuration({ candidates: [candidate], settings: { ...policy, maxSearchQueries: Math.min(policy.maxSearchQueries, MAX_SEARCHES_PER_CHECK) },
      cookie, evidencePath, statePath: this.supportPath, support: true, skipEditorialAssessment: true,
      searchQueries: () => [query] },
      async (phase, prompt) => { update({ phase: `正在${phase}` }); return this.request(prompt); }, limitedApi);
    const decision = decisions[0] || { candidateId: candidate.id, inputDigest: digest(JSON.stringify(candidate)),
      status: 'needs_review', reason: 'B站同题核查没有返回有效结果' } as CoverageDecision;
    const evidenceSha256 = fs.existsSync(evidencePath) ? digest(fs.readFileSync(evidencePath, 'utf8')) : undefined;
    const entry = await this.persistDecision(key, id, candidate, sourceSrtSha256, decision, evidencePath, evidenceSha256);
    return this.result(entry, false);
  }

  private async persistDecision(key: string, id: string, candidate: CoverageCandidate, sourceSrtSha256: string,
    decision: CoverageDecision, evidencePath?: string, evidenceSha256?: string): Promise<CacheEntry> {
    const checkedAt = new Date(this.now()).toISOString();
    const ttl = decision.status === 'covered' ? COVERED_TTL_MS : decision.status === 'original' ? ORIGINAL_TTL_MS : REVIEW_TTL_MS;
    const entry: CacheEntry = { key, id, checkedAt, expiresAt: this.now() + ttl, sourceSrtSha256,
      sourceWindow: { start: candidate.start, end: candidate.end }, evidencePath, evidenceSha256, decision: clone(decision) };
    const state = this.state(); state.entries[key] = entry; this.saveState(state);
    const result = this.result(entry, false, this.state().searchIndex?.fetchedAt);
    this.clips.savePreUploadPeerCoverage(id, { ...result, cacheKey: key, sourceSrtSha256,
      sourceWindow: entry.sourceWindow, expiresAt: entry.expiresAt });
    return entry;
  }
}
