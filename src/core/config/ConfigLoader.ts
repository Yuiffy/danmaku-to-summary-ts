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
   * 查找配置文件路径
   * 优先级: /config/production.json > /config/default.json > /src/scripts/config.json
   */
  private findConfigPath(): string {
    const env = process.env.NODE_ENV || 'development';
    const possiblePaths = [
      // 优先读取外部config目录中的环境特定配置
      path.join(process.cwd(), 'config', env === 'production' ? 'production.json' : 'default.json'),
      // 其次读取外部config目录中的默认配置
      path.join(process.cwd(), 'config', 'default.json'),
      // 再次读取根目录config.json
      path.join(process.cwd(), 'config.json'),
      // 最后回退到scripts目录
      path.join(process.cwd(), 'src', 'scripts', 'config.json'),
      // 添加secrets配置文件
      path.join(process.cwd(), 'src', 'scripts', 'config.secrets.json'),
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        console.log(`✓ 配置路径优先级: ${configPath}`);
        return configPath;
      }
    }

    // 如果找不到配置文件，返回默认路径
    const defaultPath = path.join(process.cwd(), 'config', 'default.json');
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
   * 写入JSON文件
   */
  private writeJsonFile(filePath: string, data: any): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write JSON file ${filePath}: ${error}`);
    }
  }

  /**
   * 加载配置
   */
  async load(options: ConfigLoaderOptions = {}): Promise<AppConfig> {
    const configPath = options.configPath || this.configPath;
    const validate = options.validate !== false;

    console.log(`Loading configuration from: ${configPath}`);

    let config: any = {};

    // 1. 加载默认配置
    const defaultConfig = ConfigValidator.getDefaultConfig();
    config = { ...defaultConfig };

    // 2. 尝试加载配置文件
    if (fs.existsSync(configPath)) {
      try {
        const fileConfig = this.readJsonFile(configPath);
        config = this.deepMerge(config, fileConfig);
        console.log(`Configuration loaded from file: ${configPath}`);
      } catch (error) {
        console.warn(`Failed to load configuration from ${configPath}:`, error);
      }
    } else {
      console.warn(`Configuration file not found at ${configPath}, using defaults`);
    }

    // 3. 加载环境特定配置
    const env = options.environment || process.env.NODE_ENV || 'development';
    const envConfigPath = configPath.replace(/\.json$/, `.${env}.json`);
    if (fs.existsSync(envConfigPath)) {
      try {
        const envConfig = this.readJsonFile(envConfigPath);
        config = this.deepMerge(config, envConfig);
        console.log(`Environment configuration loaded from: ${envConfigPath}`);
      } catch (error) {
        console.warn(`Failed to load environment configuration from ${envConfigPath}:`, error);
      }
    }

    // 4. 加载本地配置（不提交到版本控制）
    const localConfigPath = configPath.replace(/\.json$/, '.local.json');
    if (fs.existsSync(localConfigPath)) {
      try {
        const localConfig = this.readJsonFile(localConfigPath);
        config = this.deepMerge(config, localConfig);
        console.log(`Local configuration loaded from: ${localConfigPath}`);
      } catch (error) {
        console.warn(`Failed to load local configuration from ${localConfigPath}:`, error);
      }
    }

    // 5. 加载secrets配置（包含敏感信息，不提交到版本控制）
    const secretsConfigPaths = [
      path.join(process.cwd(), 'config', 'secrets.json'),
      path.join(process.cwd(), 'src', 'scripts', 'config.secrets.json'),
    ];
    for (const secretsPath of secretsConfigPaths) {
      if (fs.existsSync(secretsPath)) {
        try {
          const secretsConfig = this.readJsonFile(secretsPath);
          config = this.deepMerge(config, secretsConfig);
          console.log(`Secrets configuration loaded from: ${secretsPath}`);
          break; // 找到第一个secrets文件后停止
        } catch (error) {
          console.warn(`Failed to load secrets configuration from ${secretsPath}:`, error);
        }
      }
    }

    // 6. 应用环境变量覆盖
    config = this.applyEnvironmentVariables(config);

    // 7. 处理代理配置
    config = this.applyProxyConfig(config);

    // 8. 验证配置
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

    // 9. 设置环境变量
    this.setEnvironmentVariables();

    return this.config!;
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
    this.writeJsonFile(savePath, mergedConfig);
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