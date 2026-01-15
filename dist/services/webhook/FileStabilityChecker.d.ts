import { IFileStabilityChecker } from './IWebhookService';
/**
 * 文件稳定性检查器实现
 */
export declare class FileStabilityChecker implements IFileStabilityChecker {
    private logger;
    /**
     * 默认配置
     */
    private defaultConfig;
    /**
     * 等待文件大小稳定
     */
    waitForFileStability(filePath: string, timeoutMs?: number): Promise<boolean>;
    /**
     * 检查文件是否存在且可读
     */
    checkFileExists(filePath: string): Promise<boolean>;
    /**
     * 获取文件大小
     */
    getFileSize(filePath: string): Promise<number>;
    /**
     * 睡眠函数
     */
    private sleep;
}
