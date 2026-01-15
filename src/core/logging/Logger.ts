import { LogLevel, LogEntry, LoggerConfig, ILogger } from './LoggerInterface';
import { DefaultLogFormatter, ColorConsoleFormatter } from './LogFormatter';
import { ConsoleTransport, RotatingFileTransport } from './LogTransport';
import { ConfigProvider } from '../config/ConfigProvider';

/**
 * 日志级别数值映射
 */
const LogLevelValue: Record<LogLevel, number> = {
  [LogLevel.ERROR]: 0,
  [LogLevel.WARN]: 1,
  [LogLevel.INFO]: 2,
  [LogLevel.DEBUG]: 3,
  [LogLevel.VERBOSE]: 4
};

/**
 * 主日志器实现
 */
export class Logger implements ILogger {
  private config: LoggerConfig;
  private context: Record<string, any>;
  private source?: string;

  constructor(config: LoggerConfig, source?: string) {
    this.config = {
      level: config.level,
      transports: config.transports || [],
      format: config.format || new DefaultLogFormatter(),
      context: config.context || {},
      enableSourceTracking: config.enableSourceTracking !== false
    };
    this.context = { ...this.config.context };
    this.source = source;
  }

  /**
   * 创建默认日志器
   */
  static createDefault(source?: string): Logger {
    const config = ConfigProvider.getConfig();
    const logLevel = config.app.logLevel as LogLevel;
    
    const transports: any[] = [
      new ConsoleTransport(new ColorConsoleFormatter())
    ];
    
    // 如果是生产环境，添加文件日志
    if (config.app.environment === 'production') {
      const logPath = path.join(config.storage.basePath, 'logs', 'app.log');
      transports.push(new RotatingFileTransport(logPath, 10 * 1024 * 1024, 5));
    }
    
    return new Logger({
      level: logLevel,
      transports,
      enableSourceTracking: true
    }, source);
  }

  /**
   * 检查日志级别是否应该记录
   */
  private shouldLog(level: LogLevel): boolean {
    const entryLevelValue = LogLevelValue[level];
    const configLevelValue = LogLevelValue[this.config.level];
    return entryLevelValue <= configLevelValue;
  }

  /**
   * 获取调用源
   */
  private getCallerSource(): string | undefined {
    if (!this.config.enableSourceTracking) {
      return this.source;
    }

    try {
      const error = new Error();
      const stack = error.stack?.split('\n') || [];
      
      // 查找第一个不是Logger本身的调用
      for (let i = 3; i < stack.length; i++) {
        const line = stack[i].trim();
        if (!line.includes('Logger.') && !line.includes('node_modules')) {
          // 提取文件名和行号
          const match = line.match(/at\s+.+\s+\((.+):(\d+):(\d+)\)/);
          if (match) {
            const fileName = match[1];
            const lineNumber = match[2];
            
            // 提取简短文件名
            const shortFileName = fileName.split('/').pop() || fileName;
            return `${shortFileName}:${lineNumber}`;
          }
        }
      }
    } catch (error) {
      // 忽略错误
    }

    return this.source;
  }

  /**
   * 记录日志
   */
  private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context: { ...this.context, ...context },
      error,
      source: this.getCallerSource()
    };

    // 写入所有传输器
    for (const transport of this.config.transports) {
      try {
        transport.write(entry);
      } catch (transportError) {
        // 如果传输器失败，记录到控制台但不抛出
        console.error(`Log transport failed: ${transportError}`);
      }
    }
  }

  /**
   * 错误级别日志
   */
  error(message: string, context?: Record<string, any>, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error);
  }

  /**
   * 警告级别日志
   */
  warn(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context);
  }

  /**
   * 信息级别日志
   */
  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * 调试级别日志
   */
  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * 详细级别日志
   */
  verbose(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.VERBOSE, message, context);
  }

  /**
   * 创建子日志器
   */
  child(context: Record<string, any>): ILogger {
    const childLogger = new Logger(this.config, this.source);
    childLogger.context = { ...this.context, ...context };
    return childLogger;
  }

  /**
   * 刷新所有传输器
   */
  async flush(): Promise<void> {
    const promises = this.config.transports
      .filter(transport => transport.flush)
      .map(transport => transport.flush!());
    
    await Promise.all(promises);
  }

  /**
   * 关闭所有传输器
   */
  async close(): Promise<void> {
    const promises = this.config.transports
      .filter(transport => transport.close)
      .map(transport => transport.close!());
    
    await Promise.all(promises);
  }

  /**
   * 设置上下文
   */
  setContext(context: Record<string, any>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * 获取当前日志级别
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }
}

// 导入path模块
import * as path from 'path';