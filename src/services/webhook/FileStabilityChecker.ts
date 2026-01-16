import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { IFileStabilityChecker } from './IWebhookService';
import { getLogger } from '../../core/logging/LogManager';
import { FileSystemError } from '../../core/errors/AppError';

const stat = promisify(fs.stat);
const access = promisify(fs.access);

/**
 * 文件稳定性检查器实现
 */
export class FileStabilityChecker implements IFileStabilityChecker {
  private logger = getLogger('FileStabilityChecker');
  
  /**
   * 默认配置
   */
  private defaultConfig = {
    initialWaitMs: 10000, // 初始等待时间（避免干扰写入过程）
    checkIntervalMs: 6000, // 检查间隔
    maxStableChecks: 2, // 连续稳定检查次数
    timeoutMs: 30000, // 超时时间
  };

  /**
   * 等待文件大小稳定
   */
  async waitForFileStability(filePath: string, timeoutMs?: number): Promise<boolean> {
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
        } else if (lastSize === -1) {
          lastSize = currentSize;
          this.logger.debug(`[稳定性检查] ${path.basename(filePath)} 初始大小: ${currentSize} 字节`);
        } else {
          stableCount = 0;
          lastSize = currentSize;
          this.logger.debug(`[稳定性检查] ${path.basename(filePath)} 大小还在变化: ${currentSize} 字节`);
        }
      } catch (error: any) {
        this.logger.error(`[稳定性检查] 错误: ${error.message}`);
        throw new FileSystemError(`检查文件稳定性时出错: ${error.message}`, { filePath, error });
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
  async checkFileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fs.constants.F_OK | fs.constants.R_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取文件大小
   */
  async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await stat(filePath);
      return stats.size;
    } catch (error: any) {
      throw new FileSystemError(`获取文件大小时出错: ${error.message}`, { filePath, error });
    }
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}