import { ILogger } from './LoggerInterface';
/**
 * 日志管理器
 * 提供全局日志器访问
 */
export declare class LogManager {
    private static defaultLogger;
    private static loggers;
    /**
     * 初始化默认日志器
     */
    static initialize(): Promise<void>;
    /**
     * 获取默认日志器
     */
    static getLogger(): ILogger;
    /**
     * 获取指定源的日志器
     */
    static getLoggerFor(source: string): ILogger;
    /**
     * 创建自定义日志器
     */
    static createLogger(source?: string): ILogger;
    /**
     * 刷新所有日志器
     */
    static flushAll(): Promise<void>;
    /**
     * 关闭所有日志器
     */
    static closeAll(): Promise<void>;
    /**
     * 获取所有日志器
     */
    static getAllLoggers(): Map<string, ILogger>;
}
/**
 * 全局日志辅助函数
 */
export declare const logManager: typeof LogManager;
export declare function initializeLogging(): Promise<void>;
export declare function getLogger(source?: string): ILogger;
export declare function logError(message: string, error?: Error, context?: Record<string, any>): void;
export declare function logWarn(message: string, context?: Record<string, any>): void;
export declare function logInfo(message: string, context?: Record<string, any>): void;
export declare function logDebug(message: string, context?: Record<string, any>): void;
export declare function logVerbose(message: string, context?: Record<string, any>): void;
