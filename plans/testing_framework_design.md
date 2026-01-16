# 测试框架和单元测试设计

## 测试策略

### 1. 测试金字塔
```
        E2E测试 (10%)
           |
      集成测试 (20%)
           |
      单元测试 (70%)
```

### 2. 测试类型
- **单元测试**：测试单个函数或类
- **集成测试**：测试模块间的交互
- **E2E测试**：测试完整流程
- **性能测试**：测试系统性能
- **负载测试**：测试系统负载能力

## 测试框架选择

### 1. 主要测试框架
- **Jest**：单元测试和集成测试
- **Supertest**：HTTP API测试
- **Puppeteer**：E2E测试（如果需要Web界面）
- **Benchmark.js**：性能测试

### 2. 测试工具
- **ts-jest**：TypeScript支持
- **jest-mock-extended**：更好的模拟支持
- **jest-watch-typeahead**：测试过滤
- **jest-html-reporter**：HTML测试报告

## 测试目录结构

```
tests/
├── unit/                    # 单元测试
│   ├── core/              # 核心模块测试
│   │   ├── config/
│   │   ├── logging/
│   │   └── utils/
│   ├── services/          # 服务层测试
│   │   ├── webhook/
│   │   ├── audio/
│   │   ├── ai/
│   │   └── fusion/
│   └── factories/         # 工厂测试
│
├── integration/           # 集成测试
│   ├── webhook/          # Webhook集成测试
│   ├── pipeline/         # 流程集成测试
│   └── storage/          # 存储集成测试
│
├── e2e/                  # 端到端测试
│   ├── scenarios/        # 测试场景
│   └── fixtures/         # E2E测试数据
│
├── performance/          # 性能测试
│   ├── benchmarks/       # 基准测试
│   └── load/            # 负载测试
│
└── fixtures/             # 测试数据
    ├── audio/           # 音频测试文件
    ├── video/           # 视频测试文件
    ├── srt/             # 字幕测试文件
    └── xml/             # 弹幕测试文件
```

## 单元测试设计

### 1. 测试配置

```typescript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/**/types.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  }
};
```

### 2. 测试工具函数

```typescript
// tests/utils/test-utils.ts
import { Container } from '@/core/di/Container';
import { ServiceFactory } from '@/core/factories/ServiceFactory';

// 测试容器
export class TestContainer {
  private container: Container;

  constructor() {
    this.container = new Container();
    this.setupTestServices();
  }

  private setupTestServices(): void {
    // 注册测试专用的服务实现
    this.container.register('ILogger', {
      value: createTestLogger(),
      lifetime: 'singleton',
    });

    this.container.register('IConfigProvider', {
      value: createTestConfig(),
      lifetime: 'singleton',
    });

    // 其他测试服务...
  }

  resolve<T>(name: string): T {
    return this.container.resolve<T>(name);
  }

  mock<T>(name: string, mockImpl: any): void {
    this.container.register(name, {
      value: mockImpl,
      lifetime: 'singleton',
    });
  }
}

// 创建测试日志器
export function createTestLogger() {
  const logs: any[] = [];
  
  return {
    debug: (message: string, meta?: any) => logs.push({ level: 'debug', message, meta }),
    info: (message: string, meta?: any) => logs.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: any) => logs.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: any) => logs.push({ level: 'error', message, meta }),
    getLogs: () => [...logs],
    clear: () => logs.length = 0,
  };
}

// 创建测试配置
export function createTestConfig(overrides: any = {}) {
  const baseConfig = {
    app: {
      name: 'test-app',
      version: '1.0.0',
      environment: 'test',
      logLevel: 'error',
    },
    webhook: {
      enabled: true,
      port: 0, // 使用随机端口
      host: 'localhost',
      endpoints: {
        ddtv: { enabled: true, endpoint: '/ddtv' },
        mikufans: { enabled: true, endpoint: '/mikufans', basePath: '/tmp/test' },
      },
      timeouts: {
        fixVideoWait: 100,
        fileStableCheck: 100,
        processTimeout: 1000,
      },
    },
    audio: {
      enabled: true,
      audioOnlyRooms: [12345],
      formats: ['.m4a'],
      defaultFormat: '.m4a',
      ffmpeg: { path: 'ffmpeg', timeout: 1000 },
      storage: { keepOriginalVideo: false, maxFileAgeDays: 1 },
    },
    // ... 其他配置
  };

  return deepMerge(baseConfig, overrides);
}
```

### 3. 测试基类

```typescript
// tests/BaseTest.ts
import { TestContainer } from './utils/test-utils';
import { ServiceFactory } from '@/core/factories/ServiceFactory';

export abstract class BaseTest {
  protected testContainer: TestContainer;
  protected mocks: Map<string, any> = new Map();

  beforeEach() {
    this.testContainer = new TestContainer();
    this.setupMocks();
  }

  afterEach() {
    this.mocks.clear();
  }

  protected abstract setupMocks(): void;

  protected mockService<T>(name: string): jest.Mocked<T> {
    const mock = jest.fn() as any;
    this.testContainer.mock(name, mock);
    this.mocks.set(name, mock);
    return mock;
  }

  protected getMock<T>(name: string): jest.Mocked<T> {
    const mock = this.mocks.get(name);
    if (!mock) {
      throw new Error(`Mock未找到: ${name}`);
    }
    return mock;
  }

  protected createTestFile(content: string, extension: string = '.txt'): string {
    const tempDir = '/tmp/test-files';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const filename = `${uuidv4()}${extension}`;
    const filepath = path.join(tempDir, filename);
    fs.writeFileSync(filepath, content);
    
    return filepath;
  }
}
```

## 服务层单元测试示例

### 1. 音频处理器测试

```typescript
// tests/unit/services/audio/AudioProcessor.test.ts
import { AudioProcessor } from '@/services/audio/AudioProcessor';
import { IFFmpegService } from '@/core/interfaces/services';
import { BaseTest } from '@/tests/BaseTest';

describe('AudioProcessor', () => {
  class AudioProcessorTest extends BaseTest {
    private audioProcessor: AudioProcessor;
    private ffmpegServiceMock: jest.Mocked<IFFmpegService>;

    setupMocks() {
      this.ffmpegServiceMock = this.mockService<IFFmpegService>('IFFmpegService');
    }

    beforeEach() {
      super.beforeEach();
      const config = this.testContainer.resolve('IConfigProvider');
      const logger = this.testContainer.resolve('ILogger');
      this.audioProcessor = new AudioProcessor(
        config.getAudioConfig(),
        logger,
        this.ffmpegServiceMock
      );
    }
  }

  const test = new AudioProcessorTest();

  beforeEach(() => {
    test.beforeEach();
  });

  afterEach(() => {
    test.afterEach();
  });

  describe('processVideo', () => {
    it('应该处理音频专用房间', async () => {
      // 准备
      const videoPath = '/tmp/test.mp4';
      const roomId = '12345';
      const audioPath = '/tmp/test.m4a';
      
      test.ffmpegServiceMock.convertVideoToAudio.mockResolvedValue(audioPath);

      // 执行
      const result = await test.audioProcessor.processVideo(videoPath, roomId);

      // 验证
      expect(result.success).toBe(true);
      expect(result.isAudio).toBe(true);
      expect(result.filePath).toBe(audioPath);
      expect(test.ffmpegServiceMock.convertVideoToAudio).toHaveBeenCalledWith(
        videoPath,
        audioPath,
        expect.any(Object)
      );
    });

    it('应该跳过非音频专用房间', async () => {
      // 准备
      const videoPath = '/tmp/test.mp4';
      const roomId = '99999'; // 非音频专用房间

      // 执行
      const result = await test.audioProcessor.processVideo(videoPath, roomId);

      // 验证
      expect(result.success).toBe(true);
      expect(result.isAudio).toBe(false);
      expect(result.filePath).toBe(videoPath);
      expect(test.ffmpegServiceMock.convertVideoToAudio).not.toHaveBeenCalled();
    });

    it('应该处理转换失败', async () => {
      // 准备
      const videoPath = '/tmp/test.mp4';
      const roomId = '12345';
      const error = new Error('转换失败');
      
      test.ffmpegServiceMock.convertVideoToAudio.mockRejectedValue(error);

      // 执行
      const result = await test.audioProcessor.processVideo(videoPath, roomId);

      // 验证
      expect(result.success).toBe(false);
      expect(result.error).toBe('转换失败');
      expect(result.filePath).toBe(videoPath);
    });
  });

  describe('isAudioOnlyRoom', () => {
    it('应该识别音频专用房间', () => {
      expect(test.audioProcessor.isAudioOnlyRoom('12345')).toBe(true);
    });

    it('应该识别非音频专用房间', () => {
      expect(test.audioProcessor.isAudioOnlyRoom('99999')).toBe(false);
    });
  });
});
```

### 2. 文本生成器测试

```typescript
// tests/unit/services/ai/TextGenerator.test.ts
import { TextGenerator } from '@/services/ai/text/TextGenerator';
import { IGeminiService } from '@/core/interfaces/services';
import { BaseTest } from '@/tests/BaseTest';

describe('TextGenerator', () => {
  class TextGeneratorTest extends BaseTest {
    private textGenerator: TextGenerator;
    private geminiServiceMock: jest.Mocked<IGeminiService>;

    setupMocks() {
      this.geminiServiceMock = this.mockService<IGeminiService>('IGeminiService');
    }

    beforeEach() {
      super.beforeEach();
      const config = this.testContainer.resolve('IConfigProvider');
      const logger = this.testContainer.resolve('ILogger');
      const promptBuilder = this.testContainer.resolve('IPromptBuilder');
      
      this.textGenerator = new TextGenerator(
        config.getAIConfig().text,
        logger,
        this.geminiServiceMock,
        promptBuilder
      );
    }
  }

  const test = new TextGeneratorTest();

  beforeEach(() => {
    test.beforeEach();
  });

  afterEach(() => {
    test.afterEach();
  });

  describe('generate', () => {
    it('应该成功生成文本', async () => {
      // 准备
      const highlightPath = test.createTestFile('测试highlight内容', '_AI_HIGHLIGHT.txt');
      const generatedText = '生成的晚安回复内容';
      
      test.geminiServiceMock.generateText.mockResolvedValue(generatedText);

      // 执行
      const result = await test.textGenerator.generate(highlightPath);

      // 验证
      expect(result.success).toBe(true);
      expect(result.content).toBe(generatedText);
      expect(result.outputPath).toMatch(/_晚安回复\.md$/);
      expect(fs.existsSync(result.outputPath!)).toBe(true);
      
      // 清理
      fs.unlinkSync(highlightPath);
      fs.unlinkSync(result.outputPath!);
    });

    it('应该处理AI服务失败', async () => {
      // 准备
      const highlightPath = test.createTestFile('测试highlight内容', '_AI_HIGHLIGHT.txt');
      const error = new Error('API调用失败');
      
      test.geminiServiceMock.generateText.mockRejectedValue(error);

      // 执行
      const result = await test.textGenerator.generate(highlightPath);

      // 验证
      expect(result.success).toBe(false);
      expect(result.error).toBe('API调用失败');
      
      // 清理
      fs.unlinkSync(highlightPath);
    });

    it('应该处理文件不存在', async () => {
      // 执行
      const result = await test.textGenerator.generate('/tmp/nonexistent.txt');

      // 验证
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/文件不存在/);
    });
  });
});
```

## 集成测试设计

### 1. Webhook集成测试

```typescript
// tests/integration/webhook/WebhookServer.test.ts
import request from 'supertest';
import { WebhookServer } from '@/services/webhook/WebhookServer';
import { TestContainer } from '@/tests/utils/test-utils';

describe('WebhookServer Integration', () => {
  let server: WebhookServer;
  let testContainer: TestContainer;
  let app: Express.Application;

  beforeAll(async () => {
    testContainer = new TestContainer();
    server = testContainer.resolve('IWebhookServer');
    await server.start();
    
    // 获取Express应用实例
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /ddtv', () => {
    it('应该处理DDTV webhook请求', async () => {
      const payload = {
        cmd: 'FileClosed',
        data: {
          RoomId: 12345,
          Name: '测试主播',
          DownInfo: {
            DownloadFileList: {
              VideoFile: ['/tmp/test_fix.mp4'],
              DanmuFile: ['/tmp/test.xml'],
            },
          },
        },
      };

      const response = await request(app)
        .post('/ddtv')
        .send(payload)
        .expect(200);

      expect(response.text).toBe('Processing started');
    });

    it('应该返回400对于无效请求', async () => {
      const response = await request(app)
        .post('/ddtv')
        .send({ invalid: 'payload' })
        .expect(400);

      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /health', () => {
    it('应该返回健康状态', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
    });
  });
});
```

### 2. 流程集成测试

```typescript
// tests/integration/pipeline/FileProcessor.test.ts
import { FileProcessor } from '@/services/pipeline/FileProcessor';
import { TestContainer } from '@/tests/utils/test-utils';

describe('FileProcessor Integration', () => {
  let fileProcessor: FileProcessor;
  let testContainer: TestContainer;

  beforeEach(() => {
    testContainer = new TestContainer();
    fileProcessor = testContainer.resolve('IFileProcessor');
  });

  it('应该完整处理视频文件', async () => {
    // 准备测试文件
    const videoPath = createTestVideoFile();
    const xmlPath = createTestXmlFile();
    
    // 执行
    const result = await fileProcessor.processVideo(videoPath, [xmlPath], '12345');
    
    // 验证
    expect(result.success).toBe(true);
    expect(result.outputPath).toBeDefined();
    
    // 验证生成的文件
    const outputDir = path.dirname(result.outputPath!);
    const files = fs.readdirSync(outputDir);
    
    expect(files).toContain(expect.stringMatching(/_AI_HIGHLIGHT\.txt$/));
    expect(files).toContain(expect.stringMatching(/_晚安回复\.md$/));
    
    // 清理
    cleanupTestFiles([videoPath, xmlPath, result.outputPath!]);
  }, 30000); // 设置较长的超时时间
});
```

## E2E测试设计

### 1. 完整流程测试

```typescript
// tests/e2e/scenarios/full-pipeline.test.ts
describe('完整流程 E2E 测试', () => {
  let webhookServer: WebhookServer;
  let testDataDir: string;

  beforeAll(async () => {
    // 创建测试数据目录
    testDataDir = await createTestDataDirectory();
    
    // 启动webhook服务器
    webhookServer = ServiceFactory.createWebhookServer();
    await webhookServer.start();
  });

  afterAll(async () => {
    await webhookServer.stop();
    await cleanupTestDataDirectory(testDataDir);
