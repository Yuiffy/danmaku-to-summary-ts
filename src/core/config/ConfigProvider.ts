import { AppConfig } from './ConfigInterface';
import { ConfigLoader } from './ConfigLoader';

/**
 * 配置提供者
 * 提供全局配置访问
 */
export class ConfigProvider {
  private static config: AppConfig | null = null;
  private static loader: ConfigLoader;

  /**
   * 初始化配置
   */
  static async initialize(options?: any): Promise<AppConfig> {
    if (!this.loader) {
      this.loader = ConfigLoader.getInstance(options);
    }

    if (!this.config) {
      this.config = await this.loader.load(options);
    }

    return this.config;
  }

  /**
   * 获取配置
   */
  static getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Configuration not initialized. Call initialize() first.');
    }
    return this.config;
  }

  /**
   * 重新加载配置
   */
  static async reload(): Promise<AppConfig> {
    if (!this.loader) {
      this.loader = ConfigLoader.getInstance();
    }

    this.config = await this.loader.reload();
    return this.config;
  }

  /**
   * 获取应用配置
   */
  static getAppConfig() {
    return this.getConfig().app;
  }

  /**
   * 获取Webhook配置
   */
  static getWebhookConfig() {
    return this.getConfig().webhook;
  }

  /**
   * 获取音频配置
   */
  static getAudioConfig() {
    return this.getConfig().audio;
  }

  /**
   * 获取AI配置
   */
  static getAIConfig() {
    return this.getConfig().ai;
  }

  /**
   * 获取字幕融合配置
   */
  static getFusionConfig() {
    return this.getConfig().fusion;
  }

  /**
   * 获取存储配置
   */
  static getStorageConfig() {
    return this.getConfig().storage;
  }

  /**
   * 获取监控配置
   */
  static getMonitoringConfig() {
    return this.getConfig().monitoring;
  }

  /**
   * 获取特定房间的AI配置
   */
  static getRoomAIConfig(roomId: string) {
    const aiConfig = this.getAIConfig();
    const roomConfig = aiConfig.roomSettings[roomId] || {};
    
    return {
      audioOnly: roomConfig.audioOnly ?? false,
      referenceImage: roomConfig.referenceImage,
      characterDescription: roomConfig.characterDescription,
      anchorName: roomConfig.anchorName ?? aiConfig.defaultNames.anchor,
      fanName: roomConfig.fanName ?? aiConfig.defaultNames.fan,
      enableTextGeneration: roomConfig.enableTextGeneration ?? aiConfig.text.enabled,
      enableComicGeneration: roomConfig.enableComicGeneration ?? aiConfig.comic.enabled,
    };
  }

  /**
   * 检查是否为音频专用房间
   */
  static isAudioOnlyRoom(roomId: string): boolean {
    // 优先检查房间特定的audioOnly设置
    const roomConfig = this.getRoomAIConfig(roomId);
    if (roomConfig.audioOnly !== undefined) {
      return roomConfig.audioOnly;
    }

    // 回退到全局audioOnlyRooms列表
    const audioConfig = this.getAudioConfig();
    return audioConfig.audioOnlyRooms.includes(Number(roomId));
  }

  /**
   * 获取环境
   */
  static getEnvironment(): string {
    return this.getAppConfig().environment;
  }

  /**
   * 是否为开发环境
   */
  static isDevelopment(): boolean {
    return this.getEnvironment() === 'development';
  }

  /**
   * 是否为生产环境
   */
  static isProduction(): boolean {
    return this.getEnvironment() === 'production';
  }

  /**
   * 获取日志级别
   */
  static getLogLevel(): string {
    return this.getAppConfig().logLevel;
  }

  /**
   * 获取Webhook端口
   */
  static getWebhookPort(): number {
    return this.getWebhookConfig().port;
  }

  /**
   * 获取Webhook主机
   */
  static getWebhookHost(): string {
    return this.getWebhookConfig().host;
  }

  /**
   * 获取存储基础路径
   */
  static getStorageBasePath(): string {
    return this.getStorageConfig().basePath;
  }

  /**
   * 获取临时路径
   */
  static getTempPath(): string {
    return this.getStorageConfig().tempPath;
  }

  /**
   * 获取输出路径
   */
  static getOutputPath(): string {
    return this.getStorageConfig().outputPath;
  }

  /**
   * 获取Gemini API密钥
   */
  static getGeminiApiKey(): string | undefined {
    return this.getAIConfig().text.gemini?.apiKey;
  }

  /**
   * 获取OpenAI API密钥
   */
  static getOpenAIApiKey(): string | undefined {
    return this.getAIConfig().text.openai?.apiKey;
  }

  /**
   * 获取AI文本提供者
   */
  static getTextAIProvider(): string {
    return this.getAIConfig().text.provider;
  }

  /**
   * 获取AI漫画提供者
   */
  static getComicAIProvider(): string {
    return this.getAIConfig().comic.provider;
  }
}