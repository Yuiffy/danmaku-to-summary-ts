import express, { Express, Request, Response } from 'express';
import { IWebhookService, IWebhookEvent, IFileProcessingResult, IWebhookHandler } from './IWebhookService';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { DDTVWebhookHandler } from './handlers/DDTVWebhookHandler';
import { MikufansWebhookHandler } from './handlers/MikufansWebhookHandler';
import { AudioFileHandler } from './handlers/AudioFileHandler';
import { BilibiliAPIHandler } from './handlers/BilibiliAPIHandler';
import { FileStabilityChecker } from './FileStabilityChecker';
import { DuplicateProcessorGuard } from './DuplicateProcessorGuard';
import { ComicGeneratorService } from '../comic/ComicGeneratorService';
import { IDelayedReplyService } from '../bilibili/interfaces/IDelayedReplyService';

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
  private comicGenerator: ComicGeneratorService;
  private delayedReplyService?: IDelayedReplyService;

  constructor() {
    this.app = express();
    this.port = 15121; // 默认端口
    this.host = '0.0.0.0'; // 默认主机
    this.comicGenerator = new ComicGeneratorService();
    
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

          // 根据文件类型启动相应的处理流程
          const processingResult = await this.processFileBasedOnType(filePath, event.roomId);
          const processingTime = Date.now() - startTime;
          
          // 标记为处理完成
          this.duplicateGuard.markAsProcessed(filePath);
          
          if (processingResult.success) {
            results.push({
              success: true,
              filePath,
              processingTime,
              outputFiles: processingResult.outputFiles
            });
            this.getLogger().info(`文件处理成功: ${filePath} (耗时: ${processingTime / 1000} 秒)`);
          } else {
            results.push({
              success: false,
              filePath,
              processingTime,
              error: processingResult.error
            });
            this.getLogger().error(`文件处理失败: ${filePath}`, { error: processingResult.error });
          }
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
    this.app.use(express.json({ limit: '50mb' }));
    
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
      new MikufansWebhookHandler(),
      new AudioFileHandler(),
      new BilibiliAPIHandler()
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

  /**
   * 检查高亮内容是否太短（只有顶端固定的2行+0~1行）
   */
  private isHighlightTooShort(content: string): boolean {
    const lines = content.split('\n').filter(line => line.trim() !== '');
    // 只有顶端固定的2行 + 0~1行 = 最多3行有效内容
    return lines.length <= 3;
  }

  /**
   * 根据文件类型处理文件
   */
  private async processFileBasedOnType(filePath: string, roomId?: string): Promise<{
    success: boolean;
    outputFiles?: string[];
    error?: string;
  }> {
    const logger = this.getLogger();
    const fileName = filePath.split(/[\\/]/).pop() || '';
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
    
    logger.info(`开始处理文件: ${fileName} (类型: ${fileExtension})`, { filePath, roomId });

    try {
      // 根据文件类型和内容决定处理方式
      if (fileName.includes('AI_HIGHLIGHT') && fileExtension === 'txt') {
        // AI高亮文本文件 - 检查内容是否太短
        const fs = await import('fs');
        const content = fs.readFileSync(filePath, 'utf8');
        
        if (this.isHighlightTooShort(content)) {
          logger.info(`AI_HIGHLIGHT内容太短（只有顶端固定的2行+0~1行），跳过漫画生成: ${fileName}`);
          return {
            success: true,
            outputFiles: []
          };
        }
        
        // 内容充分，开始生成漫画
        logger.info(`检测到AI高亮文件，开始生成漫画: ${fileName}`);
        const comicPath = await this.comicGenerator.generateComicFromHighlight(filePath, roomId);
        
        if (comicPath) {
          logger.info(`漫画生成成功: ${comicPath}`);
          
          // 触发延迟回复任务
          await this.triggerDelayedReply(roomId, fileName, comicPath);
          
          return {
            success: true,
            outputFiles: [comicPath]
          };
        } else {
          logger.warn(`漫画生成失败: ${fileName}`);
          return {
            success: false,
            error: '漫画生成失败'
          };
        }
      } else if (fileName.includes('COMIC_SCRIPT') && fileExtension === 'txt') {
        // 漫画脚本文件 - 生成漫画
        logger.info(`检测到漫画脚本文件，开始生成漫画: ${fileName}`);
        const comicPath = await this.comicGenerator.generateComicFromHighlight(filePath, roomId);
        
        if (comicPath) {
          logger.info(`漫画生成成功: ${comicPath}`);
          
          // 触发延迟回复任务
          await this.triggerDelayedReply(roomId, fileName, comicPath);
          
          return {
            success: true,
            outputFiles: [comicPath]
          };
        } else {
          logger.warn(`漫画生成失败: ${fileName}`);
          return {
            success: false,
            error: '漫画生成失败'
          };
        }
      } else if (fileExtension === 'flv' || fileExtension === 'mp4' || fileExtension === 'mkv') {
        // 视频文件 - 音频处理流程
        logger.info(`检测到视频文件，开始音频处理: ${fileName}`);
        
        // TODO: 集成音频处理服务
        // const audioProcessor = new AudioProcessor();
        // const result = await audioProcessor.processVideo(filePath);
        
        // 暂时返回成功，但标记为需要实现
        logger.warn(`视频处理功能尚未完全实现: ${fileName}`);
        return {
          success: true,
          outputFiles: []
        };
      } else if (fileExtension === 'xml' || fileExtension === 'srt') {
        // 字幕文件 - 字幕处理流程
        logger.info(`检测到字幕文件，开始字幕处理: ${fileName}`);
        
        // TODO: 集成字幕处理服务
        // const subtitleProcessor = new SubtitleProcessor();
        // const result = await subtitleProcessor.processSubtitle(filePath);
        
        // 暂时返回成功，但标记为需要实现
        logger.warn(`字幕处理功能尚未完全实现: ${fileName}`);
        return {
          success: true,
          outputFiles: []
        };
      } else if (fileExtension === 'md') {
        // Markdown文件 - 可能是总结文件
        logger.info(`检测到Markdown文件: ${fileName}`);
        
        // 检查是否是晚安回复文件
        if (fileName.includes('晚安回复')) {
          logger.info(`检测到晚安回复文件，跳过处理: ${fileName}`);
          return {
            success: true,
            outputFiles: []
          };
        }
        
        // 其他Markdown文件暂时跳过
        logger.info(`跳过Markdown文件处理: ${fileName}`);
        return {
          success: true,
          outputFiles: []
        };
      } else {
        // 未知文件类型
        logger.warn(`未知文件类型，跳过处理: ${fileName} (扩展名: ${fileExtension})`);
        return {
          success: true,
          outputFiles: []
        };
      }
    } catch (error: any) {
      logger.error(`处理文件时出错: ${fileName}`, { error: error.message, stack: error.stack });
      return {
        success: false,
        error: `处理文件时出错: ${error.message}`
      };
    }
  }

  /**
   * 设置延迟回复服务
   */
  setDelayedReplyService(service: IDelayedReplyService): void {
    this.delayedReplyService = service;
    this.getLogger().info('延迟回复服务已设置');
  }

  /**
   * 触发延迟回复任务
   */
  private async triggerDelayedReply(roomId: string | undefined, fileName: string, comicPath: string): Promise<void> {
    if (!this.delayedReplyService) {
      this.getLogger().debug('延迟回复服务未设置，跳过触发');
      return;
    }

    if (!roomId) {
      this.getLogger().debug('房间ID未提供，跳过触发延迟回复');
      return;
    }

    try {
      // 从文件名中提取晚安回复文件路径
      const dir = comicPath.substring(0, comicPath.lastIndexOf('/'));
      const baseName = fileName.replace('COMIC_FACTORY', '晚安回复').replace('.png', '.md');
      const goodnightTextPath = `${dir}/${baseName}`;

      // 检查晚安回复文件是否存在
      const fs = await import('fs');
      if (!fs.existsSync(goodnightTextPath)) {
        this.getLogger().warn('晚安回复文件不存在，跳过触发延迟回复', { goodnightTextPath });
        return;
      }

      // 添加延迟回复任务
      const taskId = await this.delayedReplyService.addTask(roomId, goodnightTextPath, comicPath);
      
      if (taskId) {
        this.getLogger().info('已触发延迟回复任务', { taskId, roomId });
      }
    } catch (error: any) {
      this.getLogger().error('触发延迟回复任务失败', { error, roomId });
    }
  }
}