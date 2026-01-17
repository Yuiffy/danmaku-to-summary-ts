/**
 * B站动态回复功能模块导出
 */

// 接口
export type { IBilibiliAPIService } from './interfaces/IBilibiliAPIService';
export type { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
export type { IDynamicPollingService, NewDynamicCallback } from './interfaces/IDynamicPollingService';
export type { IReplyManager } from './interfaces/IReplyManager';

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
  BilibiliSecretConfig
} from './interfaces/types';

// 实现
export { BilibiliAPIService } from './BilibiliAPIService';
export { ReplyHistoryStore } from './ReplyHistoryStore';
export { DynamicPollingService } from './DynamicPollingService';
export { ReplyManager } from './ReplyManager';
