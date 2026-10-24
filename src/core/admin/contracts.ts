/** Serializable control-plane contracts shared by the UI and the operator service. */
import type { TitleDecision } from './titles';
export interface CoverSelection {
  time: number;
  part: number;
  text: string;
  crop?: { x: number; y: number; width: number; height: number };
}
export interface ConfigDocument {
  name: string;
  revision: string;
  value: Record<string, any>;
  updatedAt: string;
}
export interface ClipSummary {
  id: number;
  title: string;
  status: string;
  reviewTitle?: string;
  subtitleExcerpt?: string;
  roomId: string;
  streamerName: string;
  start: string;
  duration: string;
  issues: string[];
  pendingCut: boolean;
  updatedAt: string;
}
export const campaignCandidateSorts = ['session', 'score-desc', 'score-asc', 'number-asc', 'number-desc'] as const;
export type CampaignCandidateSort = typeof campaignCandidateSorts[number];
export interface CampaignCandidate {
  id: string;
  session: string;
  label: string;
  streamerName: string;
  roomId: string;
  recordedAt: string;
  streamTitle: string;
  title: string;
  reason: string;
  score?: number;
  start?: number;
  end?: number;
  previewAvailable: boolean;
}
export interface CampaignCandidateDetail {
  candidate: CampaignCandidate;
  subtitles: string;
  revision: string;
}
export interface ClipDetail {
  clip: ClipSummary;
  revision: string;
  title: string;
  description: string;
  coverText: string;
  coverSelection?: CoverSelection;
  tags: string[];
  subtitles: string;
  previewSubtitles: string;
  source: { available: boolean; start: number; end: number; subtitles: string };
  partSubtitles: string;
  pendingRebuild: boolean;
  mediaSubtitles: boolean;
  category: 'clip' | 'activity' | 'game';
  parts: { title: string; duration: number; subtitles: boolean }[];
  media: boolean;
  mediaRevision?: string;
  sourceRevision?: string;
  preview: boolean;
  cover: boolean;
  evidence: Record<string, any>;
}
export interface AdminJob {
  id: string;
  action: string;
  target: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  output: string;
  exitCode?: number;
  note?: string;
  revision?: string;
  phase?: string;
  plan?: Record<string, unknown>;
  edits?: Record<string, unknown>;
  titleChoice?: TitleDecision;
}
export interface ReminderView {
  configured: boolean;
  runningEnabled: boolean;
  roomId?: string;
  policy?: Record<string, any>;
  state?: {
    enabled: boolean;
    items: { id: string; name: string; enabled: boolean; templates: string[] }[];
    receipts: { day: string; id: string; at: number; text: string; status: string; notified: boolean }[];
    pausedSession?: number;
  };
  pending: { id: string; createdAt: string; action: string }[];
  results?: { id: string; at: string; status: string; message: string }[];
}
