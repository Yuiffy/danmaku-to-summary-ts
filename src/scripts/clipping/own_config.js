'use strict';

// Source-executed configuration extraction; no filesystem, process or provider IO here.
function resolveRoomConfig(base, roomId, recordedAt, now, manualReview) {
    const room = String(roomId || '');
    const campaign = (base.campaigns || []).find(row => row.enabled === true && row.roomIds?.map(String).includes(room));
    if (!campaign) return base;
    const start = Date.parse(campaign.startsAt), end = Date.parse(campaign.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid clip campaign dates');
    // Recording filenames use Shanghai local time. Unknown dates fail closed at the actual source entry.
    const sourceTime = recordedAt === undefined ? now : Date.parse(String(recordedAt || '').replace(' ', 'T') + '+08:00');
    if (!(sourceTime >= start && sourceTime < end && (manualReview || now >= start && now < end))) return { ...base, enabled: false };
    const settings = campaign.settings || {};
    return { ...base, ...settings, roomIds: [...new Set([...(base.roomIds || []).map(String), room])],
        ...(campaign.requiredGames ? { campaignContentGate: { id: campaign.id, requiredGames: campaign.requiredGames } } : {}),
        ai: { ...base.ai, ...settings.ai },
        publicationPolicy: { ...base.publicationPolicy, ...settings.publicationPolicy, roomIds: [room] },
        enhancements: { ...base.enhancements, ...settings.enhancements,
            roomIds: [...new Set([...(base.enhancements?.roomIds || []).map(String), room])] },
        attribution: { ...base.attribution, ...settings.attribution,
            roomIds: [...new Set([...(base.attribution?.roomIds || []).map(String), room])] },
        selectionPolicy: { ...base.selectionPolicy, ...settings.selectionPolicy,
            excludedCategories: [...(base.selectionPolicy?.excludedCategories || []), ...(settings.selectionPolicy?.excludedCategories || [])],
            priorityCategories: [...(base.selectionPolicy?.priorityCategories || []), ...(settings.selectionPolicy?.priorityCategories || [])] }
    };
}

const DEFAULT_OWN_STREAM_CLIPS_CONFIG = {
    enabled: false,
    mode: 'local_review',
    roomIds: [],
    windowSeconds: 110,
    prePaddingSeconds: 18,
    postPaddingSeconds: 26,
    mergeGapSeconds: 45,
    // Local signal window construction only; AI selections use complete source-backed topics.
    maxClipSeconds: 210,
    minClipSeconds: 35,
    maxCandidates: 80,
    maxClips: 50,
    chunkSeconds: 2700,
    aiConcurrency: 3,
    clipConcurrency: 2,
    enhancementConcurrency: 3,
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
    chunkOverlapSeconds: 30,
    enhancements: { enabled: false, roomIds: [], editing: false },
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
        rerankTimeoutMs: 1200000,
        rerankMaxAttempts: 2,
        maxCandidateLines: 100,
        recallMaxClipsPerChunk: 12,
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

function getOwnStreamClipsConfig(config = {}, roomId = null, recordedAt, now = Date.now(), manualReview = false) {
    const raw = resolveRoomConfig(config.ownStreamClips || {}, roomId, recordedAt, now, manualReview);
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
        selectionPolicy: require('./selection_policy').resolveSelectionPolicy({
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy,
            ...(raw.selectionPolicy || {}),
            excludedCategories: Array.isArray(raw.selectionPolicy?.excludedCategories)
                ? raw.selectionPolicy.excludedCategories
                : DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy.excludedCategories,
            priorityCategories: Array.isArray(raw.selectionPolicy?.priorityCategories)
                ? raw.selectionPolicy.priorityCategories
                : DEFAULT_OWN_STREAM_CLIPS_CONFIG.selectionPolicy.priorityCategories
        }, roomId),
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

module.exports = { DEFAULT_OWN_STREAM_CLIPS_CONFIG, getOwnStreamClipsConfig };
