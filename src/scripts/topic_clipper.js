const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const asrBackends = require('./asr/asr_backends');

const DEFAULT_CLIP_TOPICS_CONFIG = {
    enabled: false,
    mode: 'local_review',
    keywords: ['岁己', '小岁', '小岁姐', '岁己姐', '饼干岁', 'SUI'],
    aiVerify: true,  // AI 验证：过滤唱歌/ASR误识别的假命中
    prePaddingSeconds: 20,
    postPaddingSeconds: 35,
    maxClipSeconds: 300,
    mergeGapSeconds: 120,
    contextPaddingSeconds: 300,  // AI 上下文窗口：关键词前后各拿5分钟
    maxSegmentsPerBurst: 100,     // 每个 burst 最多取多少条 SRT
    aiSegmentBurst: true,         // 让 AI 决定切在哪里（而不是固定 paddding）
    burnSubtitles: true,
    outputDirName: 'topic_clips',
    extraTags: [],
    autoUpload: {
        enabled: false
    },
    notify: {
        enabled: true
    }
};

const AUDIO_EXTENSIONS = new Set(['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.flv', '.mkv', '.ts', '.mov']);

/**
 * AI 验证：判断关键词匹配是否为真正的提到/谈论目标人物。
 * 过滤掉唱歌、哼旋律、ASR 误识别等造成的假命中。
 */
async function verifyClipWithAI(window, keywords, config = {}) {
    const aiEnabled = config.ai?.text?.enabled !== false;
    const verifyEnabled = config.clipTopics?.aiVerify !== false; // default true
    if (!aiEnabled || !verifyEnabled) {
        return { verified: true, reason: 'AI验证未启用，默认通过' };
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
        '你是一个直播字幕审核助手。以下是一段直播字幕片段，其中 ASR（语音识别）在部分句子里检测到了关键词。',
        '但 ASR 常常在以下情况产生误识别：',
        '- 主播在唱歌或哼旋律时，歌词被误识别为包含关键词',
        '- 日文/英文歌词被错误识别为中文并凑巧包含关键词',
        '- 语速快或含糊时的发音被错误识别',
        '- 感谢观众礼物时的乱码碰巧包含关键词',
        '',
        `关键词: ${keywordList}`,
        '请判断：这段字幕是否真的在**提到或谈论**关键词所指的虚拟主播？',
        '',
        '判断标准：',
        '- 主播明确说出该主播的名字（如"给你们看岁己"、"岁己今天直播了吗"）→ 是',
        '- 主播在唱歌，歌词碰巧被识别为包含关键词 → 否',
        '- 上下文完全不涉及该主播，只是发音相似 → 否',
        '- 感谢礼物时的乱码碰巧包含关键词 → 否',
        '',
        '请只回复 JSON：{"verified": true/false, "reason": "一句话解释"}',
        '不要输出其他内容。',
        '',
        '命中关键词的句子:',
        sampleText || '（无）',
        '',
        '完整上下文:',
        (fullText || sampleText).slice(0, 500)
    ].join('\n');

    try {
        const provider = config.ai?.text?.provider || 'gemini';
        const aiTextGenerator = require('./ai_text_generator');
        // Use the existing AI infrastructure
        const { generateTextWithTuZi, generateTextWithGemini } = require('./ai_text_generator');
        const result = provider === 'tuZi'
            ? await generateTextWithTuZi(prompt, { wordLimit: 100 })
            : await generateTextWithGemini(prompt, { wordLimit: 100 });

        const text = (result.text || '').trim();
        // Parse JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                verified: !!parsed.verified,
                reason: parsed.reason || ''
            };
        }
        // If can't parse, be conservative and keep the clip
        return { verified: true, reason: 'AI响应解析失败，保留切片' };
    } catch (error) {
        console.warn(`⚠️  AI验证失败，保留切片: ${error.message}`);
        return { verified: true, reason: `AI调用失败: ${error.message}` };
    }
}

function getClipTopicsConfig(config = {}) {
    const raw = config.clipTopics || {};
    return {
        ...DEFAULT_CLIP_TOPICS_CONFIG,
        ...raw,
        keywords: Array.isArray(raw.keywords) ? raw.keywords : DEFAULT_CLIP_TOPICS_CONFIG.keywords,
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

function findKeywordMatches(segments = [], keywords = []) {
    const normalizedKeywords = normalizeKeywords(keywords);
    if (normalizedKeywords.length === 0) {
        return [];
    }
    return segments
        .map((segment, index) => {
            const text = String(segment.text || '');
            const matchedKeywords = normalizedKeywords.filter(keyword => text.includes(keyword));
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
 * 将关键词命中点聚合成"话题爆发段"(topic burst)，而非每个关键词切一个小窗口。
 * 
 * 1. 相邻命中点（gap <= mergeGapSeconds）聚合为一个 burst
 * 2. 每个 burst 向两端扩展 contextPaddingSeconds（默认 5 分钟）
 * 3. 取该范围内全部 SRT 字幕供 AI 理解完整上下文
 */
function buildTopicBursts(segments = [], matches = [], options = {}) {
    const contextPadding = Math.max(0, Number(options.contextPaddingSeconds) || 300);
    const mergeGap = Math.max(0, Number(options.mergeGapSeconds) || 120);
    const maxSegments = Math.max(1, Number(options.maxSegmentsPerBurst) || 100);
    const totalDuration = Number.isFinite(Number(options.totalDurationSeconds))
        ? Math.max(0, Number(options.totalDurationSeconds))
        : Number.POSITIVE_INFINITY;

    if (matches.length === 0) return [];

    // 1. 按时间排序，聚合相邻命中为 burst
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
            last.keywords.add(match.matchedKeywords);
        } else {
            rawBursts.push({
                matchStart: mStart,
                matchEnd: mEnd,
                matches: [match],
                keywords: new Set([match.matchedKeywords])
            });
        }
    }

    // 2. 每个 burst 向两端扩展，收集全部上下文
    return rawBursts.map((b, idx) => {
        const start = clamp(b.matchStart - contextPadding, 0, totalDuration);
        const end = clamp(b.matchEnd + contextPadding, 0, totalDuration);

        // 扩展范围内全部 SRT segment（受 maxSegments 上限）
        const allSegs = segments
            .filter(s => {
                const sStart = Number(s.start);
                const sEnd = Number(s.end);
                return Number.isFinite(sStart) && Number.isFinite(sEnd)
                    && sEnd > start && sStart < end;
            })
            .slice(0, maxSegments);

        // 前/后额外上下文（供 AI 理解，超出扩展窗口的）
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
            matchedKeywords: Array.from(b.keywords),
            matchCount: b.matches.length,
            matchSegments: b.matches.map(m => ({
                index: m.index,
                start: m.segment.start,
                end: m.segment.end,
                text: m.segment.text,
                matchedKeywords: m.matchedKeywords
            })),
            allSegments: allSegs,
            allSegmentTexts: allSegs.map(s => s.text),
            preContext: preCtx,
            postContext: postCtx
        };
    }).filter(b => b.duration > 0);
}

/**
 * 把 burst 的全部字幕发给 AI，让 AI 自己决定切在哪。
 * AI 可以切成 1-3 段，并根据上下文生成每段的标题和简介。
 */
async function segmentBurstWithAI(burst, parsed, streamerName, info, config = {}) {
    const aiConfig = config;
    const textEnabled = aiConfig.ai?.text?.enabled !== false;
    const segmentEnabled = aiConfig.clipTopics?.aiSegmentBurst !== false;

    if (!textEnabled || !segmentEnabled) {
        // Fallback: 使用整个 burst 作为单个窗口
        return [{
            start: burst.matchStart,
            end: burst.matchEnd,
            // 用命中点附近 ±20s 作为 fallback
        }];
    }

    // 格式化 SRT 给 AI
    const srtLines = burst.allSegments.map(s => {
        const t = formatClock(Number(s.start));
        const txt = String(s.text || '').trim();
        // 标记哪些包含关键词
        const isHit = burst.matchSegments.some(
            m => m.start === s.start && m.end === s.end
        );
        const prefix = isHit ? '★' : ' ';
        return `${prefix} ${t} | ${txt}`;
    }).join('\n');

    const keywordStr = (burst.matchedKeywords || []).join('、');
    const prompt = [
        '你是一个直播切片编辑。下面是一段直播字幕（带时间戳），主播在聊的话题中提到了"岁己"（关键词：' + keywordStr + '）。',
        '',
        '标记 ★ 的行是 ASR 命中关键词的地方。请根据上下文理解对话内容，找出真正在讨论/提到岁己的连续段落。',
        '',
        '你需要决定切片的起止时间（HH:MM:SS 格式），精确到秒即可，要切在句子边界上。',
        '注意：',
        '- 选取的区间不要超过 3 分钟，太长观众看不完。最短不少于 30 秒，太短的切片没有观看价值。',
        '- 如果话题分成了几个明显独立的段落，可以切 2-3 段（每段分别给标题简介）。',
        '- 如果整段都不超过 2 分钟且话题连贯，切 1 段就好。',
        '- 如果命中的行实际是唱歌、哼旋律、ASR 误识别，返回空 clips: []。',
        '- ASR 可能有同音错字（如"开开"≈"栞栞"），要根据语境推断正确含义。',
        '',
        '输出一个 JSON 对象（不要 Markdown 代码块，纯 JSON）：',
        '{',
        '  "clips": [',
        '    { "startTime": "HH:MM:SS", "endTime": "HH:MM:SS", "title": "标题", "description": "简介" }',
        '  ]',
        '}',
        '',
        '标题要求：',
        '- 像人工编辑过的 B 站切片标题，抓具体冲突、反应和节目效果，而不是平铺直叙摘要',
        '- 18-42 字，最多 52 字；可以稍长一点换取信息量',
        '- 优先使用主播原话、弹幕反应、游戏/事件名，形成“具体事件 + 反应/槽点”的结构',
        '- 可以写主播名 + 冒号，但不要为了格式牺牲点击点',
        '- 不要加引号、不要"【"开头',
        '- 不要用“提到岁己的小片段”“直播有趣片段”“聊到了XX”这种弱标题',
        '人工标题参考风格：',
        '- 第二次复活怎么还往回走，弹幕急死了，路痴实锤',
        '- 蚊子式刮痧打剑盾大怪，怪都睡着了',
        '- 妈妈突然进房间，赶紧把电脑画面切到桌面',
        '- 弹幕突然聊戒色，岁己当场社死',
        '- 三斤小龙虾算减肥？这逻辑没法反驳',
        '',
        '简介要求：',
        '- 一句话说清主播聊了什么（50字内）',
        '- 口语化自然',
        '',
        `主播: ${streamerName || '主播'}`,
        `直播标题: ${info.streamTitle || '未知'}`,
        `录制日期: ${info.recordedAt || '未知'}`,
        '',
        '=== 字幕 ===',
        srtLines.slice(0, 12000),  // 限制总字数
    ].join('\n');

    // 调用 AI
    const generateText = require('./ai_text_generator');
    const provider = aiConfig.ai?.text?.provider || 'gemini';
    let result;
    try {
        result = provider === 'tuZi'
            ? await generateText.generateTextWithTuZi(prompt, { wordLimit: 600 })
            : await generateText.generateTextWithGemini(prompt, { wordLimit: 600 });
    } catch (error) {
        console.warn(`⚠️  AI burst 分段失败，退回整个 burst: ${error.message}`);
        return [{
            start: burst.matchStart,
            end: burst.matchEnd
        }];
    }

    // 解析 AI 返回的 JSON
    try {
        const text = (result.text || '').trim();
        // 尝试提取 JSON（AI 有时用代码块包裹）
        const jsonMatch = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('⚠️  AI 未返回有效 JSON，退回整个 burst');
            console.warn(`   原始返回: ${text.slice(0, 200)}`);
            return [{ start: burst.matchStart, end: burst.matchEnd }];
        }
        
        const parsed = JSON.parse(jsonMatch[0]);
        const clips = (parsed.clips || []).filter(c => c.startTime && c.endTime);
        
        if (clips.length === 0) {
            console.log(`  ℹ️   [${formatClock(burst.matchStart)}] AI 判定无需切片（可能是唱歌/误识别）`);
            return [];
        }
        
        // 转换时间戳 → 秒数，返回带标题/简介的信息
        return clips.map((clip, ci) => {
            const clipStart = timeStringToSeconds(clip.startTime);
            const clipEnd = timeStringToSeconds(clip.endTime);
            if (isNaN(clipStart) || isNaN(clipEnd) || clipEnd <= clipStart) {
                return null;
            }
            return {
                start: clamp(clipStart, burst.start, burst.end),
                end: clamp(clipEnd, burst.start, burst.end),
                aiTitle: clip.title || null,
                aiDescription: clip.description || null,
                sliceIndex: ci + 1
            };
        }).filter(Boolean);
    } catch (parseError) {
        console.warn(`⚠️  解析 AI 分段结果失败: ${parseError.message}`);
        console.warn(`   原始返回: ${result.text?.slice(0, 200)}`);
        return [{ start: burst.matchStart, end: burst.matchEnd }];
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

function writeClipSrt(segments = [], window, outputPath) {
    const lines = [];
    const clipSegments = getOverlappingSegments(segments, window);
    let lineIndex = 1;

    for (const segment of clipSegments) {
        const start = clamp(Number(segment.start) - window.start, 0, window.duration);
        const end = clamp(Number(segment.end) - window.start, 0, window.duration);
        const text = String(segment.text || '').trim();
        if (!text || end <= start) {
            continue;
        }
        lines.push(String(lineIndex));
        lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
        lines.push(text);
        lines.push('');
        lineIndex += 1;
    }

    fs.writeFileSync(outputPath, `${lines.join('\n').trim()}\n`, 'utf8');
    return {
        path: outputPath,
        segmentCount: lineIndex - 1
    };
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
 * 根据 roomId 从 streamerRegistry 解析主播的正式标签（用于 B站投稿 tag）
 * 返回 searchTags（如有）或 displayName + speakerLabels。
 */
function resolveStreamerTags(config = {}, roomId = null) {
    const roomKey = roomId ? String(roomId) : null;
    if (!roomKey) return [];

    for (const entry of Object.values(config.ai?.streamerRegistry || {})) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map(value => String(value)) : [];
        if (!roomIds.includes(roomKey)) continue;

        // 优先使用显式配置的 searchTags
        if (Array.isArray(entry.searchTags) && entry.searchTags.length > 0) {
            return entry.searchTags.map(t => String(t).trim()).filter(Boolean);
        }

        // 退退：displayName + speakerLabels
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
    return `提到小岁的小片段 ${datePart}`;
}

function normalizeTitle(value, fallback) {
    const title = String(value || '').trim()
        .replace(/^["“”'']+|["“”'']+$/g, '')
        .replace(/\s+/g, ' ');
    if (!title || title.length > 60) {
        return fallback;
    }
    return title;
}

async function buildClipCopy(window, info, streamerName, config, titleGenerator = null, descriptionGenerator = null, extraTagList = null) {
    const defaultTitle = buildDefaultTitle(window, info);
    let title = defaultTitle;
    let description = `来自 ${streamerName} 的直播间，录制时间 ${info.recordedAt || '未知'}，片段时间 ${formatClock(window.start)}-${formatClock(window.end)}。`;

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
            console.warn(`⚠️  话题切片标题生成失败，使用模板标题: ${error.message}`);
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
            console.warn(`⚠️  话题切片简介生成失败，使用模板简介: ${error.message}`);
        }
    }

    const configuredTags = Array.isArray(config.tags) ? config.tags : null;
    const tags = Array.from(new Set([
        ...(configuredTags || [streamerName, '岁己', '小岁', '虚拟主播', '直播切片']),
        ...(Array.isArray(config.extraTags) ? config.extraTags : []),
        ...(Array.isArray(extraTagList) ? extraTagList : [])
    ].map(tag => String(tag || '').trim()).filter(Boolean))).slice(0, 12);

    return {
        title,
        description,
        tags
    };
}

function runFfmpeg(args, options = {}) {
    return new Promise((resolve, reject) => {
        const ffmpegPath = options.ffmpegPath || 'ffmpeg';
        const child = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stderr });
                return;
            }
            reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        });
    });
}

function escapeSubtitlePathForFfmpegFilter(srtPath) {
    return String(srtPath)
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");
}

/**
 * 为切片生成封面图：从视频截取关键帧，添加居中描边标题文字
 */
async function generateClipCover(videoPath, title, outputDir, info = {}) {
    const { spawn } = require('child_process');
    const coverBase = path.basename(videoPath, path.extname(videoPath));
    const coverPath = path.join(outputDir, `${coverBase}_cover.jpg`);

    // 用 Python 调用 cover_generator.py 生成封面
    const scriptPath = path.join(__dirname, 'cover_generator.py');
    const subtitle = info.streamerName || '';

    return new Promise((resolve, reject) => {
        const args = ['python', scriptPath, videoPath,
            '--title', title,
            '--output', coverPath,
            '--position', 'center',
            '--key-frame',
        ];
        if (subtitle) {
            args.push('--subtitle', subtitle);
        }

        // args[0] is 'python', rest are script + args
        const child = spawn(args[0], args.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stderr = '';
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });

        child.on('close', (code) => {
            if (code === 0 && fs.existsSync(coverPath)) {
                console.log(`🖼️  封面已生成: ${coverPath}`);
                resolve(coverPath);
            } else {
                reject(new Error(`cover_generator 退出码 ${code}: ${stderr.slice(-300)}`));
            }
        });
        child.on('error', reject);
    });
}

async function cutClipMedia(source, window, srtPath, outputPath, config = {}) {
    const ffmpegPath = config.ffmpegPath || 'ffmpeg';
    const duration = String(Math.max(0.1, window.duration));
    const start = String(Math.max(0, window.start));

    if (source.kind === 'audio') {
        await runFfmpeg([
            '-y',
            '-ss', start,
            '-i', source.mediaPath,
            '-t', duration,
            '-vn',
            '-c:a', 'copy',
            outputPath
        ], { ffmpegPath });
        return {
            path: outputPath,
            burnedSubtitles: false,
            fallbackUsed: false
        };
    }

    if (config.burnSubtitles !== false) {
        try {
            await runFfmpeg([
                '-y',
                '-ss', start,
                '-i', source.mediaPath,
                '-t', duration,
                '-vf', `subtitles='${escapeSubtitlePathForFfmpegFilter(srtPath)}':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'`,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-c:a', 'aac',
                '-movflags', '+faststart',
                outputPath
            ], { ffmpegPath });
            return {
                path: outputPath,
                burnedSubtitles: true,
                fallbackUsed: false
            };
        } catch (error) {
            console.warn(`⚠️  字幕烧录失败，改为生成无烧录切片: ${error.message}`);
        }
    }

    await runFfmpeg([
        '-y',
        '-ss', start,
        '-i', source.mediaPath,
        '-t', duration,
        '-c', 'copy',
        outputPath
    ], { ffmpegPath });
    return {
        path: outputPath,
        burnedSubtitles: false,
        fallbackUsed: config.burnSubtitles !== false
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
                content
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

function buildTopicNotifyMarkdown(results = [], metadata = {}) {
    const first = results[0] || {};
    const info = metadata.copy || {};
    const windowSummary = results
        .map(result => `- ${formatClock(result.window?.start || 0)}-${formatClock(result.window?.end || 0)}: ${result.output?.mediaPath || ''}`)
        .join('\n');

    return [
        '## 话题切片提醒',
        '',
        `在 **${metadata.streamerName || '主播'}** 的直播 **${metadata.streamTitle || metadata.sourceFileName || '未知直播'}** 结束后，`,
        `找到其中 **${results.length}** 段提到岁己的地方，已分别切为切片。`,
        '',
        `- 直播间: ${metadata.roomId || '未知'}`,
        `- 录制时间: ${metadata.recordedAt || '未知'}`,
        `- 切片目录: ${metadata.outputRoot || '未知'}`,
        `- 命中关键词: ${(first.window?.matchedKeywords || []).join('、') || '岁己'}`,
        `- 投稿文案: ${first.output?.copyPath || '已生成'}`,
        '',
        '切片列表:',
        windowSummary || '- 无',
        '',
        '请到上面的切片目录查看。'
    ].join('\n');
}

async function notifyTopicClipResults(results = [], metadata = {}, config = {}) {
    const notifyConfig = config.clipTopics?.notify || {};
    if (!notifyConfig.enabled || results.length === 0) {
        return false;
    }

    const webhookUrl = getWeChatWebhookUrl(config);
    if (!webhookUrl) {
        console.warn('⚠️  话题切片提醒已启用，但未配置企业微信 webhookUrl');
        return false;
    }

    const markdown = buildTopicNotifyMarkdown(results, metadata);
    return sendWeChatMarkdown(webhookUrl, markdown);
}

async function generateTopicClips(options = {}) {
    const config = getClipTopicsConfig(options.config || {});
    if (!config.enabled) {
        return [];
    }
    if (config.mode !== 'local_review') {
        console.warn(`⚠️  clipTopics.mode=${config.mode} 暂未实现，按 local_review 处理`);
    }
    if (config.autoUpload?.enabled) {
        console.warn('⚠️  clipTopics.autoUpload.enabled=true 但 v1 不执行自动投稿，仅生成本地 review 包');
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

    const parsed = asrBackends.parseSrt(options.srtPath, 'topic_clip');
    const matches = findKeywordMatches(parsed.segments, config.keywords);
    if (matches.length === 0) {
        console.log('ℹ️  话题切片: 未命中关键词');
        return [];
    }

    const aiConfig = options.config || {};

    const bursts = buildTopicBursts(parsed.segments, matches, {
        contextPaddingSeconds: config.contextPaddingSeconds,
        mergeGapSeconds: config.mergeGapSeconds,
        maxSegmentsPerBurst: config.maxSegmentsPerBurst,
        totalDurationSeconds: options.totalDurationSeconds
    });
    if (bursts.length === 0) {
        console.log('ℹ️  话题切片: 命中关键词但未形成有效话题爆发段');
        return [];
    }

    console.log(`\n📦 ${bursts.length} 个话题爆发段 (burst)，调用 AI 决定切在哪...`);

    const info = parseRecordingInfo(source.mediaPath, options.context || {});
    if (isIgnoredRoom(info.roomId, config)) {
        console.log(`ℹ️  话题切片跳过: roomId=${info.roomId} 命中忽略名单`);
        return [];
    }
    const streamerName = resolveStreamerName(options.config || {}, info.roomId, options.context || {});
    const outputRoot = path.join(path.dirname(source.mediaPath), config.outputDirName);
    fs.mkdirSync(outputRoot, { recursive: true });

    // AI 分段：对每个 burst 决定切 1-3 段
    const aiSegmentedClips = [];
    for (const burst of bursts) {
        console.log(`  🔍 [${formatClock(burst.matchStart)}] 命中 ${burst.matchCount} 次，上下文窗口 ${formatClock(burst.start)}-${formatClock(burst.end)} (${burst.allSegments.length} 条字幕)`);

        const segments = await segmentBurstWithAI(burst, parsed, streamerName, info, aiConfig);
        
        if (segments.length === 0) {
            console.log(`  ⏭️  AI 判定跳过（可能是唱歌/误识别）`);
            continue;
        }

        for (const seg of segments) {
            // 构造一个兼容旧代码的 window 对象
            const w = {
                index: `${burst.index}-${seg.sliceIndex || 1}`,
                start: seg.start,
                end: seg.end,
                duration: seg.end - seg.start,
                matchedKeywords: burst.matchedKeywords,
                matchCount: burst.matchCount,
                matchSegments: burst.matchSegments,
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
            aiSegmentedClips.push({ window: w, burst, aiTitle: seg.aiTitle, aiDescription: seg.aiDescription });
        }

        console.log(`  ✅ 切出 ${segments.length} 段: ${segments.map(s => formatClock(s.start) + '-' + formatClock(s.end)).join(', ')}`);
    }

    if (aiSegmentedClips.length === 0) {
        console.log('ℹ️  AI 分段后无有效切片');
        return [];
    }

    console.log(`\n🎬 共 ${aiSegmentedClips.length} 段切片，开始生成视频...\n`);

    const results = [];
    for (const clip of aiSegmentedClips) {
        const window = clip.window;
        const base = sanitizeFileName(`${path.basename(source.mediaPath, path.extname(source.mediaPath))}_topic_${String(window.index).padStart(2, '0')}_${formatClock(window.start).replace(/:/g, '')}`);
        const mediaExt = source.kind === 'audio' ? path.extname(source.mediaPath).toLowerCase() : '.mp4';
        const mediaPath = path.join(outputRoot, `${base}${mediaExt || '.m4a'}`);
        const srtPath = path.join(outputRoot, `${base}.srt`);
        const metadataPath = path.join(outputRoot, `${base}.json`);
        const copyPath = path.join(outputRoot, `${base}_投稿文案.md`);

        const srtResult = writeClipSrt(parsed.segments, window, srtPath);
        // 优先用 AI 分段时生成的标题/简介，其次调用独立的标题/简介生成器
        const titleGen = clip.aiTitle
            ? async () => clip.aiTitle
            : options.titleGenerator;
        const descGen = clip.aiDescription
            ? async () => clip.aiDescription
            : options.descriptionGenerator;
        // 从 streamerRegistry 解析正式标签（如 米汀Nagisa）
        const registryTags = resolveStreamerTags(options.config || {}, info.roomId);
        const copy = await buildClipCopy(window, info, streamerName, config, titleGen, descGen, registryTags);

        let mediaResult = null;
        let error = null;
        try {
            mediaResult = await cutClipMedia(source, window, srtPath, mediaPath, {
                burnSubtitles: config.burnSubtitles,
                ffmpegPath: options.ffmpegPath
            });
        } catch (clipError) {
            error = clipError.message;
            console.warn(`⚠️  话题切片媒体生成失败，保留字幕和元数据: ${clipError.message}`);
        }

        // 生成封面（从切片视频截取关键帧 + 添加标题文字）
        let coverPath = null;
        if (mediaResult?.path && fs.existsSync(mediaResult.path)) {
            try {
                coverPath = await generateClipCover(mediaResult.path, copy.title, outputRoot, info);
            } catch (coverErr) {
                console.warn(`⚠️  封面生成失败，跳过: ${coverErr.message}`);
            }
        }

        const metadata = {
            version: 1,
            generatedAt: new Date().toISOString(),
            mode: 'local_review',
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
            recordedAt: info.recordedAt,
            streamTitle: info.streamTitle,
            window,
            copy,
            uploadReady: source.uploadReady && Boolean(mediaResult?.path),
            autoUploadEnabled: false,
            output: {
                mediaPath: mediaResult?.path || mediaPath,
                srtPath,
                metadataPath,
                copyPath,
                coverPath,
                burnedSubtitles: Boolean(mediaResult?.burnedSubtitles),
                subtitleBurnFallbackUsed: Boolean(mediaResult?.fallbackUsed),
                srtSegmentCount: srtResult.segmentCount,
                mediaError: error
            }
        };

        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        writeCopyMarkdown(copy, metadata, copyPath);
        results.push(metadata);
        console.log(`✅ 话题切片已生成: ${path.basename(mediaPath)} (${formatClock(window.start)}-${formatClock(window.end)})`);
    }

    try {
        await notifyTopicClipResults(results, {
            streamerName,
            streamTitle: info.streamTitle,
            roomId: info.roomId,
            recordedAt: info.recordedAt,
            outputRoot,
            sourceFileName: info.fileName
        }, options.config || {});
        if (results.length > 0) {
            console.log(`📣 话题切片提醒已尝试发送: ${results.length} 段`);
        }
    } catch (error) {
        console.warn(`⚠️  话题切片提醒发送失败，继续保留本地切片: ${error.message}`);
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
    segmentBurstWithAI,
    verifyClipWithAI,
    writeClipSrt,
    parseRecordingInfo,
    resolveStreamerName,
    resolveStreamerTags,
    isIgnoredRoom,
    buildDefaultTitle,
    buildClipCopy,
    cutClipMedia,
    generateTopicClips,
    notifyTopicClipResults,
    buildTopicNotifyMarkdown,
    formatClock,
    sanitizeFileName
};
