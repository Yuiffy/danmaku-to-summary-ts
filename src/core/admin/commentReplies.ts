export interface AdminCommentReply {
  key: string;
  uid: string;
  type: number;
  trigger: 'mention' | 'reply' | 'legacy';
  status: string;
  text: string;
  answer?: string;
  replyId?: string;
  admittedAt: number;
  processingAt?: number;
  completedAt?: number;
  likeStatus?: string;
  url?: string;
}
export interface AdminCommentRepliesView {
  service: 'running' | 'stopped' | 'paused' | 'missing';
  updatedAt?: number;
  counts: Record<string, number>;
  today: { reservedTokens: number; modelCalls: number; limit: number };
  total: number;
  page: number;
  pages: number;
  rows: AdminCommentReply[];
}
