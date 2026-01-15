/**
 * 应用配置接口定义
 */
export interface WebhookEndpointConfig {
    enabled: boolean;
    endpoint: string;
    basePath?: string;
}
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
export interface FFmpegConfig {
    path: string;
    timeout: number;
}
export interface AudioStorageConfig {
    keepOriginalVideo: boolean;
    maxFileAgeDays: number;
}
export interface AudioConfig {
    enabled: boolean;
    audioOnlyRooms: number[];
    formats: string[];
    defaultFormat: string;
    ffmpeg: FFmpegConfig;
    storage: AudioStorageConfig;
}
export interface GeminiConfig {
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    proxy?: string;
}
export interface OpenAIConfig {
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    proxy?: string;
}
export interface TextAIConfig {
    enabled: boolean;
    provider: 'gemini' | 'openai' | 'claude';
    gemini?: GeminiConfig;
    openai?: OpenAIConfig;
    claude?: any;
}
export interface ComicAIConfig {
    enabled: boolean;
    provider: 'python' | 'huggingface' | 'local';
    python?: {
        script: string;
    };
    huggingface?: {
        apiToken: string;
        model: string;
    };
    local?: {
        modelPath: string;
    };
}
export interface RoomAIConfig {
    audioOnly?: boolean;
    referenceImage?: string;
    characterDescription?: string;
    anchorName?: string;
    fanName?: string;
    enableTextGeneration?: boolean;
    enableComicGeneration?: boolean;
}
export interface AIConfig {
    text: TextAIConfig;
    comic: ComicAIConfig;
    defaultNames: {
        anchor: string;
        fan: string;
    };
    roomSettings: Record<string, RoomAIConfig>;
}
export interface FusionConfig {
    timeWindowSec: number;
    densityPercentile: number;
    lowEnergySampleRate: number;
    myUserId: string;
    stopWords: string[];
    fillerRegex: string;
}
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
}
export interface ValidationResult {
    valid: boolean;
    errors: Array<{
        path: string;
        message: string;
        type: string;
    }>;
    config: AppConfig | null;
}
export interface ConfigLoaderOptions {
    configPath?: string;
    environment?: string;
    validate?: boolean;
}
