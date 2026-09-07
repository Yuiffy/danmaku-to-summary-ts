const { normalizeCoverText, buildGroundingReviewLine } = require('./clipping/selection_result');
const { getVideoResolution } = require('./clipping/video_probe');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');
const { isTopicEditorialEnabled, buildTopicEditorialGroups, buildTopicClipWindow } = require('./clipping/topic_editorial');
const { planTopicEventGroup, generateTopicEventCopy } = require('./clipping/topic_editorial_runner');
const { runTopicShadowReview, topicReviewLines } = require('./clipping/topic_review_runner');
const { buildPreflightEvidence } = require('./clipping/preflight_evidence');
const { isPreflightEnabled, prepareTopicGroup, preflightSelections, sourceFileHash, persistPreflightPlan } = require('./clipping/preflight_runner');
const {
    findKeywordMatches,
    clamp,
    buildClipWindows,
    getOverlappingSegments,
    buildTopicBursts,
    normalizeAiClipSelection,
    dedupeClipsByStart,
    buildFallbackAiClipSelection,
    buildTopicBurstPrompt,
    formatClock,
    segmentKey
} = require('./clipping/topic_selection');
const {
    DEFAULT_CLIP_TOPICS_CONFIG,
    getClipTopicsConfig,
    getTopicClipAiModel
} = require('./clipping/topic_config');
const fs = require('fs');
const path = require('path');
const { postProcessAiClipMetadata } = require('./ai_clip_metadata');
const childProcess = require('child_process');
const { spawn } = childProcess;
const xml2js = require('xml2js');
const {
    sendWeChatMarkdown,
    splitWeChatMarkdown
} = require('./wechat_work_markdown');
const asrBackends = require('./asr/asr_backends');
const configLoader = require('./config-loader');
const { resolveClipOutputRoot } = require('./clipping/output_path');
const {
    applyFfmpegProcessPriority,
    getFfmpegResourceConfig,
    startResourcePeakMonitor,
    waitForAsrAvailability,
    waitForCpuAvailability,
    withFfmpegResourceLimits
} = require('./ffmpeg_resource');

function loadAsrSpeakerSidecarForMediaPath(mediaPath) {
    if (!mediaPath) return {};
    try {
        const parsed = path.parse(String(mediaPath));
        const baseName = parsed.name.replace(/\.speaker$/i, '');
        const candidates = [
            path.join(parsed.dir, `${baseName}.asr_speakers.json`),
            path.join(parsed.dir, `${parsed.name}.asr_speakers.json`)
        ];
        const sidecarPath = candidates.find((candidate) => fs.existsSync(candidate));
        if (!sidecarPath) {
            return {};
        }
        const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (error) {
        console.warn(`⚠️  读取 ASR speaker sidecar 失败: ${error.message}`);
        return {};
    }
}

function buildParticipantMetadata(sidecar = {}) {
    const participants = Array.isArray(sidecar?.participants) ? sidecar.participants : [];
    if (participants.length === 0) {
        return {
            hostStreamerId: sidecar?.hostStreamerId || null,
            plannedParticipantIds: Array.isArray(sidecar?.plannedParticipantIds) ? sidecar.plannedParticipantIds : [],
            rosterStreamerIds: Array.isArray(sidecar?.rosterStreamerIds) ? sidecar.rosterStreamerIds : [],
            participants: [],
            appearedDisplayNames: []
        };
    }
    return {
        hostStreamerId: sidecar.hostStreamerId || null,
        plannedParticipantIds: Array.isArray(sidecar.plannedParticipantIds) ? sidecar.plannedParticipantIds : [],
        rosterStreamerIds: Array.isArray(sidecar.rosterStreamerIds) ? sidecar.rosterStreamerIds : [],
        participants,
        appearedDisplayNames: participants
            .filter((item) => item && item.appeared)
            .map((item) => item.displayName || item.streamerId)
            .filter(Boolean)
    };
}

const AUDIO_EXTENSIONS = new Set(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.flv', '.mkv', '.ts', '.mov']);

/**
 * AI 验证:判断关键词匹配是否为真正的提到/谈论目标人物。
 * 过滤掉唱歌、哼旋律、ASR 误识别等造成的假命中。
 */
const { verifyClipWithAI } = require('./clipping/legacy_keyword_verifier');

function isVideoFile(filePath) {
    return VIDEO_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());
}

function isAudioFile(filePath) {
    return AUDIO_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());
}

function chooseClipSource(originalMediaPath, processedMediaPath) {
    if (originalMediaPath && fs.existsSync(originalMediaPath) && isVideoFile(originalMediaPath)) {
        return {
            mediaPath: originalMediaPath,
            kind: 'video',
            uploadReady: true,
            reason: 'original_video'
        };
    }
    if (processedMediaPath && fs.existsSync(processedMediaPath) && isVideoFile(processedMediaPath)) {
        return {
            mediaPath: processedMediaPath,
            kind: 'video',
            uploadReady: true,
            reason: 'processed_video'
        };
    }
    if (processedMediaPath && fs.existsSync(processedMediaPath) && isAudioFile(processedMediaPath)) {
        return {
            mediaPath: processedMediaPath,
            kind: 'audio',
            uploadReady: false,
            reason: 'processed_audio_only'
        };
    }
    if (originalMediaPath && fs.existsSync(originalMediaPath) && isAudioFile(originalMediaPath)) {
        return {
            mediaPath: originalMediaPath,
            kind: 'audio',
            uploadReady: false,
            reason: 'original_audio_only'
        };
    }
    return null;
}

/**
 * 把 burst 的全部字幕发给 AI,让 AI 自己决定切在哪。
 * AI 最多切成 1-3 段,并根据上下文生成每段的标题和简介。
 */
async function segmentBurstWithAI(burst, parsed, streamerName, info, config = {}) {
    const aiConfig = config;
    const textEnabled = aiConfig.ai?.text?.enabled !== false;
    const segmentEnabled = aiConfig.clipTopics?.aiSegmentBurst !== false;
    const requestedModel = getTopicClipAiModel(aiConfig);

    if (!textEnabled || !segmentEnabled) {
        // Fallback: 使用命中段并按字幕边界补全,避免关闭 AI 时也产生半句话短片。
        return buildFallbackAiClipSelection(burst);
    }

    const generateText = require('./ai_text_generator');
    const prompt = buildTopicBurstPrompt(burst, streamerName, info, generateText);

    // 调用 AI
    const provider = aiConfig.ai?.text?.provider || 'gemini';
    let result;
    try {
        result = provider === 'tuZi'
            ? await generateText.generateTextWithTuZi(prompt, {
                wordLimit: 600,
                primaryModel: requestedModel
            })
            : provider === 'daiYu'
            ? await generateText.generateTextWithDaiYu(prompt, {
                wordLimit: 600,
                primaryModel: requestedModel
            })
            : await generateText.generateTextWithGemini(prompt, { wordLimit: 600 });
    } catch (error) {
        console.warn(`⚠️  AI burst 分段失败,退回整个 burst: ${error.message}`);
        return buildFallbackAiClipSelection(burst);
    }

    // 解析 AI 返回的 JSON
    try {
        const text = (result.text || '').trim();
        // 尝试提取 JSON(AI 有时用代码块包裹)
        const jsonMatch = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('⚠️  AI 未返回有效 JSON,退回整个 burst');
            console.warn(`   原始返回: ${text.slice(0, 200)}`);
            return buildFallbackAiClipSelection(burst);
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const clips = (parsed.clips || []).filter(c => c.startTime && c.endTime);

        if (clips.length === 0) {
            console.log(`  i️   [${formatClock(burst.matchStart)}] AI 判定无需切片(可能是唱歌/误识别)`);
            return [];
        }

        // 转换时间戳 → 秒数,返回带标题/简介的信息。
        // AI 拿到的是较大的上下文窗口,必须防止它切到不包含关键词命中的旁支内容。
        const actualModel = result.meta?.model || requestedModel;
        return clips
            .map((clip, ci) => normalizeAiClipSelection(
                { ...clip, aiModel: actualModel },
                burst,
                ci + 1
            ))
            .filter(Boolean);
    } catch (parseError) {
        console.warn(`⚠️  解析 AI 分段结果失败: ${parseError.message}`);
        console.warn(`   原始返回: ${result.text?.slice(0, 200)}`);
        return buildFallbackAiClipSelection(burst);
    }
}

function formatSrtTimestamp(seconds) {
    return asrBackends.formatTimestamp(seconds);
}

function wrapSubtitleText(text, maxCharsPerLine = 20) {
    const limit = Math.max(1, Number(maxCharsPerLine) || 20);
    return String(text || '').split(/\r?\n/).flatMap(line => {
        const trimmed = line.trim();
        const characters = Array.from(trimmed);
        if (!trimmed || characters.length <= limit) return [trimmed];
        const lineCount = Math.ceil(characters.length / limit);
        const baseLineLength = Math.floor(characters.length / lineCount);
        const longerLineCount = characters.length % lineCount;
        const wrapped = [];
        let offset = 0;
        for (let index = 0; index < lineCount; index += 1) {
            const lineLength = baseLineLength + (index < longerLineCount ? 1 : 0);
            wrapped.push(characters.slice(offset, offset + lineLength).join(''));
            offset += lineLength;
        }
        return wrapped;
    }).join('\n');
}

function parseSpeakerReviewText(text) {
    const value = String(text || '').trim();
    const match = value.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (!match) {
        return { text: value };
    }

    const label = match[1].trim();
    const scoreMatch = label.match(/^(.*?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
    const speaker = (scoreMatch ? scoreMatch[1] : label).trim();
    const score = scoreMatch ? Number(scoreMatch[2]) : null;
    return {
        text: match[2].trim(),
        speaker: speaker || 'UNKNOWN',
        ...(Number.isFinite(score) ? { speaker_score: score } : {})
    };
}

function parseTopicSrt(srtPath) {
    const parsed = asrBackends.parseSrt(srtPath, 'topic_clip');
    const isSpeakerReviewSrt = /\.speaker\.srt$/i.test(String(srtPath || ''));
    if (isSpeakerReviewSrt) {
        parsed.segments = parsed.segments.map(segment => ({ ...segment, ...parseSpeakerReviewText(segment.text) }));
    }
    const evidenceSrtPath = isSpeakerReviewSrt ? srtPath.replace(/\.speaker\.srt$/i, '.srt') : srtPath;
    const provenance = require('./asr/evidence_sidecar').loadAsrEvidence(evidenceSrtPath, parsed.segments);
    return { ...parsed, segments: provenance.segments, asrEvidenceStatus: provenance.status };
}

function writeClipSrt(segments = [], window, outputPath, options = {}) {
    const lines = [];
    const clipSegments = getOverlappingSegments(segments, window);
    const writtenSegments = [];
    let lineIndex = 1;

    for (const segment of clipSegments) {
        const start = clamp(Number(segment.start) - window.start, 0, window.duration);
        const end = clamp(Number(segment.end) - window.start, 0, window.duration);
        const rawText = String(segment.text || '').trim();
        const text = options.stripPunctuation
            ? asrBackends.stripSubtitlePunctuation(rawText)
            : rawText;
        if (!text || end <= start) {
            continue;
        }
        const wrappedText = wrapSubtitleText(text, options.maxCharsPerLine);
        lines.push(String(lineIndex));
        lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
        lines.push(wrappedText);
        lines.push('');
        writtenSegments.push({
            ...segment,
            start,
            end,
            text: wrappedText
        });
        lineIndex += 1;
    }

    fs.writeFileSync(outputPath, `${lines.join('\n').trim()}\n`, 'utf8');
    return {
        path: outputPath,
        segmentCount: lineIndex - 1,
        segments: writtenSegments
    };
}

function srtTimestampToAss(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!match) return '0:00:00.00';
    const hours = String(Number(match[1]));
    const minutes = match[2];
    const seconds = match[3];
    const centiseconds = String(Math.floor(Number(match[4]) / 10)).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}.${centiseconds}`;
}

function assEscapeText(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\N')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\u007f/g, '');
}

const SPEAKER_OUTLINE_COLORS = [
    '#ff66cc',
    '#66ccff',
    '#66e6a3',
    '#ffcc66',
    '#b388ff',
    '#ff7777',
    '#66d9ff',
    '#d9d966'
];

function rgbHexToAssColor(value) {
    const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) return '&H00000000';
    const rgb = match[1].toUpperCase();
    return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

function buildSpeakerStyleName(speaker, index) {
    const safe = String(speaker || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^\d+/, '');
    return `Speaker_${safe || index + 1}`;
}

function buildSpeakerStyles(speakerSegments = []) {
    const speakers = Array.from(new Set(
        speakerSegments
            .map(segment => String(segment?.speaker || '').trim())
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    const styles = new Map();
    const usedNames = new Set(['Default']);
    speakers.forEach((speaker, index) => {
        let name = buildSpeakerStyleName(speaker, index);
        if (usedNames.has(name)) {
            name = `${name}_${index + 1}`;
        }
        usedNames.add(name);
        styles.set(speaker, {
            name,
            outlineColour: rgbHexToAssColor(SPEAKER_OUTLINE_COLORS[index % SPEAKER_OUTLINE_COLORS.length])
        });
    });
    return styles;
}

function buildBurnAssContentFromSrt(srtContent, style = {}) {
    const playResX = Number(style.playResX) || 1280;
    const playResY = Number(style.playResY) || 720;
    const fontName = String(style.fontName || '汉仪有圆 85简');
    const fontSize = Number(style.fontSize) || 31;
    const outline = Number(style.outline) || 2;
    const marginV = Number(style.marginV) || 24;
    const alignment = Number(style.alignment) || 2;
    const bold = Number(style.bold) || 1;
    const shadow = Number(style.shadow) || 0;
    const wrapStyle = Number(style.wrapStyle) || 2;
    const marginL = Math.max(0, Number(style.marginL) || 32);
    const marginR = Math.max(0, Number(style.marginR) || 32);
    const maxCharsPerLine = Number(style.maxCharsPerLine);
    const speakerSegments = Array.isArray(style.speakerSegments) ? style.speakerSegments : [];
    const speakerStyles = buildSpeakerStyles(speakerSegments);
    const blocks = String(srtContent || '').trim().split(/\r?\n\r?\n+/).filter(Boolean);
    const events = [];

    blocks.forEach((block, blockIndex) => {
        const lines = block.split(/\r?\n/);
        if (lines.length < 3) return;
        const timeLine = lines[1].trim();
        const match = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/);
        if (!match) return;
        const shouldRewrap = Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0;
        const rawText = lines.slice(2).join(shouldRewrap ? '' : '\n').trim();
        const text = shouldRewrap
            ? wrapSubtitleText(rawText, maxCharsPerLine)
            : rawText;
        if (!text) return;
        const speaker = String(speakerSegments[blockIndex]?.speaker || '').trim();
        const speakerStyle = speakerStyles.get(speaker);
        events.push(`Dialogue: 0,${srtTimestampToAss(match[1])},${srtTimestampToAss(match[2])},${speakerStyle?.name || 'Default'},,0,0,0,,${assEscapeText(text)}`);
    });

    const defaultStyle = `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`;
    const speakerStyleLines = Array.from(speakerStyles.values()).map(speakerStyle =>
        `Style: ${speakerStyle.name},${fontName},${fontSize},&H00FFFFFF,&H000000FF,${speakerStyle.outlineColour},&H00000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`
    );

    return [
        '[Script Info]',
        'ScriptType: v4.00+',
        'ScaledBorderAndShadow: yes',
        `PlayResX: ${playResX}`,
        `PlayResY: ${playResY}`,
        `WrapStyle: ${wrapStyle}`,
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        defaultStyle,
        ...speakerStyleLines,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...events,
        ''
    ].join('\n');
}

function writeTemporaryBurnAssFromSrt(srtPath, assPath, style = {}) {
    const srtContent = fs.readFileSync(srtPath, 'utf8');
    const assContent = buildBurnAssContentFromSrt(srtContent, style);
    fs.writeFileSync(assPath, assContent, 'utf8');
    return assPath;
}

function parseRecordingInfo(mediaPath, context = {}) {
    const fileName = path.basename(mediaPath || '');
    const nameNoExt = fileName.replace(/\.[^.]+$/, '');
    const match = nameNoExt.match(/^录制-(\d+)-(\d{8})-(\d{6})-(\d+)-(.+)$/);
    const roomId = context.roomId || context.room_id || (match ? match[1] : null);
    const date = match ? match[2] : null;
    const time = match ? match[3] : null;
    const streamTitle = match ? match[5] : nameNoExt;
    const recordedAt = date && time
        ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
        : null;

    return {
        roomId: roomId ? String(roomId) : null,
        recordedAt,
        streamTitle,
        fileName
    };
}

function resolveStreamerName(config = {}, roomId = null, context = {}) {
    if (context.streamerName) {
        return context.streamerName;
    }
    const roomKey = roomId ? String(roomId) : null;
    const roomSettings = roomKey
        ? (config.ai?.roomSettings?.[roomKey] || config.roomSettings?.[roomKey] || null)
        : null;
    if (roomSettings?.anchorName) {
        return roomSettings.anchorName;
    }
    for (const entry of Object.values(config.ai?.streamerRegistry || {})) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(value => String(value)) : [];
        if (roomKey && roomIds.includes(roomKey) && entry.displayName) {
            return entry.displayName;
        }
    }
    for (const entry of Object.values(config.bilibili?.anchors || {})) {
        if (roomKey && String(entry.roomId || entry.uid || '') === roomKey && entry.name) {
            return entry.name;
        }
    }
    return '主播';
}

/**
 * 根据 roomId 从 streamerRegistry 解析主播的正式标签(用于 B站投稿 tag)
 * 返回 searchTags(如有)或 displayName + speakerLabels。
 */
function resolveStreamerTags(config = {}, roomId = null) {
    const roomKey = roomId ? String(roomId) : null;
    if (!roomKey) return [];

    for (const entry of Object.values(config.ai?.streamerRegistry || {})) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(value => String(value)) : [];
        if (!roomIds.includes(roomKey)) continue;

        // 投稿标签使用主播在 B 站的投稿名/标签,不要把 ASR 说话人别名
        // (例如"瑞娅""Rhea")直接带入真人切片投稿。
        if (Array.isArray(entry.uploadTags) && entry.uploadTags.length > 0) {
            return entry.uploadTags.map(t => String(t).trim()).filter(Boolean);
        }

        // 优先使用显式配置的 searchTags
        if (Array.isArray(entry.searchTags) && entry.searchTags.length > 0) {
            return entry.searchTags.map(t => String(t).trim()).filter(Boolean);
        }

        // 退退:displayName + speakerLabels
        const tags = new Set();
        if (entry.displayName) tags.add(entry.displayName);
        (entry.speakerLabels || []).forEach(label => {
            const s = String(label).trim();
            if (s && s.length >= 2) tags.add(s);
        });
        return Array.from(tags);
    }
    return [];
}

function isIgnoredRoom(roomId, config = {}) {
    const roomKey = roomId ? String(roomId) : null;
    if (!roomKey) {
        return false;
    }
    const ignoredRoomIds = Array.isArray(config.ignoredRoomIds)
        ? config.ignoredRoomIds.map(value => String(value)).filter(Boolean)
        : [];
    return ignoredRoomIds.includes(roomKey);
}

function sanitizeFileName(value, fallback = 'clip') {
    const safe = String(value || fallback)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
    return safe || fallback;
}

function buildDefaultTitle(window, info) {
    const datePart = info.recordedAt
        ? `${info.recordedAt.slice(5, 7)}-${info.recordedAt.slice(8, 10)} ${info.recordedAt.slice(11, 16)}`
        : formatClock(window.start);
    return `提到岁己的小片段 ${datePart}`;
}

function normalizeTitle(value, fallback) {
    const title = String(value || '').trim()
        .replace(/^["""'']+|["""'']+$/g, '')
        .replace(/\s+/g, ' ');
    if (!title || title.length > 60) {
        return fallback;
    }
    return title;
}


async function buildClipCopy(window, info, streamerName, config, titleGenerator = null, descriptionGenerator = null, extraTagList = null, coverText = null) {
    const defaultTitle = buildDefaultTitle(window, info);
    let title = defaultTitle;
    let description = `来自 ${streamerName} 的直播间,录制时间 ${info.recordedAt || '未知'},片段时间 ${formatClock(window.start)}-${formatClock(window.end)}。`;

    // 构建丰富的上下文供 AI 理解
    const sampleText = window.matchSegments
        .map(segment => segment.text)
        .join('\n');
    const fullClipText = (window.allSegmentTexts || []).join('\n');
    const preContext = (window.preContext || []).join('\n');
    const postContext = (window.postContext || []).join('\n');

    if (titleGenerator) {
        try {
            title = normalizeTitle(await titleGenerator({
                streamerName,
                streamTitle: info.streamTitle,
                recordedAt: info.recordedAt,
                startTime: formatClock(window.start),
                endTime: formatClock(window.end),
                matchedKeywords: window.matchedKeywords,
                sampleText,
                fullClipText,
                preContext,
                postContext,
                defaultTitle
            }), defaultTitle);
        } catch (error) {
            console.warn(`⚠️  话题切片标题生成失败,使用模板标题: ${error.message}`);
        }
    }

    // AI 生成简介
    if (descriptionGenerator) {
        try {
            const aiDesc = await descriptionGenerator({
                streamerName,
                streamTitle: info.streamTitle,
                recordedAt: info.recordedAt,
                startTime: formatClock(window.start),
                endTime: formatClock(window.end),
                matchedKeywords: window.matchedKeywords,
                sampleText,
                fullClipText,
                preContext,
                postContext
            });
            if (aiDesc && aiDesc.trim().length > 5) {
                description = aiDesc.trim();
            }
        } catch (error) {
            console.warn(`⚠️  话题切片简介生成失败,使用模板简介: ${error.message}`);
        }
    }

    const configuredTags = Array.isArray(config.tags) ? config.tags : null;
    const tags = Array.from(new Set([
        'AI切片',
        ...(configuredTags || [streamerName, '岁己', '小岁', '虚拟主播', '直播切片']),
        ...(Array.isArray(config.extraTags) ? config.extraTags : []),
        ...(Array.isArray(extraTagList) ? extraTagList : [])
    ].map(tag => String(tag || '').trim()).filter(Boolean))).slice(0, 12);

    const processed = postProcessAiClipMetadata({ title, tags }, config);
    return {
        title: processed.title,
        coverText: normalizeCoverText(coverText),
        description,
        tags: processed.tags
    };
}

async function runFfmpeg(args, options = {}) {
    const resourceConfig = {
        ...(options.resourceConfig || getFfmpegResourceConfig(configLoader.getConfig())),
        ...(Number.isFinite(Number(options.threads)) ? { threads: Number(options.threads) } : {})
    };
    const stage = options.stage || '话题切片 ffmpeg';
    const asrState = await waitForAsrAvailability(stage, resourceConfig);
    const effectiveResourceConfig = { ...resourceConfig };
    if (asrState.asrActive && Number(effectiveResourceConfig.threads) > 0) {
        const overlapThreads = Math.max(1, Number(effectiveResourceConfig.asrGuard?.overlapThreads) || 1);
        effectiveResourceConfig.threads = Math.min(
            Number(effectiveResourceConfig.threads),
            overlapThreads
        );
        console.log(`[resource] ${stage} 与 ASR 重叠，FFmpeg threads=${effectiveResourceConfig.threads}`);
    }
    await waitForCpuAvailability(stage, effectiveResourceConfig);
    return new Promise((resolve, reject) => {
        const ffmpegPath = options.ffmpegPath || 'ffmpeg';
        const commandArgs = withFfmpegResourceLimits(args, effectiveResourceConfig);
        const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_CLIP_TOPICS_CONFIG.ffmpegTimeoutMs);
        const child = spawn(ffmpegPath, commandArgs, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
            shell: false
        });
        applyFfmpegProcessPriority(child.pid, effectiveResourceConfig.priority);
        let resourcePeak = null;
        const peakMonitor = startResourcePeakMonitor(stage, {
            resourceConfig: effectiveResourceConfig,
            gpuTelemetry: options.gpuTelemetry === true,
            nvidiaSmiPath: options.nvidiaSmiPath,
            onStop: peak => {
                resourcePeak = peak;
                if (typeof options.onResourcePeak === 'function') {
                    options.onResourcePeak(peak);
                }
            }
        });
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            peakMonitor.stop();
            callback();
        };
        const timeoutId = setTimeout(() => {
            timedOut = true;
            try {
                const killed = child.kill('SIGKILL');
                if (!killed) {
                    finish(() => reject(new Error(`ffmpeg timed out after ${timeoutMs}ms and could not be terminated`)));
                }
            } catch {
                finish(() => reject(new Error(`ffmpeg timed out after ${timeoutMs}ms and could not be terminated`)));
            }
        }, timeoutMs);
        child.stderr.on('data', chunk => {
            stderr = `${stderr}${chunk.toString()}`.slice(-32768);
        });
        child.on('error', error => finish(() => reject(error)));
        child.on('close', code => {
            finish(() => {
                if (timedOut) {
                    reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
                    return;
                }
                if (code === 0) {
                    resolve({ stderr, resourcePeak });
                    return;
                }
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
            });
        });
    });
}

function probeVideoPacketsWithHashes(ffmpegPath, mediaPath, readInterval) {
    return new Promise((resolve, reject) => {
        const ffprobePath = resolveFfprobePath(ffmpegPath);
        const child = spawn(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_packets',
            '-show_entries', 'packet=pts_time,dts_time,flags,data_hash',
            '-show_data_hash', 'md5',
            '-of', 'json',
            '-read_intervals', readInterval,
            mediaPath
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffprobe packet hash probe exited with code ${code}: ${stderr.slice(-300)}`));
                return;
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                resolve(Array.isArray(parsed.packets) ? parsed.packets : []);
            } catch (error) {
                reject(new Error(`ffprobe packet hash output is invalid JSON: ${error.message}`));
            }
        });
    });
}

function resolveFfprobePath(ffmpegPath = 'ffmpeg') {
    const normalized = String(ffmpegPath || 'ffmpeg').trim() || 'ffmpeg';
    return normalized.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function findMatchingPacketTime(roughPacket, sourcePackets, targetTime) {
    const hash = String(roughPacket?.data_hash || '').trim();
    if (!hash) return null;
    const matches = (sourcePackets || [])
        .filter(packet => String(packet?.data_hash || '').trim() === hash)
        .map(packet => Number(packet?.pts_time ?? packet?.dts_time))
        .filter(time => Number.isFinite(time) && time >= 0 && time <= Number(targetTime) + 0.5)
        .sort((a, b) => b - a);
    return matches.length > 0 ? matches[0] : null;
}

/**
 * Locate the stream-copy rough cut's real source origin by matching its first
 * compressed keyframe packet against a small source window. Packet hashing
 * avoids decoding and follows ffmpeg's actual demux seek, which can differ by
 * a full GOP from ffprobe's predicted keyframe on indexed FLV files.
 */
async function probeRoughCutSourceStart(ffmpegPath, sourcePath, roughPath, targetTime) {
    const roughPackets = await probeVideoPacketsWithHashes(ffmpegPath, roughPath, '%+#1');
    const roughPacket = roughPackets[0];
    if (!roughPacket?.data_hash) {
        throw new Error('rough cut has no hashable first video packet');
    }
    if (!String(roughPacket.flags || '').includes('K')) {
        throw new Error('rough cut first video packet is not a keyframe');
    }

    const lookbacks = [30, 120];
    for (const lookback of lookbacks) {
        const searchStart = Math.max(0, Number(targetTime) - lookback);
        const searchDuration = Math.max(2, Number(targetTime) - searchStart + 2);
        const sourcePackets = await probeVideoPacketsWithHashes(
            ffmpegPath,
            sourcePath,
            `${searchStart}%+${searchDuration}`
        );
        const matchedTime = findMatchingPacketTime(roughPacket, sourcePackets, targetTime);
        if (matchedTime !== null) return matchedTime;
    }
    throw new Error(`could not match rough cut first packet near source time ${targetTime}`);
}

function escapeSubtitlePathForFfmpegFilter(srtPath) {
    return String(srtPath)
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");
}

/**
 * Pick the semantic high point used to bias visual frame selection.
 */
function selectCoverPreferredTime(danmaku = [], window = {}, reactionKeywords = [], radiusSeconds = 6) {
    const start = Number(window.start);
    const end = Number(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const items = (Array.isArray(danmaku) ? danmaku : [])
        .filter(item => Number.isFinite(Number(item.time)) && Number(item.time) >= start && Number(item.time) <= end)
        .map(item => ({
            time: Number(item.time),
            reaction: reactionKeywords.some(keyword => String(item.text || '').includes(keyword)) ? 1 : 0
        }))
        .sort((a, b) => a.time - b.time);
    if (items.length === 0) {
        const match = (window.matchSegments || [])
            .find(segment => Number(segment.start) >= start && Number(segment.start) <= end);
        return match ? (Number(match.start) + Number(match.end || match.start)) / 2 : null;
    }

    const radius = Math.max(2, Number(radiusSeconds) || 6);
    const reactionPrefix = [0];
    items.forEach(item => reactionPrefix.push(reactionPrefix.at(-1) + item.reaction));
    let left = 0;
    let right = 0;
    let best = items[0];
    let bestScore = -Infinity;
    const ideal = start + (end - start) * 0.55;
    for (let index = 0; index < items.length; index += 1) {
        const time = items[index].time;
        while (left < items.length && items[left].time < time - radius) left += 1;
        while (right < items.length && items[right].time <= time + radius) right += 1;
        const count = right - left;
        const reactions = reactionPrefix[right] - reactionPrefix[left];
        const score = count + reactions * 3 - Math.abs(time - ideal) * 0.002;
        if (score > bestScore) {
            bestScore = score;
            best = items[index];
        }
    }
    return best.time;
}

/**
 * 为切片生成封面图:优先从无字幕原始录播的切片区间多帧选优。
 */
async function generateClipCover(videoPath, title, outputDir, info = {}) {
    const { spawn } = require('child_process');
    const coverBase = path.basename(videoPath, path.extname(videoPath));
    const coverPath = path.join(outputDir, `${coverBase}_cover.jpg`);

    // 用 Python 调用 cover_generator.py 生成封面
    const scriptPath = path.join(__dirname, 'cover_generator.py');
    const subtitle = info.streamerName || '';
    const coverSourcePath = info.coverSourcePath && fs.existsSync(info.coverSourcePath)
        ? info.coverSourcePath
        : videoPath;
    const resourceConfig = info.resourceConfig || getFfmpegResourceConfig(configLoader.getConfig());
    const timeoutMs = Math.max(1, Number(info.timeoutMs) || DEFAULT_CLIP_TOPICS_CONFIG.ffmpegTimeoutMs);
    const coverStage = '话题切片封面生成';
    const asrState = await waitForAsrAvailability(coverStage, resourceConfig);
    if (asrState.asrActive) {
        console.log(`[resource] ${coverStage} 与 ASR 重叠，继续使用低优先级封面任务`);
    }
    await waitForCpuAvailability(coverStage, resourceConfig);

    return new Promise((resolve, reject) => {
        const args = ['python', scriptPath, coverSourcePath,
            '--title', title,
            '--output', coverPath,
            '--position', 'center',
            '--key-frame',
        ];
        if (Number.isFinite(Number(info.clipStart))) {
            args.push('--clip-start', String(Number(info.clipStart)));
        }
        if (Number.isFinite(Number(info.clipDuration)) && Number(info.clipDuration) > 0) {
            args.push('--clip-duration', String(Number(info.clipDuration)));
        }
        if (Number.isFinite(Number(info.preferredTime))) {
            args.push('--preferred-time', String(Number(info.preferredTime)));
        }
        if (Number.isFinite(Number(info.sampleCount))) {
            args.push('--sample-count', String(Number(info.sampleCount)));
        }
        if (subtitle) {
            args.push('--subtitle', subtitle);
        }

        // args[0] is 'python', rest are script + args
        const child = spawn(args[0], args.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
        });
        applyFfmpegProcessPriority(child.pid, resourceConfig.priority);
        const peakMonitor = startResourcePeakMonitor(coverStage, {
            resourceConfig,
            gpuTelemetry: Array.isArray(info.resourcePeaks),
            onStop: peak => {
                if (Array.isArray(info.resourcePeaks)) info.resourcePeaks.push(peak);
            }
        });

        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            peakMonitor.stop();
            callback();
        };
        const timeoutId = setTimeout(() => {
            timedOut = true;
            try {
                const killed = child.kill('SIGKILL');
                if (!killed) {
                    finish(() => reject(new Error(`cover_generator timed out after ${timeoutMs}ms and could not be terminated`)));
                }
            } catch {
                finish(() => reject(new Error(`cover_generator timed out after ${timeoutMs}ms and could not be terminated`)));
            }
        }, timeoutMs);
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => {
            stderr = `${stderr}${d.toString()}`.slice(-32768);
            process.stderr.write(d);
        });

        child.on('close', (code) => {
            finish(() => {
                if (timedOut) {
                    reject(new Error(`cover_generator timed out after ${timeoutMs}ms`));
                    return;
                }
                if (code === 0 && fs.existsSync(coverPath)) {
                    console.log(`🖼️  封面已生成: ${coverPath}`);
                    resolve(coverPath);
                } else {
                    reject(new Error(`cover_generator 退出码 ${code}: ${stderr.slice(-300)}`));
                }
            });
        });
        child.on('error', error => finish(() => reject(error)));
    });
}

function buildSubtitleBurnVideoArgs(config = {}, options = {}) {
    const forceCpu = options.forceCpu === true;
    const encoder = forceCpu
        ? 'libx264'
        : String(process.env.FFMPEG_SUBTITLE_VIDEO_ENCODER || config.subtitleVideoEncoder || 'libx264').trim();
    const cq = String(config.subtitleVideoCq ?? process.env.FFMPEG_SUBTITLE_VIDEO_CQ ?? 23);
    const crf = String(config.subtitleVideoCrf ?? process.env.FFMPEG_SUBTITLE_VIDEO_CRF ?? 23);

    if (!forceCpu && (encoder === 'h264_nvenc' || encoder === 'hevc_nvenc')) {
        const rawPreset = String(process.env.FFMPEG_SUBTITLE_VIDEO_PRESET || config.subtitleVideoPreset || 'p4').trim();
        const preset = rawPreset === 'ultrafast' ? 'p4' : rawPreset;
        return ['-c:v', encoder, '-preset', preset || 'p4', '-cq', cq];
    }

    const preset = forceCpu
        ? String(process.env.FFMPEG_SUBTITLE_CPU_FALLBACK_PRESET || config.subtitleCpuFallbackPreset || 'ultrafast').trim()
        : String(process.env.FFMPEG_SUBTITLE_VIDEO_PRESET || config.subtitleVideoPreset || 'ultrafast').trim();
    return ['-c:v', encoder || 'libx264', '-preset', preset || 'ultrafast', '-crf', crf];
}

function buildSubtitleBurnInputArgs(config = {}, options = {}) {
    if (options.forceCpu === true) return [];
    const hwaccel = String(
        config.subtitleHwaccel
        ?? process.env.FFMPEG_SUBTITLE_HWACCEL
        ?? ''
    ).trim().toLowerCase();
    if (!hwaccel || ['none', 'off', 'false'].includes(hwaccel)) return [];
    // Keep frames in system memory after decode: libass/subtitles is a CPU
    // filter and cannot consume cuda frames directly.
    return ['-hwaccel', hwaccel];
}

function isNvencSubtitleEncoder(config = {}) {
    const encoder = String(
        process.env.FFMPEG_SUBTITLE_VIDEO_ENCODER
        || config.subtitleVideoEncoder
        || 'libx264'
    ).trim().toLowerCase();
    return encoder === 'h264_nvenc' || encoder === 'hevc_nvenc';
}

/**
 * 根据视频分辨率动态计算字幕样式
 * @param {number} width - 视频宽度
 * @param {number} height - 视频高度
 * @returns {{ forceStyle: string, maxCharsPerLine: number }}
 */
function calculateSubtitleStyle(width, height, config = {}) {
    // ASS 会把 PlayRes 坐标系自动缩放到输出画面。字号必须只按 PlayRes 计算，
    // 如果再按源视频高度缩放，720p 和 1080p 就会得到不同的画面占比。
    const videoWidth = Number(width);
    const videoHeight = Number(height);
    const isPortrait = Number.isFinite(videoWidth) && videoWidth > 0
        && Number.isFinite(videoHeight) && videoHeight > videoWidth;
    const landscapeFontSizeRatio = Number(config.subtitleFontSizeRatio ?? process.env.FFMPEG_SUBTITLE_FONT_SIZE_RATIO ?? 0.094);
    // 竖屏的可用横向空间明显更窄，单独控制字号，避免为了竖屏缩小所有横屏字幕。
    const portraitFontSizeRatio = Number(config.subtitlePortraitFontSizeRatio ?? process.env.FFMPEG_SUBTITLE_PORTRAIT_FONT_SIZE_RATIO ?? 0.044);
    const fontSizeRatio = isPortrait ? portraitFontSizeRatio : landscapeFontSizeRatio;
    const minFontSize = Number(config.subtitleMinFontSize ?? process.env.FFMPEG_SUBTITLE_MIN_FONT_SIZE ?? 30);
    const maxFontSize = Number(config.subtitleMaxFontSize ?? process.env.FFMPEG_SUBTITLE_MAX_FONT_SIZE ?? 72);
    const fontName = String(config.subtitleFontName ?? process.env.FFMPEG_SUBTITLE_FONT_NAME ?? '汉仪有圆 85简').trim() || '汉仪有圆 85简';
    const playResY = Number(config.subtitlePlayResY ?? process.env.FFMPEG_SUBTITLE_PLAYRES_Y ?? 720);
    const configuredPlayResX = Number(config.subtitlePlayResX ?? process.env.FFMPEG_SUBTITLE_PLAYRES_X);
    const playResX = Number.isFinite(configuredPlayResX) && configuredPlayResX > 0
        ? Math.round(configuredPlayResX)
        : (
            Number.isFinite(videoWidth) && videoWidth > 0 && Number.isFinite(videoHeight) && videoHeight > 0
                ? Math.max(1, Math.round(playResY * videoWidth / videoHeight))
                : 1280
        );
    const fontSize = Math.min(maxFontSize, Math.max(minFontSize, Math.round(playResY * fontSizeRatio)));
    const outline = Math.max(2, Math.round(fontSize * 0.09));
    const marginV = Number(config.subtitleMarginV ?? process.env.FFMPEG_SUBTITLE_MARGIN_V ?? 24);
    const marginL = Math.max(0, Number(config.subtitleMarginL ?? config.subtitleMarginHorizontal ?? process.env.FFMPEG_SUBTITLE_MARGIN_L ?? 32));
    const marginR = Math.max(0, Number(config.subtitleMarginR ?? config.subtitleMarginHorizontal ?? process.env.FFMPEG_SUBTITLE_MARGIN_R ?? 32));
    // 汉字实际字面通常略窄于 1em；横屏沿用 0.95em，竖屏则保持保守的 1em 安全估算。
    const glyphWidthRatio = Math.max(0.5, Number(
        config.subtitleGlyphWidthRatio
        ?? process.env.FFMPEG_SUBTITLE_GLYPH_WIDTH_RATIO
        ?? (isPortrait ? 1 : 0.95)
    ));
    const availableWidth = Math.max(fontSize, playResX - marginL - marginR - outline * 2);
    const calculatedMaxChars = Math.max(1, Math.floor(availableWidth / (fontSize * glyphWidthRatio)));
    const configuredMaxChars = Number(config.subtitleMaxCharsPerLine);
    const maxCharsPerLine = Number.isFinite(configuredMaxChars) && configuredMaxChars > 0
        ? Math.min(calculatedMaxChars, Math.floor(configuredMaxChars))
        : calculatedMaxChars;
    const forceStyle = `FontSize=${fontSize},FontName=${fontName},Bold=1,Outline=${outline}`;
    return {
        forceStyle,
        maxCharsPerLine,
        fontSize,
        outline,
        fontName,
        playResX,
        playResY,
        marginL,
        marginR,
        marginV
    };
}

function resolveSubtitleBurnPlan(config = {}) {
    const requestedMode = String(
        config.twoStageMode || process.env.FFMPEG_TWO_STAGE_MODE || 'copy'
    ).toLowerCase();
    const twoStageEnabled = config.twoStageSubtitleBurn !== false
        && process.env.FFMPEG_TWO_STAGE_BURN !== 'false';
    if (!twoStageEnabled || requestedMode === 'direct') {
        return {
            useTwoStageBurn: false,
            mode: 'direct',
            requestedMode
        };
    }
    return {
        useTwoStageBurn: true,
        mode: requestedMode === 'transcode' ? 'transcode' : 'copy',
        requestedMode
    };
}




async function cutClipMedia(source, window, srtPath, outputPath, config = {}) {
    const ffmpegPath = config.ffmpegPath || 'ffmpeg';
    const resourcePeaks = Array.isArray(config.resourcePeaks) ? config.resourcePeaks : [];
    const ffmpegOptions = {
        ffmpegPath,
        threads: config.ffmpegThreads ?? config.clipFfmpegThreads,
        resourceConfig: config.resourceConfig,
        timeoutMs: config.ffmpegTimeoutMs,
        gpuTelemetry: Array.isArray(config.resourcePeaks),
        onResourcePeak: peak => resourcePeaks.push(peak)
    };
    const duration = String(Math.max(0.1, window.duration));
    const start = String(Math.max(0, window.start));
    let coverSourcePath = null;
    let coverClipStart = null;
    let coverTimeOrigin = null;
    let burnAssPath = null;
    let subtitleBurnFailure = null;
    let roughSourceStart = null;
    let roughTrimOffset = null;

    if (source.kind === 'audio') {
        await runFfmpeg([
            '-y',
            '-ss', start,
            '-i', source.mediaPath,
            '-t', duration,
            '-vn',
            '-c:a', 'copy',
            outputPath
        ], ffmpegOptions);
        return {
            path: outputPath,
            burnedSubtitles: false,
            fallbackUsed: false,
            resourcePeaks
        };
    }

    if (config.burnSubtitles !== false) {
        // 获取视频分辨率,动态计算字幕样式
        const videoRes = await getVideoResolution(source.mediaPath, resolveFfprobePath(ffmpegPath));
        const subtitleStyle = calculateSubtitleStyle(videoRes.width, videoRes.height, config);
        const parsedOutput = path.parse(outputPath);
        burnAssPath = path.join(parsedOutput.dir, `${parsedOutput.name}.burn.ass`);
        writeTemporaryBurnAssFromSrt(srtPath, burnAssPath, {
            ...subtitleStyle,
            speakerSegments: config.subtitleSegments
        });
        const subtitleBurnPlan = resolveSubtitleBurnPlan(config);
        const useTwoStageBurn = subtitleBurnPlan.useTwoStageBurn;
        try {
            if (useTwoStageBurn) {
                const twoStageMode = subtitleBurnPlan.mode;
                const preRollSeconds = Math.max(0, Number(config.twoStagePreRollSeconds ?? process.env.FFMPEG_TWO_STAGE_PREROLL ?? 8));
                const postRollSeconds = Math.max(0, Number(config.twoStagePostRollSeconds ?? process.env.FFMPEG_TWO_STAGE_POSTROLL ?? 2));
                const roughStart = Math.max(0, Number(window.start) - preRollSeconds);
                let actualRoughStart = roughStart;
                let offsetInRoughClip = Math.max(0, Number(window.start) - actualRoughStart);
                const roughDuration = Math.max(0.1, Number(window.duration) + offsetInRoughClip + postRollSeconds);
                const tempPath = path.join(parsedOutput.dir, `${parsedOutput.name}.source.tmp${parsedOutput.ext || '.mp4'}`);
                let keepTempForCover = false;
                try {
                    if (twoStageMode === 'copy') {
                        await runFfmpeg([
                            '-y',
                            '-ss', String(roughStart),
                            '-i', source.mediaPath,
                            '-t', String(roughDuration),
                            '-map', '0:v:0',
                            '-map', '0:a?',
                            '-c', 'copy',
                            '-avoid_negative_ts', 'make_zero',
                            tempPath
                        ], ffmpegOptions);
                        actualRoughStart = await probeRoughCutSourceStart(
                            ffmpegPath,
                            source.mediaPath,
                            tempPath,
                            roughStart
                        );
                        offsetInRoughClip = Math.max(0, Number(window.start) - actualRoughStart);
                        roughSourceStart = actualRoughStart;
                        roughTrimOffset = offsetInRoughClip;
                    } else {
                        await runFfmpeg([
                            '-y',
                            '-ss', String(roughStart),
                            '-i', source.mediaPath,
                            '-t', String(roughDuration),
                            '-map', '0:v:0',
                            '-map', '0:a?',
                            '-c:v', 'libx264',
                            '-preset', 'ultrafast',
                            '-crf', '18',
                            '-c:a', 'copy',
                            '-movflags', '+faststart',
                            tempPath
                        ], ffmpegOptions);
                        roughSourceStart = actualRoughStart;
                        roughTrimOffset = offsetInRoughClip;
                    }
                    // Use filter-based trim instead of -ss for frame-exact precision.
                    // -ss on the input side is keyframe-aligned (especially with copy-mode
                    // rough clips), causing subtitle misalignment. trim+setpts is sample-accurate.
                    const trimStart = String(offsetInRoughClip);
                    const trimEnd = String(Number(offsetInRoughClip) + Number(duration));
                    await runFfmpeg([
                        '-y',
                        ...buildSubtitleBurnInputArgs(config),
                        '-i', tempPath,
                        '-filter_complex', `[0:v]trim=start=${trimStart}:end=${trimEnd},setpts=PTS-STARTPTS[sub_v];[0:a]atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS[sub_a];[sub_v]subtitles='${escapeSubtitlePathForFfmpegFilter(burnAssPath)}'[vout]`,
                        '-map', '[vout]',
                        '-map', '[sub_a]',
                        ...buildSubtitleBurnVideoArgs(config),
                        '-movflags', '+faststart',
                        outputPath
                    ], ffmpegOptions);
                    if (config.preserveCoverSource === true) {
                        keepTempForCover = true;
                        coverSourcePath = tempPath;
                        coverClipStart = offsetInRoughClip;
                        coverTimeOrigin = actualRoughStart;
                    }
                } finally {
                    try {
                        if (!keepTempForCover && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    } catch {
                        // Best-effort cleanup; the final clip is already written or fallback will run.
                    }
                }
            } else {
                await runFfmpeg([
                    '-y',
                    '-ss', start,
                    ...buildSubtitleBurnInputArgs(config),
                    '-i', source.mediaPath,
                    '-t', duration,
                    '-vf', `subtitles='${escapeSubtitlePathForFfmpegFilter(burnAssPath)}'`,
                    ...buildSubtitleBurnVideoArgs(config),
                    '-c:a', 'copy',
                    '-movflags', '+faststart',
                    outputPath
                ], ffmpegOptions);
            }
            return {
                path: outputPath,
                burnedSubtitles: true,
                fallbackUsed: false,
                coverSourcePath,
                coverSourceTemporary: Boolean(coverSourcePath),
                coverClipStart,
                coverTimeOrigin,
                twoStageSubtitleBurn: useTwoStageBurn,
                twoStageMode: subtitleBurnPlan.mode,
                requestedTwoStageMode: subtitleBurnPlan.requestedMode,
                roughSourceStart,
                roughTrimOffset,
                resourcePeaks
            };
        } catch (error) {
            subtitleBurnFailure = error.message;
            if (useTwoStageBurn) {
                console.warn(`⚠️  两段式字幕烧录失败,退回原始源直接烧录: ${error.message}`);
                try {
                    await runFfmpeg([
                        '-y',
                        '-ss', start,
                        ...buildSubtitleBurnInputArgs(config),
                        '-i', source.mediaPath,
                        '-t', duration,
                        '-vf', `subtitles='${escapeSubtitlePathForFfmpegFilter(burnAssPath)}'`,
                        ...buildSubtitleBurnVideoArgs(config),
                        '-c:a', 'copy',
                        '-movflags', '+faststart',
                        outputPath
                    ], ffmpegOptions);
                    return {
                        path: outputPath,
                        burnedSubtitles: true,
                        fallbackUsed: true,
                        fallbackReason: subtitleBurnFailure,
                        twoStageSubtitleBurn: false
                    };
                } catch (directError) {
                    subtitleBurnFailure = `${subtitleBurnFailure}; direct burn failed: ${directError.message}`;
                    console.warn(`⚠️  字幕烧录失败,改为生成无烧录切片: ${directError.message}`);
                }
            } else {
                console.warn(`⚠️  字幕烧录失败,改为生成无烧录切片: ${error.message}`);
            }

            if (isNvencSubtitleEncoder(config)) {
                try {
                    console.warn('⚠️  NVENC 字幕烧录不可用，回退到 libx264，并关闭 CUDA 解码');
                    await runFfmpeg([
                        '-y',
                        '-ss', start,
                        ...buildSubtitleBurnInputArgs(config, { forceCpu: true }),
                        '-i', source.mediaPath,
                        '-t', duration,
                        '-vf', `subtitles='${escapeSubtitlePathForFfmpegFilter(burnAssPath)}'`,
                        ...buildSubtitleBurnVideoArgs(config, { forceCpu: true }),
                        '-c:a', 'copy',
                        '-movflags', '+faststart',
                        outputPath
                    ], ffmpegOptions);
                    return {
                        path: outputPath,
                        burnedSubtitles: true,
                        fallbackUsed: true,
                        fallbackReason: `${subtitleBurnFailure}; NVENC failed, used libx264`,
                        subtitleVideoEncoder: 'libx264',
                        twoStageSubtitleBurn: false,
                        twoStageMode: 'direct',
                        resourcePeaks
                    };
                } catch (cpuFallbackError) {
                    subtitleBurnFailure = `${subtitleBurnFailure}; libx264 fallback failed: ${cpuFallbackError.message}`;
                    console.warn(`⚠️  libx264 字幕回退也失败,改为生成无烧录切片: ${cpuFallbackError.message}`);
                }
            }
        } finally {
            try {
                if (burnAssPath && fs.existsSync(burnAssPath)) fs.unlinkSync(burnAssPath);
            } catch {
                // Best-effort cleanup for temporary ASS files.
            }
        }
    }

    await runFfmpeg([
        '-y',
        '-ss', start,
        '-i', source.mediaPath,
        '-t', duration,
        '-c', 'copy',
        outputPath
    ], ffmpegOptions);
    return {
        path: outputPath,
        burnedSubtitles: false,
        fallbackUsed: config.burnSubtitles !== false,
        fallbackReason: subtitleBurnFailure,
        resourcePeaks
    };
}

function writeCopyMarkdown(copy, metadata, outputPath) {
    const lines = [
        `# ${copy.title}`,
        '',
        '## 简介',
        copy.description,
        '',
        '## Tags',
        copy.tags.join(', '),
        '',
        '## 本地文件',
        `视频/音频: ${metadata.output.mediaPath}`,
        `字幕: ${metadata.output.srtPath}`,
        `元数据: ${metadata.output.metadataPath}`,
        '',
        '## 状态',
        `uploadReady: ${metadata.uploadReady}`,
        `autoUploadEnabled: ${metadata.autoUploadEnabled}`
    ];
    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function getWeChatWebhookUrl(config = {}) {
    return String(config.wechatWork?.webhookUrl || '').trim();
}

function toFwdSlash(s) {
    return String(s || '').replace(/\\+/g, '/');
}

function compactNotifyText(text, maxLength = 80) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function formatContextSegment(segment = {}) {
    const text = compactNotifyText(segment.text || '', 100);
    if (!text) return null;
    const marker = segment.hit ? '★ ' : '';
    return `${marker}[${formatClock(Number(segment.start) || 0)}] ${text}`;
}

function buildSubtitleContextLines(window = {}, maxLines = 3) {
    const limit = Math.max(1, Number(maxLines) || 3);
    const matchSegments = Array.isArray(window.matchSegments) ? window.matchSegments : [];
    const contextSegments = Array.isArray(window.contextSegments) ? window.contextSegments : [];
    const firstMatch = matchSegments[0] || null;

    if (contextSegments.length > 0) {
        const matchKeys = new Set(matchSegments.map(segmentKey));
        const hitIndex = firstMatch
            ? contextSegments.findIndex(segment => segment.index === firstMatch.index || segmentKey(segment) === segmentKey(firstMatch))
            : contextSegments.findIndex(segment => matchKeys.has(segmentKey(segment)));
        const center = hitIndex >= 0 ? hitIndex : Math.floor(contextSegments.length / 2);
        const before = Math.floor((limit - 1) / 2);
        let start = Math.max(0, center - before);
        let end = Math.min(contextSegments.length, start + limit);
        start = Math.max(0, end - limit);
        return contextSegments
            .slice(start, end)
            .map(segment => ({
                ...segment,
                hit: segment.hit || matchKeys.has(segmentKey(segment))
            }))
            .map(formatContextSegment)
            .filter(Boolean);
    }

    const fallback = [];
    const pre = Array.isArray(window.preContext) ? window.preContext.slice(-1) : [];
    const post = Array.isArray(window.postContext) ? window.postContext.slice(0, 1) : [];
    for (const text of pre) {
        fallback.push({ start: window.start || 0, text });
    }
    for (const match of matchSegments.slice(0, 1)) {
        fallback.push({ ...match, hit: true });
    }
    for (const text of post) {
        fallback.push({ start: window.end || 0, text });
    }
    return fallback.slice(0, limit).map(formatContextSegment).filter(Boolean);
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
    const parsed = await parser.parseStringPromise(data);
    const list = parsed?.i?.d || parsed?.I?.D || [];
    const rows = [];
    for (const item of list) {
        const attrsRaw = item?.$?.p || item?.$?.P;
        if (!attrsRaw) continue;
        const attrs = String(attrsRaw).split(',');
        const time = Number(attrs[0]);
        const text = compactNotifyText(item._ || '', 80);
        if (!Number.isFinite(time) || time < 0 || !text) continue;
        rows.push({ time, text });
    }
    return rows.sort((a, b) => a.time - b.time);
}

function buildDanmakuContextLines(danmaku = [], window = {}, notifyConfig = {}) {
    if (!Array.isArray(danmaku) || danmaku.length === 0) return [];
    const maxLines = Math.max(0, Number(notifyConfig.maxDanmakuLines) || 0);
    if (maxLines === 0) return [];

    const padding = Math.max(5, Number(notifyConfig.danmakuContextSeconds) || 45);
    const match = Array.isArray(window.matchSegments) ? window.matchSegments[0] : null;
    const focusStart = Number(match?.start ?? window.start ?? 0);
    const focusEnd = Number(match?.end ?? window.end ?? focusStart);
    const start = Math.max(Number(window.start || 0), focusStart - padding);
    const end = Math.min(Number(window.end || focusEnd + padding), focusEnd + padding);
    const seen = new Set();
    const samples = danmaku
        .filter(item => item.time >= start && item.time <= end)
        .filter(item => {
            if (seen.has(item.text)) return false;
            seen.add(item.text);
            return true;
        })
        .slice(0, maxLines);

    return samples.map(item => `[${formatClock(item.time)}] ${item.text}`);
}

function buildClipNotifyBlock(result = {}, notifyConfig = {}) {
    const window = result.window || {};
    const uploadId = Number.isFinite(Number(result.uploadId)) ? Number(result.uploadId) : null;
    const idPrefix = uploadId ? `ID ${uploadId} | ` : '';
    const mediaPath = toFwdSlash(result.output?.mediaPath || '');
    const fileName = mediaPath ? path.basename(mediaPath) : '文件未生成';
    const title = compactNotifyText(result.copy?.title || '', 120);
    const lines = [
        `- ${idPrefix}${formatClock(window.start || 0)}-${formatClock(window.end || 0)} | ${fileName}`
    ];

    if (title) {
        lines.push(`  - 标题: ${title}`);
    }
    if (result.aiReview) lines.push(result.aiReview.mode === 'preflight'
        ? `  - 烧录前复核: ${result.aiReview.status}; 字幕校对 ${result.aiReview.subtitleEdits.length} 处`
        : `  - AI复核: 关键词=${result.aiReview.keyword.status}, 文案=${result.aiReview.quality.status}; 建议未自动应用`);

    if (notifyConfig.includeSubtitleContext !== false) {
        const subtitleContext = buildSubtitleContextLines(
            window,
            notifyConfig.subtitleContextLines
        );
        if (subtitleContext.length > 0) {
            lines.push('  - 字幕上下文:');
            lines.push(...subtitleContext.map(line => `    ${line}`));
        }
    }

    if (notifyConfig.includeDanmakuContext !== false) {
        const danmakuContext = Array.isArray(window.danmakuContext)
            ? window.danmakuContext.filter(Boolean)
            : [];
        if (danmakuContext.length > 0) {
            lines.push('  - 附近弹幕:');
            lines.push(...danmakuContext.map(line => `    ${line}`));
        }
    }

    return lines.join('\n');
}

const TOPIC_FAILURE_STAGE_LABELS = {
    planning: 'AI 分段',
    subtitle: '字幕生成',
    subtitle_burn: '字幕烧录降级',
    copy: '文案生成',
    media: '媒体生成',
    cover: '封面生成',
    metadata: '元数据写入',
    review: '审核文件写入',
    registry: '上传注册',
    topic_clipper: '话题切片'
};

function collectTopicFailures(results = [], failures = []) {
    const collected = Array.isArray(failures) ? [...failures] : [];
    for (const result of results) {
        const mediaError = result?.output?.mediaError;
        if (!mediaError) continue;
        const duplicate = collected.some(item =>
            item?.stage === 'media'
            && Number(item?.window?.start) === Number(result?.window?.start)
            && String(item?.error || '') === String(mediaError)
        );
        if (!duplicate) {
            collected.push({
                stage: 'media',
                window: result.window,
                title: result.copy?.title || null,
                error: mediaError
            });
        }
    }
    return collected;
}

function buildTopicFailureBlock(failure = {}) {
    const stage = TOPIC_FAILURE_STAGE_LABELS[failure.stage] || failure.stage || '未知阶段';
    const window = failure.window || {};
    const hasWindow = Number.isFinite(Number(window.start)) || Number.isFinite(Number(window.end));
    const range = hasWindow
        ? `${formatClock(window.start || 0)}-${formatClock(window.end || window.start || 0)} | `
        : '';
    const severity = failure.severity === 'warning' ? '降级' : '失败';
    const error = compactNotifyText(failure.error || failure.message || '未知错误', 360);
    return `- [${severity}/${stage}] ${range}${error}`;
}

function cleanupTemporaryCoverSource(mediaResult = {}) {
    const tempPath = mediaResult?.coverSourceTemporary ? mediaResult.coverSourcePath : null;
    if (!tempPath) return false;
    try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return true;
    } catch (error) {
        console.warn(`⚠️  清理封面临时无字幕切片失败: ${error.message}`);
        return false;
    }
}

function buildTopicNotifyMarkdown(results = [], metadata = {}) {
    const notifyConfig = metadata.notify || {};
    const aiModels = Array.isArray(metadata.aiModels) && metadata.aiModels.length > 0
        ? metadata.aiModels.join(', ')
        : '规则兜底（未调用 AI）';
    const failures = collectTopicFailures(results, metadata.failures);
    const successfulResults = results.filter(result => !result?.output?.mediaError && result?.output?.mediaPath);
    const windowSummary = successfulResults
        .map(result => buildClipNotifyBlock(result, notifyConfig))
        .join('\n');
    const failureSummary = failures.map(buildTopicFailureBlock).join('\n');
    const title = failures.length > 0 ? '## 话题切片提醒（存在失败）' : '## 话题切片提醒';
    const outcome = failures.length > 0
        ? `本次候选 **${results.length}** 段,成功生成 **${successfulResults.length}** 段,另有 **${failures.length}** 条失败或降级记录。`
        : `找到其中 **${results.length}** 段提到岁己的地方,已分别切为切片。`;

    return [
        title,
        '',
        `在 **${metadata.streamerName || '主播'}** 的直播 **${metadata.streamTitle || metadata.sourceFileName || '未知直播'}** 结束后,`,
        outcome,
        '',
        `- 直播间: ${metadata.roomId || '未知'}`,
        `- 录制时间: ${metadata.recordedAt || '未知'}`,
        `- AI模型: ${aiModels}`,
        `- 切片目录: ${toFwdSlash(metadata.outputRoot || '未知')}`,
        metadata.reviewPath ? `- 审核文件: ${toFwdSlash(metadata.reviewPath)}` : null,
        metadata.uploadRegistry?.clipIds?.length ? `- 投稿短id: ${metadata.uploadRegistry.clipIds.join(',')}` : null,
        '',
        '成功切片:',
        windowSummary || '- 无',
        failures.length > 0 ? '' : null,
        failures.length > 0 ? '失败与降级详情:' : null,
        failures.length > 0 ? failureSummary : null
    ].filter(Boolean).join('\n');
}

function deriveUploadPrefix(streamerName = null) {
    const name = String(streamerName || '').trim();
    if (!name) return '【小切片】';
    const nameChars = Array.from(name.matchAll(/[\u3400-\u9fffA-Za-z0-9]/g), match => match[0]);
    if (nameChars[0] === '小' && nameChars[1]) return `【小${nameChars[1]}】`;
    // 优先取主播名中的第一个中文字符,例如"瑞瑞"→"小瑞"、
    // "岁己SUI"→"小岁"、"米汀Nagisa"→"小米"。
    const cjk = name.match(/[\u3400-\u9fff]/);
    const initial = cjk ? cjk[0] : name.match(/[A-Za-z0-9]/)?.[0];
    return initial ? `【小${initial}】` : `【小${name.slice(0, 1)}】`;
}

function resolveUploadPrefix(config = {}, roomId = null, streamerName = null) {
    const roomKey = roomId ? String(roomId) : null;
    const roomSettings = roomKey
        ? (config.ai?.roomSettings?.[roomKey] || config.roomSettings?.[roomKey] || null)
        : null;
    const configured = String(roomSettings?.clipTitlePrefix || '').trim();
    if (configured) return `【${configured.replace(/^【|】$/g, '')}】`;

    for (const entry of Object.values(config.ai?.streamerRegistry || {})) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(value => String(value)) : [];
        if (!roomKey || !roomIds.includes(roomKey)) continue;
        const registryName = String(entry.aiClipName || entry.uploadPrefix || '').trim();
        if (registryName) return `【${registryName.replace(/[【】]/g, '')}】`;
        break;
    }
    return deriveUploadPrefix(streamerName);
}

function buildTopicReviewMarkdown(results = [], metadata = {}) {
    const uploadIds = Array.isArray(metadata.uploadRegistry?.clipIds)
        ? metadata.uploadRegistry.clipIds
        : [];
    const failures = collectTopicFailures(results, metadata.failures);
    const uploadableResults = results.filter(result => result?.uploadReady && !result?.output?.mediaError);
    const localOnlyResults = results.filter(result => !result?.output?.mediaError && !result?.uploadReady);
    const lines = [
        '# 话题切片 review',
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot || ''}`,
        metadata.planPath ? `事件编排记录: ${metadata.planPath}` : null,
        uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
        '',
        '## 切片列表',
        ''
    ].filter(line => line !== null);

    uploadableResults.forEach((result, index) => {
        const start = formatClock(result.window?.start || 0);
        const duration = formatClock(result.window?.duration || ((result.window?.end || 0) - (result.window?.start || 0)));
        lines.push(`${index + 1}. ${result.copy?.title || '话题切片'} | ${start} | ${duration} | ${result.output?.mediaPath || ''}`);
        if (uploadIds[index]) {
            lines.push(`   上传ID: ${uploadIds[index]}`);
        }
        if (result.output?.coverPath) {
            lines.push(`   封面: ${result.output.coverPath}`);
        }
        if (result.editorial) {
            lines.push(`   事件编排: ${result.editorial.status} | ${result.editorial.event || result.editorial.reason}`);
            if (result.editorial.extensionReason) lines.push(`   完整性延长: ${result.editorial.extensionReason}`);
            const grounding = buildGroundingReviewLine(result.editorial.copyGrounding);
            if (grounding) lines.push(grounding);
        }
        lines.push(...topicReviewLines(result.aiReview));
    });
    if (uploadableResults.length === 0) {
        lines.push('- 无可上传切片');
    }
    if (localOnlyResults.length > 0) {
        lines.push('', '## 仅本地结果', '');
        localOnlyResults.forEach(result => {
            lines.push(`- ${result.copy?.title || '话题切片'} | ${formatClock(result.window?.start || 0)} | ${result.output?.mediaPath || ''}`);
            if (result.status === 'pending_preflight') lines.push(`   待烧录前审核: ${result.output?.metadataPath || ''}`);
            lines.push(...topicReviewLines(result.aiReview));
        });
    }
    if (failures.length > 0) {
        lines.push('', '## 失败与降级记录', '');
        lines.push(...failures.map(buildTopicFailureBlock));
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
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

function buildTopicUploadSettings(metadata, copy = {}) {
    const source = `${metadata.streamerName || '主播'} 直播《${metadata.streamTitle || metadata.sourceFileName || '未知直播'}》${metadata.recordedAt || ''}`.trim();
    const tags = Array.isArray(copy.tags) && copy.tags.length
        ? copy.tags
        : ['岁己', '虚拟主播', '直播切片', 'AI切片'];
    return {
        source,
        tags: Array.from(new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))),
        prefix: resolveUploadPrefix(metadata.config || {}, metadata.roomId, metadata.streamerName),
        tid: 21,
        roomId: metadata.roomId || null,
        streamerName: metadata.streamerName || null
    };
}

function writeTopicUploadManifest(manifestPath, reviewPath, results, metadata) {
    const settings = buildTopicUploadSettings(metadata, results[0]?.copy || {});
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
    const settings = buildTopicUploadSettings(metadata, results[0]?.copy || {});
    const manifestPath = metadata.uploadManifestPath
        || path.join(path.dirname(reviewPath), `${path.basename(reviewPath, path.extname(reviewPath))}_UPLOAD_MANIFEST.json`);
    writeTopicUploadManifest(manifestPath, reviewPath, results, metadata);
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
    let result;
    try {
        result = require('child_process').spawnSync('python', args, {
            cwd: path.dirname(path.dirname(__dirname)),
            encoding: 'utf8',
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: getClipTopicsConfig(metadata.config || {}).ffmpegTimeoutMs,
            killSignal: 'SIGKILL'
        });
    } catch (error) {
        throw new Error(`Upload registry import could not start: ${error.message}`);
    }
    if (result.error) {
        throw new Error(`Upload registry import could not start: ${result.error.message}`);
    }
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) {
        throw new Error(`Upload registry import failed: ${output || `exit ${result.status}`}`);
    }
    if (output) {
        console.log(output);
    }
    return parseUploadRegistryOutput(output);
}

async function notifyTopicClipResults(results = [], metadata = {}, config = {}) {
    const notifyConfig = config.clipTopics?.notify || {};
    const failures = collectTopicFailures(results, metadata.failures);
    if (!notifyConfig.enabled || (results.length === 0 && failures.length === 0)) {
        return false;
    }

    const webhookUrl = getWeChatWebhookUrl(config);
    if (!webhookUrl) {
        console.warn('⚠️  话题切片提醒已启用,但未配置企业微信 webhookUrl');
        return false;
    }

    const markdown = buildTopicNotifyMarkdown(results, {
        ...metadata,
        failures,
        notify: notifyConfig
    });
    return sendWeChatMarkdown(webhookUrl, markdown);
}

async function notifyTopicClipFailure(error, metadata = {}, config = {}) {
    const failure = {
        stage: metadata.stage || 'topic_clipper',
        error: error?.message || String(error || '未知错误')
    };
    return notifyTopicClipResults([], {
        ...metadata,
        failures: [failure]
    }, config);
}

async function generateTopicClips(options = {}) {
    const config = getClipTopicsConfig(options.config || {});
    if (!config.enabled) {
        return [];
    }
    if (config.mode !== 'local_review') {
        console.warn(`⚠️  clipTopics.mode=${config.mode} 暂未实现,按 local_review 处理`);
    }
    if (config.autoUpload?.enabled) {
        console.warn('⚠️  clipTopics.autoUpload.enabled=true 但 v1 不执行自动投稿,仅生成本地 review 包');
    }

    const source = chooseClipSource(options.originalMediaPath, options.processedMediaPath);
    if (!source) {
        console.warn('⚠️  话题切片跳过: 未找到可裁切的媒体文件');
        return [];
    }
    if (!options.srtPath || !fs.existsSync(options.srtPath)) {
        console.warn('⚠️  话题切片跳过: 未找到 SRT 字幕');
        return [];
    }

    const usePreflight = isPreflightEnabled(config);
    const sourceSrtHash = usePreflight ? sourceFileHash(options.srtPath) : null;
    const parsed = parseTopicSrt(options.srtPath);
    const matches = findKeywordMatches(parsed.segments, config.keywords);
    if (matches.length === 0) {
        console.log('i️  话题切片: 未命中关键词');
        return [];
    }

    const aiConfig = options.config || {};

    const bursts = buildTopicBursts(parsed.segments, matches, {
        contextPaddingSeconds: config.contextPaddingSeconds,
        contextPrePaddingSeconds: config.contextPrePaddingSeconds,
        contextPostPaddingSeconds: config.contextPostPaddingSeconds,
        mergeGapSeconds: config.mergeGapSeconds,
        maxSegmentsPerBurst: config.maxSegmentsPerBurst,
        minClipSeconds: config.minClipSeconds,
        boundaryEndExtensionSeconds: config.boundaryEndExtensionSeconds,
        boundarySilenceGapSeconds: config.boundarySilenceGapSeconds,
        maxClipSeconds: config.maxClipSeconds,
        totalDurationSeconds: options.totalDurationSeconds
    });
    if (bursts.length === 0) {
        console.log('i️  话题切片: 命中关键词但未形成有效话题爆发段');
        return [];
    }

    let danmaku = [];
    if ((usePreflight || config.notify?.includeDanmakuContext !== false) && options.xmlPath) {
        try {
            danmaku = await parseDanmakuXml(options.xmlPath);
        } catch (error) {
            console.warn(`⚠️  解析弹幕 XML 失败,企微提醒将不带弹幕上下文: ${error.message}`);
        }
    }

    console.log(`\n📦 ${bursts.length} 个话题爆发段 (burst),调用 AI 决定切在哪...`);

    const info = parseRecordingInfo(source.mediaPath, options.context || {});
    if (isIgnoredRoom(info.roomId, config)) {
        console.log(`i️  话题切片跳过: roomId=${info.roomId} 命中忽略名单`);
        return [];
    }
    const streamerName = resolveStreamerName(options.config || {}, info.roomId, options.context || {});
    const participantMetadata = buildParticipantMetadata(loadAsrSpeakerSidecarForMediaPath(options.srtPath || source.mediaPath));
    const outputRoot = resolveClipOutputRoot(source.mediaPath, config);
    fs.mkdirSync(outputRoot, { recursive: true });

    const useEditorial = usePreflight || isTopicEditorialEnabled(aiConfig);
    const editorialEvidence = usePreflight ? buildPreflightEvidence(parsed.segments)
        : useEditorial ? buildSubtitleEvidence(parsed.segments) : null;
    const planningGroups = useEditorial ? buildTopicEditorialGroups(bursts, editorialEvidence, config) : bursts;
    info.selectionCacheDirectory = path.join(path.dirname(outputRoot), 'temp', path.basename(source.mediaPath), 'topic_selection');
    const planPath = useEditorial ? path.join(outputRoot, `${path.basename(source.mediaPath, path.extname(source.mediaPath))}_TOPIC_PLAN.json`) : null;
    const aiSegmentedClips = [];
    const aiModelsUsed = new Set();
    const failures = [];
    const diagnostics = { requests: [], failures };
    if (useEditorial) console.log(`📝 ${bursts.length} 个关键词候选合为 ${planningGroups.length} 组完整上下文,按独立事件编排`);
    for (const burst of planningGroups) {
        try {
            console.log(`  🔍 [${formatClock(burst.matchStart)}] 命中 ${burst.matchCount} 次,上下文窗口 ${formatClock(burst.start)}-${formatClock(burst.end)}`);

            const segments = usePreflight
                ? preflightSelections(await prepareTopicGroup(burst, editorialEvidence, config, aiConfig,
                    { ...info, streamerName, srtPath: options.srtPath }, diagnostics, { danmaku }), burst, config)
                : useEditorial
                ? await planTopicEventGroup(burst, editorialEvidence, config, aiConfig, streamerName, info, diagnostics)
                : await segmentBurstWithAI(burst, parsed, streamerName, info, aiConfig);

            if (segments.length === 0) {
                console.log(`  ⏭️  AI 判定跳过(可能是唱歌/误识别)`);
                continue;
            }

            for (const seg of segments) {
                if (seg.aiModel) {
                    aiModelsUsed.add(seg.aiModel);
                }
                const w = buildTopicClipWindow(seg, burst, parsed.segments);
                w.danmakuContext = buildDanmakuContextLines(danmaku, w, config.notify || {});
                aiSegmentedClips.push({
                    window: w,
                    burst,
                    aiTitle: seg.aiTitle,
                    aiCoverText: seg.aiCoverText,
                    aiDescription: seg.aiDescription,
                    aiModel: seg.aiModel || null,
                    editorial: seg.editorial || null,
                    preflight: seg.preflight || null,
                    subtitleSegments: seg.subtitleSegments,
                    boundaryAdjusted: Boolean(seg.boundaryAdjusted)
                });
            }

            console.log(`  ✅ 切出 ${segments.length} 段: ${segments.map(s => formatClock(s.start) + '-' + formatClock(s.end)).join(', ')}`);
        } catch (error) {
            failures.push({
                stage: 'planning',
                window: { start: burst.start, end: burst.end },
                error: error.message
            });
            console.warn(`⚠️  话题 burst 处理失败,跳过本段并继续: ${error.message}`);
        }
    }

    if (!useEditorial && aiSegmentedClips.length === 0 && failures.length === 0) {
        console.log('i️  AI 分段后无有效切片');
        return [];
    }

    const renderableClips = usePreflight ? aiSegmentedClips.filter(clip => clip.preflight?.status === 'ready') : aiSegmentedClips;
    const clipsToGenerate = dedupeClipsByStart(renderableClips, { dedupeMatchText: !useEditorial });
    if (usePreflight) clipsToGenerate.push(...aiSegmentedClips.filter(clip => clip.preflight?.status !== 'ready'));
    clipsToGenerate.sort((a, b) => a.window.start - b.window.start);
    if (clipsToGenerate.length < aiSegmentedClips.length) {
        console.log(`i️  已过滤 ${aiSegmentedClips.length - clipsToGenerate.length} 段重复/重叠切片`);
        if (useEditorial) failures.push({ stage: 'planning', severity: 'warning',
            error: '事件编排仍存在冲突,已兜底去重;未保留的候选和独有内容请核对 TOPIC_PLAN.json' });
    }

    if (usePreflight) {
        try {
            if (sourceFileHash(options.srtPath) !== sourceSrtHash) throw new Error('Source subtitles changed during preflight');
            persistPreflightPlan(planPath, source.mediaPath, sourceSrtHash,
                diagnostics.preflightGroups, clipsToGenerate, diagnostics);
        } catch (error) {
            failures.push({ stage: 'preflight', severity: 'warning', error: error.message });
            for (const clip of clipsToGenerate) {
                clip.preflight.status = 'needs_review';
                clip.preflight.applied = false;
                clip.preflight.quality.issues.push(error.message);
            }
        }
    }
    console.log(`\n🎬 共 ${clipsToGenerate.length} 段候选,仅执行已完成前置审核的切片...\n`);

    const results = [];
    const clipResourceConfig = getFfmpegResourceConfig(options.config || configLoader.getConfig());
    const mediaGenerator = options.mediaGenerator || cutClipMedia;
    const coverGenerator = options.coverGenerator || generateClipCover;
    const reviewRegistrar = options.registerReviewForUpload || registerReviewForUpload;
    const resultNotifier = options.notifyTopicClipResults || notifyTopicClipResults;
    for (const clip of clipsToGenerate) {
        const window = clip.window;
        const base = sanitizeFileName(`${path.basename(source.mediaPath, path.extname(source.mediaPath))}_topic_${String(window.index).padStart(2, '0')}_${formatClock(window.start).replace(/:/g, '')}`);
        const mediaExt = source.kind === 'audio' ? path.extname(source.mediaPath).toLowerCase() : '.mp4';
        const mediaPath = path.join(outputRoot, `${base}${mediaExt || '.m4a'}`);
        const srtPath = path.join(outputRoot, `${base}.srt`);
        const metadataPath = path.join(outputRoot, `${base}.json`);
        const copyPath = path.join(outputRoot, `${base}_投稿文案.md`);
        let stage = 'subtitle';
        let srtResult = { segmentCount: 0, segments: [] };
        let copy = {
            title: clip.aiTitle || buildDefaultTitle(window, info),
            coverText: clip.aiCoverText || '',
            description: clip.aiDescription || '',
            tags: Array.isArray(config.extraTags) ? [...config.extraTags] : []
        };
        let mediaResult = null;
        let aiReview = clip.preflight || null;
        let mediaError = null;
        let coverPath = null;
        const clipFailures = [];
        const recordFailure = (failureStage, error, severity = 'error') => {
            const failure = {
                stage: failureStage,
                severity,
                window,
                title: copy?.title || null,
                error: error?.message || String(error || '未知错误')
            };
            clipFailures.push(failure);
            failures.push(failure);
            return failure;
        };
        const createMetadata = () => ({
            version: 1,
            generatedAt: new Date().toISOString(),
            mode: 'local_review',
            status: mediaError ? 'failed' : (clipFailures.length > 0 ? 'partial' : 'success'),
            source: {
                mediaPath: source.mediaPath,
                sourceKind: source.kind,
                sourceReason: source.reason,
                srtPath: options.srtPath,
                asrEvidenceStatus: parsed.asrEvidenceStatus,
                originalMediaPath: options.originalMediaPath || null,
                processedMediaPath: options.processedMediaPath || null
            },
            roomId: info.roomId,
            streamerName,
            participantInfo: participantMetadata,
            recordedAt: info.recordedAt,
            streamTitle: info.streamTitle,
            window,
            editorial: clip.editorial,
            aiReview,
            copy,
            upload: buildTopicUploadSettings({
                config: options.config || {},
                roomId: info.roomId,
                streamerName,
                streamTitle: info.streamTitle,
                sourceFileName: info.fileName,
                recordedAt: info.recordedAt
            }, copy),
            ai: {
                segmentationModel: clip.aiModel || null,
                boundaryAdjusted: Boolean(clip.boundaryAdjusted),
                requestedModel: usePreflight ? (config.review.model || config.aiModel) : getTopicClipAiModel(options.config || {}),
                ...(usePreflight ? { reasoningEffort: config.review.reasoningEffort, preflightStrategy: config.review.strategy } : {})
            },
            issues: clipFailures,
            uploadReady: source.uploadReady && Boolean(mediaResult?.path) && !mediaError,
            autoUploadEnabled: false,
            output: {
                mediaPath: mediaResult?.path || mediaPath,
                srtPath,
                metadataPath,
                copyPath,
                coverPath,
                burnedSubtitles: Boolean(mediaResult?.burnedSubtitles),
                subtitleBurnFallbackUsed: Boolean(mediaResult?.fallbackUsed),
                subtitleBurnFallbackReason: mediaResult?.fallbackReason || null,
                srtSegmentCount: srtResult.segmentCount,
                mediaError
            }
        });

        try {
            if (usePreflight && clip.preflight?.status !== 'ready') {
                const metadata = createMetadata();
                metadata.status = 'pending_preflight';
                metadata.uploadReady = false;
                metadata.output.mediaPath = metadata.output.srtPath = metadata.output.copyPath = null;
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
                results.push(metadata);
                continue;
            }
            srtResult = writeClipSrt(usePreflight ? clip.subtitleSegments : parsed.segments, window, srtPath, {
                maxCharsPerLine: config.subtitleMaxCharsPerLine ?? 18
            });
            if (usePreflight) aiReview.applied = true;
            stage = 'copy';
            if (useEditorial && !usePreflight) {
                try {
                    const finalCopy = await generateTopicEventCopy(clip, editorialEvidence, config, aiConfig, streamerName, info, diagnostics);
                    clip.aiTitle = finalCopy.title;
                    clip.aiDescription = finalCopy.description;
                    clip.aiCoverText = finalCopy.coverText;
                    Object.assign(clip.editorial, { copyStatus: 'generated', copyModel: finalCopy.model,
                        copyGrounding: finalCopy.grounding, copyWindow: { start: window.start, end: window.end } });
                    aiModelsUsed.add(finalCopy.model);
                } catch (error) {
                    clip.aiTitle = clip.aiDescription = clip.aiCoverText = null;
                    clip.editorial.copyStatus = 'fallback';
                    recordFailure('copy', error, 'warning');
                }
            }
            // 优先用 AI 分段时生成的标题/简介,其次调用独立的标题/简介生成器
            const titleGen = clip.aiTitle
                ? async () => clip.aiTitle
                : (useEditorial ? null : options.titleGenerator);
            const descGen = clip.aiDescription
                ? async () => clip.aiDescription
                : (useEditorial ? null : options.descriptionGenerator);
            // 从 streamerRegistry 解析正式标签(如 米汀Nagisa)
            const registryTags = resolveStreamerTags(options.config || {}, info.roomId);
            const metadataConfig = { ...config, ai: options.config?.ai };
            copy = await buildClipCopy(window, info, streamerName, metadataConfig, titleGen, descGen, registryTags, clip.aiCoverText);
            if (!usePreflight) aiReview = await runTopicShadowReview({ ...clip, copy, streamerName }, parsed.segments, config, aiConfig, info, diagnostics);

            stage = 'media';
            try {
                mediaResult = await mediaGenerator(source, window, srtPath, mediaPath, {
                    ...config,
                    burnSubtitles: config.burnSubtitles,
                    subtitleSegments: srtResult.segments,
                    preserveCoverSource: true,
                    ffmpegPath: options.ffmpegPath,
                    ffmpegTimeoutMs: config.ffmpegTimeoutMs,
                    resourceConfig: clipResourceConfig
                });
            } catch (clipError) {
                mediaError = clipError.message;
                recordFailure('media', clipError);
                try {
                    if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
                } catch (cleanupError) {
                    console.warn(`⚠️  清理失败切片文件失败: ${cleanupError.message}`);
                }
                console.warn(`⚠️  话题切片媒体生成失败,保留字幕和元数据并继续下一段: ${clipError.message}`);
            }
            if (mediaResult?.fallbackUsed) {
                recordFailure(
                    'subtitle_burn',
                    new Error(mediaResult.fallbackReason || '字幕烧录失败,已降级生成媒体'),
                    'warning'
                );
            }

            stage = 'cover';
            // 生成封面(从切片视频截取关键帧 + 添加标题文字)
            if (mediaResult?.path && fs.existsSync(mediaResult.path)) {
                try {
                    const preferredTime = selectCoverPreferredTime(danmaku, window, config.reactionKeywords || []);
                    coverPath = await coverGenerator(mediaResult.path, copy.coverText || copy.title, outputRoot, {
                        ...info,
                        coverSourcePath: mediaResult.coverSourcePath || source.mediaPath,
                        clipStart: Number.isFinite(Number(mediaResult.coverClipStart))
                            ? Number(mediaResult.coverClipStart)
                            : window.start,
                        clipDuration: window.duration,
                        preferredTime: Number.isFinite(Number(mediaResult.coverTimeOrigin)) && Number.isFinite(Number(preferredTime))
                            ? Number(preferredTime) - Number(mediaResult.coverTimeOrigin)
                            : preferredTime,
                        timeoutMs: config.ffmpegTimeoutMs,
                        resourceConfig: clipResourceConfig
                    });
                } catch (coverErr) {
                    recordFailure('cover', coverErr, 'warning');
                    console.warn(`⚠️  封面生成失败,保留切片并继续: ${coverErr.message}`);
                } finally {
                    cleanupTemporaryCoverSource(mediaResult);
                }
            }

            stage = 'metadata';
            const metadata = createMetadata();
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
            writeCopyMarkdown(copy, metadata, copyPath);
            results.push(metadata);
            console.log(mediaError
                ? `⚠️  话题切片处理失败但已记录: ${path.basename(mediaPath)} (${formatClock(window.start)}-${formatClock(window.end)})`
                : `✅ 话题切片已生成: ${path.basename(mediaPath)} (${formatClock(window.start)}-${formatClock(window.end)})`);
        } catch (clipError) {
            mediaError = mediaError || clipError.message;
            recordFailure(stage, clipError);
            cleanupTemporaryCoverSource(mediaResult || {});
            const metadata = createMetadata();
            try {
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
                writeCopyMarkdown(copy, metadata, copyPath);
            } catch (metadataError) {
                console.warn(`⚠️  失败切片的元数据也无法写入: ${metadataError.message}`);
            }
            results.push(metadata);
            console.warn(`⚠️  单个话题切片失败,已隔离并继续下一段: ${clipError.message}`);
        }
    }

    const reviewStem = sanitizeFileName(path.basename(source.mediaPath, path.extname(source.mediaPath)));
    const reviewPath = path.join(outputRoot, `${reviewStem}_REVIEW.md`);
    const latestReviewPath = path.join(outputRoot, 'REVIEW.md');
    const reviewMetadata = {
        streamerName,
        streamTitle: info.streamTitle,
        roomId: info.roomId,
        recordedAt: info.recordedAt,
        config: options.config || {},
        aiModels: Array.from(aiModelsUsed),
        outputRoot,
        sourceFileName: info.fileName,
        reviewPath,
        planPath,
        uploadManifestPath: path.join(outputRoot, `${reviewStem}_UPLOAD_MANIFEST.json`),
        failures
    };
    try {
        if (planPath && !usePreflight) fs.writeFileSync(planPath, JSON.stringify({
            version: 1, strategy: 'event_editorial_v1', source: source.mediaPath,
            sourceSha256: editorialEvidence.sourceSha256,
            preferredClipSeconds: config.preferredClipSeconds, maxClipSeconds: config.maxClipSeconds,
            groups: planningGroups.map(group => ({ index: group.index, start: group.start, end: group.end,
                sourceBurstIndices: group.bursts.map(burst => burst.index), matchSegments: group.matchSegments })),
            candidates: aiSegmentedClips.map(clip => ({ window: clip.window, editorial: clip.editorial,
                selected: clipsToGenerate.includes(clip) })),
            requests: diagnostics.requests, failures
        }, null, 2), 'utf8');
    } catch (error) {
        failures.push({ stage: 'review', error: `事件编排记录写入失败: ${error.message}` });
    }
    try {
        fs.writeFileSync(reviewPath, buildTopicReviewMarkdown(results, reviewMetadata), 'utf8');
    } catch (error) {
        failures.push({ stage: 'review', error: error.message });
        console.warn(`⚠️  话题切片审核文件写入失败,继续发送结果通知: ${error.message}`);
    }

    const uploadableResults = results.filter(result => result?.uploadReady && !result?.output?.mediaError);
    let uploadRegistry = null;
    if (uploadableResults.length > 0) {
        try {
            uploadRegistry = await Promise.resolve(reviewRegistrar(reviewPath, uploadableResults, reviewMetadata));
            if (!Array.isArray(uploadRegistry?.clipIds)) {
                throw new Error('上传注册未返回切片短 ID');
            }
            if (uploadRegistry.clipIds.length !== uploadableResults.length) {
                throw new Error(`上传注册返回 ${uploadRegistry.clipIds.length} 个短 ID,预期 ${uploadableResults.length} 个`);
            }
            uploadableResults.forEach((result, index) => {
                result.uploadId = uploadRegistry.clipIds[index];
            });
            reviewMetadata.uploadRegistry = uploadRegistry;
        } catch (error) {
            failures.push({ stage: 'registry', error: error.message });
            console.warn(`⚠️  话题切片上传注册失败,本地结果仍保留: ${error.message}`);
        }
    }

    const finalReview = buildTopicReviewMarkdown(results, reviewMetadata);
    try {
        fs.writeFileSync(reviewPath, finalReview, 'utf8');
    } catch (error) {
        failures.push({ stage: 'review', error: error.message });
        console.warn(`⚠️  话题切片最终审核文件写入失败: ${error.message}`);
    }
    try {
        fs.writeFileSync(latestReviewPath, buildTopicReviewMarkdown(results, reviewMetadata), 'utf8');
    } catch (error) {
        failures.push({ stage: 'review', severity: 'warning', error: `更新最新 REVIEW.md 失败: ${error.message}` });
        console.warn(`⚠️  最新 REVIEW.md 更新失败,每场独立审核文件仍保留: ${error.message}`);
    }

    try {
        await resultNotifier(results, {
            ...reviewMetadata,
            failures,
            uploadRegistry
        }, options.config || {});
        console.log(`📣 话题切片提醒已尝试发送: 成功=${uploadableResults.length},异常=${failures.length}`);
    } catch (error) {
        console.warn(`⚠️  话题切片提醒发送失败,继续保留本地结果: ${error.message}`);
    }

    return results;
}

module.exports = {
    DEFAULT_CLIP_TOPICS_CONFIG,
    getClipTopicsConfig,
    chooseClipSource,
    findKeywordMatches,
    buildClipWindows,
    buildTopicBursts,
    buildTopicBurstPrompt,
    segmentBurstWithAI,
    normalizeAiClipSelection,
    dedupeClipsByStart,
    verifyClipWithAI,
    parseTopicSrt,
    parseDanmakuXml,
    writeClipSrt,
    buildBurnAssContentFromSrt,
    writeTemporaryBurnAssFromSrt,
    parseRecordingInfo,
    resolveStreamerName,
    resolveStreamerTags,
    deriveUploadPrefix,
    resolveUploadPrefix,
    isIgnoredRoom,
    buildDefaultTitle,
    normalizeCoverText,
    buildClipCopy,
    findMatchingPacketTime,
    probeRoughCutSourceStart,
    resolveSubtitleBurnPlan,
    resolveFfprobePath,
    getVideoResolution,
    selectCoverPreferredTime,
    cleanupTemporaryCoverSource,
    runFfmpeg,
    cutClipMedia,
    generateClipCover,
    generateTopicClips,
    notifyTopicClipResults,
    notifyTopicClipFailure,
    buildTopicNotifyMarkdown,
    buildTopicReviewMarkdown,
    collectTopicFailures,
    splitWeChatMarkdown,
    formatClock,
    calculateSubtitleStyle,
    sanitizeFileName,
    loadAsrSpeakerSidecarForMediaPath,
    buildParticipantMetadata
};
