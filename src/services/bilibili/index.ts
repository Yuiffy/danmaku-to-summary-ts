/**
 * B站动态回复功能模块导出
 */

// 接口
export type { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
export type { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
export type { IReplyManager } from './interfaces/IReplyManager';
export type { IDelayedReplyService } from './interfaces/IDelayedReplyService';
export type { IDelayedReplyStore } from './interfaces/IDelayedReplyStore';

// 类型
export type {
  AnchorConfig,
  BilibiliDynamic,
  DynamicType,
  ReplyHistory,
  ReplyTask,
  BilibiliAPIResponse,
  DynamicListData,
  PublishCommentRequest,
  PublishCommentResponse,
  BilibiliConfig,
  BilibiliSecretConfig,
  DelayedReplyTask
} from './interfaces/types';

// 配置工具
export type { AnchorConfig as BilibiliAnchorConfig, DelayedReplySettings } from './BilibiliConfigHelper';
export { BilibiliConfigHelper } from './BilibiliConfigHelper';

// 实现
export { BilibiliAPIService } from './BilibiliAPIService';
export { ReplyHistoryStore } from './ReplyHistoryStore';
export { ReplyManager } from './ReplyManager';
export { DelayedReplyService } from './DelayedReplyService';
export { DelayedReplyStore } from './DelayedReplyStore';
export { parseDynamicItem, parseDynamicItems } from './DynamicParser';
