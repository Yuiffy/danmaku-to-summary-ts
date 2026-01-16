#!/usr/bin/env node

import { ServiceManager } from '../services/ServiceManager';
import { LogManager, getLogger } from '../core/logging/LogManager';
import { ConfigProvider } from '../core/config/ConfigProvider';

/**
 * 主应用程序
 */
class MainApplication {
  private logger: ReturnType<typeof getLogger> | null = null;
  private serviceManager: ServiceManager;
  private isShuttingDown = false;

  constructor() {
    this.serviceManager = new ServiceManager();
  }

  /**
   * 启动应用程序
   */
  async start(options?: { port?: number; host?: string }): Promise<void> {
    try {
      // 初始化日志管理器
      LogManager.initialize();
      this.logger = getLogger('MainApplication');
      
      this.logger.info('正在启动弹幕转总结应用程序...');
      
      // 设置优雅关闭处理
      this.setupGracefulShutdown();
      
      // 初始化服务管理器
      await this.serviceManager.initialize();
      
      // 应用命令行参数（如果提供）
      if (options) {
        this.applyOptions(options);
      }
      
      // 启动所有服务
      await this.serviceManager.startAll();
      
      this.logger.info('应用程序启动完成，等待Webhook事件...');
      this.logApplicationInfo();
      
      // 保持应用程序运行
      await this.keepAlive();
      
    } catch (error: any) {
      if (this.logger) {
        this.logger.error(`应用程序启动失败: ${error.message}`, { error });
      } else {
        console.error(`应用程序启动失败: ${error.message}`);
      }
      await this.shutdown(1);
    }
  }

  /**
   * 应用命令行参数
   */
  private applyOptions(options: { port?: number; host?: string }): void {
    try {
      const config = ConfigProvider.getConfig();
      
      if (options.port !== undefined) {
        config.webhook.port = options.port;
        this.logger?.info(`命令行参数：Webhook端口设置为 ${options.port}`);
      }
      
      if (options.host !== undefined) {
        config.webhook.host = options.host;
        this.logger?.info(`命令行参数：Webhook主机设置为 ${options.host}`);
      }
    } catch (error) {
      this.logger?.error(`应用命令行参数失败: ${error}`);
    }
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
   * 停止应用程序
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    
    this.isShuttingDown = true;
    this.getLogger().info('正在停止应用程序...');
    
    try {
      await this.serviceManager.stopAll();
      this.getLogger().info('应用程序已停止');
    } catch (error: any) {
      this.getLogger().error(`停止应用程序时出错: ${error.message}`, { error });
    }
  }

  /**
   * 获取服务管理器
   */
  getServiceManager(): ServiceManager {
    return this.serviceManager;
  }

  /**
   * 获取应用程序状态
   */
  getStatus(): {
    running: boolean;
    services: any;
    config: any;
    timestamp: Date;
  } {
    const services = this.serviceManager.getAllServiceStatus();
    const serviceStatus: Record<string, any> = {};
    
    for (const [name, info] of services.entries()) {
      serviceStatus[name] = {
        status: info.status,
        uptime: info.uptime,
        error: info.error
      };
    }
    
    const config = ConfigProvider.getConfig();
    
    return {
      running: !this.isShuttingDown,
      services: serviceStatus,
      config: {
        environment: config.app.environment,
        logLevel: config.app.logLevel,
        webhook: {
          port: config.webhook.port,
          host: config.webhook.host
        }
      },
      timestamp: new Date()
    };
  }

  /**
   * 处理单个文件（CLI模式）
   */
  async processFile(videoPath: string, xmlPath?: string, roomId?: string): Promise<void> {
    try {
      this.getLogger().info(`CLI模式：处理文件 ${videoPath}`);
      
      // 初始化服务
      await this.serviceManager.initialize();
      
      // 处理文件
      const result = await this.serviceManager.processVideoFile(videoPath, xmlPath, roomId);
      
      this.getLogger().info(`文件处理完成:`, {
        success: result.success,
        videoPath,
        steps: Object.keys(result.steps),
        processingTime: result.processingTime
      });
      
      // 输出详细结果
      console.log('\n=== 处理结果 ===');
      console.log(`视频文件: ${videoPath}`);
      console.log(`房间ID: ${roomId || '未指定'}`);
      console.log(`总体成功: ${result.success ? '是' : '否'}`);
      console.log(`处理时间: ${result.processingTime ? `${result.processingTime / 1000}秒` : '未知'}`);
      
      console.log('\n=== 处理步骤 ===');
      for (const [stepName, stepResult] of Object.entries(result.steps)) {
        console.log(`${stepName}: ${stepResult.success ? '✅ 成功' : '❌ 失败'}`);
        if (stepResult.error) {
          console.log(`  错误: ${stepResult.error}`);
        }
        if (stepResult.output) {
          console.log(`  输出: ${stepResult.output}`);
        }
      }
      
    } catch (error: any) {
      this.getLogger().error(`处理文件失败: ${error.message}`, { error });
      console.error(`错误: ${error.message}`);
    }
  }

  /**
   * 批量处理文件（CLI模式）
   */
  async batchProcessFiles(files: Array<{videoPath: string, xmlPath?: string, roomId?: string}>): Promise<void> {
    try {
      this.getLogger().info(`CLI模式：批量处理 ${files.length} 个文件`);
      
      // 初始化服务
      await this.serviceManager.initialize();
      
      // 批量处理文件
      const results = await this.serviceManager.batchProcessFiles(files);
      
      // 输出统计信息
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log('\n=== 批量处理结果 ===');
      console.log(`总文件数: ${files.length}`);
      console.log(`成功: ${successful}`);
      console.log(`失败: ${failed}`);
      
      if (failed > 0) {
        console.log('\n=== 失败文件 ===');
        results.filter(r => !r.success).forEach(result => {
          console.log(`${result.file}: ${result.error}`);
        });
      }
      
    } catch (error: any) {
      this.getLogger().error(`批量处理文件失败: ${error.message}`, { error });
      console.error(`错误: ${error.message}`);
    }
  }

  /**
   * 保持应用程序运行
   */
  private async keepAlive(): Promise<void> {
    return new Promise((resolve) => {
      // 应用程序将一直运行直到收到关闭信号
      // 这里我们只是等待，实际关闭由信号处理程序处理
      const interval = setInterval(() => {
        if (this.isShuttingDown) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * 设置优雅关闭处理
   */
  private setupGracefulShutdown(): void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    
    signals.forEach(signal => {
      process.on(signal, async () => {
        this.getLogger().info(`收到 ${signal} 信号，正在优雅关闭...`);
        await this.shutdown(0);
      });
    });

    // 处理未捕获的异常
    process.on('uncaughtException', (error: Error) => {
      this.getLogger().error(`未捕获的异常: ${error.message}`, { error });
    });

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      this.getLogger().error(`未处理的Promise拒绝: ${reason}`, { reason, promise });
    });
  }

  /**
   * 关闭应用程序
   */
  private async shutdown(exitCode: number): Promise<void> {
    try {
      await this.stop();
      process.exit(exitCode);
    } catch (error: any) {
      this.getLogger().error(`关闭应用程序时出错: ${error.message}`, { error });
      process.exit(1);
    }
  }

  /**
   * 输出应用程序信息
   */
  private logApplicationInfo(): void {
    const config = ConfigProvider.getConfig();
    
    this.getLogger().info('\n==================================================');
    this.getLogger().info('弹幕转总结应用程序');
    this.getLogger().info(`版本: ${config.app.version}`);
    this.getLogger().info(`环境: ${config.app.environment}`);
    this.getLogger().info(`日志级别: ${config.app.logLevel}`);
    this.getLogger().info(`Webhook端口: ${config.webhook.port}`);
    this.getLogger().info(`Webhook主机: ${config.webhook.host}`);
    this.getLogger().info('==================================================\n');
  }
}

/**
 * 解析命令行参数
 */
function parseCommandLineArgs(): {
  command: string | null;
  args: string[];
  options: {
    port?: number;
    host?: string;
    help?: boolean;
  };
} {
  const rawArgs = process.argv.slice(2);
  const options: {
    port?: number;
    host?: string;
    help?: boolean;
  } = {};
  const args: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    
    if (arg.startsWith('--')) {
      const optionName = arg.slice(2);
      const nextArg = rawArgs[i + 1];
      
      switch (optionName) {
        case 'port':
          if (nextArg && !nextArg.startsWith('--')) {
            options.port = parseInt(nextArg, 10);
            i++; // 跳过下一个参数
          }
          break;
        case 'host':
          if (nextArg && !nextArg.startsWith('--')) {
            options.host = nextArg;
            i++; // 跳过下一个参数
          }
          break;
        case 'help':
          options.help = true;
          break;
      }
    } else if (!command) {
      command = arg;
    } else {
      args.push(arg);
    }
  }

  return { command, args, options };
}

/**
 * 应用命令行参数到配置
 */
function applyCommandLineOptions(options: { port?: number; host?: string }): void {
  try {
    const config = ConfigProvider.getConfig();
    
    if (options.port !== undefined) {
      config.webhook.port = options.port;
      console.log(`命令行参数：Webhook端口设置为 ${options.port}`);
    }
    
    if (options.host !== undefined) {
      config.webhook.host = options.host;
      console.log(`命令行参数：Webhook主机设置为 ${options.host}`);
    }
  } catch (error) {
    // 如果配置未初始化，我们将在配置初始化后应用这些参数
    // 这里我们存储参数，稍后在配置初始化后应用
    console.log(`命令行参数已记录，将在配置初始化后应用: port=${options.port}, host=${options.host}`);
  }
}

/**
 * 在配置初始化后应用命令行参数
 */
function applyCommandLineOptionsAfterInit(options: { port?: number; host?: string }): void {
  try {
    const config = ConfigProvider.getConfig();
    
    if (options.port !== undefined) {
      config.webhook.port = options.port;
      console.log(`命令行参数已应用：Webhook端口设置为 ${options.port}`);
    }
    
    if (options.host !== undefined) {
      config.webhook.host = options.host;
      console.log(`命令行参数已应用：Webhook主机设置为 ${options.host}`);
    }
  } catch (error) {
    console.error(`应用命令行参数失败: ${error}`);
  }
}

/**
 * 命令行接口
 */
async function main() {
  const { command, args, options } = parseCommandLineArgs();
  
  // 如果指定了--help，显示帮助信息
  if (options.help) {
    showHelp();
    return;
  }
  
  const app = new MainApplication();
  
  if (!command) {
    // 无命令：启动服务模式
    // 将命令行参数传递给start方法
    await app.start(options);
  } else if (command === 'process' && args[0]) {
    // 处理单个文件：node main.js process <videoPath> [xmlPath] [roomId]
    const videoPath = args[0];
    const xmlPath = args[1];
    const roomId = args[2];
    
    await app.processFile(videoPath, xmlPath, roomId);
    await app.stop();
  } else if (command === 'batch' && args[0]) {
    // 批量处理：需要从文件读取文件列表
    // 这里简化处理，实际应该从JSON文件读取
    console.log('批量处理功能需要实现文件列表读取');
    await app.stop();
  } else if (command === 'status') {
    // 显示状态
    const serviceManager = app.getServiceManager();
    await serviceManager.initialize();
    const status = app.getStatus();
    console.log(JSON.stringify(status, null, 2));
    await app.stop();
  } else if (command === 'help') {
    // 显示帮助
    showHelp();
  } else {
    console.log('未知命令，使用 --help 查看帮助');
    showHelp();
  }
}

/**
 * 显示帮助信息
 */
function showHelp(): void {
  console.log(`
弹幕转总结应用程序

用法:
  node main.js [选项]                    启动服务模式（Webhook监听）
  node main.js process <video> [xml] [roomId]  处理单个文件
  node main.js status             显示应用程序状态
  node main.js help               显示此帮助信息

选项:
  --port <端口>     设置Webhook服务端口（默认: 15121）
  --host <主机>     设置Webhook服务主机（默认: localhost）
  --help            显示此帮助信息

示例:
  # 启动服务模式（默认端口和主机）
  node main.js
  
  # 启动服务模式，指定端口和主机
  node main.js --port 8080 --host 0.0.0.0
  
  # 处理单个文件
  node main.js process /path/to/video.mp4 /path/to/danmaku.xml 123456
  
  # 显示状态
  node main.js status
  
  # 使用PM2启动服务
  pm2 start dist/app/main.js --name danmaku-webhook -- --port 15121 --host 0.0.0.0

服务模式:
   启动Webhook服务监听DDTV和Mikufans录播姬的事件
   默认端口: 15121
   端点: /ddtv, /mikufans
   健康检查: /health
   状态检查: /status
  `);
}

// 启动应用程序
if (require.main === module) {
  main().catch(error => {
    console.error('应用程序错误:', error);
    process.exit(1);
  });
}

// 导出主应用程序类
export { MainApplication };
export default MainApplication;