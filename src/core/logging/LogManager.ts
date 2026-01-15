import { Logger } from './Logger';
import { ILogger } from './LoggerInterface';

/**
 * 日志管理器
 * 提供全局日志器访问
 */
export class LogManager {
  private static defaultLogger: ILogger | null = null;
  private static loggers: Map<string, ILogger> = new Map();

  /**
   * 初始化默认日志器
   */
  static async initialize(): Promise<void> {
    if (!this.defaultLogger) {
      // 需要先初始化配置
      const { ConfigProvider } = await import('../config/ConfigProvider');
      await ConfigProvider.initialize();
      
      this.defaultLogger = Logger.createDefault();
      this.loggers.set('default', this.defaultLogger);
      
      this.defaultLogger.info('LogManager initialized');
    }
  }

  /**
   * 获取默认日志器
   */
  static getLogger(): ILogger {
    if (!this.defaultLogger) {
      throw new Error('LogManager not initialized. Call initialize() first.');
    }
    return this.defaultLogger;
  }

  /**
   * 获取指定源的日志器
   */
  static getLoggerFor(source: string): ILogger {
    if (!this.defaultLogger) {
      // 如果LogManager未初始化，返回一个安全的控制台logger
      return {
        info: (message: string, ...args: any[]) => console.log(`[INFO] ${source}: ${message}`, ...args),
        error: (message: string, ...args: any[]) => console.error(`[ERROR] ${source}: ${message}`, ...args),
        warn: (message: string, ...args: any[]) => console.warn(`[WARN] ${source}: ${message}`, ...args),
        debug: (message: string, ...args: any[]) => console.debug(`[DEBUG] ${source}: ${message}`, ...args),
        trace: (message: string, ...args: any[]) => console.trace(`[TRACE] ${source}: ${message}`, ...args),
        verbose: (message: string, ...args: any[]) => console.log(`[VERBOSE] ${source}: ${message}`, ...args),
        child: (context: Record<string, any>) => this.getLoggerFor(source),
        flush: async () => {},
        close: async () => {}
      } as ILogger;
    }

    if (!this.loggers.has(source)) {
      const logger = this.defaultLogger.child({ source });
      this.loggers.set(source, logger);
    }

    return this.loggers.get(source)!;
  }

  /**
   * 创建自定义日志器
   */
  static createLogger(source?: string): ILogger {
    if (!this.defaultLogger) {
      throw new Error('LogManager not initialized. Call initialize() first.');
    }

    if (source) {
      return this.getLoggerFor(source);
    } else {
      return this.defaultLogger;
    }
  }

  /**
   * 刷新所有日志器
   */
  static async flushAll(): Promise<void> {
    const promises = Array.from(this.loggers.values()).map(logger => logger.flush());
    await Promise.all(promises);
  }

  /**
   * 关闭所有日志器
   */
  static async closeAll(): Promise<void> {
    const promises = Array.from(this.loggers.values()).map(logger => logger.close());
    await Promise.all(promises);
    this.loggers.clear();
    this.defaultLogger = null;
  }

  /**
   * 获取所有日志器
   */
  static getAllLoggers(): Map<string, ILogger> {
    return new Map(this.loggers);
  }
}

/**
 * 全局日志辅助函数
 */

// 默认导出实例
export const logManager = LogManager;

// 快捷函数
export async function initializeLogging(): Promise<void> {
  await LogManager.initialize();
}

export function getLogger(source?: string): ILogger {
  try {
    return LogManager.getLoggerFor(source || 'default');
  } catch (error) {
    // 如果LogManager未初始化，返回一个安全的控制台logger
    return {
      info: (message: string, ...args: any[]) => console.log(`[INFO] ${message}`, ...args),
      error: (message: string, ...args: any[]) => console.error(`[ERROR] ${message}`, ...args),
      warn: (message: string, ...args: any[]) => console.warn(`[WARN] ${message}`, ...args),
      debug: (message: string, ...args: any[]) => console.debug(`[DEBUG] ${message}`, ...args),
      trace: (message: string, ...args: any[]) => console.trace(`[TRACE] ${message}`, ...args),
      verbose: (message: string, ...args: any[]) => console.log(`[VERBOSE] ${message}`, ...args),
      child: (context: Record<string, any>) => getLogger(source),
      flush: async () => {},
      close: async () => {}
    } as ILogger;
  }
}

export function logError(message: string, error?: Error, context?: Record<string, any>): void {
  const logger = getLogger();
  logger.error(message, context, error);
}

export function logWarn(message: string, context?: Record<string, any>): void {
  const logger = getLogger();
  logger.warn(message, context);
}

export function logInfo(message: string, context?: Record<string, any>): void {
  const logger = getLogger();
  logger.info(message, context);
}

export function logDebug(message: string, context?: Record<string, any>): void {
  const logger = getLogger();
  logger.debug(message, context);
}

export function logVerbose(message: string, context?: Record<string, any>): void {
  const logger = getLogger();
  logger.verbose(message, context);
}