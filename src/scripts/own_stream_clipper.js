const { buildFallbackTitle, normalizeAiClips, isRerankResponseValid, clipsConflict, buildGroundingReviewLine } = require('./clipping/selection_result');
const { requestSelectionText, validSelectionResponse } = require('./clipping/selection_request');
const { buildRerankEvidence } = require('./clipping/rerank_evidence');
const { buildPersonEvidenceContext } = require('./clipping/person_evidence');
const {
    timeStringToSeconds,
    clamp,
    getEmotionEvidenceForWindow,
    buildEmotionCandidates,
    attachEmotionEvidenceToClips,
    buildCandidateWindows,
    getWindowDanmakuEvidence,
    buildRecallCandidatePool,
    buildChunkSources,
    dedupePlannedClips,
    alignClipToSubtitleBoundaries,
    alignClipsToSubtitleBoundaries,
    removeOverlappingClips
} = require('./clipping/own_selection');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const { spawnSync } = require('child_process');
const {
    sendWeChatMarkdown,
    splitWeChatMarkdown,
    WECHAT_WORK_MARKDOWN_MAX_BYTES
} = require('./wechat_work_markdown');
const asrBackends = require('./asr/asr_backends');
const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const { postProcessAiClipMetadata } = require('./ai_clip_metadata');
const fullLiveContext = require('./full_live_context');
const { buildSubtitleEvidence, cuesForWindow, formatEvidenceCues, resolveEvidenceBoundaries,
    linkClipEvidence, revalidateClipEvidence, parseClipResponse } = require('./clipping/subtitle_evidence');
const residualAudit = require('./own_stream_residual_audit');
const { resolveClipOutputRoot } = require('./clipping/output_path');
const { createClipResourceAdaptiveScheduler } = require('./clipping/resource_scheduler');

const {
    emotionMomentScore,
    buildEmotionContextLines,
    buildDanmakuDensity,
    aggregateDanmakuForFullContext,
    buildFullContextHeatLines,
    buildFullContextSource
} = fullLiveContext;

const DEFAULT_OWN_STREAM_CLIPS_CONFIG = {
    enabled: false,
    mode: 'local_review',
    roomIds: [],
    windowSeconds: 110,
    prePaddingSeconds: 18,
    postPaddingSeconds: 26,
    mergeGapSeconds: 45,
    maxClipSeconds: 210,
    minClipSeconds: 35,
    maxCandidates: 80,
    maxClips: 50,
    chunkSeconds: 2700,
    aiConcurrency: 3,
    clipConcurrency: 2,
    clipFfmpegThreads: 2,
    clipResourceAdaptive: {
        enabled: true,
        busyConcurrency: 1,
        busyFfmpegThreads: 1,
        pollIntervalMs: 3000,
        busyCpuPercentThreshold: 70,
        busyGpuUtilizationThreshold: 35,
        foregroundGpuUtilizationThreshold: 20,
        externalGpuActivityThreshold: 25,
        busySamples: 2,
        idleSamples: 3
    },
    maxSubtitleCharsPerChunk: 14000,
    maxDanmakuLinesPerChunk: 220,
    fullContextDanmakuMergeWindowSeconds: 30,
    avoidOverlappingClips: true,
    finalOverlapToleranceSeconds: 0,
    alignBoundaries: true,
    boundaryStartBacktrackSeconds: 12,
    boundaryEndExtendSeconds: 35,
    boundarySilenceGapSeconds: 2.0,
    boundaryTrailingSilenceLookbackSeconds: 14,
    densityWindowSeconds: 30,
    densityPercentile: 0.2,
    minDanmakuCount: 12,
    burnSubtitles: true,
    twoStageSubtitleBurn: true,
    twoStageMode: 'copy',
    twoStagePreRollSeconds: 8,
    twoStagePostRollSeconds: 2,
    subtitleVideoEncoder: 'h264_nvenc',
    subtitleVideoPreset: 'p4',
    subtitleVideoCrf: 23,
    subtitleVideoCq: 23,
    subtitleHwaccel: 'cuda',
    subtitleFontSizeRatio: 0.094,
    subtitlePortraitFontSizeRatio: 0.044,
    outputDirName: 'own_stream_fun_clips',
    ai: {
        enabled: true,
        strategy: 'staged',
        model: null,
        timeoutMs: 600000,
        maxCandidateLines: 100,
        maxCandidateSubtitleChars: 520,
        maxCandidateDanmakuLines: 14,
        fallbackToLocalRules: true
    },
    parallel: {
        enabled: false,
        danmakuHeatClips: 6,
        modelClips: 12,
        dedupeAcrossSources: true,
        overlapToleranceSeconds: 12,
        preferModelOnOverlap: true
    },
    emotionScoring: {
        enabled: true,
        minCandidateScore: 20,
        transitionScore: 20,
        maxContextLines: 160,
        emotionScores: {
            SURPRISE: 38,
            FEAR: 36,
            SAD: 32,
            DISGUST: 32,
            CONTEMPT: 26,
            ANGRY: 14,
            HAPPY: 6,
            NEUTRAL: 0
        },
        eventScores: {
            Cry: 44,
            Laughter: 34,
            Applause: 28,
            Sneeze: 8,
            BGM: 0,
            Speech: 0
        }
    },
    selectionPolicy: {
        requireTimeCoverage: false,
        excludedCategories: [],
        priorityCategories: []
    },
    residualAudit: {
        enabled: false,
        reviewOnly: true,
        windowSeconds: 90,
        stepSeconds: 45,
        maxCandidates: 12
    },
    notify: {
        enabled: true
    },
    reactionKeywords: [
        '哈哈', '笑死', '绷不住', '乐', '可爱', '好可爱', '太可爱', '萌',
        '傻', '笨', '呆', '憨', '逆天', '怪', '特别', '天才', '神人',
        '啊？', '？', '草', '什么东西', '怎么会', '小岁'
    ],
    subtitleKeywords: [
        '我觉得', '我的想法', '我认为', '为什么', '但是', '不对',
        '好奇怪', '好像', '我刚刚', '我忘了', '我傻', '笨蛋', '完蛋',
        '怎么办', '不是', '等一下', '等下'
    ]
};

const OWN_STREAM_SOURCE_ATTRIBUTION_RULE = '来源归属必须严格按输入分区：直播音轨字幕与观众弹幕是两类独立来源，标题、封面文案、简介和理由不得把一方的发言或行为归给另一方。';
const CUE_BOUNDARY_PROMPT_LINES = [
    'startCueId 要包含起因与铺垫，不能直接从笑点中间开始；endCueId 要包含解释、后续反应和完整收束。',
    '短暂停顿后仍在解释同一件事时要保留后续；遇到真正的新话题才结束。不要截断句子，只需返回表中已有的 cue ID，由程序处理精确时间。'
];

function getOwnStreamClipLabel(rootConfig = {}, roomId = null, streamerName = '') {
    const roomKey = roomId ? String(roomId) : null;
    const entry = Object.values(rootConfig.ai?.streamerRegistry || {}).find(item => {
        const roomIds = Array.isArray(item?.roomIds) ? item.roomIds.map(value => String(value)) : [];
        return roomKey && roomIds.includes(roomKey);
    });
    return String(entry?.aiClipName || streamerName || '小岁').trim() || '小岁';
}

function buildOwnStreamClipCopyPromptLines(generator, streamerName = '岁己SUI', boundaryFields = 'startTime-endTime') {
    const hostName = String(streamerName || '主播').trim() || '主播';
    return [
        `片段时间与文案必须一一对应：先读取当前 clips 对象 ${boundaryFields} 范围内的直播音轨字幕和同一范围内的观众弹幕，再填写该对象的 title、coverText、description 和 reason。`,
        '直播标题、录制时间和整场上下文只用于确认来源，不是当前片段的内容证据；禁止把直播标题中的型号、人物、事件或梗直接套进任何片段。',
        '严格禁止跨窗口串题：每个 clips 对象只能使用自己时间范围内能核实的内容，不得借用其他候选或其他时间窗口的文案。输出前逐条核对，若时间窗口与文案不匹配就删除该对象，不要猜测或保留错误标题。',
        ...generator.buildClipTitlePromptLines({ outputMode: 'jsonTitle', streamerName: hostName }),
        ...generator.buildCoverTextPromptLines(),
        ...generator.buildClipDescriptionPromptLines(),
        '字段必须分工：description 是公开简介，只写片中具体内容；reason 是内部选材理由，可记录字幕完整性、弹幕反应和情绪信号。不得把 reason 复述或改写进 description。',
        '听闻或转述不等于亲历；说出或引用一句话不等于现场创作。回忆/转述要交代语境，没有直接证据不要写现编、原创、亲自体验。',
        '多个人或多次事件必须保留谁先做什么、后来谁回应什么；不合并成同一次因果关系。观众意见不是主播行为。'
    ];
}

function getOwnStreamClipsConfig(config = {}) {
    const raw = config.ownStreamClips || {};
    return {
        ...DEFAULT_OWN_STREAM_CLIPS_CONFIG,
        ...raw,
        reactionKeywords: Array.isArray(raw.reactionKeywords)
            ? raw.reactionKeywords
            : DEFAULT_OWN_STREAM_CLIPS_CONFIG.reactionKeywords,
        subtitleKeywords: Array.isArray(raw.subtitleKeywords)
            ? raw.subtitleKeywords
            : DEFAULT_OWN_STREAM_CLIPS_CONFIG.subtitleKeywords,
        roomIds: Array.isArray(raw.roomIds)
            ? raw.roomIds.map(value => String(value)).filter(Boolean)
            : DEFAULT_OWN_STREAM_CLIPS_CONFIG.roomIds,
        ai: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.ai,
            ...(raw.ai || {})
        },
        parallel: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.parallel,
            ...(raw.parallel || {})
        },
        clipResourceAdaptive: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.clipResourceAdaptive,
            ...(raw.clipResourceAdaptive || {})
        },
        emotionScoring: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.emotionScoring,
            ...(raw.emotionScoring || {}),
            emotionScores: {
                ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.emotionScoring.emotionScores,
                ...(raw.emotionScoring?.emotionScores || {})
            },
            eventScores: {
                ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.emotionScoring.eventScores,
                ...(raw.emotionScoring?.eventScores || {})
            }
        },
        selectionPolicy: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy,
            ...(raw.selectionPolicy || {}),
            excludedCategories: Array.isArray(raw.selectionPolicy?.excludedCategories)
                ? raw.selectionPolicy.excludedCategories
                : DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy.excludedCategories,
            priorityCategories: Array.isArray(raw.selectionPolicy?.priorityCategories)
                ? raw.selectionPolicy.priorityCategories
                : DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy.priorityCategories
        },
        residualAudit: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.residualAudit,
            ...(raw.residualAudit || {})
        },
        notify: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.notify,
            ...(raw.notify || {})
        }
    };
}

function buildCutClipMediaConfig(config = {}, options = {}) {
    return {
        burnSubtitles: config.burnSubtitles,
        twoStageSubtitleBurn: config.twoStageSubtitleBurn,
        twoStageMode: config.twoStageMode,
        twoStagePreRollSeconds: config.twoStagePreRollSeconds,
        twoStagePostRollSeconds: config.twoStagePostRollSeconds,
        preserveCoverSource: true,
        subtitleVideoEncoder: config.subtitleVideoEncoder,
        subtitleVideoPreset: config.subtitleVideoPreset,
        subtitleVideoCrf: config.subtitleVideoCrf,
        subtitleVideoCq: config.subtitleVideoCq,
        subtitleHwaccel: config.subtitleHwaccel,
        subtitleFontSizeRatio: config.subtitleFontSizeRatio,
        subtitlePortraitFontSizeRatio: config.subtitlePortraitFontSizeRatio,
        subtitleMinFontSize: config.subtitleMinFontSize,
        subtitleMaxFontSize: config.subtitleMaxFontSize,
        subtitleMaxCharsPerLine: config.subtitleMaxCharsPerLine,
        subtitleFontName: config.subtitleFontName,
        subtitlePlayResX: config.subtitlePlayResX,
        subtitlePlayResY: config.subtitlePlayResY,
        subtitleMarginL: config.subtitleMarginL,
        subtitleMarginR: config.subtitleMarginR,
        subtitleMarginHorizontal: config.subtitleMarginHorizontal,
        subtitleMarginV: config.subtitleMarginV,
        subtitleGlyphWidthRatio: config.subtitleGlyphWidthRatio,
        ffmpegThreads: config.clipFfmpegThreads,
        ffmpegPath: options.ffmpegPath
    };
}

function buildSelectionPolicyPromptLines(policy = {}) {
    const lines = [
        '内容类型不做默认排除：电影、感谢、唱歌、普通聊天等，只按是否有独立内容价值、完整事件、观点、反应或反差判断。'
    ];
    const excluded = Array.isArray(policy.excludedCategories)
        ? policy.excludedCategories.map(value => String(value).trim()).filter(Boolean)
        : [];
    const priority = Array.isArray(policy.priorityCategories)
        ? policy.priorityCategories.map(value => String(value).trim()).filter(Boolean)
        : [];
    if (excluded.length) lines.push(`本次任务明确排除这些类型：${excluded.join('、')}。`);
    if (priority.length) lines.push(`本次任务优先关注这些类型：${priority.join('、')}。`);
    if (policy.requireTimeCoverage === true) {
        lines.push('本次任务要求覆盖不同时间段；不要把名额全部集中在同一小段话题内。');
    }
    return lines;
}

function writeResidualAuditForOwnStream({ options = {}, config = {}, outputRoot, planPath, clips = [] } = {}) {
    const auditConfig = config.residualAudit || {};
    if (auditConfig.enabled !== true) return null;
    const outputPath = path.join(outputRoot, 'RESIDUAL_REVIEW.md');
    try {
        const result = residualAudit.writeResidualReview({
            mediaPath: options.mediaPath,
            srtPath: options.srtPath,
            xmlPath: options.xmlPath,
            planPath,
            selectedWindows: clips.map(clip => ({ start: clip.start, end: clip.end })),
            outputPath,
            windowSeconds: auditConfig.windowSeconds,
            stepSeconds: auditConfig.stepSeconds,
            maxCandidates: auditConfig.maxCandidates
        });
        console.log(`Residual review: ${result.outputPath} (${result.candidates.length} candidates)`);
        return result;
    } catch (error) {
        console.warn(`Residual audit failed, automatic review kept: ${error.message}`);
        return null;
    }
}

function formatClock(seconds) {
    return topicClipper.formatClock(seconds);
}

function formatProcessingDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === '') return '未知';
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return '未知';
    if (value < 1000) return `${(value / 1000).toFixed(1)}秒`;
    let totalSeconds = Math.round(value / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
    return parts.join('');
}

function formatPercent(value) {
    if (value === null || value === undefined || value === '') return '不可用';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '不可用';
    return `${Number(numeric.toFixed(1))}%`;
}

function formatMemoryMb(value) {
    if (value === null || value === undefined || value === '') return '不可用';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '不可用';
    if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} GB`;
    return `${Math.round(numeric)} MB`;
}

function summarizeResourcePeaks(peaks = []) {
    const entries = (Array.isArray(peaks) ? peaks : [])
        .filter(item => item && typeof item === 'object');
    const weightedAverage = (valueKey, weightKey, fallbackKey = null) => {
        let weightedTotal = 0;
        let weightTotal = 0;
        for (const entry of entries) {
            const value = Number(entry[valueKey]);
            const fallback = fallbackKey ? Number(entry[fallbackKey]) : null;
            const resolved = Number.isFinite(value) ? value : fallback;
            if (!Number.isFinite(resolved)) continue;
            const weight = Math.max(1, Number(entry[weightKey]) || 1);
            weightedTotal += resolved * weight;
            weightTotal += weight;
        }
        return weightTotal > 0 ? Number((weightedTotal / weightTotal).toFixed(2)) : null;
    };
    const maximum = key => {
        const values = entries.map(entry => Number(entry[key])).filter(Number.isFinite);
        return values.length > 0 ? Number(Math.max(...values).toFixed(2)) : null;
    };
    const sum = key => entries.reduce((total, entry) => {
        const value = Number(entry[key]);
        return total + (Number.isFinite(value) ? value : 0);
    }, 0);
    const gpuUtilPeakPct = maximum('gpuUtilPeakPct');
    const gpuAvailable = entries.some(entry => (
        entry.gpuAvailable === true || Number.isFinite(Number(entry.gpuUtilPeakPct))
    ));

    return {
        stageCount: entries.length,
        hostCpuAvgPct: weightedAverage('hostCpuAvgPct', 'samples', 'hostCpuPeakPct'),
        hostCpuPeakPct: maximum('hostCpuPeakPct'),
        gpuAvailable,
        gpuUtilAvgPct: weightedAverage('gpuUtilAvgPct', 'gpuSamples', 'gpuUtilPeakPct'),
        gpuUtilPeakPct,
        gpuMemoryUsedPeakMb: maximum('gpuMemoryUsedPeakMb'),
        gpuMemoryTotalMb: maximum('gpuMemoryTotalMb'),
        gpuSamples: sum('gpuSamples'),
        gpuQueryErrors: sum('gpuQueryErrors')
    };
}

function buildClipProcessingStats(results = [], elapsedMs, startedAt = null, finishedAt = null) {
    const timings = (Array.isArray(results) ? results : [])
        .map(result => Number(result?.processing?.elapsedMs))
        .filter(value => Number.isFinite(value) && value >= 0);
    const totalClipElapsedMs = timings.reduce((total, value) => total + value, 0);
    const resourcePeaks = (Array.isArray(results) ? results : [])
        .flatMap(result => Array.isArray(result?.processing?.resourcePeaks)
            ? result.processing.resourcePeaks
            : []);

    return {
        version: 1,
        startedAt,
        finishedAt,
        totalElapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.round(Number(elapsedMs)) : null,
        averageClipElapsedMs: timings.length > 0
            ? Math.round(totalClipElapsedMs / timings.length)
            : null,
        totalClipElapsedMs: Math.round(totalClipElapsedMs),
        clipCount: Array.isArray(results) ? results.length : 0,
        timedClipCount: timings.length,
        resource: summarizeResourcePeaks(resourcePeaks)
    };
}

function buildProcessingSummaryLines(stats = null) {
    if (!stats || typeof stats !== 'object') return [];
    const clipCount = Number.isFinite(Number(stats.clipCount)) ? Number(stats.clipCount) : 0;
    const average = formatProcessingDuration(stats.averageClipElapsedMs);
    const total = formatProcessingDuration(stats.totalElapsedMs);
    const resource = stats.resource || {};
    const memory = resource.gpuAvailable
        ? `${formatMemoryMb(resource.gpuMemoryUsedPeakMb)}/${formatMemoryMb(resource.gpuMemoryTotalMb)}`
        : '不可用';
    return [
        `切片耗时: 总耗时 ${total}，平均每个切片 ${average}（${clipCount} 段）`,
        `资源占用: CPU 平均 ${formatPercent(resource.hostCpuAvgPct)} / 峰值 ${formatPercent(resource.hostCpuPeakPct)}；GPU 平均 ${formatPercent(resource.gpuUtilAvgPct)} / 峰值 ${formatPercent(resource.gpuUtilPeakPct)}；显存峰值 ${memory}`
    ];
}

const EMOTION_DISPLAY_NAMES = {
    HAPPY: '愉快',
    ANGRY: '愤怒',
    SURPRISE: '惊讶',
    SAD: '悲伤',
    FEAR: '恐惧',
    DISGUST: '厌恶',
    CONTEMPT: '轻蔑',
    NEUTRAL: '平静'
};

function buildEmotionComposition(evidence = [], start = 0, end = 0) {
    const scores = new Map();
    for (const item of Array.isArray(evidence) ? evidence : []) {
        const emotion = String(item?.emotion || '').trim().toUpperCase();
        if (!emotion) continue;
        const itemStart = Number(item.start);
        const itemEnd = Number(item.end);
        const overlap = Number.isFinite(itemStart) && Number.isFinite(itemEnd)
            ? Math.max(0, Math.min(Number(end), itemEnd) - Math.max(Number(start), itemStart))
            : 0;
        if (overlap > 0) scores.set(emotion, (scores.get(emotion) || 0) + overlap);
    }
    if (scores.size === 0) return '';

    // Neutral is useful only when it is the sole detected state; otherwise the
    // description should surface the expressive part of the clip.
    const expressive = [...scores].filter(([emotion]) => emotion !== 'NEUTRAL');
    const ranked = (expressive.length > 0 ? expressive : [...scores])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);
    const total = ranked.reduce((sum, [, value]) => sum + value, 0);
    if (!(total > 0)) return '';
    const percentages = ranked.map(([emotion, value]) => ({
        emotion,
        value,
        percent: Math.round(value / total * 100)
    }));
    const roundingDelta = 100 - percentages.reduce((sum, item) => sum + item.percent, 0);
    percentages[0].percent += roundingDelta;
    return percentages
        .filter(item => item.percent > 0)
        .map(item => `${EMOTION_DISPLAY_NAMES[item.emotion] || item.emotion}：${item.percent}%`)
        .join(' ');
}

function buildClipDescription({ streamerName, streamTitle, recordedAt, start, end, description, emotionEvidence }) {
    const liveName = streamerName || '\u4e3b\u64ad';
    const title = streamTitle || '\u672a\u77e5\u76f4\u64ad';
    const time = recordedAt || '\u672a\u77e5';
    const clipStart = formatClock(start);
    const clipEnd = formatClock(end);
    const lines = [
        '\u6765\u81ea ' + liveName + ' \u7684\u76f4\u64ad\u300a' + title + '\u300b\uff0c\u5f55\u5236\u65f6\u95f4 ' + time + '\u3002',
        '\u7247\u6bb5\u65f6\u95f4 ' + clipStart + '-' + clipEnd + '\u3002'
    ];

    const emotionComposition = buildEmotionComposition(emotionEvidence, start, end);
    if (emotionComposition) lines.push(`情绪：${emotionComposition}`);

    const publicDescription = String(description || '').replace(/\s+/g, ' ').trim();
    if (publicDescription) {
        lines.push('');
        lines.push(publicDescription);
    }

    return lines.join('\n');
}

function buildClipTags(config, roomId, streamerName) {
    const registryTags = topicClipper.resolveStreamerTags(config || {}, roomId);
    const tags = Array.from(new Set([
        ...registryTags,
        ...(String(roomId || '') === '25788785' ? ['小岁', '岁AI切片'] : []),
        streamerName,
        '虚拟主播',
        '直播切片',
        'AI切片'
    ].map(tag => String(tag || '').trim()).filter(Boolean)));
    return postProcessAiClipMetadata({ tags }, config || {}).tags;
}

async function parseDanmakuXml(xmlPath) {
    if (!xmlPath || !fs.existsSync(xmlPath)) return [];
    const parser = new xml2js.Parser({
        strict: false,
        normalize: true,
        trim: true,
        mergeAttrs: false,
        attrValueProcessors: [
            value => typeof value === 'string'
                ? value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
                : value
        ]
    });
    const data = fs.readFileSync(xmlPath, 'utf8');
    const result = await parser.parseStringPromise(data);
    const list = result?.i?.d || result?.I?.D || [];
    const rows = [];
    for (const d of list) {
        const attrsRaw = d?.$?.p || d?.$?.P;
        if (!attrsRaw) continue;
        const attrs = String(attrsRaw).split(',');
        const time = Number(attrs[0]);
        const uid = attrs[6] ? String(attrs[6]) : '';
        const text = String(d._ || '').trim();
        if (!Number.isFinite(time) || time < 0 || !text) continue;
        rows.push({ time, text, uid });
    }
    return rows.sort((a, b) => a.time - b.time);
}

function loadEmotionAnalysisForSrt(srtPath) {
    try {
        if (!srtPath) return {};
        const parsed = path.parse(srtPath);
        const baseName = parsed.name.replace(/\.speaker$/i, '');
        const candidates = [
            path.join(parsed.dir, `${baseName}.asr_meta.json`),
            path.join(parsed.dir, `${parsed.name}.asr_meta.json`)
        ];
        const metaPath = candidates.find(candidate => fs.existsSync(candidate));
        if (!metaPath) return {};
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const analysis = meta?.emotionAnalysis || meta?.emotion_analysis || {};
        return analysis && typeof analysis === 'object' ? analysis : {};
    } catch (error) {
        console.warn(`Failed to read ASR emotion metadata: ${error.message}`);
        return {};
    }
}

async function runPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    const count = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
    async function runOne() {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: count }, runOne));
    return results;
}

async function runJobsWithConcurrency(jobs = [], concurrency = 1, options = {}) {
    const scheduler = options.scheduler && typeof options.scheduler.acquire === 'function'
        ? options.scheduler
        : null;
    const requestedWorkerConcurrency = options.workerConcurrency ?? (
        scheduler?.maxConcurrency ?? concurrency
    );
    const limit = Math.max(1, Math.floor(Number(requestedWorkerConcurrency) || 1));
    const results = new Array(jobs.length);
    let cursor = 0;

    async function worker() {
        while (cursor < jobs.length) {
            const index = cursor;
            cursor += 1;
            let lease = null;
            try {
                lease = scheduler ? await scheduler.acquire() : null;
                results[index] = await jobs[index](lease?.profile || null);
            } catch (error) {
                // 一个切片失败不应终止同一场直播的其余切片；保留已完成结果，
                // 让 review/企微通知至少覆盖成功生成的部分。
                console.warn(`clip job ${index + 1} failed, continuing remaining jobs: ${error.message}`);
                results[index] = null;
            } finally {
                lease?.release();
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, jobs.length) }, () => worker());
    await Promise.all(workers);
    return results.filter(Boolean);
}



async function planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig = {}, diagnostics = null, emotionAnalysis = null, streamerName = '岁己SUI') {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return [];
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const hostName = String(streamerName || '主播').trim() || '主播';
    const clipLabel = getOwnStreamClipLabel(rootConfig, info?.roomId, hostName);
    const chunks = buildChunkSources(parsed, danmaku, totalDuration, config, emotionAnalysis);
    const worker = async (chunk) => {
        if (!chunk.segments.length && !chunk.danmaku.length && !chunk.emotionLines.length) {
            if (diagnostics) {
                diagnostics.skippedChunks ||= [];
                diagnostics.skippedChunks.push({ index: chunk.index, start: chunk.start, end: chunk.end, reason: 'no_evidence' });
            }
            return [];
        }
        const promptPrefix = [
            `你是直播切片编辑。下面是一段${hostName}自己直播的字幕和弹幕摘要。`,
            OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
            `请直接找这个分段里所有可能值得本地 review 的切片：有趣、弹幕很多、弹幕很在意、体现${hostName}想法与众不同、${hostName}傻事，或弹幕觉得她傻/特别/有趣/可爱。`,
            '不要只看关键词；弹幕密度、弹幕反应和上下文都要考虑。没有独立看点的片段降低优先级，但不要按内容类型一刀切排除。',
            ...buildSelectionPolicyPromptLines(config.selectionPolicy),
            'SenseVoice 情感和声音事件只能作为寻找反差、爆笑、惊讶、委屈等时刻的辅助线索；必须结合字幕确认具体内容，不能仅凭标签下结论。',
            `每段目标 ${config.minClipSeconds}-${config.maxClipSeconds} 秒，句尾最多允许5秒边界容差，由程序校验。一个分段最多返回8段，没有就返回空数组。`,
            '输出纯 JSON，不要 Markdown：',
            ...CUE_BOUNDARY_PROMPT_LINES,
            '',
            'G 开头的 ID 是完整字幕小段，后面的时间为绝对秒数。startCueId/endCueId 必须从本分块提供的 ID 中选择；程序按 ID 映射精确原始时间。',
            'evidenceCueIds 列出支持事件的关键原话 ID。区分当前讲话 live_speech、转述过去经历 recount、播放内容 playback；不确定填 uncertain，不猜身份。',
            'D开头的ID是观众原始弹幕；文案涉及弹幕反应或意图时，用evidenceDanmakuIds列出片内对应ID。不可引用没有在输入中出现的ID。',
            ...(config.recallOnly ? [
                '本阶段只召回事件及证据，不写发布标题、封面或简介。event 用一句简短事实描述，不能把推测写成确定事实。',
                '{"clips":[{"startCueId":"G1","endCueId":"G20","event":"片内事件","evidenceCueIds":["G8"],"sourceKind":"recount","score":90}]}'
            ] : [
                ...buildOwnStreamClipCopyPromptLines(generator, hostName, 'startCueId/endCueId 所界定的'),
                '{"clips":[{"startCueId":"G1","endCueId":"G20","title":"标题","coverText":"第一行\\n第二行","description":"简介","reason":"内部理由","evidenceCueIds":["G8"],"evidenceDanmakuIds":[],"sourceKind":"live_speech","score":90}]}'
            ]),
            ''
        ].join('\n');
        const prompt = [
            promptPrefix,
            `直播标题: ${info.streamTitle || '未知'}`,
            `录制时间: ${info.recordedAt || '未知'}`,
            '',
            chunk.sourceText
        ].join('\n');
        try {
            const requestOptions = {
                wordLimit: 1600,
                primaryModel: config.ai?.model || undefined,
                timeoutMs: config.ai?.timeoutMs
            };
            const allowedIds = new Set(chunk.subtitleCues.map(cue => cue.id));
            const result = await requestSelectionText(prompt, requestOptions, config, rootConfig, info,
                `recall-${chunk.index}`, diagnostics, value => validSelectionResponse(value, chunk.evidence, null, config, allowedIds, danmaku, chunk.allowedDanmakuIds));
            const text = String(result.text || '').trim();
            const cueIds = new Set(chunk.subtitleCues.map(cue => cue.id));
            return parseClipResponse(text).map((clip, index) => {
                let boundaries;
                try { boundaries = resolveEvidenceBoundaries(clip, chunk.evidence); } catch { return null; }
                if (boundaries && (!cueIds.has(boundaries.startCueId) || !cueIds.has(boundaries.endCueId))) return null;
                const start = boundaries?.start ?? Math.max(chunk.start, timeStringToSeconds(clip.startTime));
                const end = boundaries?.end ?? Math.min(chunk.end, timeStringToSeconds(clip.endTime));
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
                const duration = end - start;
                if (duration < config.minClipSeconds || duration > config.maxClipSeconds + 5) return null;
                return {
                    ...boundaries,
                    start,
                    end,
                    duration,
                    title: String(clip.title || clip.event || '').trim() || `${clipLabel}：直播有趣片段`,
                    event: String(clip.event || '').trim(),
                    grounding: linkClipEvidence(clip, { start, end }, chunk.evidence, danmaku,
                        { cueIds: allowedIds, danmakuIds: chunk.allowedDanmakuIds }),
                    coverText: topicClipper.normalizeCoverText(clip.coverText),
                    description: String(clip.description || '').trim(),
                    reason: String(clip.reason || clip.event || '').trim(),
                    score: Number(clip.score || 0) + 100 - index,
                    modelScore: Number(clip.score || 0),
                    selectionSource: 'model_chunked',
                    candidateIndex: `chunk-${chunk.index}-${index + 1}`,
                    base: {
                        reason: 'ai_chunked_plan',
                        chunkIndex: chunk.index,
                        selectionSource: 'model_chunked',
                        model: result.meta?.model || config.ai?.model || null,
                        score: Number(clip.score || 0)
                    }
                };
            }).filter(Boolean);
        } catch (error) {
            recordAiDiagnostic(diagnostics, `chunk-${chunk.index}`, error);
            console.warn(`AI chunk #${chunk.index} failed: ${error.message}`);
            return [];
        }
    };
    const nested = await runPool(chunks, config.aiConcurrency, worker);
    return dedupePlannedClips(nested.flat(), config);
}

async function planClipsWithAIFullContext(
    parsed,
    danmaku,
    info,
    totalDuration,
    config,
    rootConfig = {},
    diagnostics = null,
    emotionAnalysis = null,
    existingFullLiveContext = null,
    streamerName = '岁己SUI'
) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return [];
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const hostName = String(streamerName || '主播').trim() || '主播';
    const clipLabel = getOwnStreamClipLabel(rootConfig, info?.roomId, hostName);
    const fullContext = fullLiveContext.buildFullLiveSharedContext({
        parsed,
        danmaku,
        config,
        emotionAnalysis,
        info,
        totalDuration
    });
    if (existingFullLiveContext?.sharedPrefix) {
        const sourceMatches = String(existingFullLiveContext.sourceText || '') === fullContext.sourceText;
        if (sourceMatches && fullLiveContext.isFullLiveSharedPrefix(existingFullLiveContext.sharedPrefix)) {
            fullContext.sharedPrefix = String(existingFullLiveContext.sharedPrefix);
        } else {
            console.warn('Full-live context sidecar does not match current full input; regenerated shared prefix will be used.');
        }
    }
    const maxClips = Math.max(1, Number(config.maxClips) || 50);
    const taskSuffix = [
        `你是资深直播切片主编。共享事实输入提供了${hostName}本场直播的全量带时间戳字幕和全量弹幕。`,
        OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
        `请通读整场，从全局比较后选出最多 ${maxClips} 个最有趣、最适合独立发布的片段。数量不必凑满，质量优先。`,
        '模型必须同时评估内容质量和弹幕热度：先根据字幕判断事件是否完整、有趣、适合独立发布，再结合30秒热度表、反应弹幕数、重复刷屏和全量弹幕判断观众反应强度。',
        '热度是重要证据但不是唯一标准：高热度但没有明确内容看点的片段不要选；低热度但故事完整、观点独特、反差强或特别可爱的内容仍可选。',
        'SenseVoice 情感和笑声/哭声等事件是辅助证据，可用于定位反差或强反应；必须结合字幕和弹幕验证，不能只凭标签选段或描述事实。',
        `优先：完整有起承转合的趣事；${hostName}独特/离谱/可爱的想法；口误或操作事故及后续反应；弹幕明显在意且字幕能说明原因的内容。`,
        '没有独立看点的片段降低优先级；电影、感谢、唱歌和普通聊天不做默认排除，有完整事件、观点、反应或反差时可以选择。',
        ...buildSelectionPolicyPromptLines(config.selectionPolicy),
        `每段 ${config.minClipSeconds}-${config.maxClipSeconds} 秒。时间必须取自输入，不能编造。`,
        '边界要求：startTime 包含铺垫；endTime 包含解释、弹幕后续反应和收尾句；不要从笑点中间开始，也不要在句子或故事中间结束。',
        '所有输出片段必须互不重叠；同一话题可以有多个片段，只要各自独立成立且时间不重叠。',
        '请给每段 1-100 的全场相对分数，并按 score 从高到低输出。',
        '输出纯 JSON，不要 Markdown，不要解释：',
        ...buildOwnStreamClipCopyPromptLines(generator, hostName),
        '{"clips":[{"startTime":"HH:MM:SS","endTime":"HH:MM:SS","title":"人工风格标题，18-42字","coverText":"第一行\\n第二行","description":"面向观众的一句话内容简介","reason":"内部选材理由","score":95}]}'
    ].join('\n');
    const prompt = `${fullContext.sharedPrefix}\n\n${taskSuffix}`;
    const experiment = rootConfig.ai?.roomSettings?.[String(info?.roomId || '')]?.fullLiveContextExperiment || {};
    const promptCacheRolloutPercent = Number(experiment.promptCacheRolloutPercent);

    try {
        console.log(`Full-context AI input: ${prompt.length} chars, subtitles=${fullContext.subtitleLines.length}, danmaku=${danmaku.length}->${fullContext.danmakuLines.length}`);
        const result = provider === 'tuZi'
            ? await generator.generateTextWithTuZi(prompt, {
                wordLimit: Math.max(2400, maxClips * 140),
                primaryModel: config.ai?.model || undefined,
                timeoutMs: config.ai?.timeoutMs
            })
            : provider === 'daiYu'
            ? await generator.generateTextWithDaiYu(prompt, {
                wordLimit: Math.max(2400, maxClips * 140),
                primaryModel: config.ai?.model || undefined,
                timeoutMs: config.ai?.timeoutMs,
                ...(Number.isFinite(promptCacheRolloutPercent) ? { promptCacheRolloutPercent } : {})
            })
            : await generator.generateTextWithGemini(prompt, { wordLimit: Math.max(2400, maxClips * 140) });
        const text = String(result.text || '').trim();
        const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
        if (!match) {
            throw new Error(`AI did not return clips JSON: ${text.slice(0, 180)}`);
        }
        const parsedJson = JSON.parse(match[0]);
        const clips = (Array.isArray(parsedJson.clips) ? parsedJson.clips : []).map((clip, index) => {
            const start = timeStringToSeconds(clip.startTime);
            const end = timeStringToSeconds(clip.endTime);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
            const boundedStart = clamp(start, 0, totalDuration);
            const boundedEnd = clamp(end, 0, totalDuration);
            const duration = boundedEnd - boundedStart;
            if (duration < config.minClipSeconds || duration > config.maxClipSeconds + 5) return null;
            return {
                start: boundedStart,
                end: boundedEnd,
                duration,
                title: String(clip.title || '').trim() || `${clipLabel}：直播有趣片段`,
                coverText: topicClipper.normalizeCoverText(clip.coverText),
                description: String(clip.description || '').trim(),
                reason: String(clip.reason || '').trim(),
                score: Number(clip.score || (100 - index)),
                selectionSource: 'model_full_context',
                candidateIndex: `full-context-${index + 1}`,
                base: {
                    reason: 'model_full_context',
                    selectionSource: 'model_full_context',
                    model: result.meta?.model || config.ai?.model || null,
                    score: Number(clip.score || 0)
                }
            };
        }).filter(Boolean);
        return dedupePlannedClips(clips, config);
    } catch (error) {
        recordAiDiagnostic(diagnostics, 'full_context', error);
        console.warn(`AI full-context planning failed: ${error.message}`);
        return [];
    }
}

function classifyAiFallbackReason(errors = []) {
    const text = errors
        .map(error => String(error?.message || error || ''))
        .join('\n');
    if (!text.trim()) {
        return '\u672a\u8fd4\u56de\u6709\u6548 AI \u5207\u7247\u89c4\u5212';
    }
    if (/insufficient_user_quota|\u9884\u6263\u8d39\u989d\u5ea6\u5931\u8d25|\u5269\u4f59\u989d\u5ea6|\u4f59\u989d\u4e0d\u8db3/.test(text)) {
        return 'TuZi \u4f59\u989d\u4e0d\u8db3';
    }
    if (/timeout|ETIMEDOUT|\u8d85\u65f6/i.test(text)) {
        return 'AI \u8bf7\u6c42\u8d85\u65f6';
    }
    if (/did not return clips JSON|JSON/.test(text)) {
        return 'AI \u672a\u8fd4\u56de\u53ef\u89e3\u6790\u7684\u5207\u7247 JSON';
    }
    const first = String(errors[0]?.message || errors[0] || '').replace(/\s+/g, ' ').trim();
    return first ? first.slice(0, 120) : 'AI \u8c03\u7528\u5931\u8d25';
}

function recordAiDiagnostic(diagnostics, phase, error) {
    if (!diagnostics) return;
    diagnostics.errors = diagnostics.errors || [];
    diagnostics.errors.push({
        phase,
        message: String(error?.message || error || '').trim()
    });
}

function buildAiStatusLine(aiStatus = {}) {
    if (!aiStatus || !aiStatus.usedFallback) return null;
    const reason = aiStatus.fallbackReason || classifyAiFallbackReason(aiStatus.errors || []);
    return `AI\u72b6\u6001: AI \u89c4\u5212\u672a\u6210\u529f\uff08${reason}\uff09\uff0c\u5df2\u56de\u9000\u5230\u672c\u5730\u5b57\u5e55/\u5f39\u5e55/\u60c5\u7eea\u4fe1\u53f7\u5019\u9009\uff0c\u6807\u9898\u53ef\u80fd\u504f\u6cdb\u3002`;
}


function parseRecordingInfo(mediaPath, context = {}) {
    const fromTopicClipper = topicClipper.parseRecordingInfo(mediaPath, context);
    if (fromTopicClipper.roomId || fromTopicClipper.recordedAt) {
        return fromTopicClipper;
    }
    const fileName = path.basename(mediaPath || '');
    const nameNoExt = fileName.replace(/\.[^.]+$/, '');
    const match = nameNoExt.match(/^录制-(\d+)-(\d{8})-(\d{6})-(\d+)-(.+)$/);
    const roomId = context.roomId || context.room_id || (match ? match[1] : null);
    const date = match ? match[2] : null;
    const time = match ? match[3] : null;
    const streamTitle = match ? match[5] : fromTopicClipper.streamTitle || nameNoExt;
    const recordedAt = date && time
        ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
        : fromTopicClipper.recordedAt;
    return {
        roomId: roomId ? String(roomId) : null,
        recordedAt,
        streamTitle,
        fileName
    };
}


async function refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig = {}, diagnostics = null, streamerName = '岁己SUI') {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false || candidates.length === 0) {
        return [];
    }
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const hostName = String(streamerName || '主播').trim() || '主播';
    const clipLabel = getOwnStreamClipLabel(rootConfig, info?.roomId, hostName);
    const candidateLimit = Math.max(1, Math.floor(Number(config.ai?.maxCandidateLines) || 100));
    const rankedCandidates = candidates
        .slice()
        .sort((a, b) => (
            Number(b.recallScore ?? b.score ?? 0) - Number(a.recallScore ?? a.score ?? 0)
            || Number(b.reactionCount || 0) - Number(a.reactionCount || 0)
            || Number(b.danmakuCount || 0) - Number(a.danmakuCount || 0)
            || Number(a.start) - Number(b.start)
        ))
        .slice(0, candidateLimit);
    const packed = buildRerankEvidence(rankedCandidates, parsed, danmaku, config);
    const { subtitleEvidence } = packed;

    const maxClips = Math.max(1, Number(config.maxClips) || 50);

    const overlapGap = Math.max(0, Number(config.finalOverlapToleranceSeconds) || 0);
    const promptPrefix = [
        `你是直播切片主编。下面是${hostName}本场直播经过分块模型、字幕、弹幕和情绪信号共同召回并去重后的完整候选池。`,
        OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
        `请一次性全局比较所有候选，输出最多 ${maxClips} 个适合本地 review、能够独立发布的最终片段。${maxClips} 是硬上限而不是数量目标，有多少合格题材就返回多少。`,
        ...(config.avoidOverlappingClips !== false ? [
            '所有输出片段必须互不重叠；同一话题可以有多个片段，只要各自独立成立且时间不重叠。',
            ...(overlapGap > 0 ? [`相邻片段至少间隔 ${overlapGap} 秒，以满足本任务的最终选择规则。`] : [])
        ] : []),
        '候选阶段追求高召回，recallScore 和召回来源不是最终质量结论；不要按来源分配固定名额，最终只按内容价值、完整性、观众反应和独立发布价值排序。',
        `重点识别：完整趣事或观点、明显反差/口误/事故、弹幕持续追问或要求细说、观众对一句没说完的话持续在意、以及弹幕觉得${hostName}特别/有趣/可爱的片段。持续讨论本身是通用信号，不要求命中特定题材词。`,
        '没有独立看点的片段降低优先级；内容类型不做默认排除。',
        ...buildSelectionPolicyPromptLines(config.selectionPolicy),
        `每段目标 ${config.minClipSeconds}-${config.maxClipSeconds} 秒，句尾最多允许5秒边界容差，由程序校验；不要为了整数时长截断完整句子。`,
        '必须从给出的 candidateIndex 中选择；startCueId/endCueId 从该候选的完整字幕范围中选择，补齐铺垫、解释和收束，不得跨无关话题。',
        '字幕表每行是 G 开头的 ID、绝对秒数时间范围、原话。程序用 ID 映射精确时间，不会再任意缩短结尾；选择包含完整收束的 endCueId。',
        'title/coverText/description 中的人物、数字、引号原话和事件必须有本片 evidenceCueIds 或 evidenceDanmakuIds 支撑；不得把本表其他片段的信息借给本片。',
        'sourceKind 区分当前讲话 live_speech、转述往事 recount、播放内容 playback、观众评论 audience；不能确定填 uncertain，并用不猜身份的中性表达。',
        '人物正在讲过去的经历，不等于事情正在直播间发生；观看回放不等于本场正在表演。观众弹幕不能升级为主播说过或做过的事实。',
        '转述听闻不等于亲自经历；回忆或转述的片段，description必须交代这种语境。',
        '说出或引用一句话不等于现场创作；没有直接证据时，不写现编、原创、亲自体验等断言。引号只放原文确有的词句，归纳性标签不用引号。',
        '出现多个人或多次事件时，保留谁先做了什么、后来谁又做了什么；不能把两次事件、互相回应或不同人的行为合成一次因果关系。',
        '文案提到观众或弹幕的反应、意图时，必须补充片内evidenceDanmakuIds，即使其他定位与引用沿用召回结果。',
        ...(packed.recallHints.length ? [
            '带有“可复用的召回定位”的候选：若看点和范围不变，只输出candidateIndex、文案、reason、score即可，程序沿用其边界、来源类型与引用。',
            '若你改变了时间、引用了其他原话/弹幕或纠正来源类型，才输出对应的startCueId/endCueId、evidenceCueIds/evidenceDanmakuIds或sourceKind覆盖值。没有召回定位的候选仍必须自行填写这些字段。'
        ] : []),
        '请给每段 1-100 的全场相对分数，按 score 从高到低输出。',
        '输出纯 JSON，不要 Markdown：',
        ...CUE_BOUNDARY_PROMPT_LINES,
        '',
        ...buildOwnStreamClipCopyPromptLines(generator, hostName, 'startCueId/endCueId 所界定的'),
        packed.recallHints.length ? '{"clips":[{"candidateIndex":1,"title":"人工风格标题，18-42字","coverText":"第一行\\n第二行","description":"面向观众的一句话内容简介","reason":"内部选材理由","score":95}]}。沿用召回定位时省略其他字段；需要覆盖或没有定位提示时补齐边界、引用和sourceKind。'
                : '{"clips":[{"candidateIndex":1,"startCueId":"G1","endCueId":"G20","title":"人工风格标题，18-42字","coverText":"第一行\\n第二行","description":"面向观众的一句话内容简介","reason":"内部选材理由","evidenceCueIds":["G8"],"evidenceDanmakuIds":[],"sourceKind":"recount","score":95}]}',
        ''
    ].join('\n');
    const prompt = [
        promptPrefix,
        `直播标题: ${info.streamTitle || '未知'}`,
        `录制时间: ${info.recordedAt || '未知'}`,
        '',
        '=== 候选 ===',
        packed.candidateLines,
        '',
        '=== 完整字幕证据表（同一段只出现一次，禁止跨片引用） ===',
        packed.subtitleLines,
        '',
        '=== 观众弹幕证据表（不是主播原话） ===',
        packed.danmakuLines
    ].join('\n');

    try {
        const requestOptions = {
            wordLimit: Math.max(2400, maxClips * 140),
            primaryModel: config.ai?.model || undefined,
            timeoutMs: config.ai?.timeoutMs
        };
        const result = await requestSelectionText(prompt, requestOptions, config, rootConfig, info,
            'global-rerank', diagnostics, value => isRerankResponseValid(value, rankedCandidates,
                parsed.segments.at(-1)?.end || 0, config, subtitleEvidence, danmaku, packed.cueIds, packed.danmakuIds));
        const text = String(result.text || '').trim();
        const proposed = parseClipResponse(text);
        const rejected = [];
        const normalized = normalizeAiClips(proposed, rankedCandidates, parsed.segments.at(-1)?.end || 0,
            config, clipLabel, subtitleEvidence, danmaku, packed.cueIds, packed.danmakuIds, rejected);
        if (diagnostics) diagnostics.validation = { proposed: proposed.length, accepted: normalized.length, rejected };
        if (rejected.length) console.warn(`AI clip validation rejected ${rejected.length}/${proposed.length}: ${JSON.stringify(rejected)}`);
        return normalized;
    } catch (error) {
        recordAiDiagnostic(diagnostics, 'candidate_refine', error);
        console.warn(`AI clip refinement failed, using local candidates: ${error.message}`);
        return [];
    }
}

async function planClipsWithStagedAI(
    localCandidates,
    parsed,
    danmaku,
    info,
    totalDuration,
    config,
    rootConfig = {},
    diagnostics = null,
    emotionAnalysis = null,
    streamerName = '岁己SUI'
) {
    const candidateLimit = Math.max(
        Number(config.maxClips) || 50,
        Number(config.ai?.maxCandidateLines) || 100
    );
    const chunkConfig = {
        ...config,
        recallOnly: true,
        maxClips: candidateLimit
    };
    const modelCandidates = await planClipsWithAIChunks(
        parsed,
        danmaku,
        info,
        totalDuration,
        chunkConfig,
        rootConfig,
        diagnostics,
        emotionAnalysis,
        streamerName
    );
    const pool = buildRecallCandidatePool(localCandidates, modelCandidates, config);
    const clips = await refineCandidatesWithAI(
        pool,
        parsed,
        danmaku,
        info,
        config,
        rootConfig,
        diagnostics,
        streamerName
    );
    return { clips, pool, modelCandidates };
}

function fallbackClipsFromCandidates(candidates, config, streamerLabel = '小岁') {
    return candidates
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(config.maxClips) || 50))
        .map(candidate => {
            const fromRecallPool = Array.isArray(candidate.recallSources);
            const selectionSource = fromRecallPool ? 'recall_pool_fallback' : 'local_rules';
            return {
                start: candidate.start,
                end: candidate.end,
                duration: candidate.duration,
                title: String(candidate.title || '').trim() || buildFallbackTitle(candidate, streamerLabel),
                coverText: topicClipper.normalizeCoverText(candidate.coverText),
                description: String(candidate.description || '').trim(),
                reason: candidate.reason,
                candidateIndex: candidate.index,
                score: candidate.score,
                selectionSource,
                base: {
                    ...candidate,
                    selectionSource
                }
            };
        })
        .sort((a, b) => a.start - b.start);
}

function buildDanmakuHeatClips(candidates = [], count = 0, streamerLabel = '小岁') {
    const limit = Math.max(0, Math.floor(Number(count) || 0));
    if (limit === 0) return [];
    return candidates
        .filter(candidate => String(candidate.reason || '').split('+').some(reason => reason.startsWith('danmaku_')))
        .map(candidate => ({
            candidate,
            heatScore: Number(candidate.danmakuCount || 0) + Number(candidate.reactionCount || 0) * 8
        }))
        .sort((a, b) => b.heatScore - a.heatScore)
        .slice(0, limit)
        .map(({ candidate, heatScore }) => ({
            start: candidate.start,
            end: candidate.end,
            duration: candidate.duration,
            title: buildFallbackTitle(candidate, streamerLabel),
            description: '',
            reason: candidate.reason,
            candidateIndex: candidate.index,
            score: heatScore,
            selectionSource: 'danmaku_heat',
            base: {
                ...candidate,
                heatScore,
                selectionSource: 'danmaku_heat'
            }
        }));
}


function combineParallelClipPlans(danmakuHeatCandidates = [], modelCandidates = [], parallelConfig = {}) {
    const heatLimit = Math.max(0, Math.floor(Number(parallelConfig.danmakuHeatClips) || 0));
    const modelLimit = Math.max(0, Math.floor(Number(parallelConfig.modelClips) || 0));
    const dedupe = parallelConfig.dedupeAcrossSources !== false;
    const tolerance = Math.max(0, Number(parallelConfig.overlapToleranceSeconds) || 0);
    const heat = danmakuHeatCandidates.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const model = modelCandidates.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    let selectedHeat = [];
    let selectedModel = [];

    if (!dedupe) {
        selectedHeat = heat.slice(0, heatLimit);
        selectedModel = model.slice(0, modelLimit);
    } else if (parallelConfig.preferModelOnOverlap !== false) {
        selectedModel = model.slice(0, modelLimit);
        selectedHeat = heat
            .filter(clip => !selectedModel.some(modelClip => clipsConflict(clip, modelClip, tolerance)))
            .slice(0, heatLimit);
    } else {
        selectedHeat = heat.slice(0, heatLimit);
        selectedModel = model
            .filter(clip => !selectedHeat.some(heatClip => clipsConflict(clip, heatClip, tolerance)))
            .slice(0, modelLimit);
    }

    return [...selectedHeat, ...selectedModel].sort((a, b) => Number(a.start) - Number(b.start));
}

function getSelectionSource(value = {}) {
    return value.selectionSource
        || value.base?.selectionSource
        || value.candidate?.selectionSource
        || null;
}

function getSelectionSourceLabel(value = {}) {
    const source = getSelectionSource(value);
    if (source === 'model_global_rerank') return '统一重排';
    if (source === 'recall_pool_fallback') return '候选池回退';
    if (source === 'model_full_context') return '模型全量';
    if (source === 'model_chunked') return '模型分块';
    if (source === 'danmaku_heat') return '弹幕热度';
    if (value.base?.reason === 'ai_chunked_plan' || value.candidate?.reason === 'ai_chunked_plan') return '模型分块';
    return '本地规则';
}

function countSelectionSources(items = []) {
    const counts = {};
    for (const item of items) {
        const label = getSelectionSourceLabel(item);
        counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
}

function formatSelectionSourceCounts(items = []) {
    return Object.entries(countSelectionSources(items))
        .map(([label, count]) => `${label} ${count}`)
        .join('，');
}

function filterClipsBySelection(clips, selectedIndices = null) {
    if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
        return clips;
    }
    const wanted = new Set(selectedIndices.map(value => Number(value)).filter(Number.isFinite));
    return clips.filter((_, index) => wanted.has(index + 1));
}

function buildCoverTitle(title, coverText = '') {
    const preferred = topicClipper.normalizeCoverText(coverText);
    if (preferred) return preferred;
    return String(title || '')
        .replace(/^【[^】]+】/, '')
        .replace(/^[\s:：-]+/, '')
        .trim();
}

function getRecommendationScoreText(value = {}) {
    const rawScore = value.recommendationScore ?? value.recommendation?.score ?? value.score;
    const score = Number(rawScore);
    if (!Number.isFinite(score)) return '';
    return Number.isInteger(score)
        ? String(score)
        : score.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatRecommendationScore(value = {}) {
    const rendered = getRecommendationScoreText(value);
    if (!rendered) return '';
    return ` | ${rendered}分`;
}

function buildRecommendationScoreLine(value = {}) {
    const rendered = getRecommendationScoreText(value);
    return rendered ? `   推荐分数: ${rendered}分` : null;
}


function buildReviewMarkdown(results, metadata) {
    const aiStatusLine = buildAiStatusLine(metadata.aiStatus);
    const uploadIds = Array.isArray(metadata.uploadRegistry?.clipIds)
        ? metadata.uploadRegistry.clipIds
        : [];
    const streamerName = String(metadata.streamerName || '小岁').trim() || '小岁';
    const lines = [
        `# ${streamerName}直播有趣切片 review`,
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot}`,
        results.length ? `来源统计: ${formatSelectionSourceCounts(results)}` : null,
        uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
        aiStatusLine,
        ...buildProcessingSummaryLines(metadata.processingStats),
        '',
        '## 切片列表',
        ''
    ].filter(line => line !== null);
    results.forEach((result, index) => {
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const filePath = result.output.mediaPath;
        // Keep the upload manifest's path field pure.  Scores belong to the
        // structured result and are rendered separately for human review.
        lines.push(`${index + 1}. ${result.copy.title} | ${start} | ${duration} | ${filePath}`);
        const scoreLine = buildRecommendationScoreLine(result);
        if (scoreLine) lines.push(scoreLine);
        lines.push(`   来源: ${getSelectionSourceLabel(result)}`);
        const groundingLine = buildGroundingReviewLine(result.grounding);
        if (groundingLine) lines.push(groundingLine);
        if (uploadIds[index]) {
            lines.push(`   上传ID: ${uploadIds[index]}`);
        }
        if (result.output.coverPath) {
            lines.push(`   封面: ${result.output.coverPath}`);
        }
    });
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function buildPlanReviewMarkdown(clips, metadata) {
    const aiStatusLine = buildAiStatusLine(metadata.aiStatus);
    const streamerName = String(metadata.streamerName || '小岁').trim() || '小岁';
    const lines = [
        `# ${streamerName}直播有趣切片计划`,
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot}`,
        clips.length ? `来源统计: ${formatSelectionSourceCounts(clips)}` : null,
        aiStatusLine,
        '',
        '## 候选列表',
        ''
    ].filter(line => line !== null);
    clips.forEach((clip, index) => {
        const sourceLabel = getSelectionSourceLabel(clip);
        lines.push(`${index + 1}. ${clip.title} | ${formatClock(clip.start)}-${formatClock(clip.end)} | ${formatClock(clip.duration)} | ${clip.reason || ''}`);
        const scoreLine = buildRecommendationScoreLine(clip);
        if (scoreLine) lines.push(scoreLine);
        lines.push(`   来源: ${sourceLabel}`);
        const groundingLine = buildGroundingReviewLine(clip.grounding);
        if (groundingLine) lines.push(groundingLine);
    });
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function toFwdSlash(s) {
    return String(s || '').replace(/\\+/g, '/');
}

function buildNotifyMarkdown(results, metadata) {
    const aiStatusLine = buildAiStatusLine(metadata.aiStatus);
    const uploadIds = Array.isArray(metadata.uploadRegistry?.clipIds)
        ? metadata.uploadRegistry.clipIds
        : [];
    const streamerName = String(metadata.streamerName || '岁己').trim() || '岁己';
    const lines = [
        `## ${streamerName}直播有趣切片候选`,
        '',
        `直播: **${metadata.streamTitle || metadata.sourceFileName || '未知'}**`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `切片目录: ${toFwdSlash(metadata.outputRoot)}`,
        metadata.reviewPath ? `Review: ${toFwdSlash(metadata.reviewPath)}` : null,
        results.length ? `来源统计: ${formatSelectionSourceCounts(results)}` : null,
        uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
        aiStatusLine,
        ...buildProcessingSummaryLines(metadata.processingStats),
        '',
        '\u5207\u7247\u5217\u8868:'
    ].filter(line => line !== null);
    results.forEach((result, index) => {
        const title = result.copy.title;
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const uploadId = uploadIds[index] ? `ID ${uploadIds[index]} | ` : '';
        lines.push(`${index + 1}. ${uploadId}${title} | ${start} | ${duration}${formatRecommendationScore(result)}`);
    });
    let markdown = lines.join('\n');
    // 只有预计会产生很多条消息时才压缩；一两条分段消息保留完整切片列表。
    if (
        Buffer.byteLength(markdown, 'utf8') <= 3900
        || splitWeChatMarkdown(markdown, WECHAT_WORK_MARKDOWN_MAX_BYTES).length <= 2
    ) {
        return markdown;
    }

    const clipListIndex = lines.indexOf('\u5207\u7247\u5217\u8868:');
    const compact = lines.slice(0, clipListIndex >= 0 ? clipListIndex + 1 : 7);
    for (const [index, result] of results.entries()) {
        const title = result.copy.title;
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const uploadId = uploadIds[index] ? `ID ${uploadIds[index]} | ` : '';
        const line = `${index + 1}. ${uploadId}${title} | ${start} | ${duration}${formatRecommendationScore(result)}`;
        const candidate = compact.length ? `${compact.join('\n')}\n${line}` : line;
        if (Buffer.byteLength(candidate, 'utf8') + 24 > 3880) {
            compact.push(`${index + 1}. ...还有 ${results.length - index} 段，请看 Review`);
            break;
        }
        compact.push(line);
    }
    return compact.join('\n');
}

function parseUploadRegistryOutput(output) {
    const match = String(output || '').match(/^IDs:\s*([0-9,\s]+)$/m);
    if (!match) {
        return null;
    }
    const clipIds = match[1]
        .split(',')
        .map(value => Number(value.trim()))
        .filter(Number.isFinite);
    return clipIds.length ? { clipIds } : null;
}

function buildOwnUploadSettings(metadata, copy = {}) {
    const source = `${metadata.streamerName || '主播'} 直播《${metadata.streamTitle || metadata.sourceFileName || '未知直播'}》${metadata.recordedAt || ''}`.trim();
    const tags = Array.isArray(copy.tags) && copy.tags.length
        ? copy.tags
        : ['小岁', '虚拟主播', '直播切片', '岁AI切片', 'AI切片'];
    const prefix = String(metadata.roomId || '') === '25788785'
        ? '【小岁】'
        : `【${metadata.streamerName || '切片'}】`;
    return {
        source,
        tags: Array.from(new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))),
        prefix,
        tid: 21,
        roomId: metadata.roomId || null,
        streamerName: metadata.streamerName || null
    };
}

function writeOwnUploadManifest(manifestPath, reviewPath, results, metadata) {
    const settings = buildOwnUploadSettings(metadata, results[0]?.copy || {});
    const manifest = {
        version: 1,
        type: 'bilibili_clip_upload_manifest',
        generatedAt: new Date().toISOString(),
        reviewPath,
        roomId: metadata.roomId || null,
        streamerName: metadata.streamerName || null,
        recordedAt: metadata.recordedAt || null,
        streamTitle: metadata.streamTitle || metadata.sourceFileName || null,
        upload: settings,
        clips: results.map((result, index) => ({
            reviewIndex: index + 1,
            metadataPath: result.output?.metadataPath || null
        }))
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifestPath;
}

function registerReviewForUpload(reviewPath, results, metadata) {
    if (!reviewPath || !results.length) return null;
    const settings = buildOwnUploadSettings(metadata, results[0]?.copy || {});
    const manifestPath = metadata.uploadManifestPath
        || path.join(path.dirname(reviewPath), `${path.basename(reviewPath, path.extname(reviewPath))}_UPLOAD_MANIFEST.json`);
    writeOwnUploadManifest(manifestPath, reviewPath, results, metadata);
    const scriptPath = path.join(__dirname, 'clip_upload_registry.py');
    const args = [
        scriptPath,
        'import-json',
        '--manifest', manifestPath,
        '--review', reviewPath,
        '--source', settings.source,
        '--tags', settings.tags.join(','),
        '--prefix', settings.prefix,
        '--tid', '21',
        '--label', `${metadata.streamerName || '主播'} ${metadata.recordedAt || ''}`.trim()
    ];
    const result = spawnSync('python', args, {
        cwd: path.dirname(path.dirname(__dirname)),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) {
        console.warn(`Upload registry import failed: ${output}`);
        return null;
    }
    if (output) {
        console.log(output);
    }
    return parseUploadRegistryOutput(output);
}

async function notifyResults(results, metadata, rootConfig) {
    if (!rootConfig.ownStreamClips?.notify?.enabled && rootConfig.ownStreamClips?.notify?.enabled !== undefined) {
        return false;
    }
    const webhookUrl = String(rootConfig.wechatWork?.webhookUrl || '').trim();
    if (!webhookUrl || results.length === 0) return false;
    return sendWeChatMarkdown(webhookUrl, buildNotifyMarkdown(results, metadata));
}

async function generateOwnStreamClipJob({
    clip,
    evidenceReview,
    index,
    parsed,
    danmaku,
    options,
    outputRoot,
    source,
    streamerName,
    info,
    config,
    participantMetadata
}) {
    const processingStartedAt = new Date();
    const processingStartedNs = process.hrtime.bigint();
    const resourcePeaks = [];
    const window = {
        index: index + 1,
        start: clip.start,
        end: clip.end,
        duration: clip.end - clip.start,
        originalStart: clip.originalStart ?? null,
        originalEnd: clip.originalEnd ?? null,
        boundaryAligned: Boolean(clip.boundaryAligned),
        boundaryTrimmedAtTrailingSilence: Boolean(clip.boundaryTrimmedAtTrailingSilence),
        matchedKeywords: clip.base?.matchedKeywords || [],
        matchCount: clip.base?.reactionCount || 0,
        matchSegments: [],
        allSegmentTexts: parsed.segments
            .filter(segment => Number(segment.end) > clip.start && Number(segment.start) < clip.end)
            .map(segment => segment.text),
        preContext: parsed.segments
            .filter(segment => Number(segment.end) <= clip.start && Number(segment.end) >= clip.start - 60)
            .map(segment => segment.text)
            .slice(-10),
        postContext: parsed.segments
            .filter(segment => Number(segment.start) >= clip.end && Number(segment.start) <= clip.end + 60)
            .map(segment => segment.text)
            .slice(0, 10)
    };
    const baseName = topicClipper.sanitizeFileName(
        `${path.basename(options.mediaPath, path.extname(options.mediaPath))}_fun_${String(index + 1).padStart(2, '0')}_${formatClock(window.start).replace(/:/g, '')}`
    );
    const mediaPath = path.join(outputRoot, `${baseName}.mp4`);
    const srtPath = path.join(outputRoot, `${baseName}.srt`);
    const metadataPath = path.join(outputRoot, `${baseName}.json`);
    const srtResult = topicClipper.writeClipSrt(parsed.segments, window, srtPath);
    const rawCopy = {
        title: clip.title,
        coverText: topicClipper.normalizeCoverText(clip.coverText),
        description: buildClipDescription({
            streamerName,
            streamTitle: info.streamTitle,
            recordedAt: info.recordedAt,
            start: window.start,
            end: window.end,
            description: clip.description,
            emotionEvidence: clip.base?.emotionEvidence || clip.emotionEvidence || []
        }),
        tags: buildClipTags(options.config || {}, info.roomId, streamerName)
    };
    const processedCopy = postProcessAiClipMetadata(rawCopy, options.config || {});
    const copy = { ...rawCopy, ...processedCopy };
    let mediaResult = null;
    let mediaError = null;
    try {
        mediaResult = await topicClipper.cutClipMedia(source, window, srtPath, mediaPath, {
            ...buildCutClipMediaConfig(config, options),
            resourcePeaks
        });
        if (Array.isArray(mediaResult?.resourcePeaks) && mediaResult.resourcePeaks !== resourcePeaks) {
            resourcePeaks.push(...mediaResult.resourcePeaks);
        }
    } catch (error) {
        mediaError = error.message;
        console.warn(`clip media generation failed, metadata kept: ${error.message}`);
    }
    let coverPath = null;
    let coverError = null;
    if (mediaResult?.path && source.kind !== 'audio') {
        try {
            coverPath = await topicClipper.generateClipCover(
                mediaResult.path,
                buildCoverTitle(copy.title, copy.coverText),
                outputRoot,
                {
                    streamerName,
                    coverSourcePath: mediaResult.coverSourcePath || source.mediaPath,
                    clipStart: Number.isFinite(Number(mediaResult.coverClipStart))
                        ? Number(mediaResult.coverClipStart)
                        : window.start,
                    clipDuration: window.duration,
                    preferredTime: (() => {
                        const absolutePeak = topicClipper.selectCoverPreferredTime(
                            danmaku,
                            window,
                            config.reactionKeywords || []
                        );
                        return Number.isFinite(Number(mediaResult.coverTimeOrigin)) && Number.isFinite(Number(absolutePeak))
                            ? Number(absolutePeak) - Number(mediaResult.coverTimeOrigin)
                            : absolutePeak;
                    })(),
                    resourcePeaks
                }
            );
        } catch (error) {
            coverError = error.message;
            console.warn(`clip cover generation failed, metadata kept: ${error.message}`);
        } finally {
            topicClipper.cleanupTemporaryCoverSource(mediaResult);
        }
    }
    const processingFinishedAt = new Date();
    const processing = {
        version: 1,
        startedAt: processingStartedAt.toISOString(),
        finishedAt: processingFinishedAt.toISOString(),
        elapsedMs: Math.round(Number(process.hrtime.bigint() - processingStartedNs) / 1e6),
        resourceMode: config.mode || config.resourceMode || null,
        ffmpegThreads: Number.isFinite(Number(config.clipFfmpegThreads))
            ? Number(config.clipFfmpegThreads)
            : null,
        resourcePeaks,
        resource: summarizeResourcePeaks(resourcePeaks)
    };
    const metadata = {
        version: 1,
        generatedAt: new Date().toISOString(),
        mode: 'own_stream_fun_review',
        source: {
            mediaPath: options.mediaPath,
            srtPath: options.srtPath,
            xmlPath: options.xmlPath || null
        },
        roomId: info.roomId,
        streamerName,
        participantInfo: participantMetadata,
        recordedAt: info.recordedAt,
        streamTitle: info.streamTitle,
        recommendationScore: Number.isFinite(Number(clip.score)) ? Number(clip.score) : null,
        window,
        candidate: clip.base || null,
        grounding: evidenceReview(clip, copy) || null,
        copy,
        upload: buildOwnUploadSettings({
            roomId: info.roomId,
            streamerName,
            streamTitle: info.streamTitle,
            recordedAt: info.recordedAt
        }, copy),
        processing,
        uploadReady: Boolean(mediaResult?.path),
        output: {
            mediaPath: mediaResult?.path || mediaPath,
            srtPath,
            metadataPath,
            burnedSubtitles: Boolean(mediaResult?.burnedSubtitles),
            subtitleBurnFallbackUsed: Boolean(mediaResult?.fallbackUsed),
            twoStageSubtitleBurn: mediaResult?.twoStageSubtitleBurn ?? null,
            twoStageMode: mediaResult?.twoStageMode ?? null,
            srtSegmentCount: srtResult.segmentCount,
            mediaError,
            coverPath,
            coverError
        }
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`${index + 1}. ${copy.title} ${formatClock(window.start)} ${formatClock(window.duration)} ${metadata.output.mediaPath}`);
    return metadata;
}

async function generateOwnStreamClips(options = {}) {
    const rootConfig = options.config || {};
    const config = getOwnStreamClipsConfig(rootConfig);
    const clipConcurrency = Math.max(
        1,
        Math.floor(Number(config.clipConcurrency) || 1)
    );
    const clipFfmpegThreads = Math.max(
        0,
        Math.floor(Number(config.clipFfmpegThreads) || 0)
    );
    const mediaConfig = {
        ...config,
        clipFfmpegThreads
    };
    if (!config.enabled) return [];
    if (!options.mediaPath || !fs.existsSync(options.mediaPath)) {
        throw new Error(`mediaPath not found: ${options.mediaPath || ''}`);
    }
    if (!options.srtPath || !fs.existsSync(options.srtPath)) {
        throw new Error(`srtPath not found: ${options.srtPath || ''}`);
    }

    const parsed = asrBackends.parseSrt(options.srtPath, 'own_stream_clip');
    const totalDuration = Number(options.totalDurationSeconds) || Number(parsed.segments.at(-1)?.end || 0);
    const danmaku = await parseDanmakuXml(options.xmlPath);
    const emotionAnalysis = loadEmotionAnalysisForSrt(options.srtPath);
    let existingFullLiveContext = options.fullLiveContext || null;
    if (!existingFullLiveContext && options.fullLiveContextPath) {
        try {
            existingFullLiveContext = fullLiveContext.loadFullLiveContextSidecar(options.fullLiveContextPath);
            if (existingFullLiveContext) {
                console.log(`Full-live shared prefix loaded: ${fullLiveContext.getFullLiveContextPath(options.fullLiveContextPath)}`);
            }
        } catch (error) {
            console.warn(`Failed to load full-live context sidecar, continuing with regenerated input: ${error.message}`);
        }
    }
    const candidates = buildCandidateWindows(parsed, danmaku, config, totalDuration, emotionAnalysis);
    const info = parseRecordingInfo(options.mediaPath, options.context || {});
    const requestedStreamerName = String(options.streamerName || '').trim();
    const streamerName = topicClipper.resolveStreamerName(rootConfig, info.roomId, {
        streamerName: requestedStreamerName || (info.roomId ? null : '岁己SUI')
    });
    const clipLabel = getOwnStreamClipLabel(rootConfig, info.roomId, streamerName);
    const participantMetadata = topicClipper.buildParticipantMetadata(topicClipper.loadAsrSpeakerSidecarForMediaPath(options.srtPath || options.mediaPath));
    const outputRoot = resolveClipOutputRoot(options.mediaPath, config);
    fs.mkdirSync(outputRoot, { recursive: true });
    info.selectionCacheDirectory = options.selectionCacheDirectory || path.join(outputRoot, '.selection-cache');
    const reviewMetadata = {
        streamerName,
        streamTitle: info.streamTitle,
        roomId: info.roomId,
        recordedAt: info.recordedAt,
        outputRoot,
        sourceFileName: info.fileName,
        participantInfo: participantMetadata
    };
    if (emotionAnalysis.status === 'completed') {
        reviewMetadata.emotionAnalysis = {
            status: emotionAnalysis.status,
            model: emotionAnalysis.model || null,
            emotionCounts: emotionAnalysis.emotionCounts || {},
            eventCounts: emotionAnalysis.eventCounts || {},
            chunks: Number(emotionAnalysis.chunks || 0)
        };
    }
    const aiDiagnostics = {
        strategy: config.ai?.strategy || null,
        usedFallback: false,
        fallbackReason: null,
        selectedSource: null,
        localFallbackEnabled: config.ai?.fallbackToLocalRules !== false,
        errors: []
    };
    if ((parsed.segments || []).length === 0 && danmaku.length === 0) {
        console.log('No own-stream clip candidates found.');
        return [];
    }

    let clips = [];
    let fallbackCandidates = candidates;
    let candidateRefinementAttempted = false;
    if (options.planPath) {
        const plan = JSON.parse(fs.readFileSync(options.planPath, 'utf8'));
        clips = Array.isArray(plan.clips) ? plan.clips : [];
    } else {
        if (config.parallel?.enabled) {
            const heatCandidates = buildDanmakuHeatClips(candidates, candidates.length, clipLabel);
            const modelLimit = Math.max(0, Math.floor(Number(config.parallel.modelClips) || 0));
            const modelConfig = {
                ...config,
                maxClips: modelLimit
            };
            const modelClips = modelLimit > 0
                ? await planClipsWithAIFullContext(parsed, danmaku, info, totalDuration, modelConfig, rootConfig, aiDiagnostics, emotionAnalysis, existingFullLiveContext, streamerName)
                : [];
            clips = combineParallelClipPlans(heatCandidates, modelClips, config.parallel);
            aiDiagnostics.selectedSource = 'parallel';
            if (modelLimit > 0 && modelClips.length === 0) {
                aiDiagnostics.usedFallback = true;
                aiDiagnostics.fallbackReason = classifyAiFallbackReason(aiDiagnostics.errors);
            }
        } else if (config.ai?.enabled && config.ai?.strategy === 'staged') {
            const staged = await planClipsWithStagedAI(
                candidates,
                parsed,
                danmaku,
                info,
                totalDuration,
                config,
                rootConfig,
                aiDiagnostics,
                emotionAnalysis,
                streamerName
            );
            candidateRefinementAttempted = true;
            clips = staged.clips;
            fallbackCandidates = staged.pool.length > 0 ? staged.pool : candidates;
            aiDiagnostics.candidatePool = {
                localCandidates: candidates.length,
                chunkModelCandidates: staged.modelCandidates.length,
                rerankCandidates: staged.pool.length
            };
            if (clips.length > 0) {
                aiDiagnostics.selectedSource = 'staged_global_ai';
            }
        } else if (config.ai?.enabled && config.ai?.strategy === 'full_context') {
            clips = await planClipsWithAIFullContext(parsed, danmaku, info, totalDuration, config, rootConfig, aiDiagnostics, emotionAnalysis, existingFullLiveContext, streamerName);
            if (clips.length > 0) {
                aiDiagnostics.selectedSource = 'full_context_ai';
            }
        } else if (config.ai?.enabled && config.ai?.strategy !== 'candidate_only') {
            clips = await planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig, aiDiagnostics, emotionAnalysis, streamerName);
            if (clips.length > 0) {
                aiDiagnostics.selectedSource = 'chunked_ai';
            }
        }
        if (clips.length === 0 && !config.parallel?.enabled) {
            const clipsFromAi = candidateRefinementAttempted
                ? []
                : await refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig, aiDiagnostics, streamerName);
            if (clipsFromAi.length > 0) {
                clips = clipsFromAi;
                aiDiagnostics.selectedSource = 'candidate_ai';
            } else if (aiDiagnostics.localFallbackEnabled) {
                clips = fallbackClipsFromCandidates(fallbackCandidates, config, clipLabel);
                aiDiagnostics.usedFallback = true;
                aiDiagnostics.fallbackReason = (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false)
                    ? 'AI \u5df2\u7981\u7528'
                    : classifyAiFallbackReason(aiDiagnostics.errors);
                aiDiagnostics.selectedSource = fallbackCandidates === candidates
                    ? 'local_rules'
                    : 'recall_pool_fallback';
            } else {
                const failureReason = (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false)
                    ? 'AI 已禁用'
                    : classifyAiFallbackReason(aiDiagnostics.errors);
                throw new Error(`own_stream_clipper AI 规划失败且已禁用本地回退: ${failureReason}`);
            }
        } else if (clips.length === 0 && config.parallel?.enabled) {
            const failureReason = classifyAiFallbackReason(aiDiagnostics.errors);
            throw new Error(`own_stream_clipper 双路规划没有生成候选: ${failureReason}`);
        }
    }
    reviewMetadata.aiStatus = {
        strategy: aiDiagnostics.strategy,
        usedFallback: aiDiagnostics.usedFallback,
        fallbackReason: aiDiagnostics.fallbackReason,
        selectedSource: aiDiagnostics.selectedSource,
        errorCount: aiDiagnostics.errors.length,
        requests: aiDiagnostics.requests || [],
        ...(aiDiagnostics.skippedChunks?.length ? { skippedChunks: aiDiagnostics.skippedChunks } : {}),
        ...(aiDiagnostics.validation ? { validation: aiDiagnostics.validation } : {}),
        ...(aiDiagnostics.candidatePool ? { candidatePool: aiDiagnostics.candidatePool } : {})
    };
    clips = filterClipsBySelection(clips, options.selectedIndices);
    clips = attachEmotionEvidenceToClips(clips, emotionAnalysis, config.emotionScoring || {});
    clips = alignClipsToSubtitleBoundaries(clips, parsed.segments, config, totalDuration);
    const finalEvidence = buildSubtitleEvidence(parsed.segments);
    const personContext = buildPersonEvidenceContext(rootConfig, info.roomId);
    // Check narrative copy without the generated source/time attribution.
    const evidenceReview = (clip, copy) => revalidateClipEvidence({ ...clip, title: copy.title,
        coverText: copy.coverText }, finalEvidence, danmaku, personContext).grounding;
    clips = clips.map(clip => revalidateClipEvidence(clip, finalEvidence, danmaku, personContext));
    if (config.avoidOverlappingClips !== false) {
        const beforeOverlapFilter = clips.length;
        clips = removeOverlappingClips(clips, config.finalOverlapToleranceSeconds);
        if (clips.length < beforeOverlapFilter) {
            console.log(`Removed ${beforeOverlapFilter - clips.length} overlapping clip candidate(s) after subtitle boundary alignment.`);
        }
    }
    const inputPlanBase = options.planPath
        ? topicClipper.sanitizeFileName(path.basename(options.planPath, path.extname(options.planPath)))
        : null;
    const planPath = inputPlanBase
        ? path.join(outputRoot, `${inputPlanBase}_ALIGNED.json`)
        : path.join(outputRoot, 'PLAN.json');
    const reviewPath = inputPlanBase
        ? path.join(outputRoot, `REVIEW_${inputPlanBase}.md`)
        : path.join(outputRoot, 'REVIEW.md');
    reviewMetadata.reviewPath = reviewPath;
    reviewMetadata.uploadManifestPath = inputPlanBase
        ? path.join(outputRoot, `${inputPlanBase}_UPLOAD_MANIFEST.json`)
        : path.join(outputRoot, 'UPLOAD_MANIFEST.json');
    fs.writeFileSync(planPath, JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: {
            mediaPath: options.mediaPath,
            srtPath: options.srtPath,
            xmlPath: options.xmlPath || null
        },
        config: {
            maxCandidates: config.maxCandidates,
            maxClips: config.maxClips,
            minClipSeconds: config.minClipSeconds,
            maxClipSeconds: config.maxClipSeconds,
            chunkSeconds: config.chunkSeconds,
            aiConcurrency: config.aiConcurrency,
            clipConcurrency,
            clipFfmpegThreads,
            aiStrategy: config.ai?.strategy || null,
            aiModel: config.ai?.model || null,
            maxCandidateLines: config.ai?.maxCandidateLines || null,
            subtitleEvidenceFormat: `complete_grouped_v${finalEvidence.version}`,
            subtitleTruncation: false,
            maxCandidateDanmakuLines: config.ai?.maxCandidateDanmakuLines || null,
            parallel: config.parallel
        },
        aiStatus: reviewMetadata.aiStatus,
        clips
    }, null, 2), 'utf8');
    if (options.planOnly) {
        fs.writeFileSync(reviewPath, buildPlanReviewMarkdown(clips, reviewMetadata), 'utf8');
        console.log(`Plan only: ${planPath}`);
        console.log(`Review list: ${reviewPath}`);
        clips.forEach((clip, index) => {
            console.log(`${index + 1}. ${clip.title} ${formatClock(clip.start)} ${formatClock(clip.duration)} ${clip.reason || ''}`);
        });
        return clips;
    }

    const clipProcessingStartedAt = new Date();
    const clipProcessingStartedNs = process.hrtime.bigint();
    const completeClipProcessingStats = results => {
        const finishedAt = new Date();
        reviewMetadata.processingStats = buildClipProcessingStats(
            results,
            Number(process.hrtime.bigint() - clipProcessingStartedNs) / 1e6,
            clipProcessingStartedAt.toISOString(),
            finishedAt.toISOString()
        );
    };
    const resourceScheduler = createClipResourceAdaptiveScheduler({
        ownConfig: config,
        rootConfig
    });
    const initialResourceProfile = await resourceScheduler.refresh(true);
    const mediaConcurrency = resourceScheduler.enabled
        ? resourceScheduler.maxConcurrency
        : clipConcurrency;
    if (resourceScheduler.enabled) {
        console.log(
            `[resource] 自动切片资源检测: mode=${initialResourceProfile.mode}; `
            + `concurrency=${initialResourceProfile.concurrency}; `
            + `threads=${initialResourceProfile.ffmpegThreads}`
            + (initialResourceProfile.reason ? `; reason=${initialResourceProfile.reason}` : '')
        );
    }

    const source = {
        mediaPath: options.mediaPath,
        kind: topicClipper.chooseClipSource(options.mediaPath, options.mediaPath)?.kind || 'video',
        reason: 'own_stream_media',
        uploadReady: true
    };
    if (mediaConcurrency > 1) {
        console.log(`Clip media concurrency: ${mediaConcurrency}`);
        const profileAwareJobs = clips.map((clip, index) => resourceProfile => generateOwnStreamClipJob({
            clip,
            evidenceReview,
            index,
            parsed,
            danmaku,
            options,
            outputRoot,
            source,
            streamerName,
            info,
            config: resourceProfile
                ? { ...mediaConfig, clipFfmpegThreads: resourceProfile.ffmpegThreads }
                : mediaConfig,
            participantMetadata
        }));
        const results = await runJobsWithConcurrency(profileAwareJobs, mediaConcurrency, {
            scheduler: resourceScheduler
        });
        completeClipProcessingStats(results);
        fs.writeFileSync(reviewPath, buildReviewMarkdown(results, reviewMetadata), 'utf8');
        const residualReview = writeResidualAuditForOwnStream({
            options,
            config,
            outputRoot,
            planPath,
            clips
        });
        if (residualReview) reviewMetadata.residualAuditPath = residualReview.outputPath;
        const uploadRegistry = registerReviewForUpload(reviewPath, results, reviewMetadata);
        if (uploadRegistry) {
            reviewMetadata.uploadRegistry = uploadRegistry;
            fs.writeFileSync(reviewPath, buildReviewMarkdown(results, reviewMetadata), 'utf8');
        }
        try {
            await notifyResults(results, reviewMetadata, { ...rootConfig, ownStreamClips: config });
        } catch (error) {
            console.warn(`WeChat Work notification failed, local review kept: ${error.message}`);
        }
        console.log(`Review list: ${reviewPath}`);
        return results;
    }
    const results = [];
    for (const [index, clip] of clips.entries()) {
        const processingStartedAt = new Date();
        const processingStartedNs = process.hrtime.bigint();
        const resourcePeaks = [];
        const resourceLease = resourceScheduler.enabled
            ? await resourceScheduler.acquire()
            : null;
        const activeMediaConfig = resourceLease
            ? { ...mediaConfig, clipFfmpegThreads: resourceLease.profile.ffmpegThreads }
            : mediaConfig;
        try {
        const window = {
            index: index + 1,
            start: clip.start,
            end: clip.end,
            duration: clip.end - clip.start,
            originalStart: clip.originalStart ?? null,
            originalEnd: clip.originalEnd ?? null,
            boundaryAligned: Boolean(clip.boundaryAligned),
            boundaryTrimmedAtTrailingSilence: Boolean(clip.boundaryTrimmedAtTrailingSilence),
            matchedKeywords: clip.base?.matchedKeywords || [],
            matchCount: clip.base?.reactionCount || 0,
            matchSegments: [],
            allSegmentTexts: parsed.segments
                .filter(segment => Number(segment.end) > clip.start && Number(segment.start) < clip.end)
                .map(segment => segment.text),
            preContext: parsed.segments
                .filter(segment => Number(segment.end) <= clip.start && Number(segment.end) >= clip.start - 60)
                .map(segment => segment.text)
                .slice(-10),
            postContext: parsed.segments
                .filter(segment => Number(segment.start) >= clip.end && Number(segment.start) <= clip.end + 60)
                .map(segment => segment.text)
                .slice(0, 10)
        };
        const baseName = topicClipper.sanitizeFileName(
            `${path.basename(options.mediaPath, path.extname(options.mediaPath))}_fun_${String(index + 1).padStart(2, '0')}_${formatClock(window.start).replace(/:/g, '')}`
        );
        const mediaPath = path.join(outputRoot, `${baseName}.mp4`);
        const srtPath = path.join(outputRoot, `${baseName}.srt`);
        const metadataPath = path.join(outputRoot, `${baseName}.json`);
        const srtResult = topicClipper.writeClipSrt(parsed.segments, window, srtPath);
        const rawCopy = {
            title: clip.title,
            coverText: topicClipper.normalizeCoverText(clip.coverText),
            description: buildClipDescription({
                streamerName,
                streamTitle: info.streamTitle,
                recordedAt: info.recordedAt,
                start: window.start,
                end: window.end,
                description: clip.description,
                emotionEvidence: clip.base?.emotionEvidence || clip.emotionEvidence || []
            }),
            tags: buildClipTags(options.config || {}, info.roomId, streamerName)
        };
        const processedCopy = postProcessAiClipMetadata(rawCopy, options.config || {});
        const copy = { ...rawCopy, ...processedCopy };
        let mediaResult = null;
        let mediaError = null;
        try {
            mediaResult = await topicClipper.cutClipMedia(source, window, srtPath, mediaPath, {
                ...buildCutClipMediaConfig(activeMediaConfig, options),
                resourcePeaks
            });
            if (Array.isArray(mediaResult?.resourcePeaks) && mediaResult.resourcePeaks !== resourcePeaks) {
                resourcePeaks.push(...mediaResult.resourcePeaks);
            }
        } catch (error) {
            mediaError = error.message;
            console.warn(`clip media generation failed, metadata kept: ${error.message}`);
        }
        let coverPath = null;
        let coverError = null;
        if (mediaResult?.path && source.kind !== 'audio') {
            try {
                coverPath = await topicClipper.generateClipCover(
                    mediaResult.path,
                    buildCoverTitle(copy.title, copy.coverText),
                    outputRoot,
                    {
                        streamerName,
                        coverSourcePath: mediaResult.coverSourcePath || source.mediaPath,
                        clipStart: Number.isFinite(Number(mediaResult.coverClipStart))
                            ? Number(mediaResult.coverClipStart)
                            : window.start,
                        clipDuration: window.duration,
                        preferredTime: (() => {
                            const absolutePeak = topicClipper.selectCoverPreferredTime(
                                danmaku,
                                window,
                                config.reactionKeywords || []
                            );
                            return Number.isFinite(Number(mediaResult.coverTimeOrigin)) && Number.isFinite(Number(absolutePeak))
                                ? Number(absolutePeak) - Number(mediaResult.coverTimeOrigin)
                                : absolutePeak;
                        })(),
                        resourcePeaks
                    }
                );
            } catch (error) {
                coverError = error.message;
                console.warn(`clip cover generation failed, metadata kept: ${error.message}`);
            } finally {
                topicClipper.cleanupTemporaryCoverSource(mediaResult);
            }
        }
        const processingFinishedAt = new Date();
        const processing = {
            version: 1,
            startedAt: processingStartedAt.toISOString(),
            finishedAt: processingFinishedAt.toISOString(),
            elapsedMs: Math.round(Number(process.hrtime.bigint() - processingStartedNs) / 1e6),
            resourceMode: config.mode || config.resourceMode || null,
            ffmpegThreads: Number.isFinite(Number(config.clipFfmpegThreads))
                ? Number(config.clipFfmpegThreads)
                : null,
            resourcePeaks,
            resource: summarizeResourcePeaks(resourcePeaks)
        };
        const metadata = {
            version: 1,
            generatedAt: new Date().toISOString(),
            mode: 'own_stream_fun_review',
            source: {
                mediaPath: options.mediaPath,
                srtPath: options.srtPath,
                xmlPath: options.xmlPath || null
            },
            roomId: info.roomId,
            streamerName,
            participantInfo: participantMetadata,
            recordedAt: info.recordedAt,
            streamTitle: info.streamTitle,
            recommendationScore: Number.isFinite(Number(clip.score)) ? Number(clip.score) : null,
            window,
            candidate: clip.base || null,
            grounding: evidenceReview(clip, copy) || null,
            copy,
            upload: buildOwnUploadSettings({
                roomId: info.roomId,
                streamerName,
                streamTitle: info.streamTitle,
                recordedAt: info.recordedAt
            }, copy),
            processing,
            uploadReady: Boolean(mediaResult?.path),
            output: {
                mediaPath: mediaResult?.path || mediaPath,
                srtPath,
                metadataPath,
                burnedSubtitles: Boolean(mediaResult?.burnedSubtitles),
                subtitleBurnFallbackUsed: Boolean(mediaResult?.fallbackUsed),
                twoStageSubtitleBurn: mediaResult?.twoStageSubtitleBurn ?? null,
                twoStageMode: mediaResult?.twoStageMode ?? null,
                srtSegmentCount: srtResult.segmentCount,
                mediaError,
                coverPath,
                coverError
            }
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        results.push(metadata);
        console.log(`${index + 1}. ${copy.title} ${formatClock(window.start)} ${formatClock(window.duration)} ${metadata.output.mediaPath}`);
        } finally {
            resourceLease?.release();
        }
    }

    completeClipProcessingStats(results);
    fs.writeFileSync(reviewPath, buildReviewMarkdown(results, reviewMetadata), 'utf8');
    const residualReview = writeResidualAuditForOwnStream({
        options,
        config,
        outputRoot,
        planPath,
        clips
    });
    if (residualReview) reviewMetadata.residualAuditPath = residualReview.outputPath;
    const uploadRegistry = registerReviewForUpload(reviewPath, results, reviewMetadata);
    if (uploadRegistry) {
        reviewMetadata.uploadRegistry = uploadRegistry;
        fs.writeFileSync(reviewPath, buildReviewMarkdown(results, reviewMetadata), 'utf8');
    }
    try {
        await notifyResults(results, reviewMetadata, { ...rootConfig, ownStreamClips: config });
    } catch (error) {
        console.warn(`WeChat Work notification failed, local review kept: ${error.message}`);
    }
    console.log(`Review list: ${reviewPath}`);
    return results;
}

function parseCliArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--media') options.mediaPath = argv[++i];
        else if (arg.startsWith('--media=')) options.mediaPath = arg.slice('--media='.length);
        else if (arg === '--srt') options.srtPath = argv[++i];
        else if (arg.startsWith('--srt=')) options.srtPath = arg.slice('--srt='.length);
        else if (arg === '--xml') options.xmlPath = argv[++i];
        else if (arg.startsWith('--xml=')) options.xmlPath = arg.slice('--xml='.length);
        else if (arg === '--ffmpeg') options.ffmpegPath = argv[++i];
        else if (arg === '--use-plan') options.planPath = argv[++i];
        else if (arg.startsWith('--use-plan=')) options.planPath = arg.slice('--use-plan='.length);
        else if (arg === '--only') {
            options.selectedIndices = String(argv[++i] || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
        } else if (arg.startsWith('--only=')) {
            options.selectedIndices = arg.slice('--only='.length).split(',').map(v => Number(v.trim())).filter(Number.isFinite);
        }
        else if (arg === '--no-ai') options.noAi = true;
        else if (arg === '--no-notify') options.noNotify = true;
        else if (arg === '--residual-audit') options.residualAudit = true;
        else if (arg === '--no-residual-audit') options.residualAudit = false;
        else if (arg === '--plan-only') options.planOnly = true;
        else if (arg === '--parallel') options.parallel = true;
        else if (arg === '--danmaku-heat-clips') options.danmakuHeatClips = Number(argv[++i]);
        else if (arg.startsWith('--danmaku-heat-clips=')) options.danmakuHeatClips = Number(arg.slice('--danmaku-heat-clips='.length));
        else if (arg === '--model-clips') options.modelClips = Number(argv[++i]);
        else if (arg.startsWith('--model-clips=')) options.modelClips = Number(arg.slice('--model-clips='.length));
        else if (arg === '--prefer-heat-on-overlap') options.preferHeatOnOverlap = true;
        else if (arg === '--ai-strategy') options.aiStrategy = argv[++i];
        else if (arg.startsWith('--ai-strategy=')) options.aiStrategy = arg.slice('--ai-strategy='.length);
        else if (arg === '--ai-model') options.aiModel = argv[++i];
        else if (arg.startsWith('--ai-model=')) options.aiModel = arg.slice('--ai-model='.length);
        else if (arg === '--output-dir-name') options.outputDirName = argv[++i];
        else if (arg.startsWith('--output-dir-name=')) options.outputDirName = arg.slice('--output-dir-name='.length);
        else if (arg === '--max-clips') options.maxClips = Number(argv[++i]);
        else if (arg === '--chunk-seconds') options.chunkSeconds = Number(argv[++i]);
        else if (arg === '--ai-concurrency') options.aiConcurrency = Number(argv[++i]);
        else if (arg === '--clip-concurrency') options.clipConcurrency = Number(argv[++i]);
    }
    return options;
}

if (require.main === module) {
    (async () => {
        const cli = parseCliArgs(process.argv.slice(2));
        const config = configLoader.getConfig();
        config.ownStreamClips = {
            ...(config.ownStreamClips || {}),
            ...(cli.noAi ? { ai: { ...(config.ownStreamClips?.ai || {}), enabled: false } } : {}),
            ...(cli.noNotify ? { notify: { ...(config.ownStreamClips?.notify || {}), enabled: false } } : {}),
            ...(typeof cli.residualAudit === 'boolean' ? {
                residualAudit: { ...(config.ownStreamClips?.residualAudit || {}), enabled: cli.residualAudit }
            } : {}),
            ...(Number.isFinite(cli.maxClips) ? { maxClips: cli.maxClips } : {}),
            ...(Number.isFinite(cli.chunkSeconds) ? { chunkSeconds: cli.chunkSeconds } : {}),
            ...(Number.isFinite(cli.aiConcurrency) ? { aiConcurrency: cli.aiConcurrency } : {}),
            ...(Number.isFinite(cli.clipConcurrency) ? { clipConcurrency: cli.clipConcurrency } : {}),
            ...(cli.aiStrategy ? { ai: { ...(config.ownStreamClips?.ai || {}), strategy: cli.aiStrategy } } : {}),
            ...(cli.aiModel ? { ai: { ...(config.ownStreamClips?.ai || {}), ...(cli.aiStrategy ? { strategy: cli.aiStrategy } : {}), model: cli.aiModel } } : {}),
            ...(cli.outputDirName ? { outputDirName: cli.outputDirName } : {}),
            ...(cli.parallel || Number.isFinite(cli.danmakuHeatClips) || Number.isFinite(cli.modelClips) || cli.preferHeatOnOverlap ? {
                parallel: {
                    ...(config.ownStreamClips?.parallel || {}),
                    ...(cli.parallel ? { enabled: true } : {}),
                    ...(Number.isFinite(cli.danmakuHeatClips) ? { danmakuHeatClips: cli.danmakuHeatClips } : {}),
                    ...(Number.isFinite(cli.modelClips) ? { modelClips: cli.modelClips } : {}),
                    ...(cli.preferHeatOnOverlap ? { preferModelOnOverlap: false } : {})
                }
            } : {})
        };
        await generateOwnStreamClips({
            config,
            mediaPath: cli.mediaPath,
            srtPath: cli.srtPath,
            xmlPath: cli.xmlPath,
            ffmpegPath: cli.ffmpegPath,
            planOnly: cli.planOnly,
            planPath: cli.planPath,
            selectedIndices: cli.selectedIndices
        });
    })().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_OWN_STREAM_CLIPS_CONFIG,
    getOwnStreamClipsConfig,
    buildCutClipMediaConfig,
    buildSelectionPolicyPromptLines,
    writeResidualAuditForOwnStream,
    parseDanmakuXml,
    buildDanmakuDensity,
    buildCandidateWindows,
    loadEmotionAnalysisForSrt,
    emotionMomentScore,
    buildEmotionContextLines,
    getEmotionEvidenceForWindow,
    buildEmotionCandidates,
    attachEmotionEvidenceToClips,
    getWindowDanmakuEvidence,
    buildChunkSources,
    buildRecallCandidatePool,
    aggregateDanmakuForFullContext,
    buildFullContextHeatLines,
    buildFullContextSource,
    parseRecordingInfo,
    buildDanmakuHeatClips,
    combineParallelClipPlans,
    getSelectionSourceLabel,
    countSelectionSources,
    planClipsWithAIChunks,
    planClipsWithAIFullContext,
    planClipsWithStagedAI,
    refineCandidatesWithAI,
    alignClipToSubtitleBoundaries,
    alignClipsToSubtitleBoundaries,
    removeOverlappingClips,
    runJobsWithConcurrency,
    formatClock,
    formatProcessingDuration,
    summarizeResourcePeaks,
    buildClipProcessingStats,
    buildProcessingSummaryLines,
    buildNotifyMarkdown,
    buildReviewMarkdown,
    buildPlanReviewMarkdown,
    buildClipDescription,
    buildEmotionComposition,
    buildClipTags,
    buildCoverTitle,
    notifyResults,
    splitWeChatMarkdown,
    selectCoverPreferredTime: topicClipper.selectCoverPreferredTime,
    toFwdSlash,
    filterClipsBySelection,
    generateOwnStreamClips
};
