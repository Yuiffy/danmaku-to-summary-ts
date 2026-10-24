export interface AsrQueueItem {
  id: string;
  roomId: string;
  streamerName: string;
  title: string;
  recordedAt?: string;
  status: 'processing' | 'pending';
  priority: number;
  position?: number;
  addedAt?: string;
  startedAt?: string;
  waitSeconds?: number;
  elapsedSeconds?: number;
  ownerAlive?: boolean;
  activity?: {
    device: 'cpu' | 'gpu' | 'unknown';
    phase: string;
    batch?: number;
    asrCompleted?: boolean;
    at: string;
    stale: boolean;
    progress?: AsrProgress;
  };
}

export interface AsrProgress {
  audioDoneSeconds: number;
  audioTotalSeconds: number;
  percent: number;
  performanceTier: 'gpu_throughput' | 'gpu_low_impact' | 'cpu_background' | 'waiting' | 'postprocessing';
  windowSeconds?: number;
  batchSeconds?: number;
  speedX?: number;
  speedWindowSeconds?: number;
  speedProvisional?: boolean;
  etaSeconds?: number;
}

export interface AsrQueueStatus {
  observedAt: string;
  queueUpdatedAt?: string;
  activeJobs: number;
  queuedJobs: number;
  failedJobs: number;
  queue: AsrQueueItem[];
  policy: { cpuFallbackEnabled: boolean; minAvailableMemoryGb: number; deviceHandoffEnabled: boolean };
  logAvailable: boolean;
}
