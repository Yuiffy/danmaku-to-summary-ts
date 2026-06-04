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
  backend: AsrBackendName;
  hotwords?: AsrHotword[];
  corrections?: AsrCorrectionsConfig;
}

export type AsrBackendName =
  | 'whisper'
  | 'sensevoice'
  | 'fun_asr_nano'
  | 'fun-asr-nano'
  | 'fun_asr_nano_vllm'
  | 'fun-asr-nano-vllm'
  | 'paraformer';

export interface AsrHotword {
  word: string;
  weight?: number;
  aliases?: string[];
  aliases_as_hotwords?: boolean;
  alias_hotwords?: boolean;
  hotword_terms?: string[];
  correction_to?: string;
  contextual_aliases?: string[];
  require_nearby?: string[];
}

export interface AsrCorrection {
  from: string;
  to: string;
}

export interface AsrContextualCorrection extends AsrCorrection {
  require_nearby: string[];
}

export type AsrCorrectionsConfig =
  | AsrCorrection[]
  | Record<string, string>
  | {
      safe?: AsrCorrection[] | Record<string, string>;
      contextual?: AsrContextualCorrection[];
    };

export interface AsrSpeakerReferenceConfig {
  speaker: string;
  audio_path: string;
  start_s?: number;
  end_s?: number;
  chunk_s?: number;
  max_chunks?: number;
}

export interface AsrPythonRuntimeConfig {
  python_executable?: string | null;
  python_args?: string[];
  python_path_map?: Array<{ from: string; to: string }> | Record<string, string>;
}

export interface AsrConfig {
  default_backend: AsrBackendName;
  backend?: AsrBackendName;
  common_hotwords?: AsrHotword[];
  corrections?: AsrCorrectionsConfig;
  routing: AsrRoutingRule[];
  whisper: {
    model: string;
    language: string;
  };
  sensevoice: AsrPythonRuntimeConfig & {
    model: string;
    vad_model: string;
    punc_model: string;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    max_vad_segment_s?: number;
    merge_length_s?: number;
    process_timeout_s?: number;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
  };
  fun_asr_nano: AsrPythonRuntimeConfig & {
    model: string;
    vad_model: string;
    punc_model?: string | null;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    max_vad_segment_s?: number;
    merge_length_s?: number;
    process_timeout_s?: number;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
  };
  fun_asr_nano_vllm: AsrPythonRuntimeConfig & {
    model: string;
    vad_model: string;
    punc_model?: string | null;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    process_timeout_s?: number;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
    hub?: 'ms' | 'hf' | 'modelscope' | 'huggingface' | string;
    dtype?: 'bf16' | 'fp16' | 'fp32' | string;
    tensor_parallel_size?: number;
    gpu_memory_utilization?: number;
    max_model_len?: number;
    max_new_tokens?: number;
    batch_size_s?: number;
    enforce_eager?: boolean;
  };
  paraformer: AsrPythonRuntimeConfig & {
    model: string;
    vad_model: string;
    punc_model: string;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    vad_max_single_segment_time_ms?: number;
    batch_size_s?: number;
    batch_size_threshold_s?: number;
    process_timeout_s?: number;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
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

export interface ClipTopicsConfig {
  enabled: boolean;
  mode: 'local_review' | string;
  keywords: string[];
  ignoredRoomIds?: string[];
  prePaddingSeconds: number;
  postPaddingSeconds: number;
  maxClipSeconds: number;
  mergeGapSeconds: number;
  burnSubtitles: boolean;
  outputDirName: string;
  tags?: string[];
  extraTags: string[];
  autoUpload: {
    enabled: boolean;
  };
  notify: {
    enabled: boolean;
  };
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

// 弹幕风控监控配置
export interface DanmuRiskControlConfig {
  /** 是否启用弹幕风控监控 */
  enabled: boolean;
  /** 检查间隔（毫秒），默认 300000 (5分钟) */
  intervalMs: number;
  /** 要监控的房间ID列表 */
  roomIds: string[];
  /** 通知冷却时间（毫秒），同一房间在此时间内不重复通知，默认 1800000 (30分钟) */
  notifyCooldownMs: number;
}

// B站配置
export interface BilibiliConfig {
  enabled: boolean;
  cookie?: string;
  csrf?: string;
  ac_time_value?: string;
  acTimeValue?: string;
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
  danmuRiskControl?: DanmuRiskControlConfig;
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
  clipTopics: ClipTopicsConfig;
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
