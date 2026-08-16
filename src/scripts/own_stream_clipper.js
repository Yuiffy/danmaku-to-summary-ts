const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
const { spawnSync } = require('child_process');
const asrBackends = require('./asr/asr_backends');
const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');
const { postProcessAiClipMetadata } = require('./ai_clip_metadata');
const fullLiveContext = require('./full_live_context');
const residualAudit = require('./own_stream_residual_audit');
const { resolveClipOutputRoot } = require('./clip_output_path');

const {
    notableEmotionEvents,
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
    maxCandidates: 48,
    maxClips: 24,
    chunkSeconds: 2700,
    aiConcurrency: 3,
    clipConcurrency: 3,
    clipFfmpegThreads: 4,
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
    subtitleVideoEncoder: 'libx264',
    subtitleVideoPreset: 'ultrafast',
    subtitleVideoCrf: 23,
    subtitleVideoCq: 23,
    subtitleFontSizeRatio: 0.094,
    subtitlePortraitFontSizeRatio: 0.044,
    outputDirName: 'own_stream_fun_clips',
    ai: {
        enabled: true,
        strategy: 'chunked',
        model: null,
        timeoutMs: 600000,
        maxCandidateLines: 32,
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

function buildOwnStreamClipCopyPromptLines(generator) {
    return [
        ...generator.buildClipTitlePromptLines({ outputMode: 'jsonTitle', streamerName: '岁己SUI' }),
        ...generator.buildCoverTextPromptLines(),
        ...generator.buildClipDescriptionPromptLines(),
        '字段必须分工：description 是公开简介，只写片中具体内容；reason 是内部选材理由，可记录字幕完整性、弹幕反应和情绪信号。不得把 reason 复述或改写进 description。'
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

function timeStringToSeconds(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
    if (!match) return NaN;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function clamp(value, min, max = Number.POSITIVE_INFINITY) {
    return Math.min(Math.max(value, min), max);
}

function uniqueTextSamples(items, max = 8) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const text = String(item.text || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
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

function makeCandidate(start, end, reason, score, extra = {}) {
    return {
        start,
        end,
        duration: end - start,
        reason,
        score,
        ...extra
    };
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

function getEmotionEvidenceForWindow(analysis, window, config = {}) {
    const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : [];
    const items = timeline
        .filter(item => Number(item.end) > Number(window.start) && Number(item.start) < Number(window.end))
        .map(item => ({
            start: Number(item.start),
            end: Number(item.end),
            emotion: item.emotion || null,
            events: notableEmotionEvents(item.events),
            score: emotionMomentScore(item, config),
            text: String(item.text || '').trim()
        }));
    return {
        items,
        emotions: Array.from(new Set(items.map(item => item.emotion).filter(Boolean))),
        events: Array.from(new Set(items.flatMap(item => item.events))),
        maxScore: Math.max(0, ...items.map(item => item.score))
    };
}

function buildEmotionCandidates(analysis, config, totalDuration) {
    if (
        config?.enabled === false
        || analysis?.status !== 'completed'
        || !Array.isArray(analysis.timeline)
    ) {
        return [];
    }
    const minimum = Number(config.minCandidateScore || 20);
    const candidates = [];
    const timeline = [...analysis.timeline].sort((a, b) => Number(a.start) - Number(b.start));
    timeline.forEach((item, index) => {
        const score = emotionMomentScore(item, config);
        const previous = timeline[index - 1];
        const transition = previous?.emotion
            && item.emotion
            && previous.emotion !== item.emotion
            && item.emotion !== 'NEUTRAL';
        const transitionScore = transition ? Number(config.transitionScore || 0) : 0;
        const candidateScore = Math.max(score, transitionScore);
        if (candidateScore < minimum) return;
        const reason = score >= minimum ? 'emotion_signal' : 'emotion_transition';
        const start = Number(item.start);
        const end = Number(item.end);
        candidates.push(makeCandidate(
            start - Number(config.prePaddingSeconds || 18),
            end + Number(config.windowSeconds || 110),
            reason,
            candidateScore,
            {
                emotions: item.emotion ? [item.emotion] : [],
                events: notableEmotionEvents(item.events),
                emotionEvidence: [{
                    start,
                    end,
                    emotion: item.emotion || null,
                    events: notableEmotionEvents(item.events),
                    score,
                    text: String(item.text || '').trim()
                }]
            }
        ));
    });
    return candidates.filter(candidate => candidate.start < totalDuration && candidate.end > 0);
}

function attachEmotionEvidenceToClips(clips, analysis, config) {
    return (clips || []).map(clip => {
        const evidence = getEmotionEvidenceForWindow(analysis, clip, config);
        if (evidence.items.length === 0) return clip;
        return {
            ...clip,
            emotions: evidence.emotions,
            events: evidence.events,
            emotionEvidence: evidence.items,
            base: {
                ...(clip.base || {}),
                emotions: evidence.emotions,
                events: evidence.events,
                emotionEvidence: evidence.items
            }
        };
    });
}

function buildCandidateWindows(parsed, danmaku, config, totalDuration, emotionAnalysis = null) {
    const segments = parsed.segments || [];
    const density = buildDanmakuDensity(danmaku, totalDuration, config);
    const raw = [];
    raw.push(...buildEmotionCandidates(emotionAnalysis, {
        ...(config.emotionScoring || {}),
        prePaddingSeconds: config.prePaddingSeconds,
        windowSeconds: config.windowSeconds
    }, totalDuration));

    for (const bucket of density.buckets) {
        if (bucket.count >= density.threshold || bucket.keywords > 0) {
            const score = bucket.count + bucket.keywords * 8;
            raw.push(makeCandidate(
                bucket.start - config.prePaddingSeconds,
                bucket.end + config.postPaddingSeconds,
                bucket.count >= density.threshold ? 'danmaku_density' : 'danmaku_reaction',
                score,
                {
                    danmakuCount: bucket.count,
                    reactionCount: bucket.keywords,
                    danmakuSamples: uniqueTextSamples(bucket.samples, 8)
                }
            ));
        }
    }

    const reactionKeywords = config.reactionKeywords || [];
    for (const item of danmaku) {
        const hits = reactionKeywords.filter(keyword => item.text.includes(keyword));
        if (hits.length === 0) continue;
        raw.push(makeCandidate(
            item.time - config.prePaddingSeconds,
            item.time + config.windowSeconds,
            'danmaku_keyword',
            20 + hits.length * 8,
            {
                matchedKeywords: hits,
                danmakuCount: 1,
                reactionCount: hits.length,
                danmakuSamples: [item.text]
            }
        ));
    }

    const subtitleKeywords = config.subtitleKeywords || [];
    segments.forEach((segment, index) => {
        const hits = subtitleKeywords.filter(keyword => String(segment.text || '').includes(keyword));
        if (hits.length === 0) return;
        raw.push(makeCandidate(
            Number(segment.start) - config.prePaddingSeconds,
            Number(segment.end) + config.windowSeconds,
            'subtitle_keyword',
            16 + hits.length * 6,
            {
                matchedKeywords: hits,
                subtitleHitText: segment.text,
                segmentIndex: index
            }
        ));
    });

    const normalized = raw
        .map(candidate => ({
            ...candidate,
            start: clamp(candidate.start, 0, totalDuration),
            end: clamp(candidate.end, 0, totalDuration)
        }))
        .filter(candidate => candidate.end - candidate.start >= Math.max(5, Number(config.minClipSeconds) || 35))
        .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const candidate of normalized) {
        const last = merged[merged.length - 1];
        if (
            last &&
            candidate.start - last.end <= config.mergeGapSeconds &&
            Math.max(last.end, candidate.end) - last.start <= config.maxClipSeconds
        ) {
            last.end = Math.max(last.end, candidate.end);
            last.duration = last.end - last.start;
            last.score += candidate.score;
            last.reason = Array.from(new Set(String(last.reason).split('+').concat(candidate.reason))).join('+');
            last.danmakuCount = (last.danmakuCount || 0) + (candidate.danmakuCount || 0);
            last.reactionCount = (last.reactionCount || 0) + (candidate.reactionCount || 0);
            last.matchedKeywords = Array.from(new Set([...(last.matchedKeywords || []), ...(candidate.matchedKeywords || [])]));
            last.danmakuSamples = uniqueTextSamples([
                ...(last.danmakuSamples || []).map(text => ({ text })),
                ...(candidate.danmakuSamples || []).map(text => ({ text }))
            ], 10);
            last.emotions = Array.from(new Set([...(last.emotions || []), ...(candidate.emotions || [])]));
            last.events = Array.from(new Set([...(last.events || []), ...(candidate.events || [])]));
            last.emotionEvidence = [...(last.emotionEvidence || []), ...(candidate.emotionEvidence || [])];
            continue;
        }
        merged.push({ ...candidate });
    }

    return merged
        .map((candidate, index) => ({
            ...candidate,
            index: index + 1,
            duration: candidate.end - candidate.start
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(config.maxCandidates) || 48))
        .sort((a, b) => a.start - b.start);
}

function getWindowText(segments, window, maxChars = 700) {
    return segments
        .filter(segment => Number(segment.end) > window.start && Number(segment.start) < window.end)
        .map(segment => `${formatClock(segment.start)} ${String(segment.text || '').trim()}`)
        .join('\n')
        .slice(0, maxChars);
}

function getWindowDanmaku(danmaku, window, max = 12) {
    return danmaku
        .filter(item => item.time >= window.start && item.time <= window.end)
        .slice(0, max)
        .map(item => `${formatClock(item.time)} ${item.text}`);
}

function topDanmakuTexts(items, max = 8) {
    const counts = new Map();
    for (const item of items) {
        const text = String(item.text || '').trim();
        if (!text) continue;
        counts.set(text, (counts.get(text) || 0) + 1);
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([text, count]) => count > 1 ? `${text}(x${count})` : text);
}

function buildChunkSources(parsed, danmaku, totalDuration, config, emotionAnalysis = null) {
    const chunkSeconds = Math.max(600, Number(config.chunkSeconds) || 2700);
    const density = buildDanmakuDensity(danmaku, totalDuration, config);
    const chunks = [];
    for (let start = 0, index = 1; start < totalDuration; start += chunkSeconds, index += 1) {
        const end = Math.min(start + chunkSeconds, totalDuration);
        const chunkSegments = parsed.segments.filter(segment => Number(segment.end) > start && Number(segment.start) < end);
        const chunkDanmaku = danmaku.filter(item => item.time >= start && item.time < end);
        const buckets = density.buckets.filter(bucket => bucket.end > start && bucket.start < end);
        const densityLines = buckets
            .filter(bucket => bucket.count >= density.threshold || bucket.keywords > 0)
            .map(bucket => {
                const items = chunkDanmaku.filter(item => item.time >= bucket.start && item.time < bucket.end);
                const top = topDanmakuTexts(items, 6).join(' / ');
                return `${formatClock(bucket.start)} count=${bucket.count} reaction=${bucket.keywords}${top ? ` | ${top}` : ''}`;
            });
        const reactionLines = chunkDanmaku
            .filter(item => (config.reactionKeywords || []).some(keyword => item.text.includes(keyword)))
            .slice(0, Math.max(20, Number(config.maxDanmakuLinesPerChunk) || 220))
            .map(item => `${formatClock(item.time)} ${item.text}`);
        let subtitleText = chunkSegments
            .map(segment => `${formatClock(segment.start)} ${String(segment.text || '').trim()}`)
            .join('\n');
        const maxSubtitleChars = Math.max(2000, Number(config.maxSubtitleCharsPerChunk) || 14000);
        if (subtitleText.length > maxSubtitleChars) {
            subtitleText = subtitleText.slice(0, maxSubtitleChars) + '\n...(字幕过长已截断)';
        }
        const emotionLines = buildEmotionContextLines(
            emotionAnalysis,
            config.emotionScoring || {},
            start,
            end,
            Math.min(80, Number(config.emotionScoring?.maxContextLines) || 80)
        );
        chunks.push({
            index,
            start,
            end,
            segments: chunkSegments,
            danmaku: chunkDanmaku,
            emotionLines,
            sourceText: [
                `分段 #${index} ${formatClock(start)}-${formatClock(end)}`,
                `弹幕总数: ${chunkDanmaku.length}`,
                '',
                '高弹幕/高反应时间点:',
                densityLines.slice(0, 80).join('\n') || '无',
                '',
                '观众反应弹幕样例:',
                reactionLines.slice(0, Number(config.maxDanmakuLinesPerChunk) || 220).join('\n') || '无',
                '',
                'SenseVoice 情感/声音事件（辅助线索，不作为事实）:',
                emotionLines.join('\n') || '无',
                '',
                '直播音轨字幕:',
                subtitleText || '无'
            ].join('\n')
        });
    }
    return chunks;
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

function dedupePlannedClips(clips, config) {
    const sorted = clips
        .filter(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start)
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const clip of sorted) {
        const last = out[out.length - 1];
        if (last && clip.start - last.end <= 12) {
            if ((clip.score || 0) > (last.score || 0)) {
                out[out.length - 1] = clip;
            }
            continue;
        }
        out.push(clip);
    }
    return out
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(1, Number(config.maxClips) || 24))
        .sort((a, b) => a.start - b.start);
}

function isLikelyTopicContinuationText(text) {
    const normalized = String(text || '').replace(/\s+/g, '');
    if (!normalized) return false;
    if (isLikelyNewTopicOpeningText(normalized)) return false;
    return [
        '\u7136\u540e',
        '\u56e0\u4e3a',
        '\u6240\u4ee5',
        '\u4f46\u662f',
        '\u53d1\u73b0',
        '\u7a81\u7136\u60f3\u8d77',
        '\u6211\u60f3\u8bf4',
        '\u4e3a\u4ec0\u4e48',
        '\u4e3a\u5565',
        '\u8fd8\u597d',
        '\u8fd8\u6ca1',
        '\u6ca1\u6709\u770b\u5230',
        '\u6ca1\u8d70\u8fdb\u53bb',
        '\u9000\u51fa',
        '\u8d70\u8fdb\u53bb',
        '\u5f80\u90a3\u8fb9',
        '\u8fd9\u597d\u50cf',
        '\u4f60\u61c2\u5417'
    ].some(keyword => normalized.includes(keyword));
}

function isLikelyNewTopicOpeningText(text) {
    const normalized = String(text || '').replace(/\s+/g, '').toLowerCase();
    return [
        '\u8c22\u8c22',
        '\u611f\u8c22',
        'thank',
        'thanks',
        '\u793c\u7269',
        'sc',
        '\u8230\u957f'
    ].some(keyword => normalized.startsWith(keyword));
}

function collectTextAfterGap(segments, startIndex, maxSeconds) {
    const first = segments[startIndex];
    if (!first) return '';
    const maxEnd = first.start + maxSeconds;
    return segments
        .slice(startIndex)
        .filter(segment => segment.start <= maxEnd)
        .map(segment => segment.text)
        .join('');
}

function alignClipToSubtitleBoundaries(clip, segments = [], config = {}, totalDuration = Number.POSITIVE_INFINITY) {
    if (!config.alignBoundaries) return clip;
    const start = Number(clip.start);
    const end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return clip;

    const startBacktrack = Math.max(0, Number(config.boundaryStartBacktrackSeconds) || 0);
    const endExtend = Math.max(0, Number(config.boundaryEndExtendSeconds) || 0);
    const silenceGap = Math.max(0.5, Number(config.boundarySilenceGapSeconds) || 2.0);
    const trailingLookback = Math.max(0, Number(config.boundaryTrailingSilenceLookbackSeconds) || 0);
    const maxEnd = Math.min(Number.isFinite(totalDuration) ? totalDuration : Number.POSITIVE_INFINITY, end + endExtend);

    const normalized = (segments || [])
        .map(segment => ({
            start: Number(segment.start),
            end: Number(segment.end),
            text: segment.text
        }))
        .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
        .sort((a, b) => a.start - b.start);

    let alignedStart = start;
    let alignedEnd = end;

    const firstOverlapIndex = normalized.findIndex(segment => segment.end > start && segment.start <= end);
    const firstOverlap = firstOverlapIndex >= 0 ? normalized[firstOverlapIndex] : null;
    if (firstOverlap && start - firstOverlap.start <= startBacktrack) {
        alignedStart = firstOverlap.start;
        let cursor = firstOverlapIndex - 1;
        while (cursor >= 0) {
            const previous = normalized[cursor];
            const next = normalized[cursor + 1];
            const gap = next.start - previous.end;
            if (gap >= silenceGap || start - previous.start > startBacktrack) break;
            alignedStart = previous.start;
            cursor -= 1;
        }
    }

    const trailingGap = normalized
        .map((segment, index) => {
            const next = normalized[index + 1];
            if (!next) return null;
            return {
                end: segment.end,
                gap: next.start - segment.end,
                nextIndex: index + 1
            };
        })
        .filter(Boolean)
        .filter(item => item.gap >= silenceGap && item.end > start && item.end < end && end - item.end <= trailingLookback)
        .filter(item => !isLikelyTopicContinuationText(collectTextAfterGap(normalized, item.nextIndex, 25)))
        .sort((a, b) => b.end - a.end)[0];
    if (trailingGap && trailingGap.end - alignedStart >= Math.max(10, Number(config.minClipSeconds) || 0)) {
        alignedEnd = trailingGap.end;
        alignedStart = clamp(alignedStart, 0, Number.isFinite(totalDuration) ? totalDuration : Number.POSITIVE_INFINITY);
        return {
            ...clip,
            originalStart: clip.originalStart ?? clip.start,
            originalEnd: clip.originalEnd ?? clip.end,
            start: Number(alignedStart.toFixed(3)),
            end: Number(alignedEnd.toFixed(3)),
            duration: Number((alignedEnd - alignedStart).toFixed(3)),
            boundaryAligned: alignedStart !== start || alignedEnd !== end,
            boundaryTrimmedAtTrailingSilence: true
        };
    }

    const segmentAtEnd = normalized.find(segment => segment.start < end && segment.end >= end);
    if (segmentAtEnd) {
        alignedEnd = Math.max(alignedEnd, segmentAtEnd.end);
    }

    let lastIncludedIndex = -1;
    for (let i = 0; i < normalized.length; i += 1) {
        if (normalized[i].start < alignedEnd && normalized[i].end >= alignedStart) {
            lastIncludedIndex = i;
        }
    }
    if (lastIncludedIndex >= 0) {
        let cursor = lastIncludedIndex;
        alignedEnd = Math.max(alignedEnd, normalized[cursor].end);
        while (cursor + 1 < normalized.length) {
            const current = normalized[cursor];
            const next = normalized[cursor + 1];
            const gap = next.start - current.end;
            if (next.end > maxEnd) break;
            if (gap >= silenceGap && !isLikelyTopicContinuationText(collectTextAfterGap(normalized, cursor + 1, 25))) break;
            alignedEnd = Math.max(alignedEnd, next.end);
            cursor += 1;
        }
    }

    alignedStart = clamp(alignedStart, 0, Number.isFinite(totalDuration) ? totalDuration : Number.POSITIVE_INFINITY);
    alignedEnd = clamp(alignedEnd, alignedStart + 0.1, Number.isFinite(totalDuration) ? totalDuration : Number.POSITIVE_INFINITY);

    return {
        ...clip,
        originalStart: clip.originalStart ?? clip.start,
        originalEnd: clip.originalEnd ?? clip.end,
        start: Number(alignedStart.toFixed(3)),
        end: Number(alignedEnd.toFixed(3)),
        duration: Number((alignedEnd - alignedStart).toFixed(3)),
        boundaryAligned: alignedStart !== start || alignedEnd !== end
    };
}

function alignClipsToSubtitleBoundaries(clips = [], segments = [], config = {}, totalDuration = Number.POSITIVE_INFINITY) {
    return clips.map(clip => alignClipToSubtitleBoundaries(clip, segments, config, totalDuration));
}

function removeOverlappingClips(clips = [], toleranceSeconds = 0) {
    const tolerance = Math.max(0, Number(toleranceSeconds) || 0);
    const ranked = clips
        .map((clip, order) => ({ clip, order }))
        .sort((a, b) => Number(b.clip.score || 0) - Number(a.clip.score || 0) || a.order - b.order);
    const selected = [];
    for (const entry of ranked) {
        const overlaps = selected.some(existing =>
            Number(entry.clip.start) < Number(existing.end) + tolerance
            && Number(existing.start) < Number(entry.clip.end) + tolerance
        );
        if (!overlaps) selected.push(entry.clip);
    }
    return selected.sort((a, b) => Number(a.start) - Number(b.start));
}

async function runJobsWithConcurrency(jobs = [], concurrency = 1) {
    const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
    const results = new Array(jobs.length);
    let cursor = 0;

    async function worker() {
        while (cursor < jobs.length) {
            const index = cursor;
            cursor += 1;
            try {
                results[index] = await jobs[index]();
            } catch (error) {
                // 一个切片失败不应终止同一场直播的其余切片；保留已完成结果，
                // 让 review/企微通知至少覆盖成功生成的部分。
                console.warn(`clip job ${index + 1} failed, continuing remaining jobs: ${error.message}`);
                results[index] = null;
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, jobs.length) }, () => worker());
    await Promise.all(workers);
    return results.filter(Boolean);
}

async function planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig = {}, diagnostics = null, emotionAnalysis = null) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return [];
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const chunks = buildChunkSources(parsed, danmaku, totalDuration, config, emotionAnalysis);
    const worker = async (chunk) => {
        const prompt = [
            '你是直播切片编辑。下面是一段岁己SUI自己直播的字幕和弹幕摘要。',
            OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
            '请直接找这个分段里所有可能值得本地 review 的切片：有趣、弹幕很多、弹幕很在意、体现岁己想法与众不同、岁己傻事，或弹幕觉得她傻/特别/有趣/可爱。',
            '不要只看关键词；弹幕密度、弹幕反应和上下文都要考虑。没有独立看点的片段降低优先级，但不要按内容类型一刀切排除。',
            ...buildSelectionPolicyPromptLines(config.selectionPolicy),
            'SenseVoice 情感和声音事件只能作为寻找反差、爆笑、惊讶、委屈等时刻的辅助线索；必须结合字幕确认具体内容，不能仅凭标签下结论。',
            '每段 35 秒到 3 分半，尽量切在句子边界。一个分段最多返回 8 段，没有就返回空数组。',
            '输出纯 JSON，不要 Markdown：',
            'Boundary rules are critical:',
            '- startTime must include the setup/premise, not start from the punchline.',
            '- endTime must include the explanation, follow-up reactions, and the final closing sentence.',
            '- If the streamer continues explaining the same incident after a short pause, extend endTime until that explanation is complete.',
            '- Stop before a truly new topic or unrelated material; keep meaningful reactions and follow-up context.',
            '- Prefer a natural silence after a complete sentence; never end in the middle of a sentence or continuous story.',
            '',
            ...buildOwnStreamClipCopyPromptLines(generator),
            '{"clips":[{"startTime":"HH:MM:SS","endTime":"HH:MM:SS","title":"人工风格标题，18-42字","coverText":"第一行\\n第二行","description":"面向观众的一句话内容简介","reason":"内部选材理由","score":1}]}',
            '',
            `直播标题: ${info.streamTitle || '未知'}`,
            `录制时间: ${info.recordedAt || '未知'}`,
            '',
            chunk.sourceText
        ].join('\n');
        try {
            const result = provider === 'tuZi'
                ? await generator.generateTextWithTuZi(prompt, { wordLimit: 1000 })
                : provider === 'daiYu'
                ? await generator.generateTextWithDaiYu(prompt, { wordLimit: 1000 })
                : await generator.generateTextWithGemini(prompt, { wordLimit: 1000 });
            const text = String(result.text || '').trim();
            const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
            if (!match) {
                recordAiDiagnostic(diagnostics, `chunk-${chunk.index}`, new Error('AI did not return clips JSON'));
                console.warn(`AI chunk #${chunk.index} did not return clips JSON: ${text.slice(0, 160)}`);
                return [];
            }
            const parsedJson = JSON.parse(match[0]);
            return (parsedJson.clips || []).map((clip, index) => {
                const start = timeStringToSeconds(clip.startTime);
                const end = timeStringToSeconds(clip.endTime);
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
                const duration = end - start;
                if (duration < config.minClipSeconds || duration > config.maxClipSeconds + 5) return null;
                return {
                    start: clamp(start, chunk.start, chunk.end),
                    end: clamp(end, chunk.start, chunk.end),
                    duration,
                    title: String(clip.title || '').trim() || '小岁：直播有趣片段',
                    coverText: topicClipper.normalizeCoverText(clip.coverText),
                    description: String(clip.description || '').trim(),
                    reason: String(clip.reason || '').trim(),
                    score: Number(clip.score || 0) + 100 - index,
                    candidateIndex: `chunk-${chunk.index}-${index + 1}`,
                    base: {
                        reason: 'ai_chunked_plan',
                        chunkIndex: chunk.index,
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
    existingFullLiveContext = null
) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return [];
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
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
    const maxClips = Math.max(1, Number(config.maxClips) || 24);
    const taskSuffix = [
        '你是资深直播切片主编。共享事实输入提供了岁己SUI本场直播的全量带时间戳字幕和全量弹幕。',
        OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
        `请通读整场，从全局比较后选出最多 ${maxClips} 个最有趣、最适合独立发布的片段。数量不必凑满，质量优先。`,
        '模型必须同时评估内容质量和弹幕热度：先根据字幕判断事件是否完整、有趣、适合独立发布，再结合30秒热度表、反应弹幕数、重复刷屏和全量弹幕判断观众反应强度。',
        '热度是重要证据但不是唯一标准：高热度但没有明确内容看点的片段不要选；低热度但故事完整、观点独特、反差强或特别可爱的内容仍可选。',
        'SenseVoice 情感和笑声/哭声等事件是辅助证据，可用于定位反差或强反应；必须结合字幕和弹幕验证，不能只凭标签选段或描述事实。',
        '优先：完整有起承转合的趣事；岁己独特/离谱/可爱的想法；口误或操作事故及后续反应；弹幕明显在意且字幕能说明原因的内容。',
        '没有独立看点的片段降低优先级；电影、感谢、唱歌和普通聊天不做默认排除，有完整事件、观点、反应或反差时可以选择。',
        ...buildSelectionPolicyPromptLines(config.selectionPolicy),
        `每段 ${config.minClipSeconds}-${config.maxClipSeconds} 秒。时间必须取自输入，不能编造。`,
        '边界要求：startTime 包含铺垫；endTime 包含解释、弹幕后续反应和收尾句；不要从笑点中间开始，也不要在句子或故事中间结束。',
        '所有输出片段必须互不重叠；同一话题可以有多个片段，只要各自独立成立且时间不重叠。',
        '请给每段 1-100 的全场相对分数，并按 score 从高到低输出。',
        '输出纯 JSON，不要 Markdown，不要解释：',
        ...buildOwnStreamClipCopyPromptLines(generator),
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
                title: String(clip.title || '').trim() || '小岁：直播有趣片段',
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
    return `AI\u72b6\u6001: AI \u89c4\u5212\u672a\u6210\u529f\uff08${reason}\uff09\uff0c\u5df2\u56de\u9000\u5230\u672c\u5730\u5f39\u5e55\u89c4\u5219\u5019\u9009\uff0c\u6807\u9898\u53ef\u80fd\u504f\u6cdb\u3002`;
}

function buildFallbackTitle(candidate) {
    const reason = String(candidate.reason || '');
    if (reason.includes('danmaku_density')) return '小岁：弹幕突然很在意的片段';
    if (reason.includes('danmaku_keyword')) return '小岁：弹幕觉得这里很有趣';
    if (reason.includes('subtitle_keyword')) return '小岁：很有小岁想法的一段';
    return '小岁：直播有趣片段';
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

function normalizeAiClips(rawClips, candidates, totalDuration, config) {
    const candidateByIndex = new Map(candidates.map(candidate => [String(candidate.index), candidate]));
    return (Array.isArray(rawClips) ? rawClips : [])
        .map((clip, index) => {
            const base = candidateByIndex.get(String(clip.candidateIndex)) || candidates[index] || null;
            const start = timeStringToSeconds(clip.startTime);
            const end = timeStringToSeconds(clip.endTime);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
            const duration = end - start;
            if (duration < config.minClipSeconds || duration > config.maxClipSeconds + 5) return null;
            return {
                start: clamp(start, 0, totalDuration),
                end: clamp(end, 0, totalDuration),
                duration,
                title: String(clip.title || '').trim() || (base ? buildFallbackTitle(base) : '小岁：直播有趣片段'),
                coverText: topicClipper.normalizeCoverText(clip.coverText),
                description: String(clip.description || '').trim(),
                reason: String(clip.reason || base?.reason || '').trim(),
                candidateIndex: base?.index || clip.candidateIndex || index + 1,
                score: Number(base?.score || 0),
                base
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start)
        .slice(0, Math.max(1, Number(config.maxClips) || 24));
}

async function refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig = {}, diagnostics = null) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false || candidates.length === 0) {
        return [];
    }
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const candidateLines = candidates
        .slice(0, config.ai.maxCandidateLines)
        .map(candidate => [
            `#${candidate.index} ${formatClock(candidate.start)}-${formatClock(candidate.end)} score=${candidate.score} reason=${candidate.reason}`,
            `情感线索: emotions=${(candidate.emotions || []).join(',') || '无'} events=${(candidate.events || []).join(',') || '无'}`,
            `观众弹幕样例: ${getWindowDanmaku(danmaku, candidate, 8).join(' / ') || '无'}`,
            `直播音轨字幕: ${getWindowText(parsed.segments, candidate, 520) || '无'}`
        ].join('\n'))
        .join('\n\n');

    const prompt = [
        '你是直播切片编辑。下面是岁己SUI自己直播的候选片段。',
        OWN_STREAM_SOURCE_ATTRIBUTION_RULE,
        '请从中挑出适合本地 review 的有趣切片：有趣、弹幕量大、弹幕很在意、体现岁己想法与众不同、岁己做了傻事，或者弹幕指出她傻/特别/有趣/可爱。',
        '没有独立看点的片段降低优先级；内容类型不做默认排除。',
        ...buildSelectionPolicyPromptLines(config.selectionPolicy),
        `每段 35 秒到 3 分半，尽量切在句子边界。最多 ${Math.max(1, Number(config.maxClips) || 24)} 段。`,
        '输出纯 JSON，不要 Markdown：',
        'Boundary rules are critical:',
        '- startTime must include the setup/premise, not start from the punchline.',
        '- endTime must include the explanation, follow-up reactions, and the final closing sentence.',
        '- If the streamer continues explaining the same incident after a short pause, extend endTime until that explanation is complete.',
        '- Stop before a truly new topic or unrelated material; keep meaningful reactions and follow-up context.',
        '- Prefer a natural silence after a complete sentence; never end in the middle of a sentence or continuous story.',
        '',
        ...buildOwnStreamClipCopyPromptLines(generator),
        '{"clips":[{"candidateIndex":1,"startTime":"HH:MM:SS","endTime":"HH:MM:SS","title":"人工风格标题，18-42字","coverText":"第一行\\n第二行","description":"面向观众的一句话内容简介","reason":"内部选材理由"}]}',
        '',
        `直播标题: ${info.streamTitle || '未知'}`,
        `录制时间: ${info.recordedAt || '未知'}`,
        '',
        '=== 候选 ===',
        candidateLines
    ].join('\n');

    try {
        const result = provider === 'tuZi'
            ? await generator.generateTextWithTuZi(prompt, { wordLimit: 1200 })
            : provider === 'daiYu'
            ? await generator.generateTextWithDaiYu(prompt, { wordLimit: 1200 })
            : await generator.generateTextWithGemini(prompt, { wordLimit: 1200 });
        const text = String(result.text || '').trim();
        const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
        if (!match) {
            recordAiDiagnostic(diagnostics, 'candidate_refine', new Error('AI did not return clips JSON'));
            console.warn(`AI did not return clips JSON: ${text.slice(0, 180)}`);
            return [];
        }
        const parsedJson = JSON.parse(match[0]);
        return normalizeAiClips(parsedJson.clips, candidates, parsed.segments.at(-1)?.end || 0, config);
    } catch (error) {
        recordAiDiagnostic(diagnostics, 'candidate_refine', error);
        console.warn(`AI clip refinement failed, using local candidates: ${error.message}`);
        return [];
    }
}

function fallbackClipsFromCandidates(candidates, config) {
    return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(config.maxClips) || 24))
        .map(candidate => ({
            start: candidate.start,
            end: candidate.end,
            duration: candidate.duration,
            title: buildFallbackTitle(candidate),
            description: '',
            reason: candidate.reason,
            candidateIndex: candidate.index,
            score: candidate.score,
            base: candidate
        }))
        .sort((a, b) => a.start - b.start);
}

function buildDanmakuHeatClips(candidates = [], count = 0) {
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
            title: buildFallbackTitle(candidate),
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

function clipsConflict(first, second, toleranceSeconds = 12) {
    const tolerance = Math.max(0, Number(toleranceSeconds) || 0);
    return Number(first.start) <= Number(second.end) + tolerance
        && Number(second.start) <= Number(first.end) + tolerance;
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
    if (source === 'model_full_context') return '模型全量';
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

function buildReviewMarkdown(results, metadata) {
    const aiStatusLine = buildAiStatusLine(metadata.aiStatus);
    const uploadIds = Array.isArray(metadata.uploadRegistry?.clipIds)
        ? metadata.uploadRegistry.clipIds
        : [];
    const lines = [
        '# 小岁直播有趣切片 review',
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot}`,
        results.length ? `来源统计: ${formatSelectionSourceCounts(results)}` : null,
        uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
        aiStatusLine,
        '',
        '## 切片列表',
        ''
    ].filter(line => line !== null);
    results.forEach((result, index) => {
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const filePath = result.output.mediaPath;
        lines.push(`${index + 1}. ${result.copy.title} | ${start} | ${duration} | ${filePath}`);
        lines.push(`   来源: ${getSelectionSourceLabel(result)}`);
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
    const lines = [
        '# 小岁直播有趣切片计划',
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
        lines.push(`   来源: ${sourceLabel}`);
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
    const lines = [
        '## \u5c81\u5df1\u76f4\u64ad\u6709\u8da3\u5207\u7247\u5019\u9009',
        '',
        `直播: **${metadata.streamTitle || metadata.sourceFileName || '未知'}**`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `切片目录: ${toFwdSlash(metadata.outputRoot)}`,
        metadata.reviewPath ? `Review: ${toFwdSlash(metadata.reviewPath)}` : null,
        results.length ? `来源统计: ${formatSelectionSourceCounts(results)}` : null,
        uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
        aiStatusLine,
        '',
        '\u5207\u7247\u5217\u8868:'
    ].filter(line => line !== null);
    results.forEach((result, index) => {
        const title = result.copy.title;
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const uploadId = uploadIds[index] ? `ID ${uploadIds[index]} | ` : '';
        lines.push(`${index + 1}. ${uploadId}${title} | ${start} | ${duration}`);
    });
    let markdown = lines.join('\n');
    if (markdown.length <= 3900) {
        return markdown;
    }

    const compact = lines.slice(0, 7);
    for (const [index, result] of results.entries()) {
        const title = result.copy.title;
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const uploadId = uploadIds[index] ? `ID ${uploadIds[index]} | ` : '';
        const line = `${index + 1}. ${uploadId}${title} | ${start} | ${duration}`;
        if ((compact.join('\n').length + line.length + 24) > 3880) {
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

function registerReviewForUpload(reviewPath, results, metadata) {
    if (!reviewPath || !results.length) return null;
    const source = `${metadata.streamerName || '主播'} 直播《${metadata.streamTitle || metadata.sourceFileName || '未知直播'}》${metadata.recordedAt || ''}`.trim();
    const tags = Array.isArray(results[0]?.copy?.tags) && results[0].copy.tags.length
        ? results[0].copy.tags.join(',')
        : '小岁,虚拟主播,直播切片,岁AI切片,AI切片';
    const prefix = metadata.roomId === '25788785' ? '【小岁】' : `【${metadata.streamerName || '切片'}】`;
    const scriptPath = path.join(__dirname, 'clip_upload_registry.py');
    const args = [
        scriptPath,
        'import-review',
        '--review', reviewPath,
        '--source', source,
        '--tags', tags,
        '--prefix', prefix,
        '--tid', '21',
        '--label', `${metadata.streamerName || '主播'} ${metadata.recordedAt || ''}`.trim()
    ];
    const result = spawnSync('python', args, {
        cwd: path.dirname(path.dirname(__dirname)),
        encoding: 'utf8',
        windowsHide: true
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

async function sendWeChatMarkdown(webhookUrl, content) {
    if (!webhookUrl) return false;
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: toFwdSlash(content) }
        })
    });
    if (!response.ok) {
        throw new Error(`WeChat Work request failed: HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.errcode !== 0) {
        throw new Error(`WeChat Work returned error: ${result.errcode} ${result.errmsg || ''}`.trim());
    }
    return true;
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
            ...buildCutClipMediaConfig(config, options)
        });
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
                    })()
                }
            );
        } catch (error) {
            coverError = error.message;
            console.warn(`clip cover generation failed, metadata kept: ${error.message}`);
        } finally {
            topicClipper.cleanupTemporaryCoverSource(mediaResult);
        }
    }
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
        window,
        candidate: clip.base || null,
        copy,
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
    const participantMetadata = topicClipper.buildParticipantMetadata(topicClipper.loadAsrSpeakerSidecarForMediaPath(options.srtPath || options.mediaPath));
    const outputRoot = resolveClipOutputRoot(options.mediaPath, config);
    fs.mkdirSync(outputRoot, { recursive: true });
    const reviewMetadata = {
        streamerName: options.streamerName || '岁己SUI',
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
    if (options.planPath) {
        const plan = JSON.parse(fs.readFileSync(options.planPath, 'utf8'));
        clips = Array.isArray(plan.clips) ? plan.clips : [];
    } else {
        if (config.parallel?.enabled) {
            const heatCandidates = buildDanmakuHeatClips(candidates, candidates.length);
            const modelLimit = Math.max(0, Math.floor(Number(config.parallel.modelClips) || 0));
            const modelConfig = {
                ...config,
                maxClips: modelLimit
            };
            const modelClips = modelLimit > 0
                ? await planClipsWithAIFullContext(parsed, danmaku, info, totalDuration, modelConfig, rootConfig, aiDiagnostics, emotionAnalysis, existingFullLiveContext)
                : [];
            clips = combineParallelClipPlans(heatCandidates, modelClips, config.parallel);
            aiDiagnostics.selectedSource = 'parallel';
            if (modelLimit > 0 && modelClips.length === 0) {
                aiDiagnostics.usedFallback = true;
                aiDiagnostics.fallbackReason = classifyAiFallbackReason(aiDiagnostics.errors);
            }
        } else if (config.ai?.enabled && config.ai?.strategy === 'full_context') {
            clips = await planClipsWithAIFullContext(parsed, danmaku, info, totalDuration, config, rootConfig, aiDiagnostics, emotionAnalysis, existingFullLiveContext);
            if (clips.length > 0) {
                aiDiagnostics.selectedSource = 'full_context_ai';
            }
        } else if (config.ai?.enabled && config.ai?.strategy !== 'candidate_only') {
            clips = await planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig, aiDiagnostics, emotionAnalysis);
            if (clips.length > 0) {
                aiDiagnostics.selectedSource = 'chunked_ai';
            }
        }
        if (clips.length === 0 && !config.parallel?.enabled) {
            const clipsFromAi = await refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig, aiDiagnostics);
            if (clipsFromAi.length > 0) {
                clips = clipsFromAi;
                aiDiagnostics.selectedSource = 'candidate_ai';
            } else if (aiDiagnostics.localFallbackEnabled) {
                clips = fallbackClipsFromCandidates(candidates, config);
                aiDiagnostics.usedFallback = true;
                aiDiagnostics.fallbackReason = (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false)
                    ? 'AI \u5df2\u7981\u7528'
                    : classifyAiFallbackReason(aiDiagnostics.errors);
                aiDiagnostics.selectedSource = 'local_rules';
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
        errorCount: aiDiagnostics.errors.length
    };
    clips = filterClipsBySelection(clips, options.selectedIndices);
    clips = attachEmotionEvidenceToClips(clips, emotionAnalysis, config.emotionScoring || {});
    clips = alignClipsToSubtitleBoundaries(clips, parsed.segments, config, totalDuration);
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
    fs.writeFileSync(planPath, JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: {
            mediaPath: options.mediaPath,
            srtPath: options.srtPath,
            xmlPath: options.xmlPath || null
        },
        config: {
            maxClips: config.maxClips,
            chunkSeconds: config.chunkSeconds,
            aiConcurrency: config.aiConcurrency,
            clipConcurrency: config.clipConcurrency,
            aiStrategy: config.ai?.strategy || null,
            aiModel: config.ai?.model || null,
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

    const source = {
        mediaPath: options.mediaPath,
        kind: topicClipper.chooseClipSource(options.mediaPath, options.mediaPath)?.kind || 'video',
        reason: 'own_stream_media',
        uploadReady: true
    };
    const streamerName = topicClipper.resolveStreamerName(rootConfig, info.roomId, {
        streamerName: options.streamerName || '岁己SUI'
    });
    const clipConcurrency = Math.max(1, Math.floor(Number(config.clipConcurrency) || 1));
    if (clipConcurrency > 1) {
        console.log(`Clip media concurrency: ${clipConcurrency}`);
        const jobs = clips.map((clip, index) => () => generateOwnStreamClipJob({
            clip,
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
        }));
        const results = await runJobsWithConcurrency(jobs, clipConcurrency);
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
                ...buildCutClipMediaConfig(config, options)
            });
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
                        })()
                    }
                );
            } catch (error) {
                coverError = error.message;
                console.warn(`clip cover generation failed, metadata kept: ${error.message}`);
            } finally {
                topicClipper.cleanupTemporaryCoverSource(mediaResult);
            }
        }
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
            window,
            candidate: clip.base || null,
            copy,
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
    }

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
    buildChunkSources,
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
    alignClipToSubtitleBoundaries,
    alignClipsToSubtitleBoundaries,
    removeOverlappingClips,
    runJobsWithConcurrency,
    buildNotifyMarkdown,
    buildReviewMarkdown,
    buildPlanReviewMarkdown,
    buildClipDescription,
    buildEmotionComposition,
    buildClipTags,
    buildCoverTitle,
    selectCoverPreferredTime: topicClipper.selectCoverPreferredTime,
    toFwdSlash,
    filterClipsBySelection,
    generateOwnStreamClips
};
