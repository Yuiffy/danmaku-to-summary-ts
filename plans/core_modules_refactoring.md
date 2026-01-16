# 核心模块重构设计

## 模块重构策略

### 1. 重构原则
- **逐步迁移**：不一次性重写所有代码
- **保持兼容性**：确保现有功能正常工作
- **接口先行**：先定义接口，再实现
- **测试驱动**：为每个模块编写测试

### 2. 模块分类

#### 基础设施模块
- 配置管理
- 日志系统
- 错误处理
- 工具函数

#### 业务服务模块
- Webhook服务
- 音频处理服务
- AI生成服务
- 字幕融合服务
- 流程编排服务

#### 应用层模块
- CLI工具
- Web服务器
- 批处理工具

## 模块详细设计

### 1. Webhook服务模块

#### 当前状态分析
- `webhook_server.js` - 646行，功能混杂
- 处理DDTV和mikufans两种webhook
- 直接调用子进程执行其他脚本
- 缺乏错误处理和重试机制

#### 重构设计

```typescript
// src/services/webhook/WebhookServer.ts
export class WebhookServer {
  constructor(
    private config: WebhookConfig,
    private logger: Logger,
    private eventBus: EventBus,
    private fileProcessor: FileProcessor
  ) {}

  async start(): Promise<void> {
    const app = express();
    
    // 中间件
    app.use(express.json({ limit: '50mb' }));
    app.use(this.requestLogger());
    app.use(this.errorHandler());
    
    // 路由
    app.post('/ddtv', this.handleDDTV.bind(this));
    app.post('/mikufans', this.handleMikufans.bind(this));
    
    // 健康检查
    app.get('/health', this.healthCheck.bind(this));
    
    this.server = app.listen(this.config.port, this.config.host, () => {
      this.logger.info(`Webhook服务器启动在 ${this.config.host}:${this.config.port}`);
    });
  }

  private async handleDDTV(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const handler = new DDTVHandler(this.config, this.logger, this.fileProcessor);
      await handler.process(payload);
      res.status(200).send('Processing started');
    } catch (error) {
      this.logger.error('处理DDTV webhook失败', { error });
      res.status(500).send('Internal server error');
    }
  }

  private async handleMikufans(req: Request, res: Response): Promise<void> {
    try {
      const payload = req.body;
      const handler = new MikufansHandler(this.config, this.logger, this.fileProcessor);
      await handler.process(payload);
      res.status(200).send('Processing started');
    } catch (error) {
      this.logger.error('处理mikufans webhook失败', { error });
      res.status(500).send('Internal server error');
    }
  }
}

// src/services/webhook/DDTVHandler.ts
export class DDTVHandler {
  private processedFiles: Set<string> = new Set();

  async process(payload: any): Promise<void> {
    const eventType = payload.cmd || 'Unknown';
    const roomId = this.extractRoomId(payload);
    
    this.logger.info('处理DDTV事件', { eventType, roomId });

    // 处理不同事件类型
    switch (eventType) {
      case 'SaveBulletScreenFile':
        await this.handleSaveBulletScreenFile(payload, roomId);
        break;
      case 'FileClosed':
        await this.handleFileClosed(payload, roomId);
        break;
      default:
        this.logger.debug('忽略事件类型', { eventType });
    }
  }

  private async handleSaveBulletScreenFile(payload: any, roomId: string): Promise<void> {
    // 提取文件信息
    const videoFiles = this.extractVideoFiles(payload);
    const xmlFiles = this.extractXmlFiles(payload);
    
    for (const videoFile of videoFiles) {
      if (this.processedFiles.has(videoFile)) {
        this.logger.warn('文件已在处理中，跳过', { file: videoFile });
        continue;
      }
      
      this.processedFiles.add(videoFile);
      
      try {
        // 等待文件稳定
        await this.waitFileStable(videoFile);
        
        // 处理文件
        await this.fileProcessor.processVideo(videoFile, xmlFiles, roomId);
        
        // 清理缓存
        setTimeout(() => {
          this.processedFiles.delete(videoFile);
        }, 3600000); // 1小时后清理
      } catch (error) {
        this.logger.error('处理文件失败', { file: videoFile, error });
        this.processedFiles.delete(videoFile);
      }
    }
  }
}
```

### 2. 音频处理服务模块

#### 当前状态分析
- `audio_processor.js` - 270行，功能完整
- 使用ffmpeg转换视频为音频
- 支持音频专用房间配置
- 缺乏单元测试

#### 重构设计

```typescript
// src/services/audio/AudioProcessor.ts
export interface IAudioProcessor {
  processVideo(videoPath: string, roomId?: string): Promise<AudioResult>;
  convertToAudio(videoPath: string, format: string): Promise<string>;
  isAudioOnlyRoom(roomId: string): boolean;
}

export class AudioProcessor implements IAudioProcessor {
  constructor(
    private config: AudioConfig,
    private logger: Logger,
    private ffmpegService: FFmpegService
  ) {}

  async processVideo(videoPath: string, roomId?: string): Promise<AudioResult> {
    this.logger.info('开始处理视频', { videoPath, roomId });

    // 检查是否为音频专用房间
    if (roomId && this.isAudioOnlyRoom(roomId)) {
      return await this.processAudioOnlyRoom(videoPath, roomId);
    }

    // 普通房间，返回原始视频路径
    return {
      success: true,
      filePath: videoPath,
      isAudio: false,
      message: '无需音频处理',
    };
  }

  async processAudioOnlyRoom(videoPath: string, roomId: string): Promise<AudioResult> {
    try {
      // 转换视频为音频
      const audioFormat = this.config.defaultFormat;
      const audioPath = await this.convertToAudio(videoPath, audioFormat);
      
      // 是否删除原始视频
      if (!this.config.storage.keepOriginalVideo) {
        await fs.unlink(videoPath);
        this.logger.info('已删除原始视频', { videoPath });
      }
      
      return {
        success: true,
        filePath: audioPath,
        isAudio: true,
        originalVideoPath: this.config.storage.keepOriginalVideo ? videoPath : undefined,
        message: '音频处理完成',
      };
    } catch (error) {
      this.logger.error('音频处理失败', { videoPath, roomId, error });
      return {
        success: false,
        filePath: videoPath,
        isAudio: false,
        error: error.message,
        message: '音频处理失败，使用原始视频',
      };
    }
  }

  async convertToAudio(videoPath: string, format: string): Promise<string> {
    const audioPath = this.getAudioOutputPath(videoPath, format);
    
    await this.ffmpegService.convertVideoToAudio(videoPath, audioPath, {
      audioCodec: 'copy', // 不重新编码
      removeVideo: true,
    });
    
    return audioPath;
  }

  isAudioOnlyRoom(roomId: string): boolean {
    return this.config.audioOnlyRooms.includes(parseInt(roomId));
  }

  private getAudioOutputPath(videoPath: string, format: string): string {
    const dir = path.dirname(videoPath);
    const name = path.basename(videoPath, path.extname(videoPath));
    return path.join(dir, `${name}${format}`);
  }
}

// src/services/audio/FFmpegService.ts
export class FFmpegService {
  constructor(
    private config: FFmpegConfig,
    private logger: Logger
  ) {}

  async convertVideoToAudio(
    inputPath: string,
    outputPath: string,
    options: FFmpegOptions = {}
  ): Promise<void> {
    const args = this.buildFFmpegArgs(inputPath, outputPath, options);
    
    this.logger.debug('执行ffmpeg命令', { args });
    
    return new Promise((resolve, reject) => {
      const process = spawn(this.config.path, args);
      
      let stderr = '';
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        // 解析进度信息
        if (data.toString().includes('time=')) {
          this.logProgress(data.toString());
        }
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          this.logger.info('ffmpeg转换完成', { outputPath });
          resolve();
        } else {
          this.logger.error('ffmpeg转换失败', { code, stderr });
          reject(new Error(`ffmpeg失败，退出码: ${code}`));
        }
      });
      
      process.on('error', (error) => {
        this.logger.error('ffmpeg进程错误', { error });
        reject(error);
      });
      
      // 设置超时
      setTimeout(() => {
        process.kill('SIGTERM');
        reject(new Error('ffmpeg转换超时'));
      }, this.config.timeout);
    });
  }

  private buildFFmpegArgs(
    inputPath: string,
    outputPath: string,
    options: FFmpegOptions
  ): string[] {
    const args = ['-i', inputPath];
    
    if (options.removeVideo) {
      args.push('-vn');
    }
    
    if (options.audioCodec) {
      args.push('-c:a', options.audioCodec);
    }
    
    if (options.audioBitrate) {
      args.push('-b:a', options.audioBitrate);
    }
    
    args.push('-y', outputPath);
    return args;
  }
}
```

### 3. AI生成服务模块

#### 当前状态分析
- `ai_text_generator.js` - 394行，功能完整
- `ai_comic_generator.js` - 226行，调用Python脚本
- 缺乏统一的AI服务接口
- 配置管理混乱

#### 重构设计

```typescript
// src/services/ai/text/TextGenerator.ts
export interface ITextGenerator {
  generate(highlightPath: string, roomId?: string): Promise<TextResult>;
  batchGenerate(directory: string): Promise<BatchResult[]>;
}

export class TextGenerator implements ITextGenerator {
  constructor(
    private config: TextAIConfig,
    private logger: Logger,
    private geminiService: GeminiService,
    private promptBuilder: PromptBuilder
  ) {}

  async generate(highlightPath: string, roomId?: string): Promise<TextResult> {
    try {
      // 读取highlight文件
      const highlightContent = await this.readHighlightFile(highlightPath);
      
      // 构建提示词
      const prompt = this.promptBuilder.build(highlightContent, roomId);
      
      // 调用AI服务
      const generatedText = await this.geminiService.generateText(prompt);
      
      // 保存结果
      const outputPath = this.getOutputPath(highlightPath);
      await this.saveGeneratedText(outputPath, generatedText, highlightPath);
      
      return {
        success: true,
        inputPath: highlightPath,
        outputPath,
        content: generatedText,
        roomId,
      };
    } catch (error) {
      this.logger.error('文本生成失败', { highlightPath, roomId, error });
      return {
        success: false,
        inputPath: highlightPath,
        error: error.message,
        roomId,
      };
    }
  }

  private getOutputPath(highlightPath: string): string {
    const dir = path.dirname(highlightPath);
    const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
    return path.join(dir, `${baseName}_晚安回复.md`);
  }
}

// src/services/ai/text/GeminiService.ts
export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(
    private config: GeminiConfig,
    private logger: Logger
  ) {
    this.genAI = new GoogleGenerativeAI(this.config.apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: this.config.model,
      generationConfig: {
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxTokens,
      },
    });
  }

  async generateText(prompt: string): Promise<string> {
    this.logger.debug('调用Gemini API', { 
      model: this.config.model,
      promptLength: prompt.length 
    });

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      this.logger.debug('Gemini API调用成功', { 
        responseLength: text.length 
      });
      
      return text;
    } catch (error) {
      this.logger.error('Gemini API调用失败', { error });
      throw new Error(`Gemini API调用失败: ${error.message}`);
    }
  }
}

// src/services/ai/comic/ComicGenerator.ts
export interface IComicGenerator {
  generate(highlightPath: string, roomId?: string): Promise<ComicResult>;
}

export class ComicGenerator implements IComicGenerator {
  constructor(
    private config: ComicAIConfig,
    private logger: Logger,
    private pythonBridge: PythonBridge
  ) {}

  async generate(highlightPath: string, roomId?: string): Promise<ComicResult> {
    try {
      // 获取房间配置
      const roomConfig = roomId ? this.config.roomSettings[roomId] : null;
      
      // 调用Python脚本
      const outputPath = await this.pythonBridge.generateComic(
        highlightPath,
        roomConfig
      );
      
      return {
        success: true,
        inputPath: highlightPath,
        outputPath,
        roomId,
      };
    } catch (error) {
      this.logger.error('漫画生成失败', { highlightPath, roomId, error });
      return {
        success: false,
        inputPath: highlightPath,
        error: error.message,
        roomId,
      };
    }
  }
}
```

### 4. 字幕融合服务模块

#### 当前状态分析
- `do_fusion_summary.js` - 214行，核心算法
- 使用热力图分析弹幕密度
- 智能聚合字幕内容
- 缺乏配置化和可测试性

#### 重构设计

```typescript
// src/services/fusion/FusionProcessor.ts
export interface IFusionProcessor {
  process(inputs: FusionInput[]): Promise<FusionResult>;
}

export class FusionProcessor implements IFusionProcessor {
  constructor(
    private config: FusionConfig,
    private logger: Logger,
    private srtParser: SrtParser,
    private xmlParser: XmlParser,
    private heatmapAnalyzer: HeatmapAnalyzer
  ) {}

  async process(inputs: FusionInput[]): Promise<FusionResult> {
    try {
      // 分离输入文件
      const srtFiles = inputs.filter(input => input.type === 'srt');
      const xmlFiles = inputs.filter(input => input.type === 'xml');
      
      if (srtFiles.length === 0 && xmlFiles.length === 0) {
        throw new Error('没有有效的输入文件');
      }
      
      // 解析弹幕文件
      const danmakuList = await this.xmlParser.parseMultiple(xmlFiles);
      
      // 分析热力图
      const heatmap = this.heatmapAnalyzer.analyze(danmakuList, {
        timeWindowSec: this.config.timeWindowSec,
        densityPercentile: this.config.densityPercentile,
      });
      
      // 解析并过滤字幕
      const subtitles = await this.processSubtitles(srtFiles, heatmap);
      
      // 生成输出
      const outputPath = this.getOutputPath(inputs[0].path);
      const outputContent = this.generateOutput(subtitles, danmakuList, heatmap);
      
      await fs.writeFile(outputPath, outputContent, 'utf8');
      
      return {
        success: true,
        outputPath,
        subtitleCount: subtitles.length,
        danmakuCount: danmakuList.length,
        heatmapThreshold: heatmap.threshold,
      };
    } catch (error) {
      this.logger.error('字幕融合失败', { error });
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async processSubtitles(
    srtFiles: FusionInput[],
    heatmap: HeatmapAnalysis
  ): Promise<Subtitle[]> {
    const allSubtitles: Subtitle[] = [];
    
    for (const srtFile of srtFiles) {
      const subtitles = await this.srtParser.parse(srtFile.path);
      
      for (const subtitle of subtitles) {
        // 应用过滤规则
        if (this.shouldKeepSubtitle(subtitle, heatmap)) {
          allSubtitles.push(subtitle);
        }
      }
    }
    
    // 按时间排序
    return allSubtitles.sort((a, b) => a.startTime - b.startTime);
  }

  private shouldKeepSubtitle(
    subtitle: Subtitle,
    heatmap: HeatmapAnalysis
  ): boolean {
    // 检查停用词
    if (this.config.stopWords.includes(subtitle.text)) {
      return false;
    }
    
    // 检查填充词
    if (this.config.fillerRegex.test(subtitle.text)) {
      return false;
    }
    
    // 检查热力图
    const bucketIndex = Math.floor(subtitle.startTime / (this.config.timeWindowSec * 1000));
    const currentDensity = heatmap.densityArray[bucketIndex] || 0;
    const isHighEnergy = currentDensity >= heatmap.threshold;
    
    // 检查关键词
    const isKeyword = /总结|最后