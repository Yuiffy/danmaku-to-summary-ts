# 依赖注入和接口抽象设计

## 设计目标

### 1. 解耦模块依赖
- 模块间通过接口通信，而不是具体实现
- 依赖关系由容器管理，而不是硬编码
- 便于单元测试和模块替换

### 2. 提高可测试性
- 通过依赖注入可以轻松模拟依赖
- 接口抽象使得测试更加简单
- 支持不同的测试场景

### 3. 增强可扩展性
- 新功能可以通过实现接口添加
- 现有功能可以通过装饰器增强
- 支持插件式架构

## 核心组件设计

### 1. 接口定义层

#### 服务接口
```typescript
// src/core/interfaces/services.ts

// 音频处理服务接口
export interface IAudioProcessor {
  processVideo(videoPath: string, roomId?: string): Promise<AudioResult>;
  convertToAudio(videoPath: string, format: string): Promise<string>;
  isAudioOnlyRoom(roomId: string): boolean;
}

// AI文本生成服务接口
export interface ITextGenerator {
  generate(highlightPath: string, roomId?: string): Promise<TextResult>;
  batchGenerate(directory: string): Promise<BatchResult[]>;
}

// AI漫画生成服务接口
export interface IComicGenerator {
  generate(highlightPath: string, roomId?: string): Promise<ComicResult>;
}

// 字幕融合服务接口
export interface IFusionProcessor {
  process(inputs: FusionInput[]): Promise<FusionResult>;
}

// 文件处理服务接口
export interface IFileProcessor {
  processVideo(videoPath: string, xmlFiles: string[], roomId?: string): Promise<ProcessResult>;
  processAudio(audioPath: string, xmlFiles: string[], roomId?: string): Promise<ProcessResult>;
}

// Webhook处理器接口
export interface IWebhookHandler {
  process(payload: any): Promise<void>;
}

// 配置提供者接口
export interface IConfigProvider {
  getConfig(): AppConfig;
  getWebhookConfig(): WebhookConfig;
  getAudioConfig(): AudioConfig;
  getAIConfig(): AIConfig;
  getRoomConfig(roomId: string): RoomAIConfig | null;
}

// 日志服务接口
export interface ILogger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}

// 事件总线接口
export interface IEventBus {
  subscribe(event: string, handler: EventHandler): void;
  unsubscribe(event: string, handler: EventHandler): void;
  publish(event: string, data: any): void;
}
```

#### 数据接口
```typescript
// src/core/interfaces/data.ts

// 处理结果接口
export interface ProcessResult {
  success: boolean;
  inputPath: string;
  outputPath?: string;
  error?: string;
  metadata?: Record<string, any>;
}

// 音频处理结果
export interface AudioResult extends ProcessResult {
  isAudio: boolean;
  originalVideoPath?: string;
}

// AI生成结果
export interface TextResult extends ProcessResult {
  content?: string;
  roomId?: string;
}

export interface ComicResult extends ProcessResult {
  roomId?: string;
}

// 字幕融合结果
export interface FusionResult extends ProcessResult {
  subtitleCount: number;
  danmakuCount: number;
  heatmapThreshold: number;
}

// 批处理结果
export interface BatchResult {
  file: string;
  success: boolean;
  output?: string;
  error?: string;
}
```

### 2. 依赖注入容器

#### 容器实现
```typescript
// src/core/di/Container.ts
export class Container {
  private services: Map<string, ServiceDescriptor> = new Map();
  private instances: Map<string, any> = new Map();
  private scopes: Map<string, Container> = new Map();

  // 注册服务
  register<T>(name: string, descriptor: ServiceDescriptor<T>): void {
    this.services.set(name, descriptor);
  }

  // 解析服务
  resolve<T>(name: string): T {
    // 检查是否有缓存实例
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    const descriptor = this.services.get(name);
    if (!descriptor) {
      throw new Error(`服务未注册: ${name}`);
    }

    // 创建实例
    const instance = this.createInstance(descriptor);
    
    // 缓存单例实例
    if (descriptor.lifetime === 'singleton') {
      this.instances.set(name, instance);
    }

    return instance;
  }

  // 创建作用域
  createScope(): Container {
    const scopeId = uuidv4();
    const scope = new Container();
    
    // 复制父容器的服务注册
    for (const [name, descriptor] of this.services.entries()) {
      if (descriptor.lifetime === 'scoped' || descriptor.lifetime === 'transient') {
        scope.register(name, { ...descriptor });
      }
    }
    
    this.scopes.set(scopeId, scope);
    return scope;
  }

  // 创建实例
  private createInstance<T>(descriptor: ServiceDescriptor<T>): T {
    if (descriptor.factory) {
      return descriptor.factory(this);
    }

    if (descriptor.value) {
      return descriptor.value;
    }

    if (descriptor.implementation) {
      const dependencies = descriptor.dependencies || [];
      const args = dependencies.map(dep => this.resolve(dep));
      return new descriptor.implementation(...args);
    }

    throw new Error(`无效的服务描述符: ${JSON.stringify(descriptor)}`);
  }
}

// 服务描述符
export interface ServiceDescriptor<T = any> {
  // 实现类
  implementation?: new (...args: any[]) => T;
  
  // 工厂函数
  factory?: (container: Container) => T;
  
  // 直接值
  value?: T;
  
  // 依赖项
  dependencies?: string[];
  
  // 生命周期
  lifetime: 'singleton' | 'scoped' | 'transient';
}
```

#### 服务注册器
```typescript
// src/core/di/ServiceRegistry.ts
export class ServiceRegistry {
  static registerAll(container: Container): void {
    // 注册基础设施服务
    this.registerInfrastructureServices(container);
    
    // 注册业务服务
    this.registerBusinessServices(container);
    
    // 注册应用服务
    this.registerApplicationServices(container);
  }

  private static registerInfrastructureServices(container: Container): void {
    // 配置服务
    container.register('IConfigProvider', {
      implementation: ConfigProvider,
      lifetime: 'singleton',
    });

    // 日志服务
    container.register('ILogger', {
      factory: (c) => {
        const config = c.resolve<IConfigProvider>('IConfigProvider');
        return new Logger(config.getConfig().app.logLevel);
      },
      lifetime: 'singleton',
    });

    // 事件总线
    container.register('IEventBus', {
      implementation: EventBus,
      lifetime: 'singleton',
    });

    // 文件工具
    container.register('IFileUtils', {
      implementation: FileUtils,
      lifetime: 'singleton',
    });
  }

  private static registerBusinessServices(container: Container): void {
    // Webhook服务
    container.register('IWebhookServer', {
      implementation: WebhookServer,
      dependencies: ['IConfigProvider', 'ILogger', 'IEventBus', 'IFileProcessor'],
      lifetime: 'singleton',
    });

    // 文件处理器
    container.register('IFileProcessor', {
      implementation: FileProcessor,
      dependencies: ['IConfigProvider', 'ILogger', 'IAudioProcessor', 'IFusionProcessor', 'ITextGenerator', 'IComicGenerator'],
      lifetime: 'scoped',
    });

    // 音频处理器
    container.register('IAudioProcessor', {
      implementation: AudioProcessor,
      dependencies: ['IConfigProvider', 'ILogger', 'IFFmpegService'],
      lifetime: 'scoped',
    });

    // FFmpeg服务
    container.register('IFFmpegService', {
      implementation: FFmpegService,
      dependencies: ['IConfigProvider', 'ILogger'],
      lifetime: 'scoped',
    });

    // 文本生成器
    container.register('ITextGenerator', {
      implementation: TextGenerator,
      dependencies: ['IConfigProvider', 'ILogger', 'IGeminiService', 'IPromptBuilder'],
      lifetime: 'scoped',
    });

    // Gemini服务
    container.register('IGeminiService', {
      implementation: GeminiService,
      dependencies: ['IConfigProvider', 'ILogger'],
      lifetime: 'scoped',
    });

    // 漫画生成器
    container.register('IComicGenerator', {
      implementation: ComicGenerator,
      dependencies: ['IConfigProvider', 'ILogger', 'IPythonBridge'],
      lifetime: 'scoped',
    });

    // 字幕融合处理器
    container.register('IFusionProcessor', {
      implementation: FusionProcessor,
      dependencies: ['IConfigProvider', 'ILogger', 'ISrtParser', 'IXmlParser', 'IHeatmapAnalyzer'],
      lifetime: 'scoped',
    });
  }

  private static registerApplicationServices(container: Container): void {
    // CLI应用
    container.register('CliApp', {
      implementation: CliApp,
      dependencies: ['IConfigProvider', 'ILogger', 'IFileProcessor'],
      lifetime: 'singleton',
    });

    // 批处理器
    container.register('BatchProcessor', {
      implementation: BatchProcessor,
      dependencies: ['IConfigProvider', 'ILogger', 'IFileProcessor'],
      lifetime: 'scoped',
    });
  }
}
```

### 3. 服务工厂模式

#### 抽象工厂
```typescript
// src/core/factories/ServiceFactory.ts
export class ServiceFactory {
  private static container: Container;

  static initialize(): void {
    this.container = new Container();
    ServiceRegistry.registerAll(this.container);
  }

  static getContainer(): Container {
    if (!this.container) {
      this.initialize();
    }
    return this.container;
  }

  // 创建作用域容器
  static createScope(): Container {
    return this.getContainer().createScope();
  }

  // 获取服务（单例）
  static getService<T>(name: string): T {
    return this.getContainer().resolve<T>(name);
  }

  // 创建服务（新实例）
  static createService<T>(name: string): T {
    const scope = this.createScope();
    return scope.resolve<T>(name);
  }

  // 特定服务工厂方法
  static createWebhookServer(): IWebhookServer {
    return this.getService<IWebhookServer>('IWebhookServer');
  }

  static createFileProcessor(): IFileProcessor {
    return this.createService<IFileProcessor>('IFileProcessor');
  }

  static createAudioProcessor(): IAudioProcessor {
    return this.createService<IAudioProcessor>('IAudioProcessor');
  }

  static createTextGenerator(): ITextGenerator {
    return this.createService<ITextGenerator>('ITextGenerator');
  }

  static createCliApp(): CliApp {
    return this.getService<CliApp>('CliApp');
  }
}
```

#### 装饰器支持
```typescript
// src/core/decorators/Injectable.ts
export function Injectable(lifetime: 'singleton' | 'scoped' | 'transient' = 'scoped') {
  return function <T extends { new (...args: any[]): {} }>(constructor: T) {
    // 注册到容器
    const className = constructor.name;
    const token = `I${className}`;
    
    // 自动提取依赖
    const dependencies = Reflect.getMetadata('design:paramtypes', constructor) || [];
    const dependencyTokens = dependencies.map((dep: any) => `I${dep.name}`);
    
    // 注册服务
    ServiceFactory.getContainer().register(token, {
      implementation: constructor,
      dependencies: dependencyTokens,
      lifetime,
    });
    
    return constructor;
  };
}

// src/core/decorators/Inject.ts
export function Inject(token?: string) {
  return function (target: any, propertyKey: string | symbol, parameterIndex: number) {
    // 存储注入信息
    const existingInjections = Reflect.getMetadata('injections', target) || [];
    existingInjections.push({
      index: parameterIndex,
      token: token || `I${target.name}`,
    });
    Reflect.defineMetadata('injections', existingInjections, target);
  };
}
```

### 4. 配置驱动的服务创建

#### 服务配置
```typescript
// config/services.json
{
  "services": {
    "audio": {
      "provider": "ffmpeg",
      "ffmpeg": {
        "path": "ffmpeg",
        "timeout": 300000
      }
    },
    "ai": {
      "text": {
        "provider": "gemini",
        "gemini": {
          "model": "gemini-1.5-flash",
          "temperature": 0.7
        }
      },
      "comic": {
        "provider": "python",
        "python": {
          "script": "ai_comic_generator.py"
        }
      }
    }
  }
}
```

#### 动态服务工厂
```typescript
// src/core/factories/DynamicServiceFactory.ts
export class DynamicServiceFactory {
  static createAudioProcessor(config: AudioConfig): IAudioProcessor {
    const provider = config.provider || 'ffmpeg';
    
    switch (provider) {
      case 'ffmpeg':
        return new FFmpegAudioProcessor(config);
      case 'libav':
        return new LibavAudioProcessor(config);
      default:
        throw new Error(`不支持的音频处理器: ${provider}`);
    }
  }

  static createTextGenerator(config: TextAIConfig): ITextGenerator {
    const provider = config.provider || 'gemini';
    
    switch (provider) {
      case 'gemini':
        return new GeminiTextGenerator(config);
      case 'openai':
        return new OpenAITextGenerator(config);
      case 'claude':
        return new ClaudeTextGenerator(config);
      default:
        throw new Error(`不支持的文本生成器: ${provider}`);
    }
  }

  static createComicGenerator(config: ComicAIConfig): IComicGenerator {
    const provider = config.provider || 'python';
    
    switch (provider) {
      case 'python':
        return new PythonComicGenerator(config);
      case 'huggingface':
        return new HuggingFaceComicGenerator(config);
      case 'local':
        return new LocalComicGenerator(config);
      default:
        throw new Error(`不支持的漫画生成器: ${provider}`);
    }
  }
}
```

### 5. 模块生命周期管理

#### 生命周期接口
```typescript
// src/core/lifecycle/LifecycleManager.ts
export interface ILifecycle {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export class LifecycleManager {
  private services: Map<string, ILifecycle> = new Map();
  private states: Map<string, LifecycleState> = new Map();

  register(name: string, service: ILifecycle): void {
    this.services.set(name, service);
    this.states.set(name, 'registered');
  }

  async initializeAll(): Promise<void> {
    for (const [name, service] of this.services) {
      try {
        await service.initialize();
        this.states.set(name, 'initialized');
      } catch (error) {
        console.error(`初始化服务失败: ${name}`, error);
        throw error;
      }
    }
  }

  async startAll(): Promise<void> {
    for (const [name, service] of this.services) {
      try {
        await service.start();
        this.states.set(name, 'started');
      } catch (error) {
        console.error(`启动服务失败: ${name}`, error);
        throw error;
      }
    }
  }

  async stopAll(): Promise<void> {
    // 按注册顺序逆序停止
    const services = Array.from(this.services.entries()).reverse();
    
    for (const [name, service] of services) {
      try {
        await service.stop();
        this.states.set(name, 'stopped');
      } catch (error) {
        console.error(`停止服务失败: ${name}`, error);
      }
    }
  }

  getState(name: string): LifecycleState {
    return this.states.get(name) || 'unknown';
  }
}
```

### 6. 错误处理和重试机制

#### 带重试的服务代理
```typescript
// src/core/proxies/RetryProxy.ts
export class RetryProxy<T extends object> implements ProxyHandler<T> {
  constructor(
    private target: T,
    private options: RetryOptions = { maxRetries: 3, delay: 1000 }
  ) {}

  get(target: T, prop: string | symbol, receiver: any): any {
    const value = Reflect.get(target, prop, receiver);
    
    if (typeof value === 'function') {
      return (...args: any[]) => this.wrapWithRetry(value.bind(target), args);
    }
    
    return value;
  }

  private async wrapWithRetry(fn: Function, args: any[]): Promise<any> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (error) {
        lastError = error;
        
        if (attempt < this.options.maxRetries) {
          const delay = this.options.delay * Math.pow(2, attempt - 1); // 指数退避
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 使用示例
const audioProcessor = new AudioProcessor(config, logger, ffmpegService);
const retryProcessor = new