export const COMMENT_FEEDBACK_CATEGORIES = {
  selection: '选材', editing: '剪辑节奏', subtitles: '字幕', audio: '声音', visual: '画面', packaging: '标题与封面', other: '其他制作建议'
} as const;
export type CommentFeedbackCategory = keyof typeof COMMENT_FEEDBACK_CATEGORIES;
export interface CommentFeedbackNote {
  category: CommentFeedbackCategory;
  quote: string;
  videoOwnerUid: string;
  videoTitle: string;
}
export interface CommentFeedbackRecord extends CommentFeedbackNote {
  version: 1;
  id: string;
  source: 'bilibili-mention';
  eventKey: string;
  videoAid: string;
  commentId: string;
  rootId: string;
  authorUid: string;
  authorName: string;
  comment: string;
  commentCreatedAt: number;
  collectedAt: number;
}
export interface AdminCommentFeedbackView {
  total: number;
  page: number;
  pages: number;
  counts: Partial<Record<CommentFeedbackCategory, number>>;
  rows: Array<CommentFeedbackRecord & { url: string }>;
}
