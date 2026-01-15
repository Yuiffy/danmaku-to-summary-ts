/**
 * 日志级别
 */
export declare enum LogLevel {
    ERROR = "error",
    WARN = "warn",
    INFO = "info",
    DEBUG = "debug",
    VERBOSE = "verbose"
}
/**
 * 日志条目
 */
export interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    message: string;
    context?: Record<string, any>;
    error?: Error;
    source?: string;
}
/**
 * 日志格式化器接口
 */
export interface LogFormatter {
    format(entry: LogEntry): string;
}
/**
 * 日志传输器接口
 */
export interface LogTransport {
    write(entry: LogEntry): void;
    flush?(): Promise<void>;
    close?(): Promise<void>;
}
/**
 * 日志配置
 */
export interface LoggerConfig {
    level: LogLevel;
    transports: LogTransport[];
    format?: LogFormatter;
    context?: Record<string, any>;
    enableSourceTracking?: boolean;
}
/**
 * 日志器接口
 */
export interface ILogger {
    error(message: string, context?: Record<string, any>, error?: Error): void;
    warn(message: string, context?: Record<string, any>): void;
    info(message: string, context?: Record<string, any>): void;
    debug(message: string, context?: Record<string, any>): void;
    verbose(message: string, context?: Record<string, any>): void;
    child(context: Record<string, any>): ILogger;
    flush(): Promise<void>;
    close(): Promise<void>;
}
