import { IAITextGenerator, TextGenerationOptions, BatchGenerationResult, AITextGeneratorStats, PromptBuildingOptions } from './IAITextGenerator';
/**
 * AI文本生成服务实现
 */
export declare class AITextGenerator implements IAITextGenerator {
    private logger;
    private config;
    private provider;
    private providerConfig;
    constructor();
    /**
     * 加载配置
     */
    private loadConfig;
    /**
     * 确定使用的AI提供者
     */
    private determineProvider;
    /**
     * 获取提供者配置
     */
    private getProviderConfig;
    /**
     * 检查AI服务是否已配置
     */
    isConfigured(): boolean;
    /**
     * 检查AI服务是否可用
     */
    isAvailable(): Promise<boolean>;
    /**
     * 从文件名提取房间ID
     */
    private extractRoomIdFromFilename;
    /**
     * 获取名称配置
     */
    private getNames;
    /**
     * 构建晚安回复提示词
     */
    private buildGoodnightPrompt;
    /**
     * 读取高亮文件内容
     */
    private readHighlightFile;
    /**
     * 保存生成的文本
     */
    private saveGeneratedText;
    /**
     * 使用Gemini生成文本
     */
    private generateWithGemini;
    /**
     * 生成文本
     */
    generateText(prompt: string, options?: TextGenerationOptions): Promise<string>;
    /**
     * 生成晚安回复
     */
    generateGoodnightReply(highlightPath: string, roomId?: string): Promise<string | null>;
    /**
     * 批量生成晚安回复
     */
    batchGenerateGoodnightReplies(directory: string): Promise<BatchGenerationResult[]>;
    /**
     * 获取服务统计信息
     */
    getStats(): AITextGeneratorStats;
    /**
     * 构建自定义提示词
     */
    buildCustomPrompt(content: string, options: PromptBuildingOptions): string;
    /**
     * 测试AI服务连接
     */
    testConnection(): Promise<{
        success: boolean;
        message: string;
        latency?: number;
    }>;
}
/**
 * 创建AI文本生成服务实例
 */
export declare function createAITextGenerator(): IAITextGenerator;
