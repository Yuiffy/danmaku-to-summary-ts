import { AppConfig, ValidationResult } from './ConfigInterface';

/**
 * 配置验证器
 */
export class ConfigValidator {
  /**
   * 验证配置
   */
  static validate(config: any): ValidationResult {
    const errors: Array<{ path: string; message: string; type: string }> = [];
    
    // 基本验证
    if (!config.app) {
      errors.push({ path: 'app', message: 'App configuration is required', type: 'required' });
    } else {
      if (!config.app.name) errors.push({ path: 'app.name', message: 'App name is required', type: 'required' });
      if (!config.app.version) errors.push({ path: 'app.version', message: 'App version is required', type: 'required' });
      if (!config.app.environment) errors.push({ path: 'app.environment', message: 'App environment is required', type: 'required' });
      if (!config.app.logLevel) errors.push({ path: 'app.logLevel', message: 'App log level is required', type: 'required' });
    }

    if (!config.webhook) {
      errors.push({ path: 'webhook', message: 'Webhook configuration is required', type: 'required' });
    } else {
      if (config.webhook.port === undefined) errors.push({ path: 'webhook.port', message: 'Webhook port is required', type: 'required' });
      if (!config.webhook.host) errors.push({ path: 'webhook.host', message: 'Webhook host is required', type: 'required' });
    }

    if (!config.audio) {
      errors.push({ path: 'audio', message: 'Audio configuration is required', type: 'required' });
    }

    if (!config.ai) {
      errors.push({ path: 'ai', message: 'AI configuration is required', type: 'required' });
    }

    if (!config.fusion) {
      errors.push({ path: 'fusion', message: 'Fusion configuration is required', type: 'required' });
    }

    if (!config.storage) {
      errors.push({ path: 'storage', message: 'Storage configuration is required', type: 'required' });
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        config: null,
      };
    }

    return {
      valid: true,
      errors: [],
      config: config as AppConfig,
    };
  }

  /**
   * 获取默认配置
   */
  static getDefaultConfig(): AppConfig {
    return {
      app: {
        name: 'danmaku-to-summary',
        version: '0.2.0',
        environment: 'development',
        logLevel: 'info',
      },
      webhook: {
        enabled: true,
        port: 15121,
        host: 'localhost',
        endpoints: {
          ddtv: {
            enabled: true,
            endpoint: '/ddtv',
          },
          mikufans: {
            enabled: true,
            endpoint: '/mikufans',
            basePath: 'D:/files/videos/DDTV录播',
          },
        },
        timeouts: {
          fixVideoWait: 30000,
          fileStableCheck: 30000,
          processTimeout: 1800000,
        },
      },
      audio: {
        enabled: true,
        audioOnlyRooms: [],
        formats: ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
        defaultFormat: '.m4a',
        ffmpeg: {
          path: 'ffmpeg',
          timeout: 300000,
        },
        storage: {
          keepOriginalVideo: false,
          maxFileAgeDays: 30,
        },
      },
      ai: {
        text: {
          enabled: true,
          provider: 'gemini',
          gemini: {
            apiKey: '',
            model: 'gemini-3-flash',
            temperature: 0.7,
            maxTokens: 2000,
          },
        },
        comic: {
          enabled: true,
          provider: 'python',
          python: {
            script: 'ai_comic_generator.py',
          },
        },
        defaultNames: {
          anchor: '岁己SUI',
          fan: '饼干岁',
        },
        roomSettings: {},
      },
      fusion: {
        timeWindowSec: 30,
        densityPercentile: 0.35,
        lowEnergySampleRate: 0.1,
        myUserId: '14279',
        stopWords: ['晚上好', '晚安', '来了', '打call', '拜拜', '卡了', '嗯', '好', '草', '哈哈', '确实', '牛', '可爱'],
        fillerRegex: '^(呃|那个|就是|然后|哪怕|其实|我觉得|算是|哎呀|有点|怎么说呢|所以|这种|啊|哦)+',
      },
      storage: {
        basePath: './output',
        tempPath: './temp',
        outputPath: './output',
        cleanup: {
          enabled: true,
          intervalHours: 24,
          maxAgeDays: 7,
        },
      },
      monitoring: {
        enabled: false,
        metrics: {
          enabled: false,
          port: 9090,
        },
        health: {
          enabled: true,
          endpoint: '/health',
        },
      },
    };
  }
}