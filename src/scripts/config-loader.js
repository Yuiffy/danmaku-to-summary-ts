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
 * 优先级: /config/production.json > /config/default.json > /src/scripts/config.json
 */
function findConfigPath() {
    const env = process.env.NODE_ENV || 'development';
    const possiblePaths = [
        path.join(process.cwd(), 'config', env === 'production' ? 'production.json' : 'default.json'),
        path.join(process.cwd(), 'config', 'default.json'),
        path.join(process.cwd(), 'config.json'),
        path.join(__dirname, 'config.json'),
    ];

    for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }

    return possiblePaths[1]; // 默认返回 config/default.json
}

/**
 * 查找secrets配置文件路径
 * 优先级: /config/secrets.json > /src/scripts/config.secrets.json
 */
function findSecretsPath() {
    const possiblePaths = [
        path.join(process.cwd(), 'config', 'secrets.json'),
        path.join(__dirname, 'config.secrets.json'),
    ];

    for (const secretsPath of possiblePaths) {
        if (fs.existsSync(secretsPath)) {
            return secretsPath;
        }
    }

    return possiblePaths[0]; // 默认返回 config/secrets.json
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
 * 获取默认配置
 */
function getDefaultConfig() {
    return {
        aiServices: {
            gemini: {
                enabled: true,
                apiKey: '',
                model: 'gemini-2.0-flash',
                temperature: 0.7,
                maxTokens: 2000,
                proxy: ''
            },
            tuZi: {
                enabled: true,
                apiKey: '',
                baseUrl: 'https://api.tu-zi.com',
                model: 'gemini-3-flash-preview',
                textModel: 'gemini-3-flash-preview',
                temperature: 0.7,
                maxTokens: 2000,
                proxy: ''
            }
        },
        ai: {
            text: {
                enabled: true,
                provider: 'gemini',
                gemini: {
                    apiKey: '',
                    model: 'gemini-3-flash',
                    temperature: 0.7,
                    maxTokens: 100000,
                    proxy: ''
                },
                tuZi: {
                    enabled: true,
                    apiKey: '',
                    baseUrl: 'https://api.tu-zi.com',
                    model: 'gemini-3-flash',
                    proxy: ''
                }
            },
            comic: {
                enabled: true,
                provider: 'python',
                python: {
                    script: 'ai_comic_generator.py'
                },
                googleImage: {
                    enabled: true,
                    apiKey: '',
                    model: 'imagen-3.0-generate-001',
                    proxy: ''
                },
                tuZi: {
                    enabled: true,
                    apiKey: '',
                    baseUrl: 'https://api.tu-zi.com',
                    model: 'dall-e-3',
                    proxy: ''
                }
            },
            defaultNames: {
                anchor: '岁己SUI',
                fan: '饼干岁'
            },
            roomSettings: {}
        },
        timeouts: {
            fixVideoWait: 30000,
            fileStableCheck: 30000,
            processTimeout: 1800000,
            aiApiTimeout: 60000,
            ffmpegTimeout: 300000
        },
        audioRecording: {
            enabled: true,
            audioOnlyRooms: [],
            audioFormats: ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'],
            defaultFormat: '.m4a'
        },
        audioProcessing: {
            enabled: true,
            audioOnlyRooms: [],
            keepOriginalVideo: false,
            ffmpegPath: 'ffmpeg'
        },
        roomSettings: {},
        recorders: {
            ddtv: {
                enabled: true,
                endpoint: '/ddtv'
            },
            mikufans: {
                enabled: true,
                endpoint: '/mikufans',
                basePath: 'D:/files/videos/DDTV录播'
            }
        }
    };
}

/**
 * 加载主配置
 */
function loadConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = findConfigPath();
    const defaultConfig = getDefaultConfig();
    let config = { ...defaultConfig };

    if (fs.existsSync(configPath)) {
        try {
            const userConfig = readJsonFile(configPath);
            config = deepMerge(config, userConfig);
            console.log(`✓ 配置文件已加载: ${configPath}`);
        } catch (error) {
            console.warn(`⚠ 加载配置文件失败: ${error.message}`);
        }
    } else {
        console.warn(`⚠ 配置文件不存在: ${configPath}，使用默认配置`);
    }

    cachedConfig = config;
    return config;
}

/**
 * 加载secrets配置
 */
function loadSecrets() {
    if (cachedSecrets) {
        return cachedSecrets;
    }

    const secretsPath = findSecretsPath();
    let secrets = {};

    if (fs.existsSync(secretsPath)) {
        try {
            secrets = readJsonFile(secretsPath);
            console.log(`✓ Secrets配置文件已加载: ${secretsPath}`);
        } catch (error) {
            console.warn(`⚠ 加载secrets配置文件失败: ${error.message}`);
        }
    } else {
        console.warn(`⚠ Secrets配置文件不存在: ${secretsPath}`);
    }

    cachedSecrets = secrets;
    return secrets;
}

/**
 * 获取完整配置（合并主配置和secrets）
 */
function getConfig() {
    const config = loadConfig();
    const secrets = loadSecrets();

    // 合并secrets到主配置
    // 新格式：secrets只包含 apiKey
    if (secrets.gemini?.apiKey) {
        if (config.aiServices?.gemini) {
            config.aiServices.gemini.apiKey = secrets.gemini.apiKey;
        }
        if (config.ai?.text?.gemini) {
            config.ai.text.gemini.apiKey = secrets.gemini.apiKey;
        }
    }

    if (secrets.tuZi?.apiKey) {
        if (config.aiServices?.tuZi) {
            config.aiServices.tuZi.apiKey = secrets.tuZi.apiKey;
        }
        if (config.ai?.text?.tuZi) {
            config.ai.text.tuZi.apiKey = secrets.tuZi.apiKey;
        }
        if (config.ai?.comic?.tuZi) {
            config.ai.comic.tuZi.apiKey = secrets.tuZi.apiKey;
        }
    }

    // 兼容旧格式
    if (secrets.aiServices?.gemini?.apiKey) {
        if (config.aiServices?.gemini) {
            config.aiServices.gemini.apiKey = secrets.aiServices.gemini.apiKey;
        }
        if (config.ai?.text?.gemini) {
            config.ai.text.gemini.apiKey = secrets.aiServices.gemini.apiKey;
        }
    }

    if (secrets.aiServices?.tuZi?.apiKey) {
        if (config.aiServices?.tuZi) {
            config.aiServices.tuZi.apiKey = secrets.aiServices.tuZi.apiKey;
        }
        if (config.ai?.text?.tuZi) {
            config.ai.text.tuZi.apiKey = secrets.aiServices.tuZi.apiKey;
        }
        if (config.ai?.comic?.tuZi) {
            config.ai.comic.tuZi.apiKey = secrets.aiServices.tuZi.apiKey;
        }
    }

    if (secrets.ai?.text?.gemini?.apiKey) {
        if (config.aiServices?.gemini) {
            config.aiServices.gemini.apiKey = secrets.ai.text.gemini.apiKey;
        }
        if (config.ai?.text?.gemini) {
            config.ai.text.gemini.apiKey = secrets.ai.text.gemini.apiKey;
        }
    }

    if (secrets.ai?.text?.tuZi?.apiKey) {
        if (config.aiServices?.tuZi) {
            config.aiServices.tuZi.apiKey = secrets.ai.text.tuZi.apiKey;
        }
        if (config.ai?.text?.tuZi) {
            config.ai.text.tuZi.apiKey = secrets.ai.text.tuZi.apiKey;
        }
    }

    if (secrets.ai?.comic?.tuZi?.apiKey) {
        if (config.aiServices?.tuZi) {
            config.aiServices.tuZi.apiKey = secrets.ai.comic.tuZi.apiKey;
        }
        if (config.ai?.comic?.tuZi) {
            config.ai.comic.tuZi.apiKey = secrets.ai.comic.tuZi.apiKey;
        }
    }

    // B站配置
    if (secrets.bilibili?.cookie) {
        if (!config.bilibili) config.bilibili = {};
        config.bilibili.cookie = secrets.bilibili.cookie;
    }
    if (secrets.bilibili?.csrf) {
        if (!config.bilibili) config.bilibili = {};
        config.bilibili.csrf = secrets.bilibili.csrf;
    }

    return config;
}

/**
 * 获取Gemini API Key
 */
function getGeminiApiKey() {
    const config = getConfig();
    return config.aiServices?.gemini?.apiKey || config.ai?.text?.gemini?.apiKey || '';
}

/**
 * 获取tuZi API Key
 */
function getTuZiApiKey() {
    const config = getConfig();
    return config.aiServices?.tuZi?.apiKey || config.ai?.text?.tuZi?.apiKey || config.ai?.comic?.tuZi?.apiKey || '';
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
    let anchor = config.ai?.defaultNames?.anchor || config.aiServices?.defaultAnchorName || '岁己SUI';
    let fan = config.ai?.defaultNames?.fan || config.aiServices?.defaultFanName || '饼干岁';

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
    loadConfig,
    loadSecrets,
    getGeminiApiKey,
    getTuZiApiKey,
    isGeminiConfigured,
    isTuZiConfigured,
    getNames,
    clearCache,
    reloadConfig,
    findConfigPath,
    findSecretsPath
};
