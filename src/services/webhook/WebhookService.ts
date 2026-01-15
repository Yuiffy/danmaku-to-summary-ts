import * as express from 'express';
import { Express, Request, Response } from 'express';
import { IWebhookService, IWebhookEvent, IFileProcessingResult, IWebhookHandler } from './IWebhookService';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { DDTVWebhookHandler } from './handlers/DDTVWebhookHandler';
import { MikufansWebhookHandler } from './handlers/MikufansWebhookHandler';
import { FileStabilityChecker } from './FileStabilityChecker';
import { DuplicateProcessorGuard } from './DuplicateProcessorGuard';

/**
 * Webhook服务实现
 */
export class WebhookService implements IWebhookService {
  private app: Express;
  private server: any;
  private port: number;
  private host: string;
  private logger: ReturnType<typeof getLogger> | null = null;
  private stabilityChecker = new FileStabilityChecker();
  private duplicateGuard = new DuplicateProcessorGuard();
  private handlers: IWebhookHandler[] = [];
  private processingHistory: IWebhookEvent[] = [];
  private maxHistorySize = 100;

  constructor() {
    this.app = express.default();
    this.port = 15121; // 默认端口
    this.host = '0.0.0.0'; // 默认主机
    
    // 配置中间件
    this.configureMiddleware();
    
    // 初始化处理器
    this.initializeHandlers();
  }

  /**
   * 获取logger（安全方法）
   */
  private getLogger(): ReturnType<typeof getLogger> {
    if (!this.logger) {
      // 如果logger未初始化，使用控制台日志
      return {
        info: (message: string, ...args: any[]) => console.log(`[INFO] ${message}`, ...args),
        error: (message: string, ...args: any[]) => console.error(`[ERROR] ${message}`, ...args),
        warn: (message: string, ...args: any[]) => console.warn(`[WARN] ${message}`, ...args),
        debug: (message: string, ...args: any[]) => console.debug(`[DEBUG] ${message}`, ...args),
        trace: (message: string, ...args: any[]) => console.trace(`[TRACE] ${message}`, ...args)
      } as any;
    }
    return this.logger;
  }

  /**
   * 启动Webhook服务器
   */
  async start(): Promise<void> {
    try {
      // 初始化配置
      await ConfigProvider.initialize();
      
      // 获取配置
      const config = ConfigProvider.getConfig();
      this.port = config.webhook.port || this.port;
      this.host = config.webhook.host || this.host;
      
      // 初始化logger
      this.logger = getLogger('WebhookService');
      
      // 注册处理器路由
      this.registerHandlers();
      
      // 启动服务器
      return new Promise((resolve, reject) => {
        this.server = this.app.listen(this.port, this.host, () => {
          this.getLogger().info(`\n==================================================`);
          this.getLogger().info(`Webhook服务已启动`);
          this.getLogger().info(`地址: http://${this.host}:${this.port}`);
          this.getLogger().info(`DDTV端点: http://${this.host}:${this.port}/ddtv`);
          this.getLogger().info(`Mikufans端点: http://${this.host}:${this.port}/mikufans`);
          this.getLogger().info(`==================================================\n`);
          resolve();
        });
        
        this.server.on('error', (error: Error) => {
          this.getLogger().error(`启动Webhook服务器时出错: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.getLogger().error(`初始化Webhook服务时出错: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * 停止Webhook服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error?: Error) => {
        if (error) {
          this.getLogger().error(`停止Webhook服务器时出错: ${error.message}`);
          reject(error);
        } else {
          this.getLogger().info('Webhook服务已停止');
          resolve();
        }
      });
    });
  }

  /**
   * 获取服务器端口
   */
  getPort(): number {
    return this.port;
  }

  /**
   * 获取服务器URL
   */
  getServerUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * 处理Webhook事件
   */
  async processEvent(event: IWebhookEvent): Promise<IFileProcessingResult[]> {
    // 记录事件
    this.addToHistory(event);
    
    this.getLogger().info(`处理Webhook事件: ${event.type}`, {
      source: event.source,
      roomId: event.roomId,
      roomName: event.roomName,
      fileCount: event.filePaths?.length || 0
    });

    // 根据事件类型处理
    const results: IFileProcessingResult[] = [];
    
    if (event.filePaths && event.filePaths.length > 0) {
      for (const filePath of event.filePaths) {
        try {
          // 检查文件是否正在处理
          if (this.duplicateGuard.isDuplicate(filePath)) {
            this.getLogger().warn(`文件已在处理中，跳过: ${filePath}`);
            results.push({
              success: false,
              filePath,
              error: 'File already being processed'
            });
            continue;
          }

          // 标记为处理中
          this.duplicateGuard.markAsProcessing(filePath);

          // 等待文件稳定
          const startTime = Date.now();
          const isStable = await this.stabilityChecker.waitForFileStability(filePath);
          
          if (!isStable) {
            this.getLogger().error(`文件稳定性检查失败: ${filePath}`);
            this.duplicateGuard.markAsProcessed(filePath);
            results.push({
              success: false,
              filePath,
              error: 'File stability check failed'
            });
            continue;
          }

          // TODO: 启动实际处理流程
          // 这里需要集成现有的处理逻辑
          const processingTime = Date.now() - startTime;
          
          // 标记为处理完成
          this.duplicateGuard.markAsProcessed(filePath);
          
          results.push({
            success: true,
            filePath,
            processingTime
          });

          this.getLogger().info(`文件处理完成: ${filePath} (耗时: ${processingTime / 1000} 秒)`);
        } catch (error: any) {
          this.getLogger().error(`处理文件时出错: ${filePath}`, { error });
          this.duplicateGuard.markAsProcessed(filePath);
          results.push({
            success: false,
            filePath,
            error: error.message
          });
        }
      }
    }

    return results;
  }

  /**
   * 检查文件是否正在处理中
   */
  isFileProcessing(filePath: string): boolean {
    return this.duplicateGuard.isDuplicate(filePath);
  }

  /**
   * 获取正在处理的文件列表
   */
  getProcessingFiles(): string[] {
    return this.duplicateGuard.getProcessingFiles();
  }

  /**
   * 获取处理历史
   */
  getProcessingHistory(): IWebhookEvent[] {
    return [...this.processingHistory];
  }

  /**
   * 清理过期的处理记录
   */
  cleanupExpiredRecords(): void {
    this.duplicateGuard.cleanup();
    
    // 清理历史记录
    const maxAge = 24 * 60 * 60 * 1000; // 24小时
    const now = Date.now();
    const newHistory = this.processingHistory.filter(event => {
      const age = now - event.timestamp.getTime();
      return age < maxAge;
    });
    
    if (newHistory.length < this.processingHistory.length) {
      const removed = this.processingHistory.length - newHistory.length;
      this.processingHistory = newHistory;
      this.getLogger().info(`清理了 ${removed} 个过期历史记录`);
    }
  }

  /**
   * 获取所有处理器
   */
  getHandlers(): IWebhookHandler[] {
    return [...this.handlers];
  }

  /**
   * 获取服务状态
   */
  getStatus(): {
    running: boolean;
    port: number;
    host: string;
    handlers: number;
    processingFiles: number;
    historySize: number;
  } {
    return {
      running: !!this.server,
      port: this.port,
      host: this.host,
      handlers: this.handlers.length,
      processingFiles: this.getProcessingFiles().length,
      historySize: this.processingHistory.length
    };
  }

  /**
   * 配置中间件
   */
  private configureMiddleware(): void {
    // 解析JSON请求体
    this.app.use(express.default.json({ limit: '50mb' }));
    
    // 健康检查端点
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        service: 'danmaku-to-summary-webhook',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      });
    });
    
    // 状态端点
    this.app.get('/status', (req: Request, res: Response) => {
      res.json(this.getStatus());
    });
    
    // 处理历史端点
    this.app.get('/history', (req: Request, res: Response) => {
      res.json(this.getProcessingHistory());
    });
    
    // 处理文件端点
    this.app.get('/processing-files', (req: Request, res: Response) => {
      res.json(this.getProcessingFiles());
    });
    
    // 错误处理中间件
    this.app.use((error: Error, req: Request, res: Response, next: Function) => {
      this.getLogger().error(`Webhook请求处理错误: ${error.message}`, {
        error,
        path: req.path,
        method: req.method
      });
      
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    });
  }

  /**
   * 初始化处理器
   */
  private initializeHandlers(): void {
    // 创建处理器实例
    this.handlers = [
      new DDTVWebhookHandler(),
      new MikufansWebhookHandler()
    ];
    
    this.getLogger().info(`初始化了 ${this.handlers.length} 个Webhook处理器`);
  }

  /**
   * 注册处理器路由
   */
  private registerHandlers(): void {
    for (const handler of this.handlers) {
      if (handler.enabled) {
        handler.registerRoutes(this.app);
        this.getLogger().info(`注册处理器: ${handler.name} (${handler.path})`);
      } else {
        this.getLogger().info(`跳过禁用处理器: ${handler.name}`);
      }
    }
  }

  /**
   * 添加事件到历史记录
   */
  private addToHistory(event: IWebhookEvent): void {
    this.processingHistory.unshift(event);
    
    // 限制历史记录大小
    if (this.processingHistory.length > this.maxHistorySize) {
      this.processingHistory = this.processingHistory.slice(0, this.maxHistorySize);
    }
  }
}