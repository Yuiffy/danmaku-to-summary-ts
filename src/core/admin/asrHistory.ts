export interface AsrHistoryTier {
  tier: 'cpu_background' | 'gpu_low_impact' | 'gpu_throughput' | 'gpu_unknown';
  audioSeconds: number;
  windowSeconds?: number;
  batchSeconds?: number;
  speedX?: number;
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
}
