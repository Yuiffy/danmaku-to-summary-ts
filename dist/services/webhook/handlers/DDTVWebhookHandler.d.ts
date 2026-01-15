import { Request, Response } from 'express';
import { IWebhookHandler } from '../IWebhookService';
/**
 * DDTV Webhook处理器
 */
export declare class DDTVWebhookHandler implements IWebhookHandler {
    readonly name = "DDTV Webhook Handler";
    readonly path = "/ddtv";
    readonly enabled = true;
    private logger;
    private stabilityChecker;
    private duplicateGuard;
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
     * 处理登陆失效事件
     */
    private handleInvalidLogin;
    /**
     * 处理文件事件
     */
    private handleFileEvent;
    /**
     * 提取文件列表
     */
    private extractFiles;
    /**
     * 处理SaveBulletScreenFile事件
     */
    private handleSaveBulletScreenFile;
    /**
     * 处理视频文件
     */
    private processVideoFiles;
    /**
     * 启动处理流程
     */
    private startProcessing;
    /**
     * 压缩弹幕数据
     */
    private compressDanmuData;
    /**
     * 压缩数组显示
     */
    private compressArray;
    /**
     * 显示Windows通知
     */
    private showWindowsNotification;
    /**
     * 睡眠函数
     */
    private sleep;
}
