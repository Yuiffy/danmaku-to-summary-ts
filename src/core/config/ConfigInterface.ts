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

export interface AsrRoutingRule {
  match: {
    room_id?: string;
    uid?: string;
    streamer_name?: string;
    channel_id?: string;
  };
  backend: 'whisper' | 'sensevoice';
}

export interface AsrConfig {
  default_backend: 'whisper' | 'sensevoice';
  backend?: 'whisper' | 'sensevoice';
  routing: AsrRoutingRule[];
  whisper: {
    model: string;
    language: string;
  };
  sensevoice: {
    model: string;
    vad_model: string;
    punc_model: string;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
  };
}

export interface SubtitleConfig {
  max_chars_per_line: number;
  max_chars_per_segment: number;
  min_duration: number;
  max_duration: number;
  gap_split_threshold: number;
  merge_short_segments: boolean;
  avoid_overlap: boolean;
  strip_punctuation: boolean;
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
  /** 漫画生成全局默认设置 */
  defaults?: {
    /** 生成图片所需的最短直播时长（分钟），默认60 */
    minDurationMinutes: number;
    /** 生成图片的概率（0.0~1.0），默认1.0 */
    generationProbability: number;
  };
}

// 房间AI配置
export interface RoomAIConfig {
  audioOnly?: boolean;
  referenceImage?: string;
  characterDescription?: string;
  anchorName?: string;
  fanName?: string;
  /** Whisper 排队优先级，数值越大越优先；同优先级按入队先后处理 */
  whisperPriority?: number;
  enableTextGeneration?: boolean;
  enableComicGeneration?: boolean;
  /** 是否启用延迟回复 */
  enableDelayedReply?: boolean;
  /** 生成图片所需的最短直播时长（分钟），不设置则使用全局默认值 */
  minComicDurationMinutes?: number;
  /** 生成图片的概率（0.0~1.0），不设置则使用全局默认值 */
  comicGenerationProbability?: number;
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

// 企业微信配置
export interface WeChatWorkConfig {
  /** 企业微信机器人webhook URL */
  webhookUrl?: string;
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
  asr: AsrConfig;
  subtitle: SubtitleConfig;
  ai: AIConfig;
  fusion: FusionConfig;
  storage: StorageConfig;
  monitoring: MonitoringConfig;
  bilibili: BilibiliConfig;
  wechatWork: WeChatWorkConfig;
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
