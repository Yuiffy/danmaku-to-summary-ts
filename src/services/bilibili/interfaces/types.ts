/**
 * B站动态回复功能类型定义
 */

/**
 * 主播配置
 */
export interface AnchorConfig {
  /** 主播UID */
  uid: string;
  /** 主播名称 */
  name: string;
  /** 房间ID（用于关联录播） */
  roomId?: string;
  /** 是否启用动态回复 */
  enabled: boolean;
  /** 直播开始时间（从webhook获取） */
  liveStartTime?: Date;
  /** 最后检测时间 */
  lastCheckTime?: Date;
}

export interface RoomLiveStatus {
  roomId: string;
  uid?: string;
  liveStatus: number;
  isLive: boolean;
  title?: string;
  liveStartTime?: Date;
  rawData?: any;
}

/**
 * B站动态类型
 */
export enum DynamicType {
  /** 视频动态 */
  AV = 'DYNAMIC_TYPE_AV',
  /** 纯文本动态 */
  WORD = 'DYNAMIC_TYPE_WORD',
  /** 图片动态 */
  DRAW = 'DYNAMIC_TYPE_DRAW',
  /** 文章动态 */
  ARTICLE = 'DYNAMIC_TYPE_ARTICLE'
}

/**
 * B站动态数据
 */
export interface BilibiliDynamic {
  /** 动态ID */
  id: string;
  /** 主播UID */
  uid: string;
  /** 动态类型 */
  type: DynamicType;
  /** 动态内容 */
  content: string;
  /** 图片列表 */
  images?: string[];
  /** 发布时间 */
  publishTime: Date;
  /** 动态URL */
  url: string;
  /** 动态原始数据 */
  rawData?: any;
}

/**
 * 回复历史
 */
export interface ReplyHistory {
  /** 动态ID */
  dynamicId: string;
  /** 主播UID */
  uid: string;
  /** 回复时间 */
  replyTime: Date;
  /** 回复内容摘要 */
  contentSummary: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 回复任务
 */
export interface ReplyTask {
  /** 任务ID */
  taskId: string;
  /** 动态数据 */
  dynamic: BilibiliDynamic;
  /** 晚安回复文本路径 */
  textPath: string;
  /** 漫画图片路径 */
  imagePath: string;
  /** 重试次数 */
  retryCount: number;
  /** 创建时间 */
  createTime: Date;
}

/**
 * B站API响应
 */
export interface BilibiliAPIResponse<T = any> {
  /** 响应码 */
  code: number;
  /** 响应消息 */
  message: string;
  /** 响应数据 */
  data: T;
}

/**
 * 动态列表响应数据
 */
export interface DynamicListData {
  /** 动态卡片列表 */
  cards: any[];
  /** 是否有更多 */
  hasMore: boolean;
  /** 下一页偏移量 */
  offset?: string;
}

/**
 * 发布评论请求
 */
export interface PublishCommentRequest {
  /** 动态ID */
  dynamicId: string;
  /** 评论内容 */
  content: string;
  /** 图片URL列表 */
  images?: string[];
  /** Existing top-level comment to reply under; kept as a string to preserve precision. */
  replyToId?: string;
}

/**
 * 发布评论响应
 */
export interface PublishCommentResponse {
  /** 回复ID */
  replyId: string;
  /** 回复时间 */
  replyTime: number;
  /** 图片URL（如果有） */
  imageUrl?: string;
}

export type LiveContentSummaryDeliveryMode = 'separate' | 'attach_if_ready';

export type LiveContentSummaryDeliveryState =
  | 'waiting'
  | 'ready'
  | 'publishing'
  | 'attached_main'
  | 'attached_supplemental'
  | 'published_separate'
  | 'published_thread'
  | 'failed';

/**
 * B站配置
 */
export interface BilibiliConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 轮询配置 */
  polling: {
    /** 轮询间隔（毫秒） */
    interval: number;
    /** 最大重试次数 */
    maxRetries: number;
    /** 重试延迟（毫秒） */
    retryDelay: number;
  };
  /** 主播配置 */
  anchors: Record<string, AnchorConfig>;
}

/**
 * 延迟回复任务
 */
export interface DelayedReplyTask {
  /** 任务ID */
  taskId: string;
  /** 房间ID */
  roomId: string;
  /** 主播UID */
  uid?: string;
  /** 晚安回复文本路径 */
  goodnightTextPath: string;
  /** 漫画图片路径 */
  comicImagePath?: string;
  /** 创建时间 */
  createTime: Date;
  /** 计划执行时间 */
  scheduledTime: Date;
  /** 任务状态 */
  status: 'pending' | 'processing' | 'waiting_comic' | 'waiting_summary' | 'waiting_live_content' | 'completed' | 'failed';
  /** 重试次数 */
  retryCount: number;
  /** 错误信息 */
  error?: string;
  /** 直播开始时间 */
  liveStartTime?: Date;
  /** 直播结束时间 */
  liveEndTime?: Date;
  /** 上次检查动态时间 */
  lastCheckTime?: Date;
  /** 检查次数 */
  checkCount?: number;
  /** 等待漫画图片次数 */
  comicWaitCount?: number;
  /** 已向企微发送漫画生成失败告警的时间，避免重试或重启后重复提醒 */
  comicGenerationFailureNotifiedAt?: Date;
  /** 已回复的动态ID */
  repliedDynamicId?: string;
  /** 已发布的回复ID */
  replyId?: string;
  /** Persisted before publishing so interrupted sends are not automatically repeated. */
  mainReplyState?: 'ready' | 'publishing' | 'published' | 'unknown';
  /** Records actual main-reply delivery, not whether an image was merely planned. */
  mainReplyHasImage?: boolean;
  /** 补图回复ID */
  supplementalReplyId?: string;
  /** 补图回复完成时间 */
  supplementalCompletedAt?: Date;
  /** Persisted before sending; an unfinished request must not be repeated after restart. */
  supplementalPublishingAt?: Date;
  /** 汇总动态下的回复ID */
  summaryReplyId?: string;
  /** 汇总动态回复完成时间 */
  summaryCompletedAt?: Date;
  summaryPublishingAt?: Date;
  /** 汇总动态回复的独立重试次数，避免影响主回复/补图重试 */
  summaryRetryCount?: number;
  /** 本场直播内容梗概 JSON 路径 */
  liveContentSummaryPath?: string;
  /** 梗概发布方式：单独回到晚安评论下，或在主回复/补图就绪时拼接 */
  liveContentSummaryDeliveryMode?: LiveContentSummaryDeliveryMode;
  /** 梗概发布子状态；与固定汇总动态的 summaryReplyId 相互独立 */
  liveContentSummaryState?: LiveContentSummaryDeliveryState;
  /** 梗概最终所在的评论 ID（拼接时等于主回复或补图回复 ID） */
  liveContentSummaryReplyId?: string;
  /** 梗概最终投递位置 */
  liveContentSummaryAttachedTo?: 'main' | 'supplemental' | 'separate' | 'main_reply';
  /** Parent goodnight comment for a separately delivered summary. */
  liveContentSummaryParentReplyId?: string;
  /** 梗概投递完成时间 */
  liveContentSummaryCompletedAt?: Date;
  /** 梗概单独发布重试次数 */
  liveContentSummaryRetryCount?: number;
  /** 梗概读取或发布错误，不影响主晚安回复/补图 */
  liveContentSummaryError?: string;
  /** 主回复拼接超过 B 站上限后强制改为晚安下的子回复 */
  liveContentSummaryForceSeparate?: boolean;
  /** 单独发布请求发出前的持久化时间；重启后用于避免不确定请求重复发送 */
  liveContentSummaryPublishingAt?: Date;
  /** 完成时间 */
  completedAt?: Date;
  /** Task was delayed because the same live was still active after restart. */
  deferredForActiveLive?: boolean;
  /** Number of checks while waiting for a final recording task to replace it. */
  liveContinuationWaitCount?: number;
  /** Total number of times this task was deferred because the live was still active. */
  activeLiveDeferCount?: number;
}

/**
 * B站密钥配置
 */
export interface BilibiliSecretConfig {
  /** Cookie */
  cookie: string;
  /** CSRF Token */
  csrf: string;
  /** Web cookie refresh token from localStorage.ac_time_value */
  ac_time_value?: string;
}
