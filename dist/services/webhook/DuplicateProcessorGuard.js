"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuplicateProcessorGuard = void 0;
const LogManager_1 = require("../../core/logging/LogManager");
/**
 * 重复处理防护器实现
 */
class DuplicateProcessorGuard {
    logger = (0, LogManager_1.getLogger)('DuplicateProcessorGuard');
    /**
     * 处理记录存储
     */
    processingRecords = new Map();
    /**
     * 默认配置
     */
    defaultConfig = {
        processingTimeoutMs: 30 * 60 * 1000, // 30分钟处理超时
        cleanupIntervalMs: 5 * 60 * 1000, // 5分钟清理一次
        maxHistorySize: 1000, // 最大历史记录数
    };
    constructor() {
        // 启动定期清理
        this.startCleanupTimer();
    }
    /**
     * 检查文件是否正在处理或已处理
     */
    isDuplicate(filePath) {
        const record = this.processingRecords.get(filePath);
        if (!record) {
            return false;
        }
        // 检查是否正在处理中
        if (record.status === 'processing') {
            const processingTime = Date.now() - record.startTime.getTime();
            // 如果处理时间超过超时时间，认为处理失败，允许重新处理
            if (processingTime > this.defaultConfig.processingTimeoutMs) {
                this.logger.warn(`文件处理超时，允许重新处理: ${filePath}`);
                this.processingRecords.delete(filePath);
                return false;
            }
            this.logger.debug(`文件正在处理中: ${filePath} (已处理 ${processingTime / 1000} 秒)`);
            return true;
        }
        // 如果已经处理完成，检查是否在最近时间内
        if (record.status === 'processed') {
            const processedTime = Date.now() - record.startTime.getTime();
            const recentThreshold = 60 * 60 * 1000; // 1小时内视为重复
            if (processedTime < recentThreshold) {
                this.logger.debug(`文件最近已处理: ${filePath} (${processedTime / 1000} 秒前)`);
                return true;
            }
            // 超过1小时，清理记录
            this.processingRecords.delete(filePath);
            return false;
        }
        return false;
    }
    /**
     * 标记文件为正在处理
     */
    markAsProcessing(filePath) {
        const record = {
            filePath,
            startTime: new Date(),
            status: 'processing',
        };
        this.processingRecords.set(filePath, record);
        this.logger.debug(`标记文件为处理中: ${filePath}`);
        // 如果记录过多，清理最旧的记录
        if (this.processingRecords.size > this.defaultConfig.maxHistorySize) {
            this.cleanupOldRecords();
        }
    }
    /**
     * 标记文件为处理完成
     */
    markAsProcessed(filePath) {
        const record = this.processingRecords.get(filePath);
        if (record) {
            record.status = 'processed';
            record.processingTime = Date.now() - record.startTime.getTime();
            this.logger.debug(`标记文件为处理完成: ${filePath} (耗时: ${record.processingTime / 1000} 秒)`);
        }
        else {
            // 如果没有记录，创建新的处理完成记录
            this.processingRecords.set(filePath, {
                filePath,
                startTime: new Date(),
                status: 'processed',
                processingTime: 0,
            });
        }
    }
    /**
     * 清理过期的记录
     */
    cleanup() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [filePath, record] of this.processingRecords.entries()) {
            const age = now - record.startTime.getTime();
            // 清理超过24小时的记录
            if (age > 24 * 60 * 60 * 1000) {
                this.processingRecords.delete(filePath);
                cleanedCount++;
            }
            // 清理处理中超时的记录
            if (record.status === 'processing' && age > this.defaultConfig.processingTimeoutMs) {
                this.processingRecords.delete(filePath);
                cleanedCount++;
                this.logger.warn(`清理超时的处理记录: ${filePath}`);
            }
        }
        if (cleanedCount > 0) {
            this.logger.info(`清理了 ${cleanedCount} 个过期记录`);
        }
    }
    /**
     * 获取所有正在处理的文件
     */
    getProcessingFiles() {
        const processingFiles = [];
        for (const [filePath, record] of this.processingRecords.entries()) {
            if (record.status === 'processing') {
                processingFiles.push(filePath);
            }
        }
        return processingFiles;
    }
    /**
     * 获取所有记录
     */
    getAllRecords() {
        return new Map(this.processingRecords);
    }
    /**
     * 获取处理统计信息
     */
    getStatistics() {
        let processingCount = 0;
        let processedCount = 0;
        let totalProcessingTime = 0;
        let processedWithTimeCount = 0;
        for (const record of this.processingRecords.values()) {
            if (record.status === 'processing') {
                processingCount++;
            }
            else if (record.status === 'processed') {
                processedCount++;
                if (record.processingTime) {
                    totalProcessingTime += record.processingTime;
                    processedWithTimeCount++;
                }
            }
        }
        return {
            totalRecords: this.processingRecords.size,
            processingCount,
            processedCount,
            averageProcessingTime: processedWithTimeCount > 0
                ? totalProcessingTime / processedWithTimeCount
                : undefined,
        };
    }
    /**
     * 启动清理定时器
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanup();
        }, this.defaultConfig.cleanupIntervalMs);
        this.logger.debug(`启动清理定时器，间隔: ${this.defaultConfig.cleanupIntervalMs / 1000} 秒`);
    }
    /**
     * 清理最旧的记录
     */
    cleanupOldRecords() {
        const recordsArray = Array.from(this.processingRecords.entries());
        // 按开始时间排序
        recordsArray.sort((a, b) => a[1].startTime.getTime() - b[1].startTime.getTime());
        // 删除最旧的记录，直到数量在限制内
        const recordsToRemove = recordsArray.length - this.defaultConfig.maxHistorySize;
        if (recordsToRemove > 0) {
            for (let i = 0; i < recordsToRemove; i++) {
                this.processingRecords.delete(recordsArray[i][0]);
            }
            this.logger.info(`清理了 ${recordsToRemove} 个最旧记录，当前记录数: ${this.processingRecords.size}`);
        }
    }
}
exports.DuplicateProcessorGuard = DuplicateProcessorGuard;
//# sourceMappingURL=DuplicateProcessorGuard.js.map