// Configuration for the existing source-executed topic workflow.
const DEFAULT_CLIP_TOPICS_CONFIG = {
    enabled: false,
    mode: 'local_review',
    keywords: ['岁己', '小岁', '小岁姐', '岁己姐', '饼干岁', 'SUI'],
    aiModel: 'gpt-5.6-luna',
    aiVerify: true,  // AI 验证:过滤唱歌/ASR误识别的假命中
    prePaddingSeconds: 20,
    postPaddingSeconds: 35,
    minClipSeconds: 30,
    boundaryEndExtensionSeconds: 60,
    boundarySilenceGapSeconds: 2,
    maxClipSeconds: 300,
    mergeGapSeconds: 120,
    contextPaddingSeconds: 300,  // 旧版兼容:未配置不对称窗口时前后各取5分钟
    contextPrePaddingSeconds: 180,
    contextPostPaddingSeconds: 300,
    maxSegmentsPerBurst: 200,     // 每个 burst 最多取多少条 SRT
    aiSegmentBurst: true,         // 让 AI 决定切在哪里(而不是固定 paddding)
    burnSubtitles: true,
    ffmpegTimeoutMs: 600000,
    subtitleFontSizeRatio: 0.094,
    subtitlePortraitFontSizeRatio: 0.044,
    outputDirName: 'topic_clips',
    extraTags: [],
    autoUpload: {
        enabled: false
    },
    notify: {
        enabled: true,
        includeSubtitleContext: true,
        subtitleContextLines: 3,
        includeDanmakuContext: true,
        maxDanmakuLines: 6,
        danmakuContextSeconds: 45
    }
};

function getClipTopicsConfig(config = {}) {
    const raw = config.clipTopics || {};
    return {
        ...DEFAULT_CLIP_TOPICS_CONFIG,
        ...raw,
        keywords: Array.isArray(raw.keywords) ? raw.keywords : DEFAULT_CLIP_TOPICS_CONFIG.keywords,
        aiModel: String(raw.aiModel || DEFAULT_CLIP_TOPICS_CONFIG.aiModel),
        ignoredRoomIds: Array.isArray(raw.ignoredRoomIds) ? raw.ignoredRoomIds.map(value => String(value)).filter(Boolean) : [],
        extraTags: Array.isArray(raw.extraTags) ? raw.extraTags : DEFAULT_CLIP_TOPICS_CONFIG.extraTags,
        autoUpload: {
            ...DEFAULT_CLIP_TOPICS_CONFIG.autoUpload,
            ...(raw.autoUpload || {})
        },
        notify: {
            ...DEFAULT_CLIP_TOPICS_CONFIG.notify,
            ...(raw.notify || {})
        }
    };
}

function getTopicClipAiModel(config = {}) {
    return String(config.clipTopics?.aiModel || DEFAULT_CLIP_TOPICS_CONFIG.aiModel).trim()
        || DEFAULT_CLIP_TOPICS_CONFIG.aiModel;
}

module.exports = {
    DEFAULT_CLIP_TOPICS_CONFIG,
    getClipTopicsConfig,
    getTopicClipAiModel
};
