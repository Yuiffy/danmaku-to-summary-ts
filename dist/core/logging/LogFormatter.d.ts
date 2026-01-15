import { LogEntry, LogFormatter as ILogFormatter } from './LoggerInterface';
/**
 * 默认日志格式化器
 */
export declare class DefaultLogFormatter implements ILogFormatter {
    format(entry: LogEntry): string;
}
/**
 * JSON日志格式化器
 */
export declare class JsonLogFormatter implements ILogFormatter {
    format(entry: LogEntry): string;
}
/**
 * 彩色控制台格式化器
 */
export declare class ColorConsoleFormatter implements ILogFormatter {
    private colors;
    private resetColor;
    format(entry: LogEntry): string;
}
