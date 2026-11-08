export interface AsrHistoryTier {
  tier: 'cpu_background' | 'gpu_low_impact' | 'gpu_ultra_low_impact' | 'gpu_throughput' | 'gpu_unknown';
  audioSeconds: number;
  windowSeconds?: number;
  batchSeconds?: number;
  speedX?: number;
}
export type AsrHistorySummaryTier = AsrHistoryTier['tier'] | 'unrecorded';
export interface AsrHistoryTierSummary {
  tier: AsrHistorySummaryTier;
  audioSeconds: number;
  percent: number;
}
export interface AsrHistorySummary {
  basis: 'new_audio_seconds';
  totalAudioSeconds: number;
  recordedAudioSeconds: number;
  tiers: AsrHistoryTierSummary[];
}
export interface AsrHistoryItem {
  id: string;
  streamerName: string;
  title: string;
  status: string;
  generatedAt?: string;
  metadata: 'available' | 'missing' | 'unavailable';
  elapsedSeconds?: number;
  mediaSeconds?: number;
  transcriptionSeconds?: number;
  speedX?: number;
  reusedSeconds?: number;
  modelLoadSeconds?: number;
  speakerSeconds?: number;
  speakerState: 'skipped' | 'processed' | 'unknown';
  switches?: number;
  interruptions?: number;
  tiers: AsrHistoryTier[];
}
export interface AsrHistory {
  observedAt: string;
  page: number;
  pageSize: number;
  total: number;
  items: AsrHistoryItem[];
  summary: AsrHistorySummary;
}

const summaryTiers: AsrHistorySummaryTier[] = [
  'cpu_background', 'gpu_ultra_low_impact', 'gpu_low_impact', 'gpu_throughput', 'gpu_unknown', 'unrecorded'
];

/** Summarize the selected history set by newly transcribed audio seconds. */
export function summarizeAsrHistory(items: AsrHistoryItem[]): AsrHistorySummary {
  const totals = new Map<AsrHistorySummaryTier, number>(summaryTiers.map(tier => [tier, 0]));
  for (const item of items) {
    if (item.tiers.length) {
      for (const tier of item.tiers) {
        if (Number.isFinite(tier.audioSeconds) && tier.audioSeconds > 0) {
          totals.set(tier.tier, (totals.get(tier.tier) || 0) + tier.audioSeconds);
        }
      }
    } else if (Number.isFinite(item.mediaSeconds) && (item.mediaSeconds || 0) > 0) {
      // Legacy records have no handoff fields; keep their duration visible as unrecorded.
      totals.set('unrecorded', (totals.get('unrecorded') || 0) + (item.mediaSeconds || 0));
    }
  }
  const totalAudioSeconds = summaryTiers.reduce((sum, tier) => sum + (totals.get(tier) || 0), 0);
  const recordedAudioSeconds = totalAudioSeconds - (totals.get('unrecorded') || 0);
  return {
    basis: 'new_audio_seconds',
    totalAudioSeconds,
    recordedAudioSeconds,
    tiers: summaryTiers.map(tier => {
      const audioSeconds = totals.get(tier) || 0;
      return { tier, audioSeconds, percent: totalAudioSeconds > 0 ? audioSeconds / totalAudioSeconds * 100 : 0 };
    })
  };
}
