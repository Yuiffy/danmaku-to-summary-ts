import type { CampaignCandidate } from './contracts';

export const campaignShortlistPolicy = { maxPerSession: 20, overlapRatio: 0.5 } as const;

/** Read-only shortlist; recall windows and scores never authorize production or publication. */
export function shortlistCampaignCandidates(rows: CampaignCandidate[]): CampaignCandidate[] {
  const selected = new Map<string, CampaignCandidate[]>();
  const ranked = rows.filter(row => Number.isFinite(row.score)
    && Number.isFinite(row.start) && Number.isFinite(row.end) && row.start! >= 0 && row.end! > row.start!)
    .sort((a, b) => b.score! - a.score! || a.label.localeCompare(b.label, 'en', { numeric: true }) || a.id.localeCompare(b.id));
  for (const row of ranked) {
    const session = selected.get(row.session) || [];
    if (session.length >= campaignShortlistPolicy.maxPerSession) continue;
    const overlaps = session.some(other => {
      const intersection = Math.min(row.end!, other.end!) - Math.max(row.start!, other.start!);
      return intersection / Math.min(row.end! - row.start!, other.end! - other.start!) >= campaignShortlistPolicy.overlapRatio;
    });
    if (!overlaps) { session.push(row); selected.set(row.session, session); }
  }
  return [...selected.values()].flat();
}
