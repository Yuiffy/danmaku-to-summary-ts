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

    if (!config.bilibili) {
      errors.push({ path: 'bilibili', message: 'Bilibili configuration is required', type: 'required' });
    } else {
      if (config.bilibili.enabled === undefined) errors.push({ path: 'bilibili.enabled', message: 'Bilibili enabled is required', type: 'required' });
      if (!config.bilibili.polling) errors.push({ path: 'bilibili.polling', message: 'Bilibili polling configuration is required', type: 'required' });
      if (!config.bilibili.anchors) errors.push({ path: 'bilibili.anchors', message: 'Bilibili anchors configuration is required', type: 'required' });
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
      asr: {
        default_backend: 'whisper',
        common_hotwords: [],
        corrections: [],
        routing: [],
        whisper: {
          model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
          language: 'zh',
        },
        sensevoice: {
          model: 'iic/SenseVoiceSmall',
          vad_model: 'fsmn-vad',
          punc_model: 'ct-punc',
          spk_model: null,
          language: 'auto',
          device: 'cuda',
          python_executable: null,
          python_args: [],
          python_path_map: [],
          use_itn: true,
          max_vad_segment_s: 8,
          merge_length_s: 8,
          process_timeout_s: 1800,
          enable_speaker: false,
          preset_spk_num: null,
          speaker_merge_threshold: 0.78,
          speaker_references: [],
          speaker_reference_threshold: 0.45,
          speaker_reference_margin: 0.06,
        },
        fun_asr_nano: {
          model: 'FunAudioLLM/Fun-ASR-Nano-2512',
          vad_model: 'fsmn-vad',
          punc_model: null,
          spk_model: null,
          language: '中文',
          device: 'cuda',
          python_executable: null,
          python_args: [],
          python_path_map: [],
          use_itn: true,
          max_vad_segment_s: 8,
          merge_length_s: 8,
          process_timeout_s: 1800,
          enable_speaker: false,
          preset_spk_num: null,
          speaker_merge_threshold: 0.78,
          speaker_references: [],
          speaker_reference_threshold: 0.45,
          speaker_reference_margin: 0.06,
        },
        fun_asr_nano_vllm: {
          model: 'FunAudioLLM/Fun-ASR-Nano-2512',
          vad_model: 'fsmn-vad',
          punc_model: null,
          spk_model: 'cam++',
          language: '中文',
          device: 'cuda',
          python_executable: null,
          python_args: [],
          python_path_map: [],
          use_itn: true,
          process_timeout_s: 3600,
          enable_speaker: true,
          preset_spk_num: null,
          speaker_merge_threshold: 0.78,
          speaker_references: [],
          speaker_reference_threshold: 0.45,
          speaker_reference_margin: 0.06,
          hub: 'ms',
          dtype: 'bf16',
          tensor_parallel_size: 1,
          gpu_memory_utilization: 0.8,
          max_model_len: 4096,
          max_new_tokens: 512,
          batch_size_s: 300,
          enforce_eager: false,
        },
        paraformer: {
          model: 'paraformer-zh',
          vad_model: 'fsmn-vad',
          punc_model: 'ct-punc',
          spk_model: 'cam++',
          language: 'auto',
          device: 'cuda',
          python_executable: null,
          python_args: [],
          python_path_map: [],
          use_itn: true,
          vad_max_single_segment_time_ms: 60000,
          batch_size_s: 300,
          batch_size_threshold_s: 60,
          process_timeout_s: 1800,
          enable_speaker: true,
          preset_spk_num: null,
          speaker_merge_threshold: 0.78,
          speaker_references: [],
          speaker_reference_threshold: 0.45,
          speaker_reference_margin: 0.06,
        },
      },
      subtitle: {
        max_chars_per_line: 18,
        max_chars_per_segment: 30,
        min_duration: 0.7,
        max_duration: 5.5,
        gap_split_threshold: 0.45,
        merge_short_segments: true,
        avoid_overlap: true,
        strip_punctuation: true,
      },
      ai: {
        text: {
          enabled: true,
          provider: 'gemini',
          gemini: {
            apiKey: '',
            model: 'gemini-3-flash-preview',
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
      clipTopics: {
        enabled: false,
        mode: 'local_review',
        keywords: ['岁己', '小岁', '小岁姐', '岁己姐', '饼干岁', 'SUI'],
        ignoredRoomIds: [],
        prePaddingSeconds: 20,
        postPaddingSeconds: 35,
        maxClipSeconds: 180,
        mergeGapSeconds: 45,
        burnSubtitles: true,
        outputDirName: 'topic_clips',
        extraTags: [],
        autoUpload: {
          enabled: false,
        },
        notify: {
          enabled: true,
        },
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
      bilibili: {
        enabled: false,
        cookie: '',
        csrf: '',
        polling: {
          interval: 60000,
          maxRetries: 3,
          retryDelay: 5000,
        },
        anchors: {},
        delayedReply: {
          enabled: false,
          delayMinutes: 10,
          maxRetries: 3,
          retryDelayMinutes: 5,
        },
      },
      wechatWork: {
        webhookUrl: '',
      },
    };
  }
}
