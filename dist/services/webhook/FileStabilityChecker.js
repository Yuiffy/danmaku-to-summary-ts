"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStabilityChecker = void 0;
const fs = require("fs");
const path = require("path");
const util_1 = require("util");
const LogManager_1 = require("../../core/logging/LogManager");
const AppError_1 = require("../../core/errors/AppError");
const stat = (0, util_1.promisify)(fs.stat);
const access = (0, util_1.promisify)(fs.access);
/**
 * 文件稳定性检查器实现
 */
class FileStabilityChecker {
    logger = (0, LogManager_1.getLogger)('FileStabilityChecker');
    /**
     * 默认配置
     */
    defaultConfig = {
        initialWaitMs: 10000, // 初始等待时间（避免干扰写入过程）
        checkIntervalMs: 6000, // 检查间隔
        maxStableChecks: 2, // 连续稳定检查次数
        timeoutMs: 30000, // 超时时间
    };
    /**
     * 等待文件大小稳定
     */
    async waitForFileStability(filePath, timeoutMs) {
        const config = { ...this.defaultConfig, timeoutMs: timeoutMs || this.defaultConfig.timeoutMs };
        this.logger.info(`开始检查文件稳定性: ${path.basename(filePath)}`);
        // 检查文件是否存在
        if (!await this.checkFileExists(filePath)) {
            this.logger.warn(`文件不存在: ${filePath}`);
            return false;
        }
        // 初始等待，避免干扰写入过程
        this.logger.info(`倒计时开始：${config.initialWaitMs / 1000}秒后开始文件大小检查`);
        await this.sleep(config.initialWaitMs);
        let lastSize = -1;
        let stableCount = 0;
        let startTime = Date.now();
        while (stableCount < config.maxStableChecks) {
            // 检查超时
            if (Date.now() - startTime > config.timeoutMs) {
                this.logger.warn(`文件稳定性检查超时: ${path.basename(filePath)}`);
                return false;
            }
            try {
                const stats = await stat(filePath);
                const currentSize = stats.size;
                if (currentSize === lastSize && currentSize > 0) {
                    stableCount++;
                    this.logger.debug(`[稳定性检查] ${path.basename(filePath)} 大小未变化 (${stableCount}/${config.maxStableChecks})`);
                }
                else if (lastSize === -1) {
                    lastSize = currentSize;
                    this.logger.debug(`[稳定性检查] ${path.basename(filePath)} 初始大小: ${currentSize} 字节`);
                }
                else {
                    stableCount = 0;
                    lastSize = currentSize;
                    this.logger.debug(`[稳定性检查] ${path.basename(filePath)} 大小还在变化: ${currentSize} 字节`);
                }
            }
            catch (error) {
                this.logger.error(`[稳定性检查] 错误: ${error.message}`);
                throw new AppError_1.FileSystemError(`检查文件稳定性时出错: ${error.message}`, { filePath, error });
            }
            if (stableCount < config.maxStableChecks) {
                await this.sleep(config.checkIntervalMs);
            }
        }
        this.logger.info(`✅ 文件已稳定: ${path.basename(filePath)}`);
        return true;
    }
    /**
     * 检查文件是否存在且可读
     */
    async checkFileExists(filePath) {
        try {
            await access(filePath, fs.constants.F_OK | fs.constants.R_OK);
            return true;
        }
        catch (error) {
            return false;
        }
    }
    /**
     * 获取文件大小
     */
    async getFileSize(filePath) {
        try {
            const stats = await stat(filePath);
            return stats.size;
        }
        catch (error) {
            throw new AppError_1.FileSystemError(`获取文件大小时出错: ${error.message}`, { filePath, error });
        }
    }
    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.FileStabilityChecker = FileStabilityChecker;
//# sourceMappingURL=FileStabilityChecker.js.map