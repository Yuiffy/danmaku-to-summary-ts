/**
 * 应用配置接口定义
 */

// Webhook端点配置
export interface WebhookEndpointConfig {
  enabled: boolean;
  endpoint: string;
  basePath?: string;
}

// Webhook配置
export interface WebhookConfig {
  enabled: boolean;
  port: number;
  host: string;
  endpoints: {
    ddtv: WebhookEndpointConfig;
    mikufans: WebhookEndpointConfig;
  };
  timeouts: {
    fixVideoWait: number;
    fileStableCheck: number;
    processTimeout: number;
  };
}

// FFmpeg配置
export interface FFmpegConfig {
  path: string;
  timeout: number;
}

// 音频存储配置
export interface AudioStorageConfig {
  keepOriginalVideo: boolean;
  maxFileAgeDays: number;
}

// 音频配置
export interface AudioConfig {
  enabled: boolean;
  audioOnlyRooms: number[];
  formats: string[];
  defaultFormat: string;
  ffmpeg: FFmpegConfig;
  storage: AudioStorageConfig;
}

// Gemini配置
export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  proxy?: string;
}

// tuZi配置
export interface TuZiConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  proxy?: string;
}

// OpenAI配置
export interface OpenAIConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  proxy?: string;
}

// 文本AI配置
export interface TextAIConfig {
  enabled: boolean;
  provider: 'gemini' | 'openai' | 'claude';
  gemini?: GeminiConfig;
  tuZi?: TuZiConfig;
  openai?: OpenAIConfig;
  claude?: any; // 可根据需要具体化
}

// Google图像生成配置
export interface GoogleImageConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  proxy?: string;
}

// 漫画AI配置
export interface ComicAIConfig {
  enabled: boolean;
  provider: 'python' | 'huggingface' | 'local';
  python?: {
    script: string;
  };
  googleImage?: GoogleImageConfig;
  tuZi?: TuZiConfig;
  huggingface?: {
    apiToken: string;
    model: string;
  };
  local?: {
    modelPath: string;
  };
}

// 房间AI配置
export interface RoomAIConfig {
  audioOnly?: boolean;
  referenceImage?: string;
  characterDescription?: string;
  anchorName?: string;
  fanName?: string;
  enableTextGeneration?: boolean;
  enableComicGeneration?: boolean;
}

// AI配置
export interface AIConfig {
  text: TextAIConfig;
  comic: ComicAIConfig;
  defaultNames: {
    anchor: string;
    fan: string;
  };
  roomSettings: Record<string, RoomAIConfig>;
}

// 字幕融合配置
export interface FusionConfig {
  timeWindowSec: number;
  densityPercentile: number;
  lowEnergySampleRate: number;
  myUserId: string;
  stopWords: string[];
  fillerRegex: string;
}

// 存储配置
export interface StorageConfig {
  basePath: string;
  tempPath: string;
  outputPath: string;
  cleanup: {
    enabled: boolean;
    intervalHours: number;
    maxAgeDays: number;
  };
}

// 延迟回复配置
export interface DelayedReplyConfig {
  /** 是否启用延迟回复 */
  enabled: boolean;
  /** 延迟时间（分钟） */
  delayMinutes: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟（分钟） */
  retryDelayMinutes: number;
}

// B站配置
export interface BilibiliConfig {
  enabled: boolean;
  cookie?: string;
  csrf?: string;
  polling: {
    interval: number;
    maxRetries: number;
    retryDelay: number;
  };
  anchors: Record<string, {
    uid: string;
    name: string;
    roomId?: string;
    enabled: boolean;
    delayedReplyEnabled?: boolean;
  }>;
  delayedReply: DelayedReplyConfig;
}

// 监控配置
export interface MonitoringConfig {
  enabled: boolean;
  metrics: {
    enabled: boolean;
    port: number;
  };
  health: {
    enabled: boolean;
    endpoint: string;
  };
}

// 应用基础配置
export interface AppConfig {
  app: {
    name: string;
    version: string;
    environment: 'development' | 'staging' | 'production';
    logLevel: 'error' | 'warn' | 'info' | 'debug';
  };
  webhook: WebhookConfig;
  audio: AudioConfig;
  ai: AIConfig;
  fusion: FusionConfig;
  storage: StorageConfig;
  monitoring: MonitoringConfig;
  bilibili: BilibiliConfig;
}

// 配置验证结果
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    type: string;
  }>;
  config: AppConfig | null;
}

// 配置加载选项
export interface ConfigLoaderOptions {
  configPath?: string;
  environment?: string;
  validate?: boolean;
}