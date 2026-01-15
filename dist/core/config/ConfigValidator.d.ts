import { AppConfig, ValidationResult } from './ConfigInterface';
/**
 * 配置验证器
 */
export declare class ConfigValidator {
    /**
     * 验证配置
     */
    static validate(config: any): ValidationResult;
    /**
     * 获取默认配置
     */
    static getDefaultConfig(): AppConfig;
}
