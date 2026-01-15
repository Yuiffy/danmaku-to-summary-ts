# 统一配置管理系统设计

## 当前配置分析

### 现有配置文件结构

#### 1. `config.json` (主配置)
```json
{
  "audioRecording": {...},
  "audioProcessing": {...},
  "aiServices": {...},
  "roomSettings": {...},
  "timeouts": {...},
  "recorders": {...}
}
```

#### 2. `config.secrets.json` (密钥配置)
```json
{
  "aiServices": {
    "gemini": {
      "apiKey": "实际密钥"
    }
  }
}
```

#### 3. 环境变量
- `ROOM_ID` - 房间ID
- `NODE_ENV` - 环境变量
- 其他临时环境变量

### 当前问题
1. **配置分散**：配置逻辑分散在多个文件中
2. **缺乏验证**：没有配置验证机制
3. **类型不安全**：JavaScript对象，没有类型检查
4. **热重载不支持**：配置更改需要重启应用
5. **环境管理混乱**：没有清晰的环境配置分离

## 新配置系统设计

### 1. 配置分层结构

```
config/
├── schemas/              # 配置模式定义
│   ├── base.schema.ts   # 基础配置模式
│   ├── webhook.schema.ts
│   ├── audio.schema.ts
│   ├── ai.schema.ts
│   └── fusion.schema.ts
├── defaults/            # 默认配置
│   ├── default.json
│   ├── development.json
│   └── production.json
├── environments/        # 环境配置
│   ├── development.json
│   ├── staging.json
│   └── production.json
└── secrets/            # 密钥配置（git忽略）
    ├── .gitignore
    └── local.json
```

### 2. 配置加载策略

```typescript
// 配置加载优先级（从高到低）
1. 命令行参数
2. 环境变量
3. 环境特定配置文件 (config/environments/{NODE_ENV}.json)
4. 用户配置文件 (config/local.json)
5. 默认配置文件 (config/defaults/default.json)
6. 内置默认值
```

### 3. 配置接口定义

```typescript
// src/core/config/ConfigInterface.ts
export interface AppConfig {
  // 应用基础配置
  app: {
    name: string;
    version: string;
    environment: 'development' | 'staging' | 'production';
    logLevel: 'error' | 'warn' | 'info' | 'debug';
  };

  // Webhook配置
  webhook: {
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
  };

  // 音频处理配置
  audio: {
    enabled: boolean;
    audioOnlyRooms: number[];
    formats: string[];
    defaultFormat: string;
    ffmpeg: {
      path: string;
      timeout: number;
    };
    storage: {
      keepOriginalVideo: boolean;
      maxFileAgeDays: number;
    };
  };

  // AI服务配置
  ai: {
    text: {
      enabled: boolean;
      provider: 'gemini' | 'openai' | 'claude';
      gemini?: GeminiConfig;
      openai?: OpenAIConfig;
      claude?: ClaudeConfig;
    };
    comic: {
      enabled: boolean;
      provider: 'huggingface' | 'local';
      huggingface?: HuggingFaceConfig;
      local?: LocalAIConfig;
    };
    defaultNames: {
      anchor: string;
      fan: string;
    };
    roomSettings: Record<string, RoomAIConfig>;
  };

  // 字幕融合配置
  fusion: {
    timeWindowSec: number;
    densityPercentile: number;
    lowEnergySampleRate: number;
    myUserId: string;
    stopWords: string[];
    fillerRegex: string;
  };

  // 存储配置
  storage: {
    basePath: string;
    tempPath: string;
    outputPath: string;
    cleanup: {
      enabled: boolean;
      intervalHours: number;
      maxAgeDays: number;
    };
  };

  // 监控配置
  monitoring: {
    enabled: boolean;
    metrics: {
      enabled: boolean;
      port: number;
    };
    health: {
      enabled: boolean;
      endpoint: string;
    };
  };
}

// 子配置接口
export interface WebhookEndpointConfig {
  enabled: boolean;
  endpoint: string;
  basePath?: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  proxy?: string;
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
```

### 4. 配置验证系统

```typescript
// src/core/config/ConfigValidator.ts
import Joi from 'joi';

export class ConfigValidator {
  private static readonly schema = Joi.object({
    app: Joi.object({
      name: Joi.string().required(),
      version: Joi.string().required(),
      environment: Joi.string().valid('development', 'staging', 'production').required(),
      logLevel: Joi.string().valid('error', 'warn', 'info', 'debug').required(),
    }).required(),

    webhook: Joi.object({
      enabled: Joi.boolean().required(),
      port: Joi.number().port().required(),
      host: Joi.string().hostname().required(),
      endpoints: Joi.object({
        ddtv: Joi.object({
          enabled: Joi.boolean().required(),
          endpoint: Joi.string().required(),
        }).required(),
        mikufans: Joi.object({
          enabled: Joi.boolean().required(),
          endpoint: Joi.string().required(),
          basePath: Joi.string().required(),
        }).required(),
      }).required(),
      timeouts: Joi.object({
        fixVideoWait: Joi.number().min(1000).required(),
        fileStableCheck: Joi.number().min(1000).required(),
        processTimeout: Joi.number().min(30000).required(),
      }).required(),
    }).required(),

    // ... 其他配置验证规则
  });

  static validate(config: any): ValidationResult {
    const { error, value } = this.schema.validate(config, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return {
        valid: false,
        errors: error.details.map(detail => ({
          path: detail.path.join('.'),
          message: detail.message,
          type: detail.type,
        })),
        config: null,
      };
    }

    return {
      valid: true,
      errors: [],
      config: value as AppConfig,
    };
  }
}
```

### 5. 配置加载器实现

```typescript
// src/core/config/ConfigLoader.ts
export class ConfigLoader {
  private config: AppConfig | null = null;
  private watchers: Set<ConfigWatcher> = new Set();
  private lastModified: Map<string, number> = new Map();

  constructor(private options: ConfigLoaderOptions = {}) {}

  async load(): Promise<AppConfig> {
    // 1. 加载内置默认值
    let config = this.getDefaultConfig();

    // 2. 合并默认配置文件
    config = this.mergeConfig(config, await this.loadFile('config/defaults/default.json'));

    // 3. 合并用户配置文件
    const userConfigPath = this.options.configPath || 'config/local.json';
    config = this.mergeConfig(config, await this.loadFile(userConfigPath));

    // 4. 合并环境配置文件
    const env = process.env.NODE_ENV || 'development';
    config = this.mergeConfig(config, await this.loadFile(`config/environments/${env}.json`));

    // 5. 合并环境变量
    config = this.mergeConfig(config, this.loadFromEnv());

    // 6. 合并命令行参数
    config = this.mergeConfig(config, this.loadFromArgs());

    // 7. 验证配置
    const validation = ConfigValidator.validate(config);
    if (!validation.valid) {
      throw new ConfigValidationError('配置验证失败', validation.errors);
    }

    this.config = validation.config!;
    return this.config;
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('配置未加载，请先调用load()方法');
    }
    return this.config;
  }

  watch(callback: ConfigWatcher): void {
    this.watchers.add(callback);
  }

  unwatch(callback: ConfigWatcher): void {
    this.watchers.delete(callback);
  }

  private async loadFile(path: string): Promise<Partial<AppConfig> | null> {
    try {
      if (await fs.pathExists(path)) {
        const content = await fs.readFile(path, 'utf-8');
        const stats = await fs.stat(path);
        this.lastModified.set(path, stats.mtimeMs);
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn(`无法加载配置文件 ${path}:`, error.message);
    }
    return null;
  }

  private loadFromEnv(): Partial<AppConfig> {
    const config: Partial<AppConfig> = {};

    // 从环境变量映射到配置
    if (process.env.WEBHOOK_PORT) {
      config.webhook = config.webhook || {};
      config.webhook.port = parseInt(process.env.WEBHOOK_PORT, 10);
    }

    if (process.env.GEMINI_API_KEY) {
      config.ai = config.ai || {};
      config.ai.text = config.ai.text || {};
      config.ai.text.gemini = config.ai.text.gemini || {};
      config.ai.text.gemini.apiKey = process.env.GEMINI_API_KEY;
    }

    // ... 其他环境变量映射

    return config;
  }

  private getDefaultConfig(): AppConfig {
    return {
      app: {
        name: 'danmaku-to-summary',
        version: '1.0.0',
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
      // ... 其他默认配置
    };
  }
}
```

### 6. 配置提供者模式

```typescript
// src/core/config/ConfigProvider.ts
export class ConfigProvider {
  private static instance: ConfigProvider;
  private configLoader: ConfigLoader;
  private config: AppConfig | null = null;

  private constructor() {
    this.configLoader = new ConfigLoader();
  }

  static getInstance(): ConfigProvider {
    if (!ConfigProvider.instance) {
      ConfigProvider.instance = new ConfigProvider();
    }
    return ConfigProvider.instance;
  }

  async initialize(): Promise<void> {
    this.config = await this.configLoader.load();
    
    // 监听配置变化
    if (process.env.NODE_ENV === 'development') {
      this.setupFileWatcher();
    }
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('配置未初始化，请先调用initialize()');
    }
    return this.config;
  }

  getWebhookConfig(): WebhookConfig {
    return this.getConfig().webhook;
  }

  getAudioConfig(): AudioConfig {
    return this.getConfig().audio;
  }

  getAIConfig(): AIConfig {
    return this.getConfig().ai;
  }

  getRoomConfig(roomId: string): RoomAIConfig | null {
    const config = this.getConfig();
    return config.ai.roomSettings[roomId] || null;
  }

  private setupFileWatcher(): void {
    const configFiles = [
      'config/local.json',
      `config/environments/${process.env.NODE_ENV || 'development'}.json`,
    ];

    configFiles.forEach(file => {
      fs.watch(file, async (eventType) => {
        if (eventType === 'change') {
          console.log(`配置文件 ${file} 已更改，重新加载配置...`);
          try {
            this.config = await this.configLoader.load();
            this.notifyConfigChange();
          } catch (error) {
            console.error('重新加载配置失败:', error);
          }
        }
      });
    });
  }

  private notifyConfigChange(): void {
    // 通知所有监听器配置已更改
    // 实现事件总线或观察者模式
  }
}
```

### 7. 环境变量映射表

```typescript
// 环境变量到配置的映射
export const ENV_VAR_MAPPINGS = {
  // 应用配置
  'NODE_ENV': 'app.environment',
  'LOG_LEVEL': 'app.logLevel',

  // Webhook配置
  'WEBHOOK_PORT': 'webhook.port',
  'WEBHOOK_HOST': 'webhook.host',

  // AI配置
  'GEMINI_API_KEY': 'ai.text.gemini.apiKey',
  'GEMINI_MODEL': 'ai.text.gemini.model',
  'GEMINI_TEMPERATURE': 'ai.text.gemini.temperature',

  // 音频配置
  'FFMPEG_PATH': 'audio.ffmpeg.path',
  'AUDIO_ONLY_ROOMS': 'audio.audioOnlyRooms',

  // 存储配置
  'STORAGE_BASE_PATH': 'storage.basePath',
  'STORAGE_TEMP_PATH': 'storage.tempPath',
};
```

### 8. 迁移现有配置

#### 迁移脚本设计

```typescript
// scripts/migrate-config.js
const fs = require('fs');
const path = require('path');

function migrateOldConfig(oldConfigPath) {
  const oldConfig = JSON.parse(fs.readFileSync(oldConfigPath, 'utf-8'));
  
  const newConfig = {
    app: {
      name: 'danmaku-to-summary',
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      logLevel: 'info',
    },
    webhook: {
      enabled: true,
      port: 15121,
      host: 'localhost',
      endpoints: {
        ddtv: {
          enabled: oldConfig.recorders?.ddtv?.enabled ?? true,
          endpoint: oldConfig.recorders?.ddtv?.endpoint || '/ddtv',
        },
        mikufans: {
          enabled: oldConfig.recorders?.mikufans?.enabled ?? true,
          endpoint: oldConfig.recorders?.mikufans?.endpoint || '/mikufans',
          basePath: oldConfig.recorders?.mikufans?.basePath || 'D:/files/videos/DDTV录播',
        },
      },
      timeouts: {
        fixVideoWait: oldConfig.timeouts?.fixVideoWait || 30000,
        fileStableCheck: oldConfig.timeouts?.fileStableCheck || 30000,
        processTimeout: oldConfig.timeouts?.processTimeout || 1800000,
      },
    },
    audio: {
      enabled: oldConfig.audioProcessing?.enabled ?? true,
      audioOnlyRooms: oldConfig.audioProcessing?.audioOnlyRooms || [],
      formats: oldConfig.audioRecording?.audioFormats || ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
      defaultFormat: oldConfig.audioRecording?.defaultFormat || '.m4a',
      ffmpeg: {
        path: oldConfig.audioProcessing?.ffmpegPath || 'ffmpeg',
        timeout: oldConfig.timeouts?.ffmpegTimeout || 300000,
      },
      storage: {
        keepOriginalVideo: oldConfig.audioProcessing?.keepOriginalVideo ?? false,
        maxFileAgeDays: 30,
      },
    },
    ai: {
      text: {
        enabled: oldConfig.aiServices?.gemini?.enabled ?? true,
        provider: 'gemini',
        gemini: {
          apiKey: '', // 从secrets文件迁移
          model: oldConfig.aiServices?.gemini?.model || 'gemini-1.5-flash',
          temperature: oldConfig.aiServices?.gemini?.temperature || 0.7,
          maxTokens: oldConfig.aiServices?.gemini?.maxTokens || 2000,
          proxy: oldConfig.aiServices?.gemini?.proxy,
        },
      },
      comic: {
        enabled: true,
        provider: 'local', // 默认使用本地Python脚本
      },
      defaultNames: {
        anchor: oldConfig.aiServices?.defaultAnchorName || '岁己SUI',
        fan: oldConfig.aiServices?.defaultFanName || '饼干岁',
      },
      roomSettings: {},
    },
    // ... 其他配置迁移
  };

  // 迁移房间设置
  if (oldConfig.roomSettings) {
    Object.entries(oldConfig.roomSettings).forEach(([roomId, roomConfig]) => {
      newConfig.ai.roomSettings[roomId] = {
        audioOnly: roomConfig.audioOnly,
        referenceImage: roomConfig.referenceImage,
        characterDescription: roomConfig.characterDescription,
        anchorName: roomConfig.anchorName,
        fanName: roomConfig.fanName,
        enableTextGeneration: roomConfig.enableTextGeneration,
        enableComicGeneration: roomConfig.enableComicGeneration,
      };
    });
  }

  return newConfig