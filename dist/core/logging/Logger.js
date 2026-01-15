"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const LoggerInterface_1 = require("./LoggerInterface");
const LogFormatter_1 = require("./LogFormatter");
const LogTransport_1 = require("./LogTransport");
const ConfigProvider_1 = require("../config/ConfigProvider");
/**
 * 日志级别数值映射
 */
const LogLevelValue = {
    [LoggerInterface_1.LogLevel.ERROR]: 0,
    [LoggerInterface_1.LogLevel.WARN]: 1,
    [LoggerInterface_1.LogLevel.INFO]: 2,
    [LoggerInterface_1.LogLevel.DEBUG]: 3,
    [LoggerInterface_1.LogLevel.VERBOSE]: 4
};
/**
 * 主日志器实现
 */
class Logger {
    config;
    context;
    source;
    constructor(config, source) {
        this.config = {
            level: config.level,
            transports: config.transports || [],
            format: config.format || new LogFormatter_1.DefaultLogFormatter(),
            context: config.context || {},
            enableSourceTracking: config.enableSourceTracking !== false
        };
        this.context = { ...this.config.context };
        this.source = source;
    }
    /**
     * 创建默认日志器
     */
    static createDefault(source) {
        const config = ConfigProvider_1.ConfigProvider.getConfig();
        const logLevel = config.app.logLevel;
        const transports = [
            new LogTransport_1.ConsoleTransport(new LogFormatter_1.ColorConsoleFormatter())
        ];
        // 如果是生产环境，添加文件日志
        if (config.app.environment === 'production') {
            const logPath = path.join(config.storage.basePath, 'logs', 'app.log');
            transports.push(new LogTransport_1.RotatingFileTransport(logPath, 10 * 1024 * 1024, 5));
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
    shouldLog(level) {
        const entryLevelValue = LogLevelValue[level];
        const configLevelValue = LogLevelValue[this.config.level];
        return entryLevelValue <= configLevelValue;
    }
    /**
     * 获取调用源
     */
    getCallerSource() {
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
        }
        catch (error) {
            // 忽略错误
        }
        return this.source;
    }
    /**
     * 记录日志
     */
    log(level, message, context, error) {
        if (!this.shouldLog(level)) {
            return;
        }
        const entry = {
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
            }
            catch (transportError) {
                // 如果传输器失败，记录到控制台但不抛出
                console.error(`Log transport failed: ${transportError}`);
            }
        }
    }
    /**
     * 错误级别日志
     */
    error(message, context, error) {
        this.log(LoggerInterface_1.LogLevel.ERROR, message, context, error);
    }
    /**
     * 警告级别日志
     */
    warn(message, context) {
        this.log(LoggerInterface_1.LogLevel.WARN, message, context);
    }
    /**
     * 信息级别日志
     */
    info(message, context) {
        this.log(LoggerInterface_1.LogLevel.INFO, message, context);
    }
    /**
     * 调试级别日志
     */
    debug(message, context) {
        this.log(LoggerInterface_1.LogLevel.DEBUG, message, context);
    }
    /**
     * 详细级别日志
     */
    verbose(message, context) {
        this.log(LoggerInterface_1.LogLevel.VERBOSE, message, context);
    }
    /**
     * 创建子日志器
     */
    child(context) {
        const childLogger = new Logger(this.config, this.source);
        childLogger.context = { ...this.context, ...context };
        return childLogger;
    }
    /**
     * 刷新所有传输器
     */
    async flush() {
        const promises = this.config.transports
            .filter(transport => transport.flush)
            .map(transport => transport.flush());
        await Promise.all(promises);
    }
    /**
     * 关闭所有传输器
     */
    async close() {
        const promises = this.config.transports
            .filter(transport => transport.close)
            .map(transport => transport.close());
        await Promise.all(promises);
    }
    /**
     * 设置上下文
     */
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    /**
     * 获取当前日志级别
     */
    getLevel() {
        return this.config.level;
    }
    /**
     * 设置日志级别
     */
    setLevel(level) {
        this.config.level = level;
    }
}
exports.Logger = Logger;
// 导入path模块
const path = require("path");
//# sourceMappingURL=Logger.js.map