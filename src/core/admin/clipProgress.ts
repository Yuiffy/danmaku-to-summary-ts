export const clipStages: Record<string, string> = {
  earlyCampaign: '活动提前切片', recordingJob: '指定录播切片', activity: '活动切片',
  topics: '关键词切片', own: '本场选材与制作', songs: '歌切', games: '游戏完整切片', watch: '同步视听'
};
export interface ClipProgressItem {
  id: string;
  roomId: string;
  streamerName: string;
  title: string;
  status: 'processing' | 'pending' | 'retry_wait' | 'interrupted' | 'done' | 'failed';
  enqueuedAt?: string;
  stage?: string;
  steps?: string[];
  videos?: {
    total: number; processed: number; rendered: number; refined: number; needsReview: number; failed: number; updatedAt: string;
    phase: 'production' | 'final_review';
    items: { index: number; state: 'waiting' | 'rendering' | 'rendered' | 'needs_review' | 'failed'; review?: 'pending' | 'passed' | 'failed';
      finalReview?: 'pending' | 'passed' | 'failed'; title?: string; edition?: 'initial' | 'ordinary' | 'highlight_first' | 'precision';
      previewKey?: string; issue?: string }[];
  };
  completedStages: string[];
  updatedAt?: string;
  activity?: { label: string; at: string };
  stale: boolean;
  attempts: number;
  nextAttemptAt?: string;
  logAvailable: boolean;
  progressAvailable: boolean;
}
export interface ClipProgressStatus {
  observedAt: string;
  worker: 'online' | 'offline' | 'unknown';
  heartbeatAt?: string;
  activeJobs: number;
  queuedJobs: number;
  unreadableJobs: number;
  queue: ClipProgressItem[];
  recent: ClipProgressItem[];
  latestOutput?: ClipProgressItem;
}
