export interface UploadQueueItem {
  id: string;
  status: string;
  phase: string;
  clips: { id: number; title: string; done: boolean; excluded: boolean }[];
  createdAt?: string;
  updatedAt?: string;
  retryAt?: string;
  eligibleAt?: string;
  reason: string;
}
export interface UploadSubmission {
  at: string;
  title: string;
  bvid?: string;
  clipId?: number;
}
export interface UploadQueueStatus {
  observedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'ready' | 'blocked';
  summary: string;
  reasons: string[];
  queuedJobs: number;
  queuedClips: number;
  activeJobs: number;
  blockedJobs: number;
  failedJobs: number;
  nextAttemptAt?: string;
  nextJobId?: string;
  lastSubmission?: UploadSubmission;
  lastAttempt?: {
    jobId: string;
    at: string;
    status: string;
    submissionRateLimited: boolean;
    preuploadRateLimited: boolean;
    outcomeUnknown: boolean;
  };
  rateLimit?: { code: number; streak: number; at?: string; until?: string; active: boolean };
  rolling: {
    available: boolean;
    limit: number;
    windowSeconds: number;
    boundaryBufferSeconds: number;
    count: number;
    remaining: number;
    blockedUntil?: string;
    nextDecreaseAt?: string;
    syncedAt?: string;
    syncFailed: boolean;
    events: UploadSubmission[];
    releases: { at: string; count: number; remainingCount: number }[];
  };
  queue: UploadQueueItem[];
}
