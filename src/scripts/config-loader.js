const fs = require('fs');
const path = require('path');
const Joi = require('joi');

/**
 * 统一配置加载器
 * 使用 Joi 进行类型定义和验证
 */

// 缓存配置，避免重复读取
let cachedConfig = null;

// ============================================================================
// Schema 定义
// ============================================================================

const RoomSettingsSchema = Joi.object({
    anchorName: Joi.string().optional(),
    fanName: Joi.string().optional(),
    wordLimit: Joi.number().optional()
}).pattern(Joi.string(), Joi.any());

const AISchema = Joi.object({
    text: Joi.object({
        enabled: Joi.boolean().default(true),
        provider: Joi.string().default('gemini'),
        gemini: Joi.object({
            apiKey: Joi.string().allow('').default(''),
            model: Joi.string().default('gemini-3-flash-preview'),
            temperature: Joi.number().default(0.7),
            maxTokens: Joi.number().default(100000),
            proxy: Joi.string().allow('').default('')
        }).default(),
        tuZi: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().default('https://api.tu-zi.com'),
            model: Joi.string().default('gemini-3-flash-preview'),
            proxy: Joi.string().allow('').default('')
        }).default()
    }).default(),
    comic: Joi.object({
        enabled: Joi.boolean().default(true),
        provider: Joi.string().default('python'),
        python: Joi.object({
            script: Joi.string().default('ai_comic_generator.py')
        }).default(),
        googleImage: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            model: Joi.string().default('imagen-3.0-generate-001'),
            proxy: Joi.string().allow('').default('')
        }).default(),
        tuZi: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().default('https://api.tu-zi.com'),
            model: Joi.string().default('dall-e-3'),
            proxy: Joi.string().allow('').default('')
        }).default()
    }).default(),
    defaultNames: Joi.object({
        anchor: Joi.string().default('主播'),
        fan: Joi.string().default('粉丝')
    }).default(),
    defaultWordLimit: Joi.number().default(100),
    roomSettings: Joi.object().pattern(Joi.string(), RoomSettingsSchema).default()
}).default();

const ConfigSchema = Joi.object({
    app: Joi.object({
        name: Joi.string().default('danmaku-to-summary'),
        version: Joi.string().default('0.2.0'),
        environment: Joi.string().default('development'),
        logLevel: Joi.string().default('info')
    }).default(),
    webhook: Joi.object({
        enabled: Joi.boolean().default(true),
        port: Joi.number().default(15121),
        host: Joi.string().default('localhost'),
        endpoints: Joi.object({
            ddtv: Joi.object({
                enabled: Joi.boolean().default(true),
                endpoint: Joi.string().default('/ddtv')
            }).default(),
            mikufans: Joi.object({
                enabled: Joi.boolean().default(true),
                endpoint: Joi.string().default('/mikufans'),
                basePath: Joi.string()
            }).default()
        }).default(),
        timeouts: Joi.object({
            fixVideoWait: Joi.number().default(30000),
            fileStableCheck: Joi.number().default(30000),
            processTimeout: Joi.number().default(1800000)
        }).default()
    }).default(),
    audio: Joi.object({
        enabled: Joi.boolean().default(true),
        audioOnlyRooms: Joi.array().items(Joi.number()).default([]),
        formats: Joi.array().items(Joi.string()).default(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac']),
        defaultFormat: Joi.string().default('.m4a'),
        ffmpeg: Joi.object({
            path: Joi.string().default('ffmpeg'),
            timeout: Joi.number().default(300000)
        }).default(),
        storage: Joi.object({
            keepOriginalVideo: Joi.boolean().default(false),
            maxFileAgeDays: Joi.number().default(30)
        }).default()
    }).default(),
    ai: AISchema,
    fusion: Joi.object({
        timeWindowSec: Joi.number().default(30),
        densityPercentile: Joi.number().default(0.35),
        lowEnergySampleRate: Joi.number().default(0.1),
        myUserId: Joi.string().default('14279'),
        stopWords: Joi.array().items(Joi.string()).default(['晚上好', '晚安', '来了', '打call', '拜拜', '卡了', '嗯', '好', '草', '哈哈', '确实', '牛', '可爱']),
        fillerRegex: Joi.string().default('^(呃|那个|就是|然后|哪怕|其实|我觉得|算是|哎呀|有点|怎么说呢|所以|这种|啊|哦)+')
    }).default(),
    storage: Joi.object({
        basePath: Joi.string().default('./output'),
        tempPath: Joi.string().default('./temp'),
        outputPath: Joi.string().default('./output'),
        cleanup: Joi.object({
            enabled: Joi.boolean().default(true),
            intervalHours: Joi.number().default(24),
            maxAgeDays: Joi.number().default(7)
        }).default()
    }).default(),
    monitoring: Joi.object({
        enabled: Joi.boolean().default(false),
        metrics: Joi.object({
            enabled: Joi.boolean().default(false),
            port: Joi.number().default(9090)
        }).default(),
        health: Joi.object({
            enabled: Joi.boolean().default(true),
            endpoint: Joi.string().default('/health')
        }).default()
    }).default(),
    bilibili: Joi.object({
        enabled: Joi.boolean().default(true),
        polling: Joi.object({
            interval: Joi.number().default(60000),
            maxRetries: Joi.number().default(3),
            retryDelay: Joi.number().default(5000)
        }).default(),
        anchors: Joi.object().pattern(Joi.string(), Joi.object({
            uid: Joi.string(),
            name: Joi.string(),
            enabled: Joi.boolean()
        })).default()
    }).default(),
    // 兼容旧格式
    aiServices: Joi.object({
        gemini: Joi.object({ apiKey: Joi.string() }).optional(),
        tuZi: Joi.object({ apiKey: Joi.string() }).optional(),
        defaultAnchorName: Joi.string().optional(),
        defaultFanName: Joi.string().optional()
    }).optional(),
    roomSettings: Joi.object().pattern(Joi.string(), RoomSettingsSchema).optional()
}).default();

// Secrets Schema - 扁平结构，将转换为嵌套
const SecretsSchema = Joi.object({
    gemini: Joi.object({ apiKey: Joi.string().allow('') }).optional(),
    tuZi: Joi.object({ apiKey: Joi.string().allow('') }).optional(),
    bilibili: Joi.object({
        cookie: Joi.string().allow('').optional(),
        csrf: Joi.string().allow('').optional()
    }).optional()
}).default();

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 查找配置文件路径
 * 优先级: /config/production.json > /config/default.json
 */
function findConfigPath() {
    const env = process.env.NODE_ENV || 'development';
    const possiblePaths = [
        path.join(process.cwd(), 'config', env === 'production' ? 'production.json' : 'default.json'),
        path.join(process.cwd(), 'config', 'default.json'),
    ];

    for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }

    return path.join(process.cwd(), 'config', 'default.json');
}

/**
 * 查找secrets配置文件路径
 */
function findSecretsPath() {
    return path.join(process.cwd(), 'config', 'secret.json');
}

/**
 * 读取并验证JSON文件
 */
function readAndValidateJson(filePath, schema) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        const { error, value } = schema.validate(data, { allowUnknown: true, stripUnknown: false });
        if (error) {
            throw new Error(`Validation failed: ${error.message}`);
        }
        return value;
    } catch (error) {
        throw new Error(`Failed to read JSON file ${filePath}: ${error.message}`);
    }
}

/**
 * 将扁平的secrets转换为嵌套结构
 */
function transformSecrets(secrets) {
    const transformed = {};

    if (secrets.gemini?.apiKey) {
        transformed.ai = transformed.ai || {};
        transformed.ai.text = transformed.ai.text || {};
        transformed.ai.text.gemini = transformed.ai.text.gemini || {};
        transformed.ai.text.gemini.apiKey = secrets.gemini.apiKey;
    }

    if (secrets.tuZi?.apiKey) {
        transformed.ai = transformed.ai || {};
        // tuZi API Key 用于文本生成（备用方案）
        transformed.ai.text = transformed.ai.text || {};
        transformed.ai.text.tuZi = transformed.ai.text.tuZi || {};
        transformed.ai.text.tuZi.apiKey = secrets.tuZi.apiKey;
        // tuZi API Key 也用于漫画生成
        transformed.ai.comic = transformed.ai.comic || {};
        transformed.ai.comic.tuZi = transformed.ai.comic.tuZi || {};
        transformed.ai.comic.tuZi.apiKey = secrets.tuZi.apiKey;
    }

    if (secrets.bilibili) {
        transformed.bilibili = secrets.bilibili;
    }

    return transformed;
}

/**
 * 深度合并对象
 */
function deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                if (target[key] && typeof target[key] === 'object') {
                    result[key] = deepMerge(target[key], source[key]);
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

// ============================================================================
// 配置加载
// ============================================================================

/**
 * 获取完整配置（合并主配置和secrets）
 */
function getConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = findConfigPath();
    const secretsPath = findSecretsPath();

    let config = {};

    // 读取主配置
    if (fs.existsSync(configPath)) {
        try {
            config = readAndValidateJson(configPath, ConfigSchema);
            console.log(`✓ 配置文件已加载: ${configPath}`);
        } catch (error) {
            console.warn(`⚠ 加载配置文件失败: ${error.message}`);
        }
    } else {
        console.warn(`⚠ 配置文件不存在: ${configPath}`);
    }

    // 读取secrets并合并
    if (fs.existsSync(secretsPath)) {
        try {
            const secrets = readAndValidateJson(secretsPath, SecretsSchema);
            const transformedSecrets = transformSecrets(secrets);
            config = deepMerge(config, transformedSecrets);
            console.log(`✓ Secrets配置文件已加载: ${secretsPath}`);
        } catch (error) {
            console.warn(`⚠ 加载secrets配置文件失败: ${error.message}`);
        }
    } else {
        console.warn(`⚠ Secrets配置文件不存在: ${secretsPath}`);
    }

    // 最终验证合并后的配置
    const { error, value } = ConfigSchema.validate(config, { allowUnknown: true, stripUnknown: false });
    if (error) {
        console.warn(`⚠ 配置验证警告: ${error.message}`);
    }

    cachedConfig = value || config;
    return cachedConfig;
}

// ============================================================================
// 配置访问器 - 使用路径访问简化代码
// ============================================================================

/**
 * 通过路径获取配置值
 * @param {string} path - 点分隔的路径，如 'ai.text.gemini.apiKey'
 * @param {*} defaultValue - 默认值
 */
function getByPath(pathStr, defaultValue = undefined) {
    const config = getConfig();
    const keys = pathStr.split('.');
    let value = config;

    for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
            value = value[key];
        } else {
            return defaultValue;
        }
    }

    return value !== undefined ? value : defaultValue;
}

/**
 * 获取Gemini API Key
 */
function getGeminiApiKey() {
    return getByPath('ai.text.gemini.apiKey') ||
           getByPath('aiServices.gemini.apiKey') ||
           '';
}

/**
 * 获取tuZi API Key
 */
function getTuZiApiKey() {
    return getByPath('ai.comic.tuZi.apiKey') ||
           getByPath('aiServices.tuZi.apiKey') ||
           getByPath('ai.text.tuZi.apiKey') ||
           '';
}

/**
 * 检查Gemini是否配置
 */
function isGeminiConfigured() {
    const apiKey = getGeminiApiKey();
    return apiKey && apiKey.trim() !== '';
}

/**
 * 检查tuZi是否配置
 */
function isTuZiConfigured() {
    const apiKey = getTuZiApiKey();
    return apiKey && apiKey.trim() !== '';
}

/**
 * 获取主播和粉丝名称
 */
function getNames(roomId) {
    const config = getConfig();
    let anchor = getByPath('ai.defaultNames.anchor') ||
                 getByPath('aiServices.defaultAnchorName') ||
                 '主播';
    let fan = getByPath('ai.defaultNames.fan') ||
              getByPath('aiServices.defaultFanName') ||
              '粉丝';

    if (roomId) {
        const roomStr = String(roomId);
        const roomSettings = getByPath(`ai.roomSettings.${roomStr}`) ||
                             getByPath(`roomSettings.${roomStr}`);
        if (roomSettings) {
            if (roomSettings.anchorName) anchor = roomSettings.anchorName;
            if (roomSettings.fanName) fan = roomSettings.fanName;
        }
    }

    return { anchor, fan };
}

/**
 * 获取字数限制
 */
function getWordLimit(roomId) {
    let wordLimit = getByPath('ai.defaultWordLimit', 100);

    if (roomId) {
        const roomStr = String(roomId);
        const roomSettings = getByPath(`ai.roomSettings.${roomStr}`) ||
                             getByPath(`roomSettings.${roomStr}`);
        if (roomSettings && roomSettings.wordLimit !== undefined) {
            wordLimit = roomSettings.wordLimit;
        }
    }

    return wordLimit;
}

/**
 * 清除缓存
 */
function clearCache() {
    cachedConfig = null;
}

/**
 * 重新加载配置
 */
function reloadConfig() {
    clearCache();
    return getConfig();
}

module.exports = {
    getConfig,
    getGeminiApiKey,
    getTuZiApiKey,
    isGeminiConfigured,
    isTuZiConfigured,
    getNames,
    getWordLimit,
    clearCache,
    reloadConfig,
    findConfigPath,
    findSecretsPath,
    getByPath
};
