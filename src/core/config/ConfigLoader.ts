import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, ConfigLoaderOptions } from './ConfigInterface';
import { ConfigValidator } from './ConfigValidator';

/**
 * 配置加载器
 */
export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: AppConfig | null = null;
  private configPath: string;

  private constructor(options: ConfigLoaderOptions = {}) {
    this.configPath = options.configPath || this.findConfigPath();
  }

  /**
   * 获取单例实例
   */
  static getInstance(options?: ConfigLoaderOptions): ConfigLoader {
    if (!this.instance) {
      this.instance = new ConfigLoader(options);
    }
    return this.instance;
  }

  /**
   * 获取项目根目录
   */
  private getProjectRoot(): string {
    // 向上查找项目根目录（包含config目录的目录）
    let currentDir = process.cwd();
    
    while (currentDir && currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, 'config'))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    
    // 如果找不到，返回当前目录
    return process.cwd();
  }

  /**
   * 查找配置文件路径
   * 优先级: /config/production.json > /config/default.json
   */
  private findConfigPath(): string {
    const env = process.env.NODE_ENV || 'development';
    const projectRoot = this.getProjectRoot();
    
    const possiblePaths = [
      // 优先读取外部config目录中的环境特定配置
      path.join(projectRoot, 'config', env === 'production' ? 'production.json' : 'default.json'),
      // 其次读取外部config目录中的默认配置
      path.join(projectRoot, 'config', 'default.json'),
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        console.log(`✓ 配置路径优先级: ${configPath}`);
        return configPath;
      }
    }

    // 默认返回 config/default.json
    const defaultPath = path.join(projectRoot, 'config', 'default.json');
    console.warn(`⚠ 配置文件未找到，使用默认路径: ${defaultPath}`);
    return defaultPath;
  }

  /**
   * 读取JSON文件
   */
  private readJsonFile(filePath: string): any {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to read JSON file ${filePath}: ${error}`);
    }
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (target[key] && typeof target[key] === 'object') {
            result[key] = this.deepMerge(target[key], source[key]);
          } else {
            result[key] = source[key];
          }
        } else {
          result[key] = source[key];
        }
      }
    }

    return result;
  }

  /**
   * 加载配置
   */
  async load(options: ConfigLoaderOptions = {}): Promise<AppConfig> {
    const configPath = options.configPath || this.configPath;
    const validate = options.validate !== false;

    console.log(`Loading configuration from: ${configPath}`);

    let config: any = {};

    // 1. 加载主配置文件
    if (fs.existsSync(configPath)) {
      try {
        config = this.readJsonFile(configPath);
        console.log(`Configuration loaded from file: ${configPath}`);
      } catch (error) {
        console.warn(`Failed to load configuration from ${configPath}:`, error);
      }
    } else {
      console.warn(`Configuration file not found at ${configPath}, using defaults`);
    }

    // 2. 加载secrets配置（包含敏感信息，不提交到版本控制）
    // 位置: /config/secret.json
    const projectRoot = this.getProjectRoot();
    const secretsPath = path.join(projectRoot, 'config', 'secret.json');
    if (fs.existsSync(secretsPath)) {
      try {
        const secretsConfig = this.readJsonFile(secretsPath);
        config = this.deepMerge(config, secretsConfig);
        console.log(`Secrets configuration loaded from: ${secretsPath}`);
      } catch (error) {
        console.warn(`Failed to load secrets configuration from ${secretsPath}:`, error);
      }
    }

    // 3. 应用环境变量覆盖
    config = this.applyEnvironmentVariables(config);

    // 4. 处理代理配置
    config = this.applyProxyConfig(config);

    // 5. 验证配置
    if (validate) {
      const validationResult = ConfigValidator.validate(config);
      if (!validationResult.valid) {
        console.error('Configuration validation failed:');
        validationResult.errors.forEach(error => {
          console.error(`  ${error.path}: ${error.message}`);
        });
        throw new Error('Configuration validation failed');
      }
      this.config = validationResult.config;
    } else {
      this.config = config as AppConfig;
    }

    // 6. 设置环境变量
    this.setEnvironmentVariables();

    return this.config!;
  }

  /**
   * 应用环境变量覆盖
   */
  private applyEnvironmentVariables(config: any): any {
    const envConfig = { ...config };

    // 应用环境变量映射
    const envMappings = {
      'APP_ENVIRONMENT': 'app.environment',
      'APP_LOG_LEVEL': 'app.logLevel',
      'WEBHOOK_PORT': 'webhook.port',
      'WEBHOOK_HOST': 'webhook.host',
      'GEMINI_API_KEY': 'ai.text.gemini.apiKey',
      'OPENAI_API_KEY': 'ai.text.openai.apiKey',
      'STORAGE_BASE_PATH': 'storage.basePath',
      'STORAGE_TEMP_PATH': 'storage.tempPath',
      'STORAGE_OUTPUT_PATH': 'storage.outputPath',
    };

    for (const [envVar, configPath] of Object.entries(envMappings)) {
      if (process.env[envVar]) {
        this.setNestedValue(envConfig, configPath, process.env[envVar]);
      }
    }

    return envConfig;
  }

  /**
   * 设置嵌套值
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  /**
   * 应用代理配置
   * 将根级别的proxy字段复制到AI配置中
   */
  private applyProxyConfig(config: any): any {
    const proxyConfig = { ...config };
    
    // 如果根级别有proxy配置
    if (proxyConfig.proxy) {
      const proxyUrl = proxyConfig.proxy;
      
      // 复制到Gemini配置
      if (proxyConfig.ai?.text?.gemini) {
        if (!proxyConfig.ai.text.gemini.proxy) {
          proxyConfig.ai.text.gemini.proxy = proxyUrl;
        }
      }
      
      // 复制到OpenAI配置
      if (proxyConfig.ai?.text?.openai) {
        if (!proxyConfig.ai.text.openai.proxy) {
          proxyConfig.ai.text.openai.proxy = proxyUrl;
        }
      }
      
      console.log(`代理配置已应用到AI服务: ${proxyUrl}`);
    }
    
    return proxyConfig;
  }

  /**
   * 设置环境变量
   */
  private setEnvironmentVariables(): void {
    if (!this.config) return;

    // 设置NODE_ENV（只读属性，不能直接设置）
    // 使用其他方式处理环境变量

    // 设置其他环境变量
    if (this.config.ai.text.gemini?.apiKey) {
      process.env.GEMINI_API_KEY = this.config.ai.text.gemini.apiKey;
    }

    if (this.config.ai.text.openai?.apiKey) {
      process.env.OPENAI_API_KEY = this.config.ai.text.openai.apiKey;
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<AppConfig> {
    this.config = null;
    return this.load();
  }

  /**
   * 保存配置到文件
   */
  async save(config: Partial<AppConfig>, targetPath?: string): Promise<void> {
    const savePath = targetPath || this.configPath;
    const currentConfig = this.config || ConfigValidator.getDefaultConfig();
    const mergedConfig = this.deepMerge(currentConfig, config);

    // 验证配置
    const validationResult = ConfigValidator.validate(mergedConfig);
    if (!validationResult.valid) {
      throw new Error(`Configuration validation failed: ${validationResult.errors.map(e => e.message).join(', ')}`);
    }

    // 保存配置
    fs.writeFileSync(savePath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
    console.log(`Configuration saved to: ${savePath}`);

    // 重新加载配置
    this.config = mergedConfig;
  }

  /**
   * 获取配置路径
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
