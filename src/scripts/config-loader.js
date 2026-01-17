const fs = require('fs');
const path = require('path');

/**
 * 统一配置加载器
 * 用于所有JavaScript脚本加载配置
 */

// 缓存配置，避免重复读取
let cachedConfig = null;
let cachedSecrets = null;

/**
 * 查找配置文件路径
 * 优先级: /config/production.json > /config/default.json
 */
function findConfigPath() {
    const env = process.env.NODE_ENV || 'development';
    const possiblePaths = [
        // 优先读取外部config目录中的环境特定配置
        path.join(process.cwd(), 'config', env === 'production' ? 'production.json' : 'default.json'),
        // 其次读取外部config目录中的默认配置
        path.join(process.cwd(), 'config', 'default.json'),
    ];

    for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }

    // 默认返回 config/default.json
    return path.join(process.cwd(), 'config', 'default.json');
}

/**
 * 查找secrets配置文件路径
 * 位置: /config/secret.json
 */
function findSecretsPath() {
    return path.join(process.cwd(), 'config', 'secret.json');
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

/**
 * 读取JSON文件
 */
function readJsonFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to read JSON file ${filePath}: ${error.message}`);
    }
}

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
            config = readJsonFile(configPath);
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
            const secrets = readJsonFile(secretsPath);
            // 将扁平的secrets结构映射到嵌套结构
            const mappedSecrets = {};
            
            // gemini.apiKey -> ai.text.gemini.apiKey
            if (secrets.gemini && secrets.gemini.apiKey) {
                if (!mappedSecrets.ai) mappedSecrets.ai = {};
                if (!mappedSecrets.ai.text) mappedSecrets.ai.text = {};
                if (!mappedSecrets.ai.text.gemini) mappedSecrets.ai.text.gemini = {};
                mappedSecrets.ai.text.gemini.apiKey = secrets.gemini.apiKey;
            }
            
            // tuZi.apiKey -> ai.comic.tuZi.apiKey
            if (secrets.tuZi && secrets.tuZi.apiKey) {
                if (!mappedSecrets.ai) mappedSecrets.ai = {};
                if (!mappedSecrets.ai.comic) mappedSecrets.ai.comic = {};
                if (!mappedSecrets.ai.comic.tuZi) mappedSecrets.ai.comic.tuZi = {};
                mappedSecrets.ai.comic.tuZi.apiKey = secrets.tuZi.apiKey;
            }
            
            // bilibili -> bilibili
            if (secrets.bilibili) {
                mappedSecrets.bilibili = secrets.bilibili;
            }
            
            config = deepMerge(config, mappedSecrets);
            console.log(`✓ Secrets配置文件已加载: ${secretsPath}`);
        } catch (error) {
            console.warn(`⚠ 加载secrets配置文件失败: ${error.message}`);
        }
    } else {
        console.warn(`⚠ Secrets配置文件不存在: ${secretsPath}`);
    }

    cachedConfig = config;
    return config;
}

/**
 * 获取Gemini API Key
 */
function getGeminiApiKey() {
    const config = getConfig();
    return config.ai?.text?.gemini?.apiKey || config.aiServices?.gemini?.apiKey || '';
}

/**
 * 获取tuZi API Key
 */
function getTuZiApiKey() {
    const config = getConfig();
    return config.ai?.comic?.tuZi?.apiKey || config.aiServices?.tuZi?.apiKey || config.ai?.text?.tuZi?.apiKey || '';
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
    let anchor = config.ai?.defaultNames?.anchor || config.aiServices?.defaultAnchorName || '主播';
    let fan = config.ai?.defaultNames?.fan || config.aiServices?.defaultFanName || '粉丝';

    if (roomId) {
        const roomStr = String(roomId);
        // 新格式：ai.roomSettings
        if (config.ai?.roomSettings?.[roomStr]) {
            const r = config.ai.roomSettings[roomStr];
            if (r.anchorName) anchor = r.anchorName;
            if (r.fanName) fan = r.fanName;
        }
        // 旧格式：roomSettings
        if (config.roomSettings?.[roomStr]) {
            const r = config.roomSettings[roomStr];
            if (r.anchorName) anchor = r.anchorName;
            if (r.fanName) fan = r.fanName;
        }
    }

    return { anchor, fan };
}

/**
 * 获取字数限制
 */
function getWordLimit(roomId) {
    const config = getConfig();
    let wordLimit = config.ai?.defaultWordLimit || 100;

    if (roomId) {
        const roomStr = String(roomId);
        // 新格式：ai.roomSettings
        if (config.ai?.roomSettings?.[roomStr]) {
            const r = config.ai.roomSettings[roomStr];
            if (r.wordLimit !== undefined) wordLimit = r.wordLimit;
        }
        // 旧格式：roomSettings
        if (config.roomSettings?.[roomStr]) {
            const r = config.roomSettings[roomStr];
            if (r.wordLimit !== undefined) wordLimit = r.wordLimit;
        }
    }

    return wordLimit;
}

/**
 * 清除缓存
 */
function clearCache() {
    cachedConfig = null;
    cachedSecrets = null;
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
    findSecretsPath
};
