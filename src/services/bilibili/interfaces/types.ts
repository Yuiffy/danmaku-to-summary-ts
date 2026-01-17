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
}

/**
 * 发布评论响应
 */
export interface PublishCommentResponse {
  /** 回复ID */
  replyId: string;
  /** 回复时间 */
  replyTime: number;
}

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
 * B站密钥配置
 */
export interface BilibiliSecretConfig {
  /** Cookie */
  cookie: string;
  /** CSRF Token */
  csrf: string;
}
