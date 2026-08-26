const fs = require('fs');
const path = require('path');
const { postProcessAiClipMetadata } = require('./ai_clip_metadata');
const { spawn } = require('child_process');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
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

const AUDIO_EXTENSIONS = new Set(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.flv', '.mkv', '.ts', '.mov']);

/**
 * AI 验证:判断关键词匹配是否为真正的提到/谈论目标人物。
 * 过滤掉唱歌、哼旋律、ASR 误识别等造成的假命中。
 */
async function verifyClipWithAI(window, keywords, config = {}) {
    const aiEnabled = config.ai?.text?.enabled !== false;
    const verifyEnabled = config.clipTopics?.aiVerify !== false; // default true
    if (!aiEnabled || !verifyEnabled) {
        return { verified: true, reason: 'AI验证未启用,默认通过' };
    }

    // Collect all segment texts in the window
    const sampleText = window.matchSegments
        ? window.matchSegments.map(m => m.text).join('\n')
        : '';

    // Also get broader context from all segments in the window
    const fullText = (window.allSegmentTexts || []).join('\n');

    if (!sampleText && !fullText) {
        return { verified: false, reason: '无字幕内容' };
    }

    const keywordList = (keywords || []).join('、') || '岁己';

    const prompt = [
        '你是一个直播字幕审核助手。以下是一段直播字幕片段,其中 ASR(语音识别)在部分句子里检测到了关键词。',
        '但 ASR 常常在以下情况产生误识别:',
        '- 主播在唱歌或哼旋律时,歌词被误识别为包含关键词',
        '- 日文/英文歌词被错误识别为中文并凑巧包含关键词',
        '- 语速快或含糊时的发音被错误识别',
        '- 感谢观众礼物时的乱码碰巧包含关键词',
        '',
        `关键词: ${keywordList}`,
        '请判断:这段字幕是否真的在**提到或谈论**关键词所指的虚拟主播?',
        '',
        '判断标准:',
        '- 主播明确说出该主播的名字(如"给你们看岁己"、"岁己今天直播了吗")→ 是',
        '- 主播在唱歌,歌词碰巧被识别为包含关键词 → 否',
        '- 上下文完全不涉及该主播,只是发音相似 → 否',
        '- 游戏道具"粉碎机"被音素纠正写成"粉岁己/粉粉岁己"(采石场/升级/石头/研磨等语境) → 否',
        '- 感谢礼物时的乱码碰巧包含关键词 → 否',
        '',
        '请只回复 JSON:{"verified": true/false, "reason": "一句话解释"}',
        '不要输出其他内容。',
        '',
        '命中关键词的句子:',
        sampleText || '(无)',
        '',
        '完整上下文:',
        (fullText || sampleText).slice(0, 500)
    ].join('\n');

    try {
        const provider = config.ai?.text?.provider || 'gemini';
        const aiTextGenerator = require('./ai_text_generator');
        // Use the existing AI infrastructure
        const { generateTextWithTuZi, generateTextWithGemini, generateTextWithDaiYu } = require('./ai_text_generator');
        const result = provider === 'tuZi'
            ? await generateTextWithTuZi(prompt, {
                wordLimit: 100,
                primaryModel: getTopicClipAiModel(config)
            })
            : provider === 'daiYu'
            ? await generateTextWithDaiYu(prompt, {
                wordLimit: 100,
                primaryModel: getTopicClipAiModel(config)
            })
            : await generateTextWithGemini(prompt, { wordLimit: 100 });

        const text = (result.text || '').trim();
        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                verified: !!parsed.verified,
                reason: parsed.reason || '',
                model: result.meta?.model || getTopicClipAiModel(config)
            };
        }
        // If can't parse, be conservative and keep the clip
        return {
            verified: true,
            reason: 'AI响应解析失败,保留切片',
            model: result.meta?.model || getTopicClipAiModel(config)
        };
    } catch (error) {
        console.warn(`⚠️  AI验证失败,保留切片: ${error.message}`);
        return { verified: true, reason: `AI调用失败: ${error.message}`, model: getTopicClipAiModel(config) };
    }
}

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

function normalizeKeywords(keywords = []) {
    return Array.from(new Set(
        keywords
            .map(keyword => String(keyword || '').trim())
            .filter(Boolean)
    ));
}

function isAsciiWordChar(char) {
    return Boolean(char && /[A-Za-z0-9_]/.test(char));
}

function isKeywordOccurrenceAllowed(text, keyword, index) {
    const before = text[index - 1] || '';
    const after = text[index + keyword.length] || '';

    // Avoid matching Latin keywords inside longer IDs/usernames, e.g. SUI in SUICA.
    if (/^[A-Za-z0-9_]+$/.test(keyword)) {
        return !isAsciiWordChar(before) && !isAsciiWordChar(after);
    }

    // "小岁" is often hit inside unrelated names like "小小岁"; require the
    // occurrence not to be immediately prefixed by another "小".
    if (keyword === '小岁' && before === '小') {
        return false;
    }

    // PhonemeCorrector can rewrite game item "粉碎机" -> "粉岁己" / "粉粉岁己".
    // Block "岁己" when immediately preceded by "粉".
    if (keyword === '岁己' && before === '粉') {
        return false;
    }

    return true;
}

function containsTopicKeyword(text, keyword) {
    let fromIndex = 0;
    while (fromIndex <= text.length - keyword.length) {
        const index = text.indexOf(keyword, fromIndex);
        if (index === -1) {
            return false;
        }
        if (isKeywordOccurrenceAllowed(text, keyword, index)) {
            return true;
        }
        fromIndex = index + 1;
    }
    return false;
}

function isLowSignalTopicHit(text) {
    return /谢谢|谢|感谢|灯牌|粉丝团|人气票|礼物|舰长|上舰|提督|总督|\bID\b|昵称/i.test(text);
}

function findKeywordMatches(segments = [], keywords = []) {
    const normalizedKeywords = normalizeKeywords(keywords);
    if (normalizedKeywords.length === 0) {
        return [];
    }
    return segments
        .map((segment, index) => {
            const text = String(segment.text || '');
            if (isLowSignalTopicHit(text)) {
                return null;
            }
            const matchedKeywords = normalizedKeywords.filter(keyword => containsTopicKeyword(text, keyword));
            if (matchedKeywords.length === 0) {
                return null;
            }
            return {
                index,
                segment,
                matchedKeywords
            };
        })
        .filter(Boolean);
}

function clamp(value, min, max = Number.POSITIVE_INFINITY) {
    return Math.min(Math.max(value, min), max);
}

function buildClipWindows(segments = [], matches = [], options = {}) {
    const prePadding = Math.max(0, Number(options.prePaddingSeconds) || 0);
    const postPadding = Math.max(0, Number(options.postPaddingSeconds) || 0);
    const mergeGap = Math.max(0, Number(options.mergeGapSeconds) || 0);
    const maxClipSeconds = Math.max(1, Number(options.maxClipSeconds) || DEFAULT_CLIP_TOPICS_CONFIG.maxClipSeconds);
    const totalDuration = Number.isFinite(Number(options.totalDurationSeconds))
        ? Math.max(0, Number(options.totalDurationSeconds))
        : Number.POSITIVE_INFINITY;

    const rawWindows = matches
        .map(match => {
            const start = Number(match.segment.start);
            const end = Number(match.segment.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                return null;
            }
            return {
                start: clamp(start - prePadding, 0, totalDuration),
                end: clamp(end + postPadding, 0, totalDuration),
                matches: [match],
                keywords: new Set(match.matchedKeywords)
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const current of rawWindows) {
        const last = merged[merged.length - 1];
        if (!last) {
            merged.push(current);
            continue;
        }

        const candidateEnd = Math.max(last.end, current.end);
        const candidateDuration = candidateEnd - last.start;
        if (current.start - last.end <= mergeGap && candidateDuration <= maxClipSeconds) {
            last.end = candidateEnd;
            last.matches.push(...current.matches);
            current.keywords.forEach(keyword => last.keywords.add(keyword));
            continue;
        }

        merged.push(current);
    }

    return merged.map((window, index) => {
        const end = Math.min(window.end, window.start + maxClipSeconds);
        return {
            index: index + 1,
            start: Number(window.start.toFixed(3)),
            end: Number(end.toFixed(3)),
            duration: Number((end - window.start).toFixed(3)),
            matchedKeywords: Array.from(window.keywords),
            matchCount: window.matches.length,
            matchSegments: window.matches.map(match => ({
                index: match.index,
                start: match.segment.start,
                end: match.segment.end,
                text: match.segment.text,
                matchedKeywords: match.matchedKeywords
            }))
        };
    }).filter(window => window.duration > 0);
}

function getOverlappingSegments(segments = [], window) {
    return segments.filter(segment => {
        const start = Number(segment.start);
        const end = Number(segment.end);
        return Number.isFinite(start) && Number.isFinite(end) && end > window.start && start < window.end;
    });
}

/**
 * 将关键词命中点聚合成"话题爆发段"(topic burst),而非每个关键词切一个小窗口。
 *
 * 1. 相邻命中点(gap <= mergeGapSeconds)聚合为一个 burst
 * 2. 每个 burst 向前 3 分钟、向后 5 分钟扩展上下文(旧版 contextPaddingSeconds 仍兼容)
 * 3. 不密集时全部发送;过密时保留命中附近连续字幕,其余按时间均匀抽样
 */
function takeEvenly(items = [], count = 0) {
    if (count >= items.length) return [...items];
    if (count <= 0 || items.length === 0) return [];
    if (count === 1) return [items[Math.floor(items.length / 2)]];
    return Array.from({ length: count }, (_, index) => {
        const position = Math.min(
            items.length - 1,
            Math.floor(((index + 0.5) * items.length) / count)
        );
        return items[position];
    });
}

function selectBurstContextSegments(candidateSegments = [], matches = [], maxSegments = 200, focusPaddingSeconds = 45) {
    if (candidateSegments.length <= maxSegments) {
        return {
            segments: candidateSegments,
            sampled: false,
            candidateCount: candidateSegments.length
        };
    }

    const matchKeys = new Set(matches.map(match => segmentKey(match.segment)));
    const hitIndexes = candidateSegments
        .map((segment, segmentIndex) => matchKeys.has(segmentKey(segment)) ? segmentIndex : -1)
        .filter(segmentIndex => segmentIndex >= 0);
    const matchedSegments = matches
        .map(match => normalizeBoundarySegment(match.segment))
        .filter(Boolean);
    const firstMatchStart = matchedSegments.length > 0
        ? Math.min(...matchedSegments.map(segment => segment.start))
        : Number(candidateSegments[Math.floor(candidateSegments.length / 2)]?.start || 0);
    const lastMatchEnd = matchedSegments.length > 0
        ? Math.max(...matchedSegments.map(segment => segment.end))
        : firstMatchStart;
    const focusStart = firstMatchStart - focusPaddingSeconds;
    const focusEnd = lastMatchEnd + focusPaddingSeconds;
    const focusIndexes = candidateSegments
        .map((segment, segmentIndex) => {
            const start = Number(segment.start);
            const end = Number(segment.end);
            return end > focusStart && start < focusEnd ? segmentIndex : -1;
        })
        .filter(segmentIndex => segmentIndex >= 0);

    // 保留命中行和命中点附近的连续字幕，剩余名额从整个 8 分钟范围均匀抽样。
    const mustKeep = new Set([...hitIndexes, ...focusIndexes]);
    const selected = new Set();
    hitIndexes.forEach(index => selected.add(index));

    const focusNonHitIndexes = focusIndexes.filter(index => !selected.has(index));
    const focusSlots = Math.max(0, Math.min(
        maxSegments - selected.size,
        focusNonHitIndexes.length
    ));
    takeEvenly(focusNonHitIndexes, focusSlots).forEach(segment => {
        const index = candidateSegments.indexOf(segment);
        if (index >= 0) selected.add(index);
    });

    const remainingSlots = Math.max(0, maxSegments - selected.size);
    const remainingIndexes = candidateSegments
        .map((_, segmentIndex) => segmentIndex)
        .filter(segmentIndex => !mustKeep.has(segmentIndex) && !selected.has(segmentIndex));
    takeEvenly(remainingIndexes, remainingSlots).forEach(segmentIndex => selected.add(segmentIndex));

    // 极端情况下 mustKeep 本身超过上限，仍保证所有命中点优先，并从焦点区均匀截取。
    if (selected.size > maxSegments) {
        const priorityIndexes = [...new Set([...hitIndexes, ...focusIndexes])];
        const limited = new Set(hitIndexes);
        takeEvenly(priorityIndexes.filter(index => !limited.has(index)), maxSegments - limited.size)
            .forEach(index => limited.add(index));
        return {
            segments: candidateSegments.filter((_, index) => limited.has(index)),
            sampled: true,
            candidateCount: candidateSegments.length
        };
    }

    return {
        segments: candidateSegments.filter((_, index) => selected.has(index)),
        sampled: true,
        candidateCount: candidateSegments.length
    };
}

function buildTopicBursts(segments = [], matches = [], options = {}) {
    const legacyPadding = Number.isFinite(Number(options.contextPaddingSeconds))
        ? Math.max(0, Number(options.contextPaddingSeconds))
        : null;
    const contextPrePadding = Math.max(0, Number(
        options.contextPrePaddingSeconds
            ?? legacyPadding
            ?? DEFAULT_CLIP_TOPICS_CONFIG.contextPrePaddingSeconds
    ) || 0);
    const contextPostPadding = Math.max(0, Number(
        options.contextPostPaddingSeconds
            ?? legacyPadding
            ?? DEFAULT_CLIP_TOPICS_CONFIG.contextPostPaddingSeconds
    ) || 0);
    const mergeGap = Math.max(0, Number(options.mergeGapSeconds) || 120);
    const maxSegments = Math.max(1, Number(options.maxSegmentsPerBurst) || DEFAULT_CLIP_TOPICS_CONFIG.maxSegmentsPerBurst);
    const minClipSeconds = Math.max(0, Number(options.minClipSeconds) || DEFAULT_CLIP_TOPICS_CONFIG.minClipSeconds);
    const boundaryEndExtensionSeconds = Math.max(0, Number(options.boundaryEndExtensionSeconds) || DEFAULT_CLIP_TOPICS_CONFIG.boundaryEndExtensionSeconds);
    const boundarySilenceGapSeconds = Math.max(0, Number(options.boundarySilenceGapSeconds) || DEFAULT_CLIP_TOPICS_CONFIG.boundarySilenceGapSeconds);
    const maxClipSeconds = Math.max(1, Number(options.maxClipSeconds) || DEFAULT_CLIP_TOPICS_CONFIG.maxClipSeconds);
    const totalDuration = Number.isFinite(Number(options.totalDurationSeconds))
        ? Math.max(0, Number(options.totalDurationSeconds))
        : Number.POSITIVE_INFINITY;

    if (matches.length === 0) return [];

    // 1. 按时间排序,聚合相邻命中为 burst
    const sorted = [...matches].sort((a, b) =>
        Number(a.segment.start) - Number(b.segment.start));

    const rawBursts = [];
    for (const match of sorted) {
        const mStart = Number(match.segment.start);
        const mEnd = Number(match.segment.end);

        const last = rawBursts[rawBursts.length - 1];
        if (last && mStart - last.matchEnd <= mergeGap) {
            // 续到上一个 burst
            last.matchEnd = Math.max(last.matchEnd, mEnd);
            last.matches.push(match);
            match.matchedKeywords.forEach(keyword => last.keywords.add(keyword));
        } else {
            rawBursts.push({
                matchStart: mStart,
                matchEnd: mEnd,
                matches: [match],
                keywords: new Set(match.matchedKeywords)
            });
        }
    }

    // 2. 每个 burst 向两端扩展,收集全部上下文
    return rawBursts.map((b, idx) => {
        const start = clamp(b.matchStart - contextPrePadding, 0, totalDuration);
        const end = clamp(b.matchEnd + contextPostPadding, 0, totalDuration);

        // 扩展范围内全部 SRT segment。超过上限时围绕命中点取样，不能只取窗口开头，
        // 否则关键词靠近上下文尾部时，AI 会根本看不到话题后半段。
        const candidateSegments = segments
            .filter(s => {
                const sStart = Number(s.start);
                const sEnd = Number(s.end);
                return Number.isFinite(sStart) && Number.isFinite(sEnd)
                    && sEnd > start && sStart < end;
            });
        const selectedContext = selectBurstContextSegments(
            candidateSegments,
            b.matches,
            maxSegments
        );
        const allSegs = selectedContext.segments;

        // 前/后额外上下文(供 AI 理解,超出扩展窗口的)
        const preCtx = segments
            .filter(s => Number(s.end) <= start && Number(s.end) >= start - 120)
            .map(s => s.text)
            .slice(-15);
        const postCtx = segments
            .filter(s => Number(s.start) >= end && Number(s.start) <= end + 120)
            .map(s => s.text)
            .slice(0, 15);

        return {
            index: idx + 1,
            matchStart: b.matchStart,
            matchEnd: b.matchEnd,
            start,
            end,
            duration: end - start,
            contextPrePaddingSeconds: contextPrePadding,
            contextPostPaddingSeconds: contextPostPadding,
            contextSampled: selectedContext.sampled,
            contextCandidateCount: selectedContext.candidateCount,
            minClipSeconds,
            boundaryEndExtensionSeconds,
            boundarySilenceGapSeconds,
            maxClipSeconds,
            matchedKeywords: Array.from(b.keywords),
            matchCount: b.matches.length,
            matchSegments: b.matches.map(m => ({
                index: m.index,
                start: m.segment.start,
                end: m.segment.end,
                text: m.segment.text,
                matchedKeywords: m.matchedKeywords
            })),
            boundarySegments: candidateSegments,
            allSegments: allSegs,
            allSegmentTexts: allSegs.map(s => s.text),
            preContext: preCtx,
            postContext: postCtx
        };
    }).filter(b => b.duration > 0);
}

function normalizeBoundarySegment(segment) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
    }
    return {
        start,
        end,
        text: String(segment?.text || '').trim()
    };
}

function isLikelyIncompleteSubtitle(text) {
    const normalized = String(text || '').replace(/\s+/g, '').trim();
    if (!normalized) return true;

    // ASR 经常把一句话拆成“里面 / 然后呢 / 要不要”这样的片段。
    // 这些词即使带了“呢”，也通常不是故事的真正收束点。
    if (/(?:然后(?:呢)?|就是|里面|因为|所以|但是|可是|如果|以及|还有|要不要|要是|在|跟|和|把|从|到|等)$/.test(normalized)) {
        return true;
    }

    return !/[。！？!?；;…]$/.test(normalized)
        && !/[吗呢呀吧呗哦喔啊啦嘛]$/.test(normalized);
}

function extendAiClipEndToBoundary(start, end, burst, options = {}) {
    const sourceSegments = Array.isArray(burst?.boundarySegments)
        ? burst.boundarySegments
        : (Array.isArray(burst?.allSegments) ? burst.allSegments : []);
    const boundarySegments = sourceSegments
        .map(normalizeBoundarySegment)
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);
    if (boundarySegments.length === 0) {
        return end;
    }

    const minimumDuration = Math.max(0, Number(
        options.minClipSeconds ?? burst.minClipSeconds ?? DEFAULT_CLIP_TOPICS_CONFIG.minClipSeconds
    ) || 0);
    const maxExtension = Math.max(0, Number(
        options.boundaryEndExtensionSeconds
            ?? burst.boundaryEndExtensionSeconds
            ?? DEFAULT_CLIP_TOPICS_CONFIG.boundaryEndExtensionSeconds
    ) || 0);
    const silenceGap = Math.max(0, Number(
        options.boundarySilenceGapSeconds
            ?? burst.boundarySilenceGapSeconds
            ?? DEFAULT_CLIP_TOPICS_CONFIG.boundarySilenceGapSeconds
    ) || 0);
    const maxClipSeconds = Math.max(1, Number(
        options.maxClipSeconds ?? burst.maxClipSeconds ?? DEFAULT_CLIP_TOPICS_CONFIG.maxClipSeconds
    ) || DEFAULT_CLIP_TOPICS_CONFIG.maxClipSeconds);
    const burstEnd = Number.isFinite(Number(burst.end)) ? Number(burst.end) : end;
    const maxEnd = Math.min(
        burstEnd,
        start + maxClipSeconds,
        end + maxExtension
    );

    let adjustedEnd = Math.min(end, maxEnd);
    let tailIndex = -1;
    for (let index = 0; index < boundarySegments.length; index += 1) {
        const segment = boundarySegments[index];
        if (segment.start <= adjustedEnd + 0.25 && segment.end >= adjustedEnd - 0.25) {
            adjustedEnd = Math.max(adjustedEnd, Math.min(segment.end, maxEnd));
            tailIndex = index;
        } else if (segment.end <= adjustedEnd + 0.25) {
            tailIndex = index;
        }
    }

    let tail = tailIndex >= 0 ? boundarySegments[tailIndex] : null;
    let nextIndex = tailIndex + 1;
    while (nextIndex < boundarySegments.length && boundarySegments[nextIndex].start <= adjustedEnd + 0.25) {
        nextIndex += 1;
    }

    // 先保证不会出现提示词要求的“不到 30 秒”短片；再处理落在半句话上的结尾。
    while (nextIndex < boundarySegments.length) {
        const needsMinimumDuration = adjustedEnd - start < minimumDuration;
        const needsSentenceCompletion = tail ? isLikelyIncompleteSubtitle(tail.text) : true;
        if (!needsMinimumDuration && !needsSentenceCompletion) {
            break;
        }

        const next = boundarySegments[nextIndex];
        const gap = Math.max(0, next.start - adjustedEnd);
        const withinExtension = next.end <= maxEnd + 0.25;
        if (!withinExtension) break;
        // 已经达到最低时长后，明显的停顿视为话题边界；最低时长阶段允许跨过一次短停顿，
        // 以免把连续故事截在 ASR 的分段空隙上。
        if (!needsMinimumDuration && gap > silenceGap) break;

        adjustedEnd = Math.min(next.end, maxEnd);
        tail = next;
        nextIndex += 1;
    }

    return Number(adjustedEnd.toFixed(3));
}

function normalizeAiClipSelection(clip, burst, sliceIndex = 1, options = {}) {
    const clipStart = timeStringToSeconds(clip.startTime);
    const clipEnd = timeStringToSeconds(clip.endTime);
    if (isNaN(clipStart) || isNaN(clipEnd) || clipEnd <= clipStart) {
        return null;
    }

    const start = clamp(clipStart, burst.start, burst.end);
    const normalizedEnd = clamp(clipEnd, burst.start, burst.end);
    const end = extendAiClipEndToBoundary(start, normalizedEnd, burst, options);
    if (end <= start) {
        return null;
    }

    const containsMatchedSegment = (burst.matchSegments || []).some(match => {
        const matchStart = Number(match.start);
        const matchEnd = Number(match.end);
        return Number.isFinite(matchStart)
            && Number.isFinite(matchEnd)
            && matchEnd >= start - 2
            && matchStart <= end + 2;
    });

    if (!containsMatchedSegment) {
        return null;
    }

    return {
        start,
        end,
        aiTitle: clip.title || null,
        aiCoverText: clip.coverText || null,
        aiDescription: clip.description || null,
        aiModel: clip.aiModel || null,
        boundaryAdjusted: end > normalizedEnd,
        sliceIndex
    };
}

function getClipWindowBounds(clip) {
    const start = Number(clip?.window?.start);
    const end = Number(clip?.window?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
    }
    return { start, end, duration: end - start };
}

function normalizeTopicMatchText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\s，。！？!?；;、,.：:“”‘’「」『』（）()【】\[\]…]+/g, '')
        .trim();
}

function getClipBurstIndex(clip) {
    const burstIndex = clip?.burst?.index;
    return burstIndex === undefined || burstIndex === null ? null : String(burstIndex);
}

function hasSameTopicMatchText(first, second) {
    const firstTexts = new Set((first?.window?.matchSegments || [])
        .map(segment => normalizeTopicMatchText(segment?.text))
        .filter(Boolean));
    if (firstTexts.size === 0) return false;
    return (second?.window?.matchSegments || [])
        .some(segment => firstTexts.has(normalizeTopicMatchText(segment?.text)));
}

function areDuplicateClipWindows(first, second, options = {}) {
    const firstBounds = getClipWindowBounds(first);
    const secondBounds = getClipWindowBounds(second);
    if (!firstBounds || !secondBounds) {
        return false;
    }

    const sameStartTolerance = Math.max(0, Number(options.sameStartToleranceSeconds ?? 1));
    if (Math.abs(firstBounds.start - secondBounds.start) <= sameStartTolerance) {
        return true;
    }

    // 同一 burst 内同一句关键词命中被 AI 拆成多个不重叠区间时，仍视为同一事件。
    const firstBurstIndex = getClipBurstIndex(first);
    const secondBurstIndex = getClipBurstIndex(second);
    if (firstBurstIndex !== null
        && firstBurstIndex === secondBurstIndex
        && hasSameTopicMatchText(first, second)) {
        return true;
    }

    const overlap = Math.max(
        0,
        Math.min(firstBounds.end, secondBounds.end) - Math.max(firstBounds.start, secondBounds.start)
    );
    const shorterDuration = Math.min(firstBounds.duration, secondBounds.duration);
    const overlapRatio = shorterDuration > 0 ? overlap / shorterDuration : 0;
    const duplicateOverlapRatio = Math.min(1, Math.max(0, Number(
        options.duplicateOverlapRatio ?? 0.5
    )));
    return overlapRatio >= duplicateOverlapRatio;
}

function compareClipQuality(first, second) {
    const firstBounds = getClipWindowBounds(first);
    const secondBounds = getClipWindowBounds(second);
    if (!firstBounds || !secondBounds) return 0;

    // 重叠切片中保留覆盖更完整的一段；同样长时保留先进入候选列表的那段。
    return firstBounds.duration - secondBounds.duration;
}

function dedupeClipsByStart(clips = [], options = {}) {
    const groups = [];
    const passthrough = [];

    for (const clip of clips) {
        if (!getClipWindowBounds(clip)) {
            passthrough.push(clip);
            continue;
        }

        // AI 可能从同一事件返回不同起点的嵌套/高度重叠区间，不能只按 start 去重。
        const group = groups.find(candidate => candidate.some(existing =>
            areDuplicateClipWindows(existing, clip, options)
        ));
        if (group) {
            group.push(clip);
        } else {
            groups.push([clip]);
        }
    }

    const deduped = groups.map(group => group.reduce((best, candidate) =>
        compareClipQuality(candidate, best) > 0 ? candidate : best
    ));

    return [...passthrough, ...deduped]
        .sort((a, b) => {
            const startA = Number(a.window?.start);
            const startB = Number(b.window?.start);
            const endA = Number(a.window?.end);
            const endB = Number(b.window?.end);
            return (Number.isFinite(startA) ? startA : 0) - (Number.isFinite(startB) ? startB : 0)
                || (Number.isFinite(endA) ? endA : 0) - (Number.isFinite(endB) ? endB : 0);
        });
}

function buildFallbackAiClipSelection(burst) {
    const clip = normalizeAiClipSelection({
        startTime: formatClock(Number(burst.matchStart) || Number(burst.start) || 0),
        endTime: formatClock(Number(burst.matchEnd) || Number(burst.end) || 0)
    }, burst, 1);
    return clip ? [clip] : [{
        start: burst.matchStart,
        end: burst.matchEnd,
        aiModel: null
    }];
}

function buildTopicBurstPrompt(burst, streamerName, info = {}, generateText) {
    const srtLines = (burst.allSegments || []).map(s => {
        const t = formatClock(Number(s.start));
        const txt = String(s.text || '').trim();
        // 标记哪些包含关键词
        const isHit = (burst.matchSegments || []).some(
            m => m.start === s.start && m.end === s.end
        );
        const prefix = isHit ? '★' : ' ';
        return `${prefix} ${t} | ${txt}`;
    }).join('\n');

    const keywordStr = (burst.matchedKeywords || []).join('、');
    const contextNotice = burst.contextSampled
        ? `候选范围原本有 ${burst.contextCandidateCount} 条字幕,下面保留命中附近连续字幕,其余按时间均匀抽样到 ${burst.allSegments.length} 条;时间戳仍是原始时间,中间可能省略了字幕。`
        : `候选范围共有 ${burst.contextCandidateCount || burst.allSegments.length} 条字幕,下面全部列出。`;
    const titlePromptLines = typeof generateText?.buildClipTitlePromptLines === 'function'
        ? generateText.buildClipTitlePromptLines({ outputMode: 'jsonTitle', streamerName })
        : [];
    const coverPromptLines = typeof generateText?.buildCoverTextPromptLines === 'function'
        ? generateText.buildCoverTextPromptLines()
        : [];
    const descriptionPromptLines = typeof generateText?.buildClipDescriptionPromptLines === 'function'
        ? generateText.buildClipDescriptionPromptLines()
        : [];

    return [
        '你是一个直播切片编辑。下面是一段直播字幕(带时间戳),主播在聊的话题中提到了"岁己"(关键词:' + keywordStr + ')。',
        contextNotice,
        '',
        '标记 ★ 的行是 ASR 命中关键词的地方。请根据上下文理解对话内容,找出真正在讨论/提到岁己的连续段落。',
        '',
        '你需要决定切片的起止时间(HH:MM:SS 格式),精确到秒即可,要切在句子边界上。',
        '注意:',
        `- 选取的区间不要超过 ${Math.round(Number(burst.maxClipSeconds || DEFAULT_CLIP_TOPICS_CONFIG.maxClipSeconds) / 60)} 分钟,太长观众看不完。最短不少于 ${burst.minClipSeconds || DEFAULT_CLIP_TOPICS_CONFIG.minClipSeconds} 秒,太短的切片没有观看价值。`,
        '- 默认只返回 1 段。只有存在 2-3 个完全独立、各自完整且有独立命中锚点的事件时才返回多段。',
        '- 多段切片的时间区间必须互不重叠，不能一段包含另一段，也不能只是同一事件的不同起止时间。',
        '- 如果同一件事被重复提到，或多个命中行属于同一轮对话，只返回覆盖完整事件的 1 段。',
        '- 如果整段不超过 2 分钟或话题连贯，只返回 1 段。不要为了凑数拆分。',
        '- 关键词命中行只是话题锚点,不是切片终点。必须把命中前后的完整叙述、提问和回应一起保留。',
        '- 绝对不要在“然后/然后呢/里面/就是/因为/但是/要不要”等明显未完的词后结束。',
        '- 如果最后一行像半句话,继续查看后面的字幕,直到一句话或一轮对话自然收束；宁可多保留几秒,也不要截断。',
        '- 起止时间要覆盖实际字幕行,结束时间至少落在最后一句字幕的 end 之后。',
        '- 如果命中的行实际是唱歌、哼旋律、ASR 误识别,返回空 clips: []。',
        '- 特别注意:游戏里的"粉碎机"常被音素纠正错写成"粉岁己/粉粉岁己"。若上下文是采石场、升级、石头、研磨、木材等建造/生产内容,而不是在谈论虚拟主播岁己,视为误识别,返回空 clips: []。',
        '- ASR 可能有同音错字(如"开开"≈"栞栞"),要根据语境推断正确含义。',
        '- 前后扩展上下文只用于理解语境和决定切片边界,不属于最终切片内容。',
        '- 标题、封面文案、简介必须只根据最终选中的 startTime-endTime 区间内实际字幕生成;最多参考前后各 10 秒来补全指代,不得把区间外的事件、弹幕或说法写进文案。',
        '- 输出前逐项核对标题、封面文案和简介中的每个具体事实都能在最终区间字幕中找到;找不到就删除或改写。',
        '',
        '输出一个 JSON 对象(不要 Markdown 代码块,纯 JSON)。输出前再次检查：每段都是独立事件、区间不重叠、没有重复/嵌套切片。',
        '{',
        '  "clips": [',
        '    { "startTime": "HH:MM:SS", "endTime": "HH:MM:SS", "title": "标题", "coverText": "第一行\\n第二行", "description": "简介" }',
        '  ]',
        '}',
        '',
        ...titlePromptLines,
        ...coverPromptLines,
        '',
        ...descriptionPromptLines,
        '',
        `主播: ${streamerName || '主播'}`,
        `直播标题: ${info.streamTitle || '未知'}`,
        `录制日期: ${info.recordedAt || '未知'}`,
        '',
        '=== 字幕 ===',
        srtLines.slice(0, 30000),  // 200句抽样后通常远低于此上限,防止异常 ASR 文本失控
    ].join('\n');
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

/**
 * 将 HH:MM:SS 或 HH:MM:SS.MSC 转为秒数
 */
function timeStringToSeconds(ts) {
    if (typeof ts !== 'string') return NaN;
    const parts = ts.split(':');
    if (parts.length !== 3) return NaN;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
    return h * 3600 + m * 60 + s;
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
    if (!isSpeakerReviewSrt) {
        return parsed;
    }

    return {
        ...parsed,
        segments: parsed.segments.map(segment => ({
            ...segment,
            ...parseSpeakerReviewText(segment.text)
        }))
    };
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

function formatClock(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

function normalizeCoverText(value) {
    const lines = String(value || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n/)
        .map(line => line.replace(/[【】]/g, '').replace(/\s+/g, '').trim())
        .filter(Boolean)
        .slice(0, 2);
    return lines.length >= 2 ? lines.join('\n') : '';
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
            windowsHide: true
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
        const ffprobePath = (ffmpegPath || 'ffmpeg').replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
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
            windowsHide: true
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

/**
 * 获取视频分辨率
 * @param {string} mediaPath
 * @returns {Promise<{width: number, height: number}>}
 */
async function getVideoResolution(mediaPath) {
    try {
        const { execSync } = require('child_process');
        const result = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${mediaPath}"`,
            { encoding: 'utf8', timeout: 10000 }
        ).trim();
        const [width, height] = result.split(',').map(Number);
        if (width > 0 && height > 0) return { width, height };
    } catch {
        // fallback
    }
    return { width: 1920, height: 1080 };
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
        const videoRes = await getVideoResolution(source.mediaPath);
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

async function sendWeChatMarkdown(webhookUrl, content) {
    if (!webhookUrl) {
        return false;
    }

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: toFwdSlash(content)
            }
        })
    });

    if (!response.ok) {
        throw new Error(`企业微信请求失败: HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.errcode !== 0) {
        throw new Error(`企业微信返回错误: ${result.errcode} ${result.errmsg || ''}`.trim());
    }

    return true;
}

function toFwdSlash(s) {
    return String(s || '').replace(/\\+/g, '/');
}

function compactNotifyText(text, maxLength = 80) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function segmentKey(segment = {}) {
    return `${Number(segment.start).toFixed(3)}-${Number(segment.end).toFixed(3)}`;
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

function splitWeChatMarkdown(content, maxLength = 4096) {
    const limit = Math.max(1, Math.floor(Number(maxLength) || 4096));
    const lines = String(content || '').split('\n');
    const chunks = [];
    let current = '';

    const byteLength = value => Buffer.byteLength(String(value || ''), 'utf8');
    const takeByBytes = value => {
        const text = String(value || '');
        let bytes = 0;
        let index = 0;
        while (index < text.length) {
            const codePoint = text.codePointAt(index);
            const char = String.fromCodePoint(codePoint);
            const charBytes = Buffer.byteLength(char, 'utf8');
            if (bytes + charBytes > limit) break;
            bytes += charBytes;
            index += char.length;
        }
        return [text.slice(0, index), text.slice(index)];
    };

    const flush = () => {
        if (current) {
            chunks.push(current);
            current = '';
        }
    };

    for (let line of lines) {
        while (byteLength(line) > limit) {
            const [head, tail] = takeByBytes(line);
            flush();
            if (!head) {
                throw new Error(`企微 Markdown 单字符超过 ${limit} bytes 限制`);
            }
            chunks.push(head);
            line = tail;
        }

        const next = current ? `${current}\n${line}` : line;
        if (byteLength(next) > limit) {
            flush();
        }
        current = current ? `${current}\n${line}` : line;
    }
    flush();
    return chunks.length ? chunks : [''];
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
    });
    if (uploadableResults.length === 0) {
        lines.push('- 无可上传切片');
    }
    if (localOnlyResults.length > 0) {
        lines.push('', '## 仅本地结果', '');
        localOnlyResults.forEach(result => {
            lines.push(`- ${result.copy?.title || '话题切片'} | ${formatClock(result.window?.start || 0)} | ${result.output?.mediaPath || ''}`);
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

function registerReviewForUpload(reviewPath, results, metadata) {
    if (!reviewPath || !results.length) return null;
    const source = `${metadata.streamerName || '主播'} 直播《${metadata.streamTitle || metadata.sourceFileName || '未知直播'}》${metadata.recordedAt || ''}`.trim();
    const tags = Array.isArray(results[0]?.copy?.tags) && results[0].copy.tags.length
        ? results[0].copy.tags.join(',')
        : '岁己,虚拟主播,直播切片,AI切片';
    const prefix = resolveUploadPrefix(metadata.config || {}, metadata.roomId, metadata.streamerName);
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
    let result;
    try {
        result = require('child_process').spawnSync('python', args, {
            cwd: path.dirname(path.dirname(__dirname)),
            encoding: 'utf8',
            windowsHide: true,
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
    const messages = splitWeChatMarkdown(markdown);
    for (const message of messages) {
        await sendWeChatMarkdown(webhookUrl, message);
    }
    return true;
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
    if (config.notify?.includeDanmakuContext !== false && options.xmlPath) {
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

    // AI 分段:对每个 burst 决定切 1-3 段
    const aiSegmentedClips = [];
    const aiModelsUsed = new Set();
    const failures = [];
    for (const burst of bursts) {
        try {
            console.log(`  🔍 [${formatClock(burst.matchStart)}] 命中 ${burst.matchCount} 次,上下文窗口 ${formatClock(burst.start)}-${formatClock(burst.end)} (${burst.allSegments.length}/${burst.contextCandidateCount} 条字幕${burst.contextSampled ? ',均匀抽样' : ''})`);

            const segments = await segmentBurstWithAI(burst, parsed, streamerName, info, aiConfig);

            if (segments.length === 0) {
                console.log(`  ⏭️  AI 判定跳过(可能是唱歌/误识别)`);
                continue;
            }

            for (const seg of segments) {
                if (seg.aiModel) {
                    aiModelsUsed.add(seg.aiModel);
                }
                const matchKeys = new Set((burst.matchSegments || []).map(segmentKey));
                const contextSegments = parsed.segments
                    .map((s, index) => ({
                        index,
                        start: s.start,
                        end: s.end,
                        text: s.text,
                        hit: matchKeys.has(segmentKey(s))
                    }))
                    .filter(s => Number(s.end) >= seg.start - 20 && Number(s.start) <= seg.end + 20);
                const clipMatchSegments = (burst.matchSegments || []).filter(match =>
                    Number(match.end) >= seg.start && Number(match.start) <= seg.end
                );
                // 构造一个兼容旧代码的 window 对象
                const w = {
                    index: `${burst.index}-${seg.sliceIndex || 1}`,
                    start: seg.start,
                    end: seg.end,
                    duration: seg.end - seg.start,
                    matchedKeywords: burst.matchedKeywords,
                    matchCount: burst.matchCount,
                    matchSegments: clipMatchSegments.length > 0 ? clipMatchSegments : burst.matchSegments,
                    contextSegments,
                    allSegmentTexts: parsed.segments
                        .filter(s => Number(s.start) >= seg.start - 5 && Number(s.end) <= seg.end + 5)
                        .map(s => s.text),
                    preContext: parsed.segments
                        .filter(s => Number(s.end) <= seg.start && Number(s.end) >= seg.start - 60)
                        .map(s => s.text).slice(-10),
                    postContext: parsed.segments
                        .filter(s => Number(s.start) >= seg.end && Number(s.start) <= seg.end + 60)
                        .map(s => s.text).slice(0, 10),
                };
                w.danmakuContext = buildDanmakuContextLines(danmaku, w, config.notify || {});
                aiSegmentedClips.push({
                    window: w,
                    burst,
                    aiTitle: seg.aiTitle,
                    aiCoverText: seg.aiCoverText,
                    aiDescription: seg.aiDescription,
                    aiModel: seg.aiModel || null,
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

    if (aiSegmentedClips.length === 0 && failures.length === 0) {
        console.log('i️  AI 分段后无有效切片');
        return [];
    }

    const clipsToGenerate = dedupeClipsByStart(aiSegmentedClips);
    if (clipsToGenerate.length < aiSegmentedClips.length) {
        console.log(`i️  已过滤 ${aiSegmentedClips.length - clipsToGenerate.length} 段重复/重叠切片`);
    }

    console.log(`\n🎬 共 ${clipsToGenerate.length} 段切片,开始生成视频...\n`);

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
                originalMediaPath: options.originalMediaPath || null,
                processedMediaPath: options.processedMediaPath || null
            },
            roomId: info.roomId,
            streamerName,
            participantInfo: participantMetadata,
            recordedAt: info.recordedAt,
            streamTitle: info.streamTitle,
            window,
            copy,
            ai: {
                segmentationModel: clip.aiModel || null,
                boundaryAdjusted: Boolean(clip.boundaryAdjusted),
                requestedModel: getTopicClipAiModel(options.config || {})
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
            srtResult = writeClipSrt(parsed.segments, window, srtPath, {
                maxCharsPerLine: config.subtitleMaxCharsPerLine ?? 18
            });
            stage = 'copy';
            // 优先用 AI 分段时生成的标题/简介,其次调用独立的标题/简介生成器
            const titleGen = clip.aiTitle
                ? async () => clip.aiTitle
                : options.titleGenerator;
            const descGen = clip.aiDescription
                ? async () => clip.aiDescription
                : options.descriptionGenerator;
            // 从 streamerRegistry 解析正式标签(如 米汀Nagisa)
            const registryTags = resolveStreamerTags(options.config || {}, info.roomId);
            const metadataConfig = { ...config, ai: options.config?.ai };
            copy = await buildClipCopy(window, info, streamerName, metadataConfig, titleGen, descGen, registryTags, clip.aiCoverText);

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
        failures
    };
    let reviewWritten = false;
    try {
        fs.writeFileSync(reviewPath, buildTopicReviewMarkdown(results, reviewMetadata), 'utf8');
        reviewWritten = true;
    } catch (error) {
        failures.push({ stage: 'review', error: error.message });
        console.warn(`⚠️  话题切片审核文件写入失败,继续发送结果通知: ${error.message}`);
    }

    const uploadableResults = results.filter(result => result?.uploadReady && !result?.output?.mediaError);
    let uploadRegistry = null;
    if (reviewWritten && uploadableResults.length > 0) {
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
