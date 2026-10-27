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
export interface UploadObservation {
  from: string;
  until: string;
  windows: { hours: number; count: number; points: { at: string; count: number }[] }[];
  incidents: {
    id: string; at: string; kind: 'http406' | 'submission137022'; stage: string;
    source: 'ledger' | 'history' | 'snapshot'; jobId?: string; accountId?: string; partIndex?: number;
    counts: number[]; preupload5m?: number;
  }[];
  telemetry: { available: boolean; since?: string; truncated: boolean };
  historySince?: string;
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
  observation?: UploadObservation;
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
