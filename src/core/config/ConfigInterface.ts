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
  streamMerge?: {
    enabled?: boolean;
    maxSegments?: number;
    fillGaps?: boolean;
    backupOriginals?: boolean;
    copyCover?: boolean;
    nearbySegmentRecovery?: boolean;
    nearbySegmentMaxGapSeconds?: number;
  };
  /**
   * Detect a stuck Mikufans recorder state from Bilibili's room status.
   * The monitor only sends an alert and does not change lifecycle state.
   */
  mikufansOfflineFallback?: {
    enabled?: boolean;
    pollIntervalSeconds?: number;
    offlineConfirmations?: number;
    offlineGraceSeconds?: number;
    apiTimeoutMs?: number;
  };
}

// FFmpeg配置
export interface FFmpegConfig {
  path: string;
  timeout: number;
  threads?: number;
  priority?: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | string;
  asrGuard?: {
    enabled?: boolean;
    claimFile?: string;
    staleMs?: number;
    pollMs?: number;
    maxWaitMs?: number;
    overlapThreads?: number;
  };
  resourcePeak?: {
    enabled?: boolean;
    sampleIntervalMs?: number;
  };
}

// 音频存储配置
export interface AudioStorageConfig {
  keepOriginalVideo: boolean;
  retentionEnabled?: boolean;
  convertAfterDays?: number;
  maxProcessAgeDays?: number | null | false;
  includeBak?: boolean;
  scanIntervalHours?: number;
  maxFileAgeDays?: number | null | false;
  archiveEnabled?: boolean;
  moveToArchiveAfterDays?: number | null | false;
  archiveAfterDays?: number | null | false;
  archiveExtraDays?: number | null | false;
  archiveTargetBasePath?: string;
  deleteBakBeforeArchive?: boolean;
  /** Rooms archived without converting their recordings to audio first. */
  additionalArchiveRoomIds?: number[];
  /** Archive every numeric DDTV room directory, independently of audio conversion policy. */
  archiveAllRoomDirectories?: boolean;
  /** Additional archive rooms whose disposable videos are pruned before moving. */
  pruneNonMergedVideosBeforeArchiveRoomIds?: number[];
}

export interface AudioOutputProfileConfig {
  format?: string;
  extension?: string;
  outputSuffix?: string;
  codec?: string;
  audioCodec?: string;
  bitrate?: string;
  ffmpegArgs?: string[];
}

// 音频配置
export interface AudioConfig {
  enabled: boolean;
  audioOnlyRooms: number[];
  formats: string[];
  defaultFormat: string;
  defaultProfile?: string;
  outputProfiles?: Record<string, AudioOutputProfileConfig>;
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
  protect?: boolean;
}

export interface AsrCorrection {
  from: string;
  to: string;
  protect?: boolean;
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
  state?: string;
}

export interface PlannedSpeakerParticipantConfig {
  streamerId: string;
  displayName?: string | null;
  role?: 'host' | 'participant' | string;
  planned?: boolean;
  roomIds?: string[];
  speakerLabels?: string[];
  aliases?: string[];
  mentionLabels?: string[];
}

export interface AsrPythonRuntimeConfig {
  python_executable?: string | null;
  python_args?: string[];
  python_path_map?: Array<{ from: string; to: string }> | Record<string, string>;
  resource_guard?: AsrResourceGuardConfig;
  cpu_throttle?: boolean | AsrCpuThrottleConfig;
  resource_peak_monitor?: AsrResourcePeakMonitorConfig;
}

export interface AsrCpuThrottleConfig {
  enabled?: boolean;
  busy_percent_threshold?: number;
  resume_percent_threshold?: number;
  sample_interval_s?: number;
  check_interval_s?: number;
  wait_s?: number;
  max_wait_s?: number;
  consecutive_busy_samples?: number;
  consecutive_idle_samples?: number;
  torch_num_threads?: number;
  torch_num_interop_threads?: number;
}

export interface AsrResourceGuardConfig {
  enabled?: boolean;
  game_process_names?: string[] | string;
  process_names?: string[] | string;
  pause_when_game_running?: boolean;
  poll_interval_s?: number;
  wait_s?: number;
  max_wait_s?: number;
  priority?: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | string;
  eco_qos?: boolean;
  prefer_e_cores?: boolean;
  e_core_efficiency_class?: number | null;
  torch_num_threads?: number;
  torch_num_interop_threads?: number;
  claim_enabled?: boolean;
  claim_file?: string;
  claim_heartbeat_s?: number;
  soft_gpu?: AsrGpuSoftPressureConfig;
  low_impact?: AsrGpuLowImpactConfig;
}

export interface AsrGpuSoftPressureConfig {
  enabled?: boolean;
  sm_threshold?: number;
  mem_threshold?: number;
  fb_threshold_mb?: number;
  total_memory_threshold_pct?: number;
  include_total_utilization?: boolean;
}

export interface AsrGpuLowImpactConfig {
  batch_size_s?: number;
  speaker_batch_size?: number;
  emotion_batch_size_s?: number;
  yield_s?: number;
  model_load_max_wait_s?: number;
  model_load_poll_s?: number;
}

export interface AsrResourcePeakMonitorConfig {
  enabled?: boolean;
  sample_interval_s?: number;
}

export interface AsrGpuThrottleConfig {
  enabled?: boolean;
  busy_sm_threshold?: number;
  busy_mem_threshold?: number;
  busy_fb_threshold_mb?: number;
  check_interval_s?: number;
  wait_s?: number;
  max_wait_s?: number;
  pmon_sample_count?: number;
  segment_paraformer?: boolean;
  hard_wait?: boolean;
  soft_gpu?: AsrGpuSoftPressureConfig;
  low_impact?: AsrGpuLowImpactConfig;
}

export interface AsrEmotionAnalysisConfig {
  enabled?: boolean;
  room_ids?: Array<string | number>;
  model?: string;
  device?: 'cuda' | 'cpu' | string;
  language?: string;
  chunk_s?: number;
  max_gap_s?: number;
  batch_size_s?: number;
  max_batch_chunks?: number;
  inference_batch_size?: number;
  precision?: 'bf16' | 'fp32' | string;
  tf32?: boolean;
  include_events?: boolean;
  fail_open?: boolean;
  model_load_timeout_s?: number;
  batch_timeout_s?: number;
}

export interface AsrAdaptiveSpeakerConfig {
  speaker_detection_mode?: 'auto' | 'always';
  speaker_min_segment_s?: number;
  speaker_max_segment_s?: number;
  speaker_probe_max_chunks?: number;
  speaker_probe_max_assignment_clusters?: number;
  speaker_probe_min_valid_chunks?: number;
  speaker_probe_min_speech_s?: number;
  speaker_probe_min_cluster_chunks?: number;
  speaker_probe_min_cluster_s?: number;
  speaker_probe_min_cohesion?: number;
  speaker_probe_separation_margin?: number;
  speaker_probe_fail_open?: boolean;
  speaker_full_refine_enabled?: boolean;
  speaker_full_refine_iterations?: number;
  speaker_reference_max_sample_chunks?: number;
  speaker_reference_min_support_chunks?: number;
  speaker_reference_min_support_ratio?: number;
  speaker_reference_prototype_merge_threshold?: number;
  speaker_reference_max_prototypes?: number;
  speaker_reference_prototype_min_support_chunks?: number;
  speaker_row_reference_threshold?: number;
  speaker_row_reference_margin?: number;
  speaker_row_reference_top_k?: number;
  speaker_reference_consensus_enabled?: boolean;
  speaker_reference_consensus_min_score?: number;
  speaker_reference_consensus_min_margin?: number;
  speaker_reference_consensus_min_support_chunks?: number;
  speaker_reference_consensus_min_support_ratio?: number;
  speaker_reference_consensus_min_support_mean_score?: number;
  speaker_reference_consensus_min_cluster_similarity?: number;
  speaker_reference_consensus_min_anchor_similarity?: number;
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
  sensevoice: AsrPythonRuntimeConfig & AsrAdaptiveSpeakerConfig & {
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
    gpu_throttle?: boolean | AsrGpuThrottleConfig;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
    speaker_reference_margin?: number;
    speaker_embedding_batch_size?: number;
  };
  fun_asr_nano: AsrPythonRuntimeConfig & AsrAdaptiveSpeakerConfig & {
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
    gpu_throttle?: boolean | AsrGpuThrottleConfig;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
    speaker_reference_margin?: number;
    speaker_embedding_batch_size?: number;
  };
  fun_asr_nano_vllm: AsrPythonRuntimeConfig & AsrAdaptiveSpeakerConfig & {
    model: string;
    vad_model: string;
    punc_model?: string | null;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    process_timeout_s?: number;
    gpu_throttle?: boolean | AsrGpuThrottleConfig;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
    speaker_reference_margin?: number;
    speaker_embedding_batch_size?: number;
    hub?: 'ms' | 'hf' | 'modelscope' | 'huggingface' | string;
    dtype?: 'bf16' | 'fp16' | 'fp32' | string;
    tensor_parallel_size?: number;
    gpu_memory_utilization?: number;
    max_model_len?: number;
    max_new_tokens?: number;
    batch_size_s?: number;
    enforce_eager?: boolean;
  };
  paraformer: AsrPythonRuntimeConfig & AsrAdaptiveSpeakerConfig & {
    model: string;
    vad_model: string;
    punc_model: string;
    spk_model?: string | null;
    language: string;
    device: 'cuda' | 'cpu' | string;
    vad_device?: 'cuda' | 'cpu' | string;
    use_itn: boolean;
    vad_max_single_segment_time_ms?: number;
    batch_size_s?: number;
    batch_size_threshold_s?: number;
    process_timeout_s?: number;
    emotion_analysis?: AsrEmotionAnalysisConfig;
    persistent_worker?: {
      enabled?: boolean;
      startup_timeout_s?: number;
    };
    gpu_throttle?: boolean | AsrGpuThrottleConfig;
    enable_speaker: boolean;
    preset_spk_num?: number | null;
    speaker_merge_threshold?: number;
    speaker_references?: AsrSpeakerReferenceConfig[];
    speaker_reference_threshold?: number;
    speaker_reference_margin?: number;
    speaker_embedding_batch_size?: number;
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
  textModel?: string;
  fallbackModels?: string[];
  includeBuiltInFallbackModels?: boolean;
  apiMode?: 'chatCompletions' | 'responses';
  transientMaxAttempts?: number;
  transientRetryDelayMs?: number;
  temperature?: number;
  maxTokens?: number;
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
export interface AIProviderConfig {
  type: 'openai' | 'openai-compatible' | string;
  displayName?: string;
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  proxy?: string;
  options?: Record<string, any>;
}

export interface ImageGenerationRouteConfig {
  enabled?: boolean;
  provider: string;
  model: string;
  flow?: 'openaiImages' | 'tuZiCompatible' | 'tuziCompatible' | 'tuzi' | string;
  maxAttempts?: number;
  timeoutMs?: number;
  timeoutSec?: number;
  size?: string;
  quality?: string;
  outputFormat?: string;
  responseFormat?: string;
  useTuziRetry?: boolean;
}

export interface ImageGenerationConfig {
  enabled: boolean;
  routes: ImageGenerationRouteConfig[];
}
export interface TextAIConfig {
  enabled: boolean;
  provider: 'gemini' | 'openai' | 'claude' | 'daiYu' | 'tuZi';
  /** Reuse one exact live-facts prefix across goodnight and comic-script requests. */
  sharedPromptCache?: {
    enabled?: boolean;
    explicitRolloutPercent?: number;
    ttl?: '30m';
  };
  gemini?: GeminiConfig;
  tuZi?: TuZiConfig;
  daiYu?: TuZiConfig & {
    apiMode?: 'chatCompletions' | 'responses';
    fallbackProvider?: 'tuZi';
    fallbackProviderModel?: string;
    fallbackProviderApiMode?: 'chatCompletions' | 'responses';
    thinking?: {
      enabled?: boolean;
      budgetTokens?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    };
  };
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

export interface ComicStorytellingExperimentConfig {
  enabled: boolean;
  immersivePercent: number;
  salt?: string;
  directedScreenshots?: {
    enabled?: boolean;
    maxImages?: number;
    maxRequests?: number;
    maxFramesPerRequest?: number;
    maxTotalReferenceImages?: number;
    coverageSheetsEnabled?: boolean;
    coverageSheetMaxCandidates?: number;
    coverageSheetWidth?: number;
    maxWidth?: number;
    jpegQuality?: number;
  };
}

export interface FullLiveContextExperimentConfig {
  enabled: boolean;
  tasks: Array<'summary' | 'goodnight' | 'comic' | 'ownStreamClips'>;
  summaryDeliveryMode: 'separate' | 'attach_if_ready';
  /** Per-request explicit prompt-cache rollout for this room experiment. */
  promptCacheRolloutPercent?: number;
  /** Maximum time to delay cache-dependent work while the summary seeds the prefix. */
  cacheWarmupWaitMs?: number;
  /** Delay after goodnight completes so its shared prefix cache can propagate before summary/comic requests start. */
  cachePropagationWaitMs?: number;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Reuse an identical failed summary for this long before retrying the model. */
  failureRetryCooldownMs?: number;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
}

// 漫画AI配置
export interface ComicAIConfig {
  enabled: boolean;
  provider: 'python' | 'huggingface' | 'local';
  outputLockEnabled?: boolean;
  storytellingExperiment?: ComicStorytellingExperimentConfig;
  python?: {
    script: string;
  };
  googleImage?: GoogleImageConfig;
  tuZi?: TuZiConfig;
  imageGeneration?: ImageGenerationConfig;
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
  /** 可用于称呼主播的昵称/正式名 */
  anchorNicknames?: string[];
  fanName?: string;
  /** 主播 B站 UID (mid)，配置后延迟回复不需调 API 查询 */
  uid?: string;
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
  storytellingExperiment?: Partial<ComicStorytellingExperimentConfig>;
  fullLiveContextExperiment?: FullLiveContextExperimentConfig;
}

// AI配置
export interface AIConfig {
  providers?: Record<string, AIProviderConfig>;
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
  aiModel?: string;
  ignoredRoomIds?: string[];
  prePaddingSeconds: number;
  postPaddingSeconds: number;
  contextPrePaddingSeconds?: number;
  contextPostPaddingSeconds?: number;
  maxSegmentsPerBurst?: number;
  minClipSeconds?: number;
  boundaryEndExtensionSeconds?: number;
  boundarySilenceGapSeconds?: number;
  maxClipSeconds: number;
  mergeGapSeconds: number;
  burnSubtitles: boolean;
  ffmpegTimeoutMs?: number;
  outputDirName: string;
  archiveSourceRoot?: string;
  activeOutputRoot?: string;
  backgroundQueue?: {
    enabled?: boolean;
    directory?: string;
    pollMs?: number;
    idleGraceMs?: number;
    staleLockMs?: number;
  };
  tags?: string[];
  extraTags: string[];
  autoUpload: {
    enabled: boolean;
  };
  notify: {
    enabled: boolean;
    includeSubtitleContext?: boolean;
    subtitleContextLines?: number;
    includeDanmakuContext?: boolean;
    maxDanmakuLines?: number;
    danmakuContextSeconds?: number;
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
  maxTaskAgeHours?: number;
  /** 将每条晚安回复集中发布到一个固定动态，便于统一查看 */
  summaryDynamic?: {
    enabled: boolean;
    dynamicId: string;
  };
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
  upload?: {
    /** 创作中心合集分区 ID（用于投稿后加入合集）。 */
    collectionSectionId?: number | null;
    /** @deprecated Use collectionSectionId. */
    collectionSeriesId?: number | null;
    /** 按主播来源选择合集；seasonId 是 B 站页面展示的合集 ID，sectionId 用于投稿接口。 */
    collectionRouting?: {
      sui?: {
        seasonId?: number | null;
        sectionId?: number | null;
        roomIds?: Array<string | number>;
        markers?: string[];
      };
      other?: {
        seasonId?: number | null;
        sectionId?: number | null;
      };
      default?: {
        seasonId?: number | null;
        sectionId?: number | null;
      };
    };
  };
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

export interface RecorderStallDiagnosticsConfig {
  /** 是否在 SessionStarted 后自动诊断迟迟没有 FileOpening 的录制会话。 */
  enabled?: boolean;
  /** 等待 FileOpening 的秒数，默认 480。 */
  delaySeconds?: number;
  /** 相对 storage.tempPath 的诊断输出目录，也可以填写绝对路径。 */
  outputDirectory?: string;
  /** 是否在诊断触发时自动采集 BililiveRecorder 进程完整 dump，默认开启。 */
  includeProcessDump?: boolean;
  /** 采集 dotnet-dump 后是否自动导出 clrstack/clrthreads，默认开启。 */
  analyzeDump?: boolean;
  /** auto、dotnet-dump 或 procdump。 */
  dumpTool?: string;
  /** 可选的 dump 工具绝对路径。 */
  dumpToolPath?: string;
  /** dump 工具最长运行秒数。 */
  dumpTimeoutSeconds?: number;
  /** BililiveRecorder 日志目录；为空时自动搜索。 */
  logDirectory?: string;
  /** 每个日志文件最多读取的尾部字节数。 */
  maxLogBytes?: number;
  /** 录播目录最多记录多少个匹配文件。 */
  maxFileEntries?: number;
}

// 监控配置
export interface MonitoringConfig {
  enabled: boolean;
  recorderStallDiagnostics?: RecorderStallDiagnosticsConfig;
  processingAlerts?: {
    enabled: boolean;
    cpuHighPercent: number;
    mergeSlowSeconds: number;
    screenshotSlowSeconds: number;
    asrSlowSeconds: number;
    /** StreamStarted 后多久仍未见 SessionStarted/FileOpening 时告警。 */
    streamStartNoFileOpeningSeconds: number;
    /** StreamEnded 后等待迟到 FileClosed/片段事件的告警宽限。 */
    streamEndNoSegmentGraceSeconds: number;
    /** 正常收尾等待结束后，再给 watchdog 的额外宽限。 */
    finalizationWatchdogGraceSeconds: number;
    cooldownMs: number;
  };
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
