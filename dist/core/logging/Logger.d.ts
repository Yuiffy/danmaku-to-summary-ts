import { LogLevel, LoggerConfig, ILogger } from './LoggerInterface';
/**
 * 主日志器实现
 */
export declare class Logger implements ILogger {
    private config;
    private context;
    private source?;
    constructor(config: LoggerConfig, source?: string);
    /**
     * 创建默认日志器
     */
    static createDefault(source?: string): Logger;
    /**
     * 检查日志级别是否应该记录
     */
    private shouldLog;
    /**
     * 获取调用源
     */
    private getCallerSource;
    /**
     * 记录日志
     */
    private log;
    /**
     * 错误级别日志
     */
    error(message: string, context?: Record<string, any>, error?: Error): void;
    /**
     * 警告级别日志
     */
    warn(message: string, context?: Record<string, any>): void;
    /**
     * 信息级别日志
     */
    info(message: string, context?: Record<string, any>): void;
    /**
     * 调试级别日志
     */
    debug(message: string, context?: Record<string, any>): void;
    /**
     * 详细级别日志
     */
    verbose(message: string, context?: Record<string, any>): void;
    /**
     * 创建子日志器
     */
    child(context: Record<string, any>): ILogger;
    /**
     * 刷新所有传输器
     */
    flush(): Promise<void>;
    /**
     * 关闭所有传输器
     */
    close(): Promise<void>;
    /**
     * 设置上下文
     */
    setContext(context: Record<string, any>): void;
    /**
     * 获取当前日志级别
     */
    getLevel(): LogLevel;
    /**
     * 设置日志级别
     */
    setLevel(level: LogLevel): void;
}
