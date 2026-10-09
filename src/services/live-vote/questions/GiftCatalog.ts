import * as fs from 'fs/promises';
import { EvidenceSearchHit } from './RecordingEvidence';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function text(value: unknown, max = 800): string {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, max) : '';
}
const tiers: Record<string, string> = { captain: '舰长', admiral: '提督', governor: '总督' };
const statuses: Record<string, string> = { official: '官方公告', recorded: '录播整理，ASR可能有误', lead: '仅线索，未确认' };

/** Explicit operator-configured file only. No imports, URL following, images or arbitrary catalog fields. */
export async function readGiftCatalog(file: string, signal: AbortSignal): Promise<EvidenceSearchHit[]> {
  signal.throwIfAborted();
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid gift catalog');
  const handle = await fs.open(file, 'r');
  let content: string;
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 2 * 1024 * 1024) throw new Error('Gift catalog changed');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    content = bytes.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
  const catalog = object(JSON.parse(content.replace(/^\uFEFF/u, '')));
  if (catalog.version !== 1 || !Array.isArray(catalog.months) || catalog.months.length > 240) throw new Error('Invalid gift catalog schema');
  const hits: EvidenceSearchHit[] = [];
  for (const raw of catalog.months) {
    signal.throwIfAborted();
    const month = object(raw);
    if (typeof month.month !== 'string' || !/^\d{4}-\d{2}$/u.test(month.month) || !Array.isArray(month.entries) || !Array.isArray(month.sources)) continue;
    const sources = month.sources.slice(0, 40).map(object);
    const entries = month.entries.slice(0, 30).map(object);
    const lines: string[] = [];
    const used = new Set<ObjectValue>();
    const present = new Set<string>();
    for (const entry of entries) {
      const tier = tiers[String(entry.tier)], status = statuses[String(entry.status)];
      if (!tier || !status || !Array.isArray(entry.items) || !Array.isArray(entry.sources)) continue;
      const sourceIds = entry.sources;
      const refs = sources.filter(source => sourceIds.includes(source.id) && typeof source.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(source.date));
      if (!refs.length) continue;
      const items = entry.items.slice(0, 20).map(value => text(value, 100)).filter(Boolean);
      if (!items.length) continue;
      // The archive's status is retained; an official illustration alone does not upgrade recorded/lead entries.
      present.add(tier); refs.forEach(source => used.add(source));
      lines.push(`${tier}（${status}）：${items.join('、')}${text(entry.condition) ? `；条件：${text(entry.condition)}` : ''}`);
    }
    if (!lines.length) continue;
    for (const tier of Object.values(tiers)) if (!present.has(tier)) lines.push(`${tier}：本月档案未收录可靠礼单，不代表没有礼物`);
    const provenance = [...used].map(source => `${text(source.date, 10)} ${text(source.start, 12)} ${text(source.title || source.kind, 100)} [${text(source.id, 100)}]`).join('；');
    const excerpt = `礼物所属月：${month.month}。${lines.join('。')}。备注：${text(month.note)}。来源：${provenance}`;
    if (excerpt.length > 6000) continue; // Never silently cut off a condition or uncertainty marker.
    const evidenceId = `gift${hits.length + 1}`;
    hits.push({ evidenceId, kind: 'gift-catalog', date: String([...used][0].date), time: '', catalogMonth: month.month,
      excerpt, context: [...used].slice(0, 8).map(source => ({ evidenceId, time: text(source.start, 12),
        text: `${text(source.date, 10)} ${text(source.title || source.kind, 100)}：${text(source.excerpt, 1200)} ${text(source.note)}` })) });
  }
  return hits.sort((a, b) => b.catalogMonth!.localeCompare(a.catalogMonth!));
}
