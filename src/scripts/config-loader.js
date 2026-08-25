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
    providers: Joi.object().pattern(
        Joi.string(),
        Joi.object({
            type: Joi.string().default('openai'),
            displayName: Joi.string().optional(),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().allow('').optional(),
            baseURL: Joi.string().allow('').optional(),
            proxy: Joi.string().allow('', null).default(''),
            options: Joi.object().unknown(true).optional()
        }).unknown(true)
    ).default({}),
    text: Joi.object({
        enabled: Joi.boolean().default(true),
        provider: Joi.string().default('daiYu'),
        sharedPromptCache: Joi.object({
            enabled: Joi.boolean().default(true),
            explicitRolloutPercent: Joi.number().min(0).max(100).default(0),
            ttl: Joi.string().valid('30m').default('30m')
        }).default(),
        gemini: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            model: Joi.string().default('gemini-3-flash-preview'),
            temperature: Joi.number().default(0.7),
            maxTokens: Joi.number().default(100000),
            proxy: Joi.string().allow('', null).default('')
        }).default(),
        tuZi: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().default('https://api.tu-zi.com'),
            model: Joi.string().default('gemini-3-flash-preview'),
            fallbackModels: Joi.array().items(Joi.string()).default(['gemini-3-flash-preview']),
            temperature: Joi.number().default(0.7),
            maxTokens: Joi.number().default(100000),
            proxy: Joi.string().allow('', null).default('')
        }).default(),
        daiYu: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().default('http://localhost:8080'),
            apiMode: Joi.string().valid('chatCompletions', 'responses').default('chatCompletions'),
            model: Joi.string().default('gpt-5.6-luna'),
            fallbackModels: Joi.array().items(Joi.string()).default(['gemini-3-flash-preview']),
            thinking: Joi.object({
                enabled: Joi.boolean().default(true),
                budgetTokens: Joi.number().integer().min(1024).default(10000),
                reasoningEffort: Joi.string()
                    .valid('none', 'minimal', 'low', 'medium', 'high', 'xhigh')
                    .default('high')
            }).default(),
            temperature: Joi.number().default(0.7),
            maxTokens: Joi.number().default(100000),
            proxy: Joi.string().allow('', null).default('')
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
            proxy: Joi.string().allow('', null).default('')
        }).default(),
        tuZi: Joi.object({
            enabled: Joi.boolean().default(true),
            apiKey: Joi.string().allow('').default(''),
            baseUrl: Joi.string().default('https://api.tu-zi.com'),
            model: Joi.string().default('dall-e-3'),
            proxy: Joi.string().allow('', null).default('')
        }).default(),
        imageGeneration: Joi.object({
            enabled: Joi.boolean().default(true),
            routes: Joi.array().items(Joi.object({
                enabled: Joi.boolean().default(true),
                provider: Joi.string().required(),
                model: Joi.string().default('gpt-image-2'),
                flow: Joi.string().valid('openaiImages', 'tuZiCompatible', 'tuziCompatible', 'tuzi').default('openaiImages'),
                maxAttempts: Joi.number().integer().min(1).default(1),
                timeoutMs: Joi.number().integer().min(1).optional(),
                timeoutSec: Joi.number().integer().min(1).optional(),
                size: Joi.string().default('1:1'),
                quality: Joi.string().default('high'),
                outputFormat: Joi.string().default('png'),
                responseFormat: Joi.string().default('b64_json'),
                useTuziRetry: Joi.boolean().default(false)
            }).unknown(true)).default([])
        }).default()
    }).default(),
    defaultNames: Joi.object({
        anchor: Joi.string().default('主播'),
        fan: Joi.string().default('粉丝')
    }).default(),
    defaultWordLimit: Joi.number().default(100),
    tuZiBalance: Joi.object({
        enabled: Joi.boolean().default(true),
        accessToken: Joi.string().allow('').default(''),
        newApiUser: Joi.string().allow('').default(''),
        lowBalanceThreshold: Joi.number().default(5),
        notifyOnSuccess: Joi.boolean().default(true),
        alertCooldownMinutes: Joi.number().default(30),
        stateFile: Joi.string().allow('').optional()
    }).default(),
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
        formats: Joi.array().items(Joi.string()).default(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac', '.opus']),
        defaultFormat: Joi.string().default('.opus'),
        defaultProfile: Joi.string().default('opus48k'),
        outputProfiles: Joi.object().pattern(Joi.string(), Joi.object({
            format: Joi.string().optional(),
            extension: Joi.string().optional(),
            outputSuffix: Joi.string().allow('').optional(),
            codec: Joi.string().optional(),
            audioCodec: Joi.string().optional(),
            bitrate: Joi.string().optional(),
            ffmpegArgs: Joi.array().items(Joi.string()).optional()
        }).unknown(true)).default({
            opus48k: {
                format: '.opus',
                ffmpegArgs: ['-c:a', 'libopus', '-b:a', '48k']
            },
            aac64k: {
                format: '.m4a',
                outputSuffix: '_64k',
                ffmpegArgs: ['-c:a', 'aac', '-b:a', '64k']
            }
        }),
        ffmpeg: Joi.object({
            path: Joi.string().default('ffmpeg'),
            timeout: Joi.number().default(300000),
            threads: Joi.number().integer().min(0).default(2),
            priority: Joi.string().valid('idle', 'belowNormal', 'normal', 'aboveNormal', 'high').default('belowNormal')
        }).default(),
        storage: Joi.object({
            keepOriginalVideo: Joi.boolean().default(false),
            retentionEnabled: Joi.boolean().default(true),
            convertAfterDays: Joi.number().default(3),
            maxProcessAgeDays: Joi.number().allow(null, false).default(null),
            includeBak: Joi.boolean().default(false),
            scanIntervalHours: Joi.number().default(24),
            maxFileAgeDays: Joi.number().allow(null, false).default(null),
            archiveEnabled: Joi.boolean().default(true),
            moveToArchiveAfterDays: Joi.number().allow(null, false).default(33),
            archiveAfterDays: Joi.number().allow(null, false).default(33),
            archiveExtraDays: Joi.number().allow(null, false).default(30),
            archiveTargetBasePath: Joi.string().default('E:/EFiles/Evideo/DDTV录播-E'),
            deleteBakBeforeArchive: Joi.boolean().default(true),
            additionalArchiveRoomIds: Joi.array().items(Joi.number().integer().positive()).default([]),
            archiveAllRoomDirectories: Joi.boolean().default(false),
            pruneNonMergedVideosBeforeArchiveRoomIds: Joi.array().items(Joi.number().integer().positive()).default([])
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
    clipTopics: Joi.object({
        enabled: Joi.boolean().default(false),
        mode: Joi.string().default('local_review'),
        keywords: Joi.array().items(Joi.string()).default(['岁己', '小岁', '小岁姐', '岁己姐', '饼干岁', 'SUI']),
        aiModel: Joi.string().default('gpt-5.6-luna'),
        ignoredRoomIds: Joi.array().items(Joi.alternatives(Joi.string(), Joi.number())).default([]),
        prePaddingSeconds: Joi.number().default(20),
        postPaddingSeconds: Joi.number().default(35),
        contextPrePaddingSeconds: Joi.number().default(180),
        contextPostPaddingSeconds: Joi.number().default(300),
        maxSegmentsPerBurst: Joi.number().integer().min(1).default(200),
        minClipSeconds: Joi.number().default(30),
        boundaryEndExtensionSeconds: Joi.number().default(60),
        boundarySilenceGapSeconds: Joi.number().default(3),
        maxClipSeconds: Joi.number().default(180),
        mergeGapSeconds: Joi.number().default(45),
        burnSubtitles: Joi.boolean().default(true),
        ffmpegTimeoutMs: Joi.number().integer().min(1000).default(600000),
        outputDirName: Joi.string().default('topic_clips'),
        archiveSourceRoot: Joi.string().allow('').default(''),
        activeOutputRoot: Joi.string().allow('').default(''),
        backgroundQueue: Joi.object({
            enabled: Joi.boolean().default(true),
            directory: Joi.string().allow('').default(''),
            pollMs: Joi.number().integer().min(100).default(500),
            idleGraceMs: Joi.number().integer().min(0).default(1000),
            staleLockMs: Joi.number().integer().min(1000).default(60000)
        }).default(),
        tags: Joi.array().items(Joi.string()).optional(),
        extraTags: Joi.array().items(Joi.string()).default([]),
        autoUpload: Joi.object({
            enabled: Joi.boolean().default(false)
        }).default(),
        notify: Joi.object({
            enabled: Joi.boolean().default(true),
            includeSubtitleContext: Joi.boolean().default(true),
            subtitleContextLines: Joi.number().default(3),
            includeDanmakuContext: Joi.boolean().default(true),
            maxDanmakuLines: Joi.number().default(6),
            danmakuContextSeconds: Joi.number().default(45)
        }).default()
    }).default(),
    ownStreamClips: Joi.object({
        enabled: Joi.boolean().default(false),
        mode: Joi.string().default('local_review'),
        roomIds: Joi.array().items(Joi.alternatives(Joi.string(), Joi.number())).default([]),
        maxCandidates: Joi.number().default(48),
        maxClips: Joi.number().default(24),
        chunkSeconds: Joi.number().default(2700),
        aiConcurrency: Joi.number().default(3),
        clipConcurrency: Joi.number().integer().min(1).default(3),
        clipFfmpegThreads: Joi.number().integer().min(0).default(4),
        clipResourceAdaptive: Joi.object({
            enabled: Joi.boolean().default(true),
            idleConcurrency: Joi.number().integer().min(1).optional(),
            busyConcurrency: Joi.number().integer().min(1).default(1),
            idleFfmpegThreads: Joi.number().integer().min(0).optional(),
            busyFfmpegThreads: Joi.number().integer().min(0).default(1),
            pollIntervalMs: Joi.number().integer().min(1000).default(3000),
            busyCpuPercentThreshold: Joi.number().min(1).max(100).default(70),
            busyGpuUtilizationThreshold: Joi.number().min(1).max(100).default(35),
            foregroundGpuUtilizationThreshold: Joi.number().min(1).max(100).default(20),
            externalGpuActivityThreshold: Joi.number().min(1).max(100).default(25),
            busySamples: Joi.number().integer().min(1).default(2),
            idleSamples: Joi.number().integer().min(1).default(3),
            gameProcessNames: Joi.array().items(Joi.string()).optional(),
            ignoredGpuProcessNames: Joi.array().items(Joi.string()).optional(),
            nvidiaSmiPath: Joi.string().default('nvidia-smi'),
            powerShellPath: Joi.string().default('powershell.exe'),
            tasklistPath: Joi.string().default('tasklist.exe')
        }).default(),
        maxSubtitleCharsPerChunk: Joi.number().default(14000),
        maxDanmakuLinesPerChunk: Joi.number().default(220),
        fullContextDanmakuMergeWindowSeconds: Joi.number().min(1).default(30),
        avoidOverlappingClips: Joi.boolean().default(true),
        finalOverlapToleranceSeconds: Joi.number().min(0).default(0),
        minClipSeconds: Joi.number().default(35),
        maxClipSeconds: Joi.number().default(210),
        burnSubtitles: Joi.boolean().default(true),
        twoStageSubtitleBurn: Joi.boolean().default(true),
        twoStageMode: Joi.string().valid('copy', 'transcode').default('copy'),
        twoStagePreRollSeconds: Joi.number().min(0).default(8),
        twoStagePostRollSeconds: Joi.number().min(0).default(2),
        subtitleVideoEncoder: Joi.string().default('libx264'),
        subtitleVideoPreset: Joi.string().default('ultrafast'),
        subtitleVideoCrf: Joi.number().default(23),
        subtitleVideoCq: Joi.number().default(23),
        subtitleHwaccel: Joi.string().allow('', null).default(''),
        outputDirName: Joi.string().default('own_stream_fun_clips'),
        archiveSourceRoot: Joi.string().allow('').default(''),
        activeOutputRoot: Joi.string().allow('').default(''),
        alignBoundaries: Joi.boolean().default(true),
        boundaryStartBacktrackSeconds: Joi.number().default(12),
        boundaryEndExtendSeconds: Joi.number().default(35),
        boundarySilenceGapSeconds: Joi.number().default(2),
        boundaryTrailingSilenceLookbackSeconds: Joi.number().default(14),
        reactionKeywords: Joi.array().items(Joi.string()).optional(),
        subtitleKeywords: Joi.array().items(Joi.string()).optional(),
        ai: Joi.object({
            enabled: Joi.boolean().default(true),
            strategy: Joi.string().valid('chunked', 'candidate_only', 'full_context').default('chunked'),
            model: Joi.string().allow('', null).default(null),
            timeoutMs: Joi.number().min(1000).default(600000),
            maxCandidateLines: Joi.number().default(32),
            fallbackToLocalRules: Joi.boolean().default(true)
        }).default(),
        parallel: Joi.object({
            enabled: Joi.boolean().default(false),
            danmakuHeatClips: Joi.number().integer().min(0).default(6),
            modelClips: Joi.number().integer().min(0).default(12),
            dedupeAcrossSources: Joi.boolean().default(true),
            overlapToleranceSeconds: Joi.number().min(0).default(12),
            preferModelOnOverlap: Joi.boolean().default(true)
        }).default(),
        emotionScoring: Joi.object({
            enabled: Joi.boolean().default(true),
            minCandidateScore: Joi.number().min(0).default(20),
            transitionScore: Joi.number().min(0).default(20),
            maxContextLines: Joi.number().integer().min(1).default(160),
            emotionScores: Joi.object().pattern(Joi.string(), Joi.number()).default(),
            eventScores: Joi.object().pattern(Joi.string(), Joi.number()).default()
        }).default(),
        selectionPolicy: Joi.object({
            requireTimeCoverage: Joi.boolean().default(false),
            excludedCategories: Joi.array().items(Joi.string()).default([]),
            priorityCategories: Joi.array().items(Joi.string()).default([])
        }).default(),
        residualAudit: Joi.object({
            enabled: Joi.boolean().default(false),
            reviewOnly: Joi.boolean().default(true),
            windowSeconds: Joi.number().min(30).default(90),
            stepSeconds: Joi.number().min(15).default(45),
            maxCandidates: Joi.number().integer().min(1).default(12)
        }).default(),
        notify: Joi.object({
            enabled: Joi.boolean().default(true)
        }).default()
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
    wechatWork: Joi.object({
        enabled: Joi.boolean().default(true),
        webhookUrl: Joi.string().allow('').default('')
    }).default(),
    bilibili: Joi.object({
        enabled: Joi.boolean().default(true),
        upload: Joi.object({
            collectionSectionId: Joi.number().integer().positive().allow(null).default(null),
            collectionSeriesId: Joi.number().integer().positive().allow(null).default(null)
        }).default(),
        polling: Joi.object({
            interval: Joi.number().default(60000),
            maxRetries: Joi.number().default(3),
            retryDelay: Joi.number().default(5000)
        }).default(),
        anchors: Joi.object().pattern(Joi.string(), Joi.object({
            uid: Joi.string(),
            name: Joi.string(),
            enabled: Joi.boolean()
        })).default(),
        delayedReply: Joi.object({
            enabled: Joi.boolean().default(false),
            delayMinutes: Joi.number().default(10),
            maxRetries: Joi.number().default(3),
            retryDelayMinutes: Joi.number().default(5),
            maxTaskAgeHours: Joi.number().default(24),
            maxSupplementalComicWaitMinutes: Joi.number().default(20)
        }).default()
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
    tuZi: Joi.object({
        apiKey: Joi.string().allow('').optional(),
        textApiKey: Joi.string().allow('').optional()
    }).optional(),
    bilibili: Joi.object({
        cookie: Joi.string().allow('').optional(),
        csrf: Joi.string().allow('').optional()
    }).optional(),
    wechatWork: Joi.object({
        webhookUrl: Joi.string().allow('').optional()
    }).optional(),
    tuZiBalance: Joi.object({
        accessToken: Joi.string().allow('').optional(),
        newApiUser: Joi.string().allow('').optional()
    }).optional(),
    providers: Joi.object().pattern(Joi.string(), Joi.object().unknown(true)).optional(),
    ai: Joi.object({
        providers: Joi.object().pattern(Joi.string(), Joi.object().unknown(true)).optional()
    }).unknown(true).optional()
}).default();

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 查找配置文件路径
 * 优先级: /config/production.json > /config/default.json
 */
function findConfigPath() {
    const explicitPath = process.env.CONFIG_PATH;
    if (explicitPath && fs.existsSync(explicitPath)) {
        return explicitPath;
    }
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
        const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(content);
        const { error, value } = schema.validate(data, { allowUnknown: true, stripUnknown: false });
        if (error) {
            console.warn(`⚠ 配置验证警告 (${filePath}): ${error.message}`);
            return data; // 使用原始数据，即使验证失败
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

    if (secrets.tuZi?.apiKey || secrets.tuZi?.textApiKey) {
        transformed.ai = transformed.ai || {};
        // tuZi API Key 用于文本生成（备用方案）
        transformed.ai.text = transformed.ai.text || {};
        transformed.ai.text.tuZi = transformed.ai.text.tuZi || {};
        transformed.ai.text.tuZi.apiKey = secrets.tuZi.textApiKey || secrets.tuZi.apiKey || '';
        // tuZi API Key 也用于漫画生成
        transformed.ai.comic = transformed.ai.comic || {};
        transformed.ai.comic.tuZi = transformed.ai.comic.tuZi || {};
        if (secrets.tuZi.apiKey) {
            transformed.ai.comic.tuZi.apiKey = secrets.tuZi.apiKey;
        }
    }

    if (secrets.bilibili) {
        transformed.bilibili = secrets.bilibili;
    }

    if (secrets.wechatWork) {
        transformed.wechatWork = secrets.wechatWork;
    }

    if (secrets.tuZiBalance) {
        transformed.ai = transformed.ai || {};
        transformed.ai.tuZiBalance = secrets.tuZiBalance;
    }

    if (secrets.providers) {
        transformed.ai = transformed.ai || {};
        transformed.ai.providers = deepMerge(transformed.ai.providers || {}, secrets.providers);
        // 从 providers.daiYu 注入 text.daiYu.apiKey
        if (secrets.providers.daiYu?.apiKey) {
            transformed.ai.text = transformed.ai.text || {};
            transformed.ai.text.daiYu = transformed.ai.text.daiYu || {};
            transformed.ai.text.daiYu.apiKey = secrets.providers.daiYu.apiKey;
            transformed.ai.text.daiYu.baseUrl = secrets.providers.daiYu.baseURL
                ? secrets.providers.daiYu.baseURL.replace(/\/v1$/, '')
                : (secrets.providers.daiYu.baseUrl || 'http://localhost:8080');
        }
    }

    if (secrets.ai?.providers) {
        transformed.ai = transformed.ai || {};
        transformed.ai.providers = deepMerge(transformed.ai.providers || {}, secrets.ai.providers);
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

function getTuZiTextApiKey() {
    return getByPath('ai.text.tuZi.apiKey') ||
           getByPath('aiServices.tuZi.textApiKey') ||
           getByPath('aiServices.tuZi.apiKey') ||
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

function isTuZiTextConfigured() {
    const apiKey = getTuZiTextApiKey();
    return apiKey && apiKey.trim() !== '';
}

/**
 * 获取daiYu API Key
 */
function getDaiYuApiKey() {
    return getByPath('ai.text.daiYu.apiKey') ||
           getByPath('ai.providers.daiYu.apiKey') ||
           '';
}

function isDaiYuTextConfigured() {
    const apiKey = getDaiYuApiKey();
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
    getTuZiTextApiKey,
    getDaiYuApiKey,
    isGeminiConfigured,
    isTuZiConfigured,
    isTuZiTextConfigured,
    isDaiYuTextConfigured,
    getNames,
    getWordLimit,
    clearCache,
    reloadConfig,
    findConfigPath,
    findSecretsPath,
    getByPath
};
