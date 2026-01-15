import { WebhookService } from './webhook/WebhookService';
import { IAudioProcessor } from './audio/IAudioProcessor';
import { IAITextGenerator } from './ai/IAITextGenerator';
/**
 * 服务状态
 */
export declare enum ServiceStatus {
    STOPPED = "stopped",
    STARTING = "starting",
    RUNNING = "running",
    STOPPING = "stopping",
    ERROR = "error"
}
/**
 * 服务信息
 */
export interface ServiceInfo {
    name: string;
    status: ServiceStatus;
    error?: string;
    startedAt?: Date;
    uptime?: number;
}
/**
 * 处理步骤结果
 */
export interface ProcessingStepResult {
    success: boolean;
    output?: string;
    error?: string;
}
/**
 * 视频处理结果
 */
export interface VideoProcessingResult {
    success: boolean;
    steps: Record<string, ProcessingStepResult>;
    videoPath: string;
    roomId?: string;
    processingTime?: number;
}
/**
 * 服务管理器
 * 负责协调所有服务的启动、停止和状态管理
 */
export declare class ServiceManager {
    private logger;
    private services;
    private webhookService?;
    private audioProcessor?;
    private aiTextGenerator?;
    /**
     * 获取logger（安全方法）
     */
    private getLogger;
    /**
     * 初始化所有服务
     */
    initialize(): Promise<void>;
    /**
     * 启动所有服务
     */
    startAll(): Promise<void>;
    /**
     * 停止所有服务
     */
    stopAll(): Promise<void>;
    /**
     * 获取Webhook服务
     */
    getWebhookService(): WebhookService | undefined;
    /**
     * 获取音频处理服务
     */
    getAudioProcessor(): IAudioProcessor | undefined;
    /**
     * 获取AI文本生成服务
     */
    getAITextGenerator(): IAITextGenerator | undefined;
    /**
     * 获取所有服务状态
     */
    getAllServiceStatus(): Map<string, ServiceInfo>;
    /**
     * 获取服务状态
     */
    getServiceStatus(name: string): ServiceInfo | undefined;
    /**
     * 检查服务是否运行
     */
    isServiceRunning(name: string): boolean;
    /**
     * 获取系统健康状态
     */
    getHealthStatus(): {
        healthy: boolean;
        services: Record<string, ServiceStatus>;
        timestamp: Date;
    };
    /**
     * 处理视频文件
     * 这是主要的业务流程编排
     */
    processVideoFile(videoPath: string, xmlPath?: string, roomId?: string): Promise<VideoProcessingResult>;
    /**
     * 批量处理文件
     */
    batchProcessFiles(files: Array<{
        videoPath: string;
        xmlPath?: string;
        roomId?: string;
    }>): Promise<Array<{
        file: string;
        success: boolean;
        error?: string;
        processingTime?: number;
    }>>;
    /**
     * 获取服务统计信息
     */
    getServiceStatistics(): {
        totalServices: number;
        runningServices: number;
        stoppedServices: number;
        errorServices: number;
    };
    /**
     * 重启服务
     */
    restartService(name: string): Promise<boolean>;
    /**
     * 初始化各个服务
     */
    private initializeServices;
    /**
     * 初始化单个服务
     */
    private initializeService;
    /**
     * 启动单个服务
     */
    private startService;
    /**
     * 停止单个服务
     */
    private stopService;
    /**
     * 清理服务资源
     */
    private cleanupServices;
    /**
     * 更新服务状态
     */
    private updateServiceStatus;
}
