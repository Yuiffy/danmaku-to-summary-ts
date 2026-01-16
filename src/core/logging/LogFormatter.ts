import { LogEntry, LogFormatter as ILogFormatter, LogLevel } from './LoggerInterface';

/**
 * 默认日志格式化器
 */
export class DefaultLogFormatter implements ILogFormatter {
  format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(7);
    const source = entry.source ? `[${entry.source}]` : '';
    const message = entry.message;
    
    let formatted = `${timestamp} ${level} ${source} ${message}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      formatted += ` ${JSON.stringify(entry.context)}`;
    }
    
    if (entry.error) {
      formatted += `\nError: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\nStack: ${entry.error.stack}`;
      }
    }
    
    return formatted;
  }
}

/**
 * JSON日志格式化器
 */
export class JsonLogFormatter implements ILogFormatter {
  format(entry: LogEntry): string {
    const logObject = {
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      source: entry.source,
      message: entry.message,
      context: entry.context,
      error: entry.error ? {
        message: entry.error.message,
        stack: entry.error.stack,
        name: entry.error.name
      } : undefined
    };
    
    return JSON.stringify(logObject);
  }
}

/**
 * 彩色控制台格式化器
 */
export class ColorConsoleFormatter implements ILogFormatter {
  private colors = {
    [LogLevel.ERROR]: '\x1b[31m', // 红色
    [LogLevel.WARN]: '\x1b[33m',  // 黄色
    [LogLevel.INFO]: '\x1b[32m',  // 绿色
    [LogLevel.DEBUG]: '\x1b[36m', // 青色
    [LogLevel.VERBOSE]: '\x1b[90m' // 灰色
  };
  
  private resetColor = '\x1b[0m';
  
  format(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(7);
    const source = entry.source ? `[${entry.source}]` : '';
    const message = entry.message;
    
    const color = this.colors[entry.level] || this.resetColor;
    
    let formatted = `${color}${timestamp} ${level} ${source} ${message}${this.resetColor}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      formatted += ` ${JSON.stringify(entry.context)}`;
    }
    
    if (entry.error) {
      formatted += `\n${color}Error: ${entry.error.message}${this.resetColor}`;
      if (entry.error.stack) {
        formatted += `\n${color}Stack: ${entry.error.stack}${this.resetColor}`;
      }
    }
    
    return formatted;
  }
}