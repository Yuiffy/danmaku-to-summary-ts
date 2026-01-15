import { Request, Response } from 'express';
import { IWebhookHandler } from '../IWebhookService';
/**
 * Mikufans Webhook处理器
 */
export declare class MikufansWebhookHandler implements IWebhookHandler {
    readonly name = "Mikufans Webhook Handler";
    readonly path = "/mikufans";
    readonly enabled = true;
    private logger;
    private stabilityChecker;
    private duplicateGuard;
    private sessionFiles;
    /**
     * 注册Express路由
     */
    registerRoutes(app: any): void;
    /**
     * 处理Webhook请求
     */
    handleRequest(req: Request, res: Response): Promise<void>;
    /**
     * 验证请求有效性
     */
    validateRequest(req: Request): boolean;
    /**
     * 记录事件日志
     */
    private logEvent;
    /**
     * 处理事件
     */
    private handleEvent;
    /**
     * 处理会话开始事件
     */
    private handleSessionStarted;
    /**
     * 处理文件关闭事件
     */
    private handleFileClosed;
    /**
     * 处理Mikufans文件
     */
    private processMikufansFile;
    /**
     * 启动处理流程
     */
    private startProcessing;
    /**
     * 获取会话文件列表
     */
    getSessionFiles(sessionId: string): string[];
    /**
     * 获取所有会话
     */
    getAllSessions(): Map<string, string[]>;
    /**
     * 清理过期的会话
     */
    cleanupExpiredSessions(maxAgeHours?: number): void;
}
