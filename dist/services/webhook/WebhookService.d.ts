import { IWebhookService, IWebhookEvent, IFileProcessingResult, IWebhookHandler } from './IWebhookService';
/**
 * Webhook服务实现
 */
export declare class WebhookService implements IWebhookService {
    private app;
    private server;
    private port;
    private host;
    private logger;
    private stabilityChecker;
    private duplicateGuard;
    private handlers;
    private processingHistory;
    private maxHistorySize;
    constructor();
    /**
     * 获取logger（安全方法）
     */
    private getLogger;
    /**
     * 启动Webhook服务器
     */
    start(): Promise<void>;
    /**
     * 停止Webhook服务器
     */
    stop(): Promise<void>;
    /**
     * 获取服务器端口
     */
    getPort(): number;
    /**
     * 获取服务器URL
     */
    getServerUrl(): string;
    /**
     * 处理Webhook事件
     */
    processEvent(event: IWebhookEvent): Promise<IFileProcessingResult[]>;
    /**
     * 检查文件是否正在处理中
     */
    isFileProcessing(filePath: string): boolean;
    /**
     * 获取正在处理的文件列表
     */
    getProcessingFiles(): string[];
    /**
     * 获取处理历史
     */
    getProcessingHistory(): IWebhookEvent[];
    /**
     * 清理过期的处理记录
     */
    cleanupExpiredRecords(): void;
    /**
     * 获取所有处理器
     */
    getHandlers(): IWebhookHandler[];
    /**
     * 获取服务状态
     */
    getStatus(): {
        running: boolean;
        port: number;
        host: string;
        handlers: number;
        processingFiles: number;
        historySize: number;
    };
    /**
     * 配置中间件
     */
    private configureMiddleware;
    /**
     * 初始化处理器
     */
    private initializeHandlers;
    /**
     * 注册处理器路由
     */
    private registerHandlers;
    /**
     * 添加事件到历史记录
     */
    private addToHistory;
}
//# sourceMappingURL=WebhookService.d.ts.map