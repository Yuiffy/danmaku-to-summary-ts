#!/usr/bin/env node
import { ServiceManager } from '../services/ServiceManager';
/**
 * 主应用程序
 */
declare class MainApplication {
    private logger;
    private serviceManager;
    private isShuttingDown;
    constructor();
    /**
     * 启动应用程序
     */
    start(options?: {
        port?: number;
        host?: string;
    }): Promise<void>;
    /**
     * 应用命令行参数
     */
    private applyOptions;
    /**
     * 获取logger（安全方法）
     */
    private getLogger;
    /**
     * 停止应用程序
     */
    stop(): Promise<void>;
    /**
     * 获取服务管理器
     */
    getServiceManager(): ServiceManager;
    /**
     * 获取应用程序状态
     */
    getStatus(): {
        running: boolean;
        services: any;
        config: any;
        timestamp: Date;
    };
    /**
     * 处理单个文件（CLI模式）
     */
    processFile(videoPath: string, xmlPath?: string, roomId?: string): Promise<void>;
    /**
     * 批量处理文件（CLI模式）
     */
    batchProcessFiles(files: Array<{
        videoPath: string;
        xmlPath?: string;
        roomId?: string;
    }>): Promise<void>;
    /**
     * 保持应用程序运行
     */
    private keepAlive;
    /**
     * 设置优雅关闭处理
     */
    private setupGracefulShutdown;
    /**
     * 关闭应用程序
     */
    private shutdown;
    /**
     * 输出应用程序信息
     */
    private logApplicationInfo;
}
export { MainApplication };
export default MainApplication;
//# sourceMappingURL=main.d.ts.map