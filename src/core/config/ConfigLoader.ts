import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, ConfigLoaderOptions } from './ConfigInterface';
import { ConfigValidator } from './ConfigValidator';
import { deepMerge, findConfigPaths, loadConfigLayers } from './ConfigLayers';
import { getProjectRoot } from './ProjectPaths';

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
   * 优先级: /config/production.json > /config/default.json
   */
  private findConfigPath(): string {
    return findConfigPaths().at(-1) || path.join(getProjectRoot(), 'config', 'default.json');
  }

  /**
   * 加载配置
   */
  async load(options: ConfigLoaderOptions = {}): Promise<AppConfig> {
    const configPath = options.configPath || this.configPath;
    const validate = options.validate !== false;

    console.log(`Loading configuration from: ${configPath}`);

    let config: any = loadConfigLayers({ configPath });

    // 处理代理配置
    config = this.applyProxyConfig(config);

    // 验证配置
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

    // 设置环境变量
    this.setEnvironmentVariables();

    return this.config!;
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
    const mergedConfig = deepMerge(currentConfig as unknown as Record<string, unknown>, config as unknown as Record<string, unknown>);

    // 验证配置
    const validationResult = ConfigValidator.validate(mergedConfig);
    if (!validationResult.valid) {
      throw new Error(`Configuration validation failed: ${validationResult.errors.map(e => e.message).join(', ')}`);
    }

    // 保存配置
    fs.writeFileSync(savePath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
    console.log(`Configuration saved to: ${savePath}`);

    // 重新加载配置
    this.config = mergedConfig as unknown as AppConfig;
  }

  /**
   * 获取配置路径
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
