import { AppConfig } from './ConfigInterface';
/**
 * 配置提供者
 * 提供全局配置访问
 */
export declare class ConfigProvider {
    private static config;
    private static loader;
    /**
     * 初始化配置
     */
    static initialize(options?: any): Promise<AppConfig>;
    /**
     * 获取配置
     */
    static getConfig(): AppConfig;
    /**
     * 重新加载配置
     */
    static reload(): Promise<AppConfig>;
    /**
     * 获取应用配置
     */
    static getAppConfig(): {
        name: string;
        version: string;
        environment: "development" | "staging" | "production";
        logLevel: "error" | "warn" | "info" | "debug";
    };
    /**
     * 获取Webhook配置
     */
    static getWebhookConfig(): import("./ConfigInterface").WebhookConfig;
    /**
     * 获取音频配置
     */
    static getAudioConfig(): import("./ConfigInterface").AudioConfig;
    /**
     * 获取AI配置
     */
    static getAIConfig(): import("./ConfigInterface").AIConfig;
    /**
     * 获取字幕融合配置
     */
    static getFusionConfig(): import("./ConfigInterface").FusionConfig;
    /**
     * 获取存储配置
     */
    static getStorageConfig(): import("./ConfigInterface").StorageConfig;
    /**
     * 获取监控配置
     */
    static getMonitoringConfig(): import("./ConfigInterface").MonitoringConfig;
    /**
     * 获取特定房间的AI配置
     */
    static getRoomAIConfig(roomId: string): {
        audioOnly: boolean;
        referenceImage: string | undefined;
        characterDescription: string | undefined;
        anchorName: string;
        fanName: string;
        enableTextGeneration: boolean;
        enableComicGeneration: boolean;
    };
    /**
     * 检查是否为音频专用房间
     */
    static isAudioOnlyRoom(roomId: string): boolean;
    /**
     * 获取环境
     */
    static getEnvironment(): string;
    /**
     * 是否为开发环境
     */
    static isDevelopment(): boolean;
    /**
     * 是否为生产环境
     */
    static isProduction(): boolean;
    /**
     * 获取日志级别
     */
    static getLogLevel(): string;
    /**
     * 获取Webhook端口
     */
    static getWebhookPort(): number;
    /**
     * 获取Webhook主机
     */
    static getWebhookHost(): string;
    /**
     * 获取存储基础路径
     */
    static getStorageBasePath(): string;
    /**
     * 获取临时路径
     */
    static getTempPath(): string;
    /**
     * 获取输出路径
     */
    static getOutputPath(): string;
    /**
     * 获取Gemini API密钥
     */
    static getGeminiApiKey(): string | undefined;
    /**
     * 获取OpenAI API密钥
     */
    static getOpenAIApiKey(): string | undefined;
    /**
     * 获取AI文本提供者
     */
    static getTextAIProvider(): string;
    /**
     * 获取AI漫画提供者
     */
    static getComicAIProvider(): string;
}
