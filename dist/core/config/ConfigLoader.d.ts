import { AppConfig, ConfigLoaderOptions } from './ConfigInterface';
/**
 * 配置加载器
 */
export declare class ConfigLoader {
    private static instance;
    private config;
    private configPath;
    private constructor();
    /**
     * 获取单例实例
     */
    static getInstance(options?: ConfigLoaderOptions): ConfigLoader;
    /**
     * 查找配置文件路径
     */
    private findConfigPath;
    /**
     * 读取JSON文件
     */
    private readJsonFile;
    /**
     * 写入JSON文件
     */
    private writeJsonFile;
    /**
     * 加载配置
     */
    load(options?: ConfigLoaderOptions): Promise<AppConfig>;
    /**
     * 深度合并对象
     */
    private deepMerge;
    /**
     * 应用环境变量覆盖
     */
    private applyEnvironmentVariables;
    /**
     * 设置嵌套值
     */
    private setNestedValue;
    /**
     * 设置环境变量
     */
    private setEnvironmentVariables;
    /**
     * 获取当前配置
     */
    getConfig(): AppConfig;
    /**
     * 重新加载配置
     */
    reload(): Promise<AppConfig>;
    /**
     * 保存配置到文件
     */
    save(config: Partial<AppConfig>, targetPath?: string): Promise<void>;
    /**
     * 获取配置路径
     */
    getConfigPath(): string;
}
