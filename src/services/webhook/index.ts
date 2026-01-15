import { WebhookService } from './WebhookService';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';

/**
 * Webhook服务启动器
 */
export class WebhookStarter {
  private logger = getLogger('WebhookStarter');
  private webhookService: WebhookService;

  constructor() {
    this.webhookService = new WebhookService();
  }

  /**
   * 启动Webhook服务
   */
  async start(): Promise<void> {
    try {
      this.logger.info('正在启动Webhook服务...');
      
      // 初始化配置
      await ConfigProvider.initialize();
      
      // 启动Webhook服务
      await this.webhookService.start();
      
      this.logger.info('Webhook服务启动成功');
      
      // 设置优雅关闭
      this.setupGracefulShutdown();
      
    } catch (error: any) {
      this.logger.error(`启动Webhook服务失败: ${error.message}`, { error });
      process.exit(1);
    }
  }

  /**
   * 停止Webhook服务
   */
  async stop(): Promise<void> {
    try {
      this.logger.info('正在停止Webhook服务...');
      await this.webhookService.stop();
      this.logger.info('Webhook服务已停止');
    } catch (error: any) {
      this.logger.error(`停止Webhook服务时出错: ${error.message}`, { error });
    }
  }

  /**
   * 获取Webhook服务实例
   */
  getService(): WebhookService {
    return this.webhookService;
  }

  /**
   * 设置优雅关闭
   */
  private setupGracefulShutdown(): void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    
    signals.forEach(signal => {
      process.on(signal, async () => {
        this.logger.info(`收到 ${signal} 信号，正在优雅关闭...`);
        await this.stop();
        process.exit(0);
      });
    });

    // 处理未捕获的异常
    process.on('uncaughtException', (error: Error) => {
      this.logger.error(`未捕获的异常: ${error.message}`, { error });
    });

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      this.logger.error(`未处理的Promise拒绝: ${reason}`, { reason, promise });
    });
  }
}

/**
 * 命令行启动入口
 */
if (require.main === module) {
  const starter = new WebhookStarter();
  starter.start().catch(error => {
    console.error('启动失败:', error);
    process.exit(1);
  });
}

// 导出主要组件
export { WebhookService } from './WebhookService';
export { DDTVWebhookHandler } from './handlers/DDTVWebhookHandler';
export { MikufansWebhookHandler } from './handlers/MikufansWebhookHandler';
export { FileStabilityChecker } from './FileStabilityChecker';
export { DuplicateProcessorGuard } from './DuplicateProcessorGuard';
export type { 
  IWebhookService, 
  IWebhookEvent, 
  IFileProcessingResult,
  IWebhookHandler,
  IFileStabilityChecker,
  IDuplicateProcessorGuard 
} from './IWebhookService';