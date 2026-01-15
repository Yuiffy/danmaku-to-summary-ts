import { IDuplicateProcessorGuard } from './IWebhookService';
/**
 * 处理记录
 */
interface ProcessingRecord {
    filePath: string;
    startTime: Date;
    status: 'processing' | 'processed';
    processingTime?: number;
}
/**
 * 重复处理防护器实现
 */
export declare class DuplicateProcessorGuard implements IDuplicateProcessorGuard {
    private logger;
    /**
     * 处理记录存储
     */
    private processingRecords;
    /**
     * 默认配置
     */
    private defaultConfig;
    constructor();
    /**
     * 检查文件是否正在处理或已处理
     */
    isDuplicate(filePath: string): boolean;
    /**
     * 标记文件为正在处理
     */
    markAsProcessing(filePath: string): void;
    /**
     * 标记文件为处理完成
     */
    markAsProcessed(filePath: string): void;
    /**
     * 清理过期的记录
     */
    cleanup(): void;
    /**
     * 获取所有正在处理的文件
     */
    getProcessingFiles(): string[];
    /**
     * 获取所有记录
     */
    getAllRecords(): Map<string, ProcessingRecord>;
    /**
     * 获取处理统计信息
     */
    getStatistics(): {
        totalRecords: number;
        processingCount: number;
        processedCount: number;
        averageProcessingTime?: number;
    };
    /**
     * 启动清理定时器
     */
    private startCleanupTimer;
    /**
     * 清理最旧的记录
     */
    private cleanupOldRecords;
}
export {};
