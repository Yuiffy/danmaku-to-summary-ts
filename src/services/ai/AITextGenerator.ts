import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getLogger } from '../../core/logging/LogManager';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { AppError } from '../../core/errors/AppError';
import {
  IAITextGenerator,
  AIProvider,
  AIProviderConfig,
  TextGenerationOptions,
  BatchGenerationResult,
  AITextGeneratorStats,
  RoomAIConfig,
  NamesConfig,
  PromptBuildingOptions
} from './IAITextGenerator';

/**
 * AI文本生成服务实现
 */
export class AITextGenerator implements IAITextGenerator {
  private logger = getLogger('AITextGenerator');
  private config: any;
  private provider: AIProvider;
  private providerConfig: AIProviderConfig | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.provider = this.determineProvider();
    this.providerConfig = this.getProviderConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): any {
    try {
      return ConfigProvider.getConfig();
    } catch (error) {
      this.logger.warn('加载AI配置失败，使用默认配置', { error });
      return {
        ai: {
          text: {
            enabled: false,
            provider: 'gemini',
            gemini: {
              enabled: false,
              apiKey: '',
              model: 'gemini-3-flash',
              temperature: 0.7,
              maxTokens: 2000
            },
            tuZi: {
              enabled: false,
              apiKey: '',
              model: 'gemini-3-flash-preview',
              baseUrl: 'https://api.tu-zi.com',
              temperature: 0.7,
              maxTokens: 2000
            }
          },
          defaultNames: {
            anchor: '岁己SUI',
            fan: '饼干岁'
          },
          roomSettings: {}
        }
      };
    }
  }

  /**
   * 确定使用的AI提供者
   */
  private determineProvider(): AIProvider {
    const provider = this.config.ai?.text?.provider || 'gemini';
    this.logger.debug('确定AI提供者', { provider });
    return provider as AIProvider;
  }

  /**
   * 获取提供者配置
   */
  private getProviderConfig(): AIProviderConfig | null {
    const aiConfig = this.config.ai?.text;
    if (!aiConfig) {
      return null;
    }

    switch (this.provider) {
      case 'gemini':
        return {
          enabled: aiConfig.gemini?.enabled ?? false,
          apiKey: aiConfig.gemini?.apiKey,
          model: aiConfig.gemini?.model || 'gemini-3-flash',
          temperature: aiConfig.gemini?.temperature || 0.7,
          maxTokens: aiConfig.gemini?.maxTokens || 2000,
          proxy: aiConfig.gemini?.proxy
        };
      case 'openai':
        return {
          enabled: aiConfig.openai?.enabled ?? false,
          apiKey: aiConfig.openai?.apiKey,
          model: aiConfig.openai?.model || 'gpt-3.5-turbo',
          temperature: aiConfig.openai?.temperature || 0.7,
          maxTokens: aiConfig.openai?.maxTokens || 2000,
          proxy: aiConfig.openai?.proxy
        };
      default:
        return null;
    }
  }

  /**
   * 检查tuZi配置是否有效
   */
  private isTuZiConfigured(): boolean {
    const tuziConfig = this.config.ai?.text?.tuZi;
    return tuziConfig?.enabled && 
           tuziConfig?.apiKey && 
           tuziConfig.apiKey.trim() !== '';
  }

  /**
   * 使用tuZi API生成文本（备用方案）
   */
  private async generateWithTuZi(prompt: string, options?: TextGenerationOptions): Promise<string> {
    const tuziConfig = this.config.ai?.text?.tuZi;
    if (!tuziConfig?.apiKey) {
      throw new AppError('tuZi API密钥未配置', 'CONFIGURATION_ERROR', 400);
    }

    const temperature = options?.temperature ?? tuziConfig.temperature;
    const maxTokens = options?.maxTokens ?? tuziConfig.maxTokens;
    const modelName = options?.model ?? tuziConfig.model;
    const proxy = options?.proxy ?? tuziConfig.proxy;
    const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';

    this.logger.info('调用tuZi API生成文本（Gemini超频备用方案）', {
      model: modelName,
      temperature,
      maxTokens,
      baseUrl,
      proxy: proxy ? '已配置' : '未配置'
    });

    try {
      const apiUrl = `${baseUrl}/v1/chat/completions`;
      
      // 设置代理
      let agent: any = null;
      if (proxy) {
        agent = new HttpsProxyAgent(proxy);
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tuziConfig.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: temperature,
          max_tokens: maxTokens
        }),
        agent: agent,
        timeout: 60000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new AppError(`tuZi API返回错误 ${response.status}: ${errorText}`, 'AI_SERVICE_ERROR', response.status);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content;

      if (!text) {
        throw new AppError('tuZi API返回空结果', 'AI_SERVICE_ERROR', 500);
      }

      this.logger.info('tuZi API调用成功', { textLength: text.length });
      return text;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `tuZi API调用失败: ${error instanceof Error ? error.message : error}`,
        'AI_SERVICE_ERROR',
        500
      );
    }
  }

  /**
   * 检查AI服务是否已配置
   */
  isConfigured(): boolean {
    if (!this.providerConfig?.enabled) {
      return false;
    }

    const hasApiKey = !!this.providerConfig.apiKey && this.providerConfig.apiKey.trim() !== '';
    return hasApiKey;
  }

  /**
   * 检查AI服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      // 尝试一个简单的API调用测试
      await this.generateText('测试连接', { maxTokens: 10 });
      return true;
    } catch (error) {
      this.logger.warn('AI服务不可用', { error: error instanceof Error ? error.message : error });
      return false;
    }
  }

  /**
   * 从文件名提取房间ID
   */
  private extractRoomIdFromFilename(filename: string): string | null {
    const match = filename.match(/^(\d+)_/);
    return match ? match[1] : null;
  }

  /**
   * 获取名称配置
   */
  private getNames(roomId?: string): NamesConfig {
    const defaultNames = this.config.ai?.defaultNames || { anchor: '岁己SUI', fan: '饼干岁' };
    
    if (!roomId) {
      return defaultNames;
    }

    const roomConfig = this.config.ai?.roomSettings?.[roomId] as RoomAIConfig | undefined;
    if (!roomConfig) {
      return defaultNames;
    }

    return {
      anchor: roomConfig.anchorName || defaultNames.anchor,
      fan: roomConfig.fanName || defaultNames.fan
    };
  }

  /**
   * 构建晚安回复提示词
   */
  private buildGoodnightPrompt(highlightContent: string, roomId?: string): string {
    const names = this.getNames(roomId);
    const anchor = names.anchor;
    const fan = names.fan;

    return `【角色设定】

身份：${anchor}的铁粉（自称"${fan}"或"${fan.replace(/岁$/, '')}"）。

性格：喜欢调侃、宠溺主播，有点话痨，对主播的生活琐事和梗如数家珍。

语气：亲昵、幽默、像老朋友一样聊天。常用语气词（如：哈哈、捏、嘛、呜呜），会使用直播间黑话（如：老己、漂亮饭、阿肯苦力等）。

【核心原则（最重要！）】

严格限定素材：只根据用户当前提供的文档/文本内容进行创作。绝对禁止混入该文档以外的任何已知信息、历史直播内容或互联网搜索结果（因为${anchor}的梗很多，AI容易串台，这一点必须强调）。

时效性：根据文档内容判断是早播、午播还是晚播，分别对应"早安"、"午安"或"晚安"的场景。

【写作结构与要素】

开场白：
格式：晚安/早安${anchor}！🌙/☀️
内容：一句话总结今天直播的整体感受（如：含金量极高、含梗量爆炸、辛苦了、被治愈了等）。

正文（核心内容回顾）：
抓细节：从文档中提取3-5个具体的直播亮点。
生活碎碎念（如：洗碗、理发、吃东西、身体不舒服、猫咪嘉嘉的趣事）。
直播事故/趣事（如：迟到理由、设备故障、口误、奇怪的脑洞）。
鉴赏/游戏环节（如：看了什么电影/视频、玩了什么游戏，主播的反应和吐槽）。
歌回：提到了哪些歌，唱得怎么样（好听/糊弄/搞笑）。
互动吐槽：针对上述细节进行粉丝视角的吐槽或夸奖（如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾（情感升华）：
关怀：叮嘱主播注意身体（嗓子、睡眠、吃饭），不要太累。
期待：确认下一次直播的时间（如果文档里提到了）。
落款：—— 永远爱你的/支持你的/陪着你的${fan} 🍪

字数要求：800字以内。

【直播内容摘要】
${highlightContent}

请根据以上直播内容，以${fan}的身份写一篇晚安回复。记住：只使用提供的直播内容，不要添加任何外部信息。`;
  }

  /**
   * 读取高亮文件内容
   */
  private readHighlightFile(highlightPath: string): string {
    try {
      return fs.readFileSync(highlightPath, 'utf8');
    } catch (error) {
      throw new AppError(
        `读取AI_HIGHLIGHT文件失败: ${error instanceof Error ? error.message : error}`,
        'FILE_READ_ERROR',
        500
      );
    }
  }

  /**
   * 保存生成的文本
   */
  private saveGeneratedText(outputPath: string, text: string, highlightPath: string): string {
    try {
      const highlightName = path.basename(highlightPath);
      const timestamp = new Date().toLocaleString('zh-CN');
      const metaInfo = `# 晚安回复（基于${highlightName}）
生成时间: ${timestamp}
---
        
`;

      const fullText = metaInfo + text;
      fs.writeFileSync(outputPath, fullText, 'utf8');
      this.logger.info('晚安回复已保存', { outputPath });
      return outputPath;
    } catch (error) {
      throw new AppError(
        `保存生成文本失败: ${error instanceof Error ? error.message : error}`,
        'FILE_WRITE_ERROR',
        500
      );
    }
  }

  /**
   * 使用Gemini生成文本
   */
  private async generateWithGemini(prompt: string, options?: TextGenerationOptions): Promise<string> {
    if (!this.providerConfig?.apiKey) {
      throw new AppError('Gemini API密钥未配置', 'CONFIGURATION_ERROR', 400);
    }

    const config = this.providerConfig;
    const temperature = options?.temperature ?? config.temperature;
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    const modelName = options?.model ?? config.model;
    const proxy = options?.proxy ?? config.proxy;
    const timeout = options?.timeout ?? 60000;

    this.logger.info('调用Gemini API生成文本', {
      model: modelName,
      temperature,
      maxTokens,
      proxy: proxy ? '已配置' : '未配置'
    });

    // 处理代理配置 - 在try块外声明，以便在catch块中访问
    let originalFetch: any = null;
    try {
      if (proxy) {
        const agent = new HttpsProxyAgent(proxy);
        
        // 临时覆盖全局fetch
        originalFetch = (global as any).fetch;
        (global as any).fetch = (url: any, init?: any) => {
          return fetch(url, {
            ...init,
            agent
          });
        };
      }

      const genAI = new GoogleGenerativeAI(config.apiKey!);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        }
      });

      // 设置超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new AppError('Gemini API调用超时', 'TIMEOUT_ERROR', 408)), timeout);
      });

      const generatePromise = model.generateContent(prompt);
      const result = await Promise.race([generatePromise, timeoutPromise]);
      const response = await result.response;
      const text = response.text();

      // 恢复原始fetch
      if (originalFetch !== null) {
        (global as any).fetch = originalFetch;
      }

      this.logger.info('Gemini API调用成功', { textLength: text.length });
      return text;
    } catch (error) {
      // 确保恢复原始fetch
      if (originalFetch !== null) {
        (global as any).fetch = originalFetch;
      }

      if (error instanceof AppError) {
        throw error;
      }

      // 检查是否是429超频错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      const is429Error = errorMessage.includes('429') || 
                        errorMessage.includes('Too Many Requests') ||
                        errorMessage.includes('RESOURCE_EXHAUSTED') ||
                        errorMessage.includes('quota');

      if (is429Error && this.isTuZiConfigured()) {
        this.logger.warn('Gemini API超频 (429)，尝试使用tuZi API作为备用方案');
        try {
          return await this.generateWithTuZi(prompt, options);
        } catch (tuziError) {
          this.logger.error('tuZi API备用方案也失败', { error: tuziError });
          throw new AppError(
            `Gemini和tuZi API都失败: Gemini - ${errorMessage}, tuZi - ${tuziError instanceof Error ? tuziError.message : tuziError}`,
            'AI_SERVICE_ERROR',
            500
          );
        }
      }

      throw new AppError(
        `Gemini API调用失败: ${errorMessage}`,
        'AI_SERVICE_ERROR',
        500
      );
    }
  }

  /**
   * 生成文本
   */
  async generateText(prompt: string, options?: TextGenerationOptions): Promise<string> {
    if (!this.isConfigured()) {
      throw new AppError('AI服务未配置', 'CONFIGURATION_ERROR', 400);
    }

    switch (this.provider) {
      case 'gemini':
        return await this.generateWithGemini(prompt, options);
      case 'openai':
        throw new AppError('OpenAI提供者暂未实现', 'NOT_IMPLEMENTED_ERROR', 501);
      default:
        throw new AppError(`不支持的AI提供者: ${this.provider}`, 'CONFIGURATION_ERROR', 400);
    }
  }

  /**
   * 生成晚安回复
   */
  async generateGoodnightReply(highlightPath: string, roomId?: string): Promise<string | null> {
    if (!this.config.ai?.text?.enabled) {
      this.logger.info('AI文本生成功能已禁用');
      return null;
    }

    if (!this.isConfigured()) {
      this.logger.warn('AI服务未配置，跳过文本生成');
      return null;
    }

    this.logger.info('处理AI_HIGHLIGHT文件', { highlightPath, roomId });

    try {
      // 检查输入文件
      if (!fs.existsSync(highlightPath)) {
        throw new AppError(`AI_HIGHLIGHT文件不存在: ${highlightPath}`, 'FILE_NOT_FOUND_ERROR', 404);
      }

      // 读取内容
      const highlightContent = this.readHighlightFile(highlightPath);
      this.logger.debug('读取高亮内容完成', { contentLength: highlightContent.length });

      // 如果没有提供roomId，尝试从文件名提取
      let actualRoomId: string | undefined = roomId;
      if (!actualRoomId) {
        const extractedRoomId = this.extractRoomIdFromFilename(path.basename(highlightPath));
        if (extractedRoomId !== null) {
          actualRoomId = extractedRoomId;
        }
      }

      // 构建提示词
      const prompt = this.buildGoodnightPrompt(highlightContent, actualRoomId);
      
      // 调用API生成文本
      const generatedText = await this.generateText(prompt);

      // 确定输出路径
      const dir = path.dirname(highlightPath);
      const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
      const outputPath = path.join(dir, `${baseName}_晚安回复.md`);

      // 保存结果
      return this.saveGeneratedText(outputPath, generatedText, highlightPath);
    } catch (error) {
      // 检查是否是429超频错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      const is429Error = errorMessage.includes('429') ||
                        errorMessage.includes('Too Many Requests') ||
                        errorMessage.includes('RESOURCE_EXHAUSTED') ||
                        errorMessage.includes('quota');

      if (is429Error && this.isTuZiConfigured()) {
        this.logger.warn('生成晚安回复时Gemini API超频，尝试使用tuZi API作为备用方案');
        try {
          // 重新读取高亮内容并构建提示词
          const highlightContent = this.readHighlightFile(highlightPath);
          
          // 如果没有提供roomId，尝试从文件名提取
          let actualRoomId: string | undefined = roomId;
          if (!actualRoomId) {
            const extractedRoomId = this.extractRoomIdFromFilename(path.basename(highlightPath));
            if (extractedRoomId !== null) {
              actualRoomId = extractedRoomId;
            }
          }

          const prompt = this.buildGoodnightPrompt(highlightContent, actualRoomId);
          const generatedText = await this.generateWithTuZi(prompt);

          // 保存结果
          const dir = path.dirname(highlightPath);
          const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
          const outputPath = path.join(dir, `${baseName}_晚安回复.md`);

          return this.saveGeneratedText(outputPath, generatedText, highlightPath);
        } catch (tuziError) {
          this.logger.error('tuZi API备用方案也失败', { error: tuziError instanceof Error ? tuziError.message : tuziError });
        }
      }

      this.logger.error('生成晚安回复失败', {
        highlightPath,
        error: errorMessage
      });
      return null;
    }
  }

  /**
   * 批量生成晚安回复
   */
  async batchGenerateGoodnightReplies(directory: string): Promise<BatchGenerationResult[]> {
    const results: BatchGenerationResult[] = [];

    try {
      const files = fs.readdirSync(directory);
      const highlightFiles = files.filter(f => f.includes('_AI_HIGHLIGHT.txt'));
      
      this.logger.info('批量处理AI_HIGHLIGHT文件', { 
        directory, 
        fileCount: highlightFiles.length 
      });

      for (const file of highlightFiles) {
        const filePath = path.join(directory, file);
        this.logger.debug('处理文件', { file });

        try {
          const result = await this.generateGoodnightReply(filePath);
          if (result) {
            results.push({ 
              file, 
              success: true, 
              output: result 
            });
          } else {
            results.push({ 
              file, 
              success: false, 
              error: '生成失败' 
            });
          }
        } catch (error) {
          this.logger.error('处理文件时出错', { 
            file, 
            error: error instanceof Error ? error.message : error 
          });
          results.push({ 
            file, 
            success: false, 
            error: error instanceof Error ? error.message : '未知错误' 
          });
        }
      }

      // 输出统计信息
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      this.logger.info('批量处理完成', { 
        successCount, 
        failCount, 
        total: highlightFiles.length 
      });

      return results;
    } catch (error) {
      this.logger.error('批量处理失败', { 
        directory, 
        error: error instanceof Error ? error.message : error 
      });
      throw error;
    }
  }

  /**
   * 获取服务统计信息
   */
  getStats(): AITextGeneratorStats {
    const enabled = this.config.ai?.text?.enabled ?? false;
    const provider = this.provider;
    const model = this.providerConfig?.model || '未配置';
    const apiKeyConfigured = !!this.providerConfig?.apiKey && this.providerConfig.apiKey.trim() !== '';
    const proxyConfigured = !!this.providerConfig?.proxy;

    return {
      enabled,
      provider,
      model,
      apiKeyConfigured,
      proxyConfigured
    };
  }

  /**
   * 构建自定义提示词
   */
  buildCustomPrompt(content: string, options: PromptBuildingOptions): string {
    const { anchorName, fanName, includeMetadata = true, wordLimit = 800, additionalInstructions = '' } = options;

    let prompt = `【角色设定】

身份：${anchorName}的铁粉（自称"${fanName}"）。

性格：喜欢调侃、宠溺主播，有点话痨，对主播的生活琐事和梗如数家珍。

语气：亲昵、幽默、像老朋友一样聊天。

【核心原则】
严格限定素材：只根据提供的文档内容进行创作，不要添加任何外部信息。

【写作要求】
字数：${wordLimit}字以内
${additionalInstructions ? `额外要求：${additionalInstructions}\n` : ''}
【内容】
${content}

请根据以上内容，以${fanName}的身份进行创作。`;

    if (includeMetadata) {
      const timestamp = new Date().toISOString();
      prompt = `生成时间: ${timestamp}\n---\n${prompt}`;
    }

    return prompt;
  }

  /**
   * 测试AI服务连接
   */
  async testConnection(): Promise<{ success: boolean; message: string; latency?: number }> {
    const startTime = Date.now();
    
    try {
      const testPrompt = '请回复"连接测试成功"。';
      const response = await this.generateText(testPrompt, { maxTokens: 10 });
      
      const latency = Date.now() - startTime;
      const success = response.includes('连接测试成功') || response.length > 0;
      
      return {
        success,
        message: success ? 'AI服务连接正常' : 'AI服务响应异常',
        latency
      };
    } catch (error) {
      return {
        success: false,
        message: `AI服务连接失败: ${error instanceof Error ? error.message : '未知错误'}`,
        latency: Date.now() - startTime
      };
    }
  }
}

/**
 * 创建AI文本生成服务实例
 */
export function createAITextGenerator(): IAITextGenerator {
  return new AITextGenerator();
}
