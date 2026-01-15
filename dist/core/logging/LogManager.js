"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logManager = exports.LogManager = void 0;
exports.initializeLogging = initializeLogging;
exports.getLogger = getLogger;
exports.logError = logError;
exports.logWarn = logWarn;
exports.logInfo = logInfo;
exports.logDebug = logDebug;
exports.logVerbose = logVerbose;
const Logger_1 = require("./Logger");
/**
 * 日志管理器
 * 提供全局日志器访问
 */
class LogManager {
    static defaultLogger = null;
    static loggers = new Map();
    /**
     * 初始化默认日志器
     */
    static async initialize() {
        if (!this.defaultLogger) {
            // 需要先初始化配置
            const { ConfigProvider } = await Promise.resolve().then(() => require('../config/ConfigProvider'));
            await ConfigProvider.initialize();
            this.defaultLogger = Logger_1.Logger.createDefault();
            this.loggers.set('default', this.defaultLogger);
            this.defaultLogger.info('LogManager initialized');
        }
    }
    /**
     * 获取默认日志器
     */
    static getLogger() {
        if (!this.defaultLogger) {
            throw new Error('LogManager not initialized. Call initialize() first.');
        }
        return this.defaultLogger;
    }
    /**
     * 获取指定源的日志器
     */
    static getLoggerFor(source) {
        if (!this.defaultLogger) {
            // 如果LogManager未初始化，返回一个安全的控制台logger
            return {
                info: (message, ...args) => console.log(`[INFO] ${source}: ${message}`, ...args),
                error: (message, ...args) => console.error(`[ERROR] ${source}: ${message}`, ...args),
                warn: (message, ...args) => console.warn(`[WARN] ${source}: ${message}`, ...args),
                debug: (message, ...args) => console.debug(`[DEBUG] ${source}: ${message}`, ...args),
                trace: (message, ...args) => console.trace(`[TRACE] ${source}: ${message}`, ...args),
                verbose: (message, ...args) => console.log(`[VERBOSE] ${source}: ${message}`, ...args),
                child: (context) => this.getLoggerFor(source),
                flush: async () => { },
                close: async () => { }
            };
        }
        if (!this.loggers.has(source)) {
            const logger = this.defaultLogger.child({ source });
            this.loggers.set(source, logger);
        }
        return this.loggers.get(source);
    }
    /**
     * 创建自定义日志器
     */
    static createLogger(source) {
        if (!this.defaultLogger) {
            throw new Error('LogManager not initialized. Call initialize() first.');
        }
        if (source) {
            return this.getLoggerFor(source);
        }
        else {
            return this.defaultLogger;
        }
    }
    /**
     * 刷新所有日志器
     */
    static async flushAll() {
        const promises = Array.from(this.loggers.values()).map(logger => logger.flush());
        await Promise.all(promises);
    }
    /**
     * 关闭所有日志器
     */
    static async closeAll() {
        const promises = Array.from(this.loggers.values()).map(logger => logger.close());
        await Promise.all(promises);
        this.loggers.clear();
        this.defaultLogger = null;
    }
    /**
     * 获取所有日志器
     */
    static getAllLoggers() {
        return new Map(this.loggers);
    }
}
exports.LogManager = LogManager;
/**
 * 全局日志辅助函数
 */
// 默认导出实例
exports.logManager = LogManager;
// 快捷函数
async function initializeLogging() {
    await LogManager.initialize();
}
function getLogger(source) {
    try {
        return LogManager.getLoggerFor(source || 'default');
    }
    catch (error) {
        // 如果LogManager未初始化，返回一个安全的控制台logger
        return {
            info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
            error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
            warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
            debug: (message, ...args) => console.debug(`[DEBUG] ${message}`, ...args),
            trace: (message, ...args) => console.trace(`[TRACE] ${message}`, ...args),
            verbose: (message, ...args) => console.log(`[VERBOSE] ${message}`, ...args),
            child: (context) => getLogger(source),
            flush: async () => { },
            close: async () => { }
        };
    }
}
function logError(message, error, context) {
    const logger = getLogger();
    logger.error(message, context, error);
}
function logWarn(message, context) {
    const logger = getLogger();
    logger.warn(message, context);
}
function logInfo(message, context) {
    const logger = getLogger();
    logger.info(message, context);
}
function logDebug(message, context) {
    const logger = getLogger();
    logger.debug(message, context);
}
function logVerbose(message, context) {
    const logger = getLogger();
    logger.verbose(message, context);
}
//# sourceMappingURL=LogManager.js.map