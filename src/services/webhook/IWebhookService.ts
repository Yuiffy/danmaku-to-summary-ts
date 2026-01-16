import { Express } from 'express';

/**
 * Webhook事件类型
 */
export type WebhookEventType = 
  | 'ddtv' 
  | 'mikufans' 
  | 'file_closed' 
  | 'session_started' 
  | 'save_bullet_screen'
  | 'invalid_login'
  | 'configuration_change'
  | 'unknown';

/**
 * Webhook事件数据接口
 */
export interface IWebhookEvent {
  type: WebhookEventType;
  payload: any;
  timestamp: Date;
  source: string;
  roomId?: string;
  roomName?: string;
  filePaths?: string[];
  sessionId?: string;
}

/**
 * 文件处理结果
 */
export interface IFileProcessingResult {
  success: boolean;
  filePath: string;
  outputPath?: string;
  outputFiles?: string[];
  error?: string;
  processingTime?: number;
}

/**
 * Webhook服务接口
 */
export interface IWebhookService {
  /**
   * 启动Webhook服务器
   */
  start(): Promise<void>;

  /**
   * 停止Webhook服务器
   */
  stop(): Promise<void>;

  /**
   * 获取服务器端口
   */
  getPort(): number;

  /**
   * 获取服务器URL
   */
  getServerUrl(): string;

  /**
   * 处理Webhook事件
   */
  processEvent(event: IWebhookEvent): Promise<IFileProcessingResult[]>;

  /**
   * 检查文件是否正在处理中
   */
  isFileProcessing(filePath: string): boolean;

  /**
   * 获取正在处理的文件列表
   */
  getProcessingFiles(): string[];

  /**
   * 获取处理历史
   */
  getProcessingHistory(): IWebhookEvent[];

  /**
   * 清理过期的处理记录
   */
  cleanupExpiredRecords(): void;
}

/**
 * 文件稳定性检查器接口
 */
export interface IFileStabilityChecker {
  /**
   * 等待文件大小稳定
   */
  waitForFileStability(filePath: string, timeoutMs?: number): Promise<boolean>;

  /**
   * 检查文件是否存在且可读
   */
  checkFileExists(filePath: string): Promise<boolean>;

  /**
   * 获取文件大小
   */
  getFileSize(filePath: string): Promise<number>;
}

/**
 * 重复处理防护器接口
 */
export interface IDuplicateProcessorGuard {
  /**
   * 检查文件是否正在处理或已处理
   */
  isDuplicate(filePath: string): boolean;

  /**
   * 标记文件为正在处理
   */
  markAsProcessing(filePath: string): void;

  /**
   * 标记文件为处理完成
   */
  markAsProcessed(filePath: string): void;

  /**
   * 清理过期的记录
   */
  cleanup(): void;

  /**
   * 获取所有正在处理的文件
   */
  getProcessingFiles(): string[];
}

/**
 * Webhook处理器接口
 */
export interface IWebhookHandler {
  /**
   * 处理器名称
   */
  readonly name: string;

  /**
   * 处理器支持的路径
   */
  readonly path: string;

  /**
   * 处理器是否启用
   */
  readonly enabled: boolean;

  /**
   * 注册Express路由
   */
  registerRoutes(app: Express): void;

  /**
   * 处理Webhook请求
   */
  handleRequest(req: any, res: any): Promise<void>;

  /**
   * 验证请求有效性
   */
  validateRequest(req: any): boolean;
}