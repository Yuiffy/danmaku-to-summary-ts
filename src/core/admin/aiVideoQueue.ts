export interface AdminAIVideoRow {
  key: string; id: string; name: string; prompt: string; status: string; failureCode?: string;
  backend: string; source: 'qq' | 'operator'; model: string; ratio: string; resolution: string; duration: number;
  completed: number; repeat: number; active: number; referenceCount: number; audioCount: number;
  videoCount?: number;
  createdAt?: number; lastSubmittedAt?: number; nextQueryAt?: number; requiredCredits?: number; playable: boolean;
}
export interface AdminAIVideoCreditUsage {
  key: string; senderName?: string; tasks: number; completed: number;
  submittedCredits: number; uncertainCredits: number; unpricedTasks: number;
}
export interface AdminAIVideoQueueView {
  updatedAt: number; counts: Record<string, number>; total: number; page: number; pages: number;
  rows: AdminAIVideoRow[];
  creditUsage: AdminAIVideoCreditUsage[];
}
