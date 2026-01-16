/**
 * AI文本生成服务接口
 * 定义AI文本生成的核心功能
 */
export interface IAITextGenerator {
  /**
   * 检查AI服务是否已配置
   * @returns 是否已配置
   */
  isConfigured(): boolean;

  /**
   * 检查AI服务是否可用
   * @returns 是否可用
   */
  isAvailable(): Promise<boolean>;

  /**
   * 生成晚安回复
   * @param highlightPath AI_HIGHLIGHT文件路径
   * @param roomId 房间ID（可选，用于获取房间特定配置）
   * @returns 生成的晚安回复文件路径或null
   */
  generateGoodnightReply(highlightPath: string, roomId?: string): Promise<string | null>;

  /**
   * 生成文本
   * @param prompt 提示词
   * @param options 生成选项
   * @returns 生成的文本
   */
  generateText(prompt: string, options?: TextGenerationOptions): Promise<string>;

  /**
   * 批量生成晚安回复
   * @param directory 包含AI_HIGHLIGHT文件的目录
   * @returns 批量处理结果
   */
  batchGenerateGoodnightReplies(directory: string): Promise<BatchGenerationResult[]>;

  /**
   * 获取服务统计信息
   */
  getStats(): AITextGeneratorStats;
}

/**
 * 文本生成选项
 */
export interface TextGenerationOptions {
  /** 温度参数（0-1） */
  temperature?: number;
  /** 最大令牌数 */
  maxTokens?: number;
  /** 模型名称 */
  model?: string;
  /** 代理配置 */
  proxy?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 批量生成结果
 */
export interface BatchGenerationResult {
  /** 文件名 */
  file: string;
  /** 是否成功 */
  success: boolean;
  /** 输出文件路径（成功时） */
  output?: string;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * AI文本生成器统计信息
 */
export interface AITextGeneratorStats {
  /** 服务是否启用 */
  enabled: boolean;
  /** 提供者名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** 是否已配置API密钥 */
  apiKeyConfigured: boolean;
  /** 代理配置 */
  proxyConfigured: boolean;
}

/**
 * AI提供者类型
 */
export type AIProvider = 'gemini' | 'openai' | 'claude';

/**
 * AI提供者配置
 */
export interface AIProviderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** API密钥 */
  apiKey?: string;
  /** 模型名称 */
  model: string;
  /** 温度参数 */
  temperature: number;
  /** 最大令牌数 */
  maxTokens: number;
  /** 代理URL */
  proxy?: string;
}

/**
 * 房间AI配置
 */
export interface RoomAIConfig {
  /** 是否为音频专用房间 */
  audioOnly?: boolean;
  /** 参考图片路径 */
  referenceImage?: string;
  /** 角色描述 */
  characterDescription?: string;
  /** 主播名称 */
  anchorName?: string;
  /** 粉丝名称 */
  fanName?: string;
  /** 是否启用文本生成 */
  enableTextGeneration?: boolean;
  /** 是否启用漫画生成 */
  enableComicGeneration?: boolean;
}

/**
 * 名称配置
 */
export interface NamesConfig {
  /** 主播名称 */
  anchor: string;
  /** 粉丝名称 */
  fan: string;
}

/**
 * 提示词构建选项
 */
export interface PromptBuildingOptions {
  /** 主播名称 */
  anchorName: string;
  /** 粉丝名称 */
  fanName: string;
  /** 是否包含元信息 */
  includeMetadata?: boolean;
  /** 字数限制 */
  wordLimit?: number;
  /** 额外指令 */
  additionalInstructions?: string;
}

/**
 * 生成结果
 */
export interface GenerationResult {
  /** 生成的文本 */
  text: string;
  /** 使用的提示词 */
  prompt: string;
  /** 使用的模型 */
  model: string;
  /** 生成时间戳 */
  timestamp: Date;
  /** 令牌使用情况 */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}