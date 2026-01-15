# 集成测试和验证计划

## 验证策略

### 1. 验证目标
- 确保重构后的系统功能与原有系统一致
- 验证新架构的性能和稳定性
- 确保平滑迁移，不影响现有工作流程

### 2. 验证阶段
1. **单元测试验证**：确保每个模块功能正确
2. **集成测试验证**：确保模块间协作正常
3. **端到端测试验证**：确保完整流程工作
4. **性能对比验证**：确保性能不下降
5. **生产环境验证**：在实际环境中测试

## 集成测试计划

### 1. 测试环境搭建

#### 测试环境配置
```yaml
# docker-compose.test.yml
version: '3.8'

services:
  # 主应用服务
  app:
    build:
      context: .
      dockerfile: Dockerfile.test
    environment:
      NODE_ENV: test
      LOG_LEVEL: debug
      WEBHOOK_PORT: 15121
    ports:
      - "15121:15121"
    volumes:
      - ./tests/fixtures:/app/tests/fixtures
      - ./tests/output:/app/tests/output
    depends_on:
      - ffmpeg
      - python

  # FFmpeg服务（用于音频处理测试）
  ffmpeg:
    image: jrottenberg/ffmpeg:4.1-alpine
    command: ["sleep", "infinity"]

  # Python环境（用于漫画生成测试）
  python:
    image: python:3.9-alpine
    command: ["sleep", "infinity"]
    volumes:
      - ./src/scripts/python:/app/python

  # 测试数据生成器
  test-data:
    build:
      context: ./tests
      dockerfile: Dockerfile.test-data
    volumes:
      - ./tests/fixtures:/app/fixtures
```

#### 测试数据准备
```typescript
// tests/fixtures/generate-test-data.ts
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

class TestDataGenerator {
  async generateAll(): Promise<void> {
    console.log('生成测试数据...');
    
    // 创建测试目录
    await fs.ensureDir('tests/fixtures/video');
    await fs.ensureDir('tests/fixtures/audio');
    await fs.ensureDir('tests/fixtures/srt');
    await fs.ensureDir('tests/fixtures/xml');
    
    // 生成测试视频文件（使用FFmpeg创建简单视频）
    await this.generateTestVideo();
    
    // 生成测试音频文件
    await this.generateTestAudio();
    
    // 生成测试字幕文件
    await this.generateTestSrt();
    
    // 生成测试弹幕文件
    await this.generateTestXml();
    
    console.log('测试数据生成完成');
  }
  
  private async generateTestVideo(): Promise<void> {
    const outputPath = 'tests/fixtures/video/test.mp4';
    
    // 使用FFmpeg生成10秒的测试视频
    const command = `ffmpeg -f lavfi -i testsrc=duration=10:size=640x480:rate=30 -c:v libx264 -pix_fmt yuv420p ${outputPath}`;
    
    try {
      execSync(command, { stdio: 'pipe' });
      console.log(`✅ 生成测试视频: ${outputPath}`);
    } catch (error) {
      console.warn(`⚠️  无法生成测试视频，使用占位文件: ${error.message}`);
      await fs.writeFile(outputPath, 'video placeholder');
    }
  }
  
  private async generateTestSrt(): Promise<void> {
    const srtContent = `1
00:00:01,000 --> 00:00:04,000
这是第一条测试字幕

2
00:00:05,000 --> 00:00:08,000
这是第二条测试字幕，包含一些关键词

3
00:00:10,000 --> 00:00:13,000
最后总结一下今天的直播内容
`;
    
    await fs.writeFile('tests/fixtures/srt/test.srt', srtContent);
    console.log('✅ 生成测试字幕文件');
  }
  
  private async generateTestXml(): Promise<void> {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <d p="1.0,1,25,16777215,1650969600000,0,14279,0">第一条测试弹幕</d>
  <d p="5.0,1,25,16777215,1650969650000,0,14279,0">第二条测试弹幕</d>
  <d p="10.0,1,25,16777215,1650969700000,0,14279,0">总结弹幕</d>
  <d p="12.0,1,25,16777215,1650969720000,0,12345,0">其他用户弹幕</d>
</i>`;
    
    await fs.writeFile('tests/fixtures/xml/test.xml', xmlContent);
    console.log('✅ 生成测试弹幕文件');
  }
}
```

### 2. 集成测试套件

#### Webhook集成测试
```typescript
// tests/integration/webhook/WebhookIntegration.test.ts
describe('Webhook集成测试', () => {
  let webhookServer: WebhookServer;
  let testClient: TestClient;
  
  beforeAll(async () => {
    // 启动测试服务器
    webhookServer = ServiceFactory.createWebhookServer();
    await webhookServer.start();
    
    // 创建测试客户端
    testClient = new TestClient('http://localhost:15121');
  });
  
  afterAll(async () => {
    await webhookServer.stop();
  });
  
  describe('DDTV Webhook流程', () => {
    it('应该完整处理DDTV文件关闭事件', async () => {
      // 准备测试数据
      const videoFile = await createTestVideoFile();
      const xmlFile = await createTestXmlFile();
      
      // 模拟DDTV webhook请求
      const payload = {
        cmd: 'FileClosed',
        data: {
          RoomId: 26966466,
          Name: '测试主播',
          DownInfo: {
            DownloadFileList: {
              VideoFile: [videoFile],
              DanmuFile: [xmlFile],
            },
          },
        },
      };
      
      // 发送webhook请求
      const response = await testClient.post('/ddtv', payload);
      expect(response.status).toBe(200);
      
      // 等待处理完成
      await waitForProcessing(videoFile, 30000);
      
      // 验证输出文件
      const outputDir = path.dirname(videoFile);
      const files = await fs.readdir(outputDir);
      
      expect(files).toContain(expect.stringMatching(/_AI_HIGHLIGHT\.txt$/));
      expect(files).toContain(expect.stringMatching(/_晚安回复\.md$/));
      
      // 验证文件内容
      const highlightFile = files.find(f => f.includes('_AI_HIGHLIGHT.txt'));
      const highlightContent = await fs.readFile(path.join(outputDir, highlightFile!), 'utf8');
      expect(highlightContent).toContain('【高能浓缩摘要】');
      
      // 清理测试文件
      await cleanupTestFiles([videoFile, xmlFile, ...files.map(f => path.join(outputDir, f))]);
    }, 60000); // 设置较长的超时时间
  });
  
  describe('Mikufans Webhook流程', () => {
    it('应该完整处理Mikufans文件关闭事件', async () => {
      // 准备测试数据
      const videoFile = await createTestVideoFile();
      
      // 模拟Mikufans webhook请求
      const payload = {
        EventType: 'FileClosed',
        EventData: {
          RelativePath: 'test/2026_01_15/录制-26966466-20260115-120000-001-测试直播.flv',
          RoomId: 26966466,
          Name: '测试主播',
        },
      };
      
      // 发送webhook请求
      const response = await testClient.post('/mikufans', payload);
      expect(response.status).toBe(200);
      
      // 验证处理已开始
      expect(response.text).toBe('Processing started');
    });
  });
});
```

#### 完整流程集成测试
```typescript
// tests/integration/pipeline/FullPipeline.test.ts
describe('完整流程集成测试', () => {
  let fileProcessor: IFileProcessor;
  let testContainer: TestContainer;
  
  beforeEach(() => {
    testContainer = new TestContainer();
    fileProcessor = testContainer.resolve('IFileProcessor');
  });
  
  afterEach(async () => {
    await cleanupTestOutput();
  });
  
  test('视频+弹幕完整处理流程', async () => {
    // 准备测试文件
    const videoPath = await createTestVideoFile();
    const xmlPath = await createTestXmlFile();
    
    // 执行完整处理
    const result = await fileProcessor.processVideo(videoPath, [xmlPath], '26966466');
    
    // 验证处理结果
    expect(result.success).toBe(true);
    expect(result.outputPath).toBeDefined();
    
    // 验证生成的文件
    const outputDir = path.dirname(result.outputPath!);
    const generatedFiles = await fs.readdir(outputDir);
    
    const expectedFiles = [
      '_AI_HIGHLIGHT.txt',
      '_晚安回复.md',
      '.srt', // 字幕文件
    ];
    
    expectedFiles.forEach(expected => {
      const found = generatedFiles.some(f => f.includes(expected));
      expect(found).toBe(true);
    });
    
    // 验证文件内容
    const highlightFile = generatedFiles.find(f => f.includes('_AI_HIGHLIGHT.txt'));
    const highlightContent = await fs.readFile(path.join(outputDir, highlightFile!), 'utf8');
    expect(highlightContent).toContain('【高能浓缩摘要】');
    expect(highlightContent).toContain('测试字幕');
    
    // 验证AI生成内容
    const replyFile = generatedFiles.find(f => f.includes('_晚安回复.md'));
    const replyContent = await fs.readFile(path.join(outputDir, replyFile!), 'utf8');
    expect(replyContent).toContain('晚安回复');
    expect(replyContent.length).toBeGreaterThan(100);
  }, 90000); // 90秒超时
  
  test('音频专用房间处理流程', async () => {
    // 准备测试文件
    const videoPath = await createTestVideoFile();
    const xmlPath = await createTestXmlFile();
    
    // 执行处理（音频专用房间）
    const result = await fileProcessor.processVideo(videoPath, [xmlPath], '26966466');
    
    // 验证音频处理
    expect(result.success).toBe(true);
    
    // 检查是否生成了音频文件
    const outputDir = path.dirname(result.outputPath!);
    const generatedFiles = await fs.readdir(outputDir);
    
    const hasAudioFile = generatedFiles.some(f => f.endsWith('.m4a') || f.endsWith('.mp3'));
    expect(hasAudioFile).toBe(true);
  }, 60000);
});
```

### 3. 性能对比测试

#### 性能测试套件
```typescript
// tests/performance/PerformanceComparison.test.ts
describe('性能对比测试', () => {
  let oldSystem: OldSystemAdapter;
  let newSystem: NewSystemAdapter;
  
  beforeAll(async () => {
    // 初始化旧系统适配器
    oldSystem = new OldSystemAdapter();
    
    // 初始化新系统
    newSystem = new NewSystemAdapter();
    
    // 准备性能测试数据
    await preparePerformanceTestData();
  });
  
  afterAll(async () => {
    await cleanupPerformanceTestData();
  });
  
  describe('处理速度对比', () => {
    const testCases = [
      { name: '小文件处理', size: '10MB', duration: '10秒' },
      { name: '中文件处理', size: '100MB', duration: '60秒' },
      { name: '大文件处理', size: '500MB', duration: '300秒' },
    ];
    
    testCases.forEach(testCase => {
      it(`应该比较${testCase.name}的处理速度`, async () => {
        const testFile = await getTestFile(testCase.size);
        
        // 测试旧系统
        const oldStartTime = Date.now();
        const oldResult = await oldSystem.process(testFile);
        const oldDuration = Date.now() - oldStartTime;
        
        // 测试新系统
        const newStartTime = Date.now();
        const newResult = await newSystem.process(testFile);
        const newDuration = Date.now() - newStartTime;
        
        // 记录结果
        console.log(`性能对比 - ${testCase.name}:`);
        console.log(`  旧系统: ${oldDuration}ms`);
        console.log(`  新系统: ${newDuration}ms`);
        console.log(`  性能提升: ${((oldDuration - newDuration) / oldDuration * 100).toFixed(1)}%`);
        
        // 验证功能一致性
        expect(newResult.success).toBe(oldResult.success);
        
        // 性能要求：新系统不应比旧系统慢20%以上
        const maxSlowdown = 1.2; // 20% slowdown
        expect(newDuration).toBeLessThanOrEqual(oldDuration * maxSlowdown);
      }, 300000); // 5分钟超时
    });
  });
  
  describe('内存使用对比', () => {
    it('应该比较内存使用情况', async () => {
      const memoryProfiler = new MemoryProfiler();
      
      // 测试旧系统内存使用
      const oldMemoryUsage = await memoryProfiler.measure(() => 
        oldSystem.process(await getTestFile('100MB'))
      );
      
      // 测试新系统内存使用
      const newMemoryUsage = await memoryProfiler.measure(() =>
        newSystem.process(await getTestFile('100MB'))
      );
      
      console.log('内存使用对比:');
      console.log(`  旧系统: ${formatBytes(oldMemoryUsage.peak)} 峰值`);
      console.log(`  新系统: ${formatBytes(newMemoryUsage.peak)} 峰值`);
      
      // 内存要求：新系统不应使用超过旧系统150%的内存
      const maxMemoryIncrease = 1.5;
      expect(newMemoryUsage.peak).toBeLessThanOrEqual(oldMemoryUsage.peak * maxMemoryIncrease);
    });
  });
  
  describe('并发处理能力', () => {
    it('应该测试并发处理性能', async () => {
      const concurrencyLevels = [1, 2, 5, 10];
      const results: any[] = [];
      
      for (const concurrency of concurrencyLevels) {
        const testFiles = await Promise.all(
          Array(concurrency).fill(0).map(() => getTestFile('50MB'))
        );
        
        // 测试新系统并发处理
        const startTime = Date.now();
        const promises = testFiles.map(file => newSystem.process(file));
        const newResults = await Promise.all(promises);
        const duration = Date.now() - startTime;
        
        const successCount = newResults.filter(r => r.success).length;
        const throughput = concurrency / (duration / 1000); // 文件/秒
        
        results.push({
          concurrency,
          duration,
          successCount,
          throughput,
        });
        
        console.log(`并发测试 - ${concurrency}并发:`);
        console.log(`  耗时: ${duration}ms`);
        console.log(`  成功率: ${successCount}/${concurrency}`);
        console.log(`  吞吐量: ${throughput.toFixed(2)} 文件/秒`);
      }
      
      // 验证并发处理能力
      expect(results.every(r => r.successCount === r.concurrency)).toBe(true);
    }, 600000); // 10分钟超时
  });
});
```

### 4. 迁移验证测试

#### 向后兼容性测试
```typescript
// tests/validation/BackwardCompatibility.test.ts
describe('向后兼容性验证', () => {
  describe('配置文件兼容性', () => {
    it('应该能够读取旧版配置文件', async () => {
      const oldConfig = {
        audioRecording: {
          enabled: true,
          audioOnlyRooms: [26966466],
          audioFormats: ['.m4a', '.mp3'],
          defaultFormat: '.m4a',
        },
        aiServices: {
          gemini: {
            enabled: true,
            model: 'gemini-1.5-flash',
            temperature: 0.7,
          },
          defaultAnchorName: '岁己SUI',
          defaultFanName: '饼干岁',
        },
        roomSettings: {
          '26966466': {
            audioOnly: true,
            anchorName: '栞栞Shiori',
            fanName: '獭獭栞',
          },
        },
      };
      
      // 使用迁移工具转换配置
      const migrator = new ConfigMigrator();
      const newConfig = await migrator.migrate(oldConfig);
      
      // 验证转换结果
      expect(newConfig.audio.audioOnlyRooms).toEqual([26966466]);
      expect(newConfig.audio.formats).toEqual(['.m4a', '.mp3']);
      expect(newConfig.ai.defaultNames.anchor).toBe('岁己SUI');
      expect(newConfig.ai.defaultNames.fan).toBe('饼干岁');
      expect(newConfig.ai.roomSettings['26966466'].anchorName).toBe('栞栞Shiori');
      expect(newConfig.ai.roomSettings['26966466'].fanName).toBe('獭獭栞');
    });
  });
  
  describe('命令行接口兼容性', () => {
    it('应该支持旧版命令行参数', async () => {
      // 测试旧版命令
      const oldCommand = 'node src/scripts/enhanced_auto_summary.js /path/to/video.mp4 /path/to/danmaku.xml';
      
      // 转换为新版命令
      const newCommand =