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
    maxClipSeconds: 180,
    mergeGapSeconds: 45,
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
        .replace(/^["“”'']+|["“”'']+$/g, '')
        .replace(/\s+/g, ' ');
    if (!title || title.length > 60) {
        return fallback;
    }
    return title;
}

async function buildClipCopy(window, info, streamerName, config, titleGenerator = null, descriptionGenerator = null) {
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
        ...(Array.isArray(config.extraTags) ? config.extraTags : [])
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

    const windows = buildClipWindows(parsed.segments, matches, {
        prePaddingSeconds: config.prePaddingSeconds,
        postPaddingSeconds: config.postPaddingSeconds,
        maxClipSeconds: config.maxClipSeconds,
        mergeGapSeconds: config.mergeGapSeconds,
        totalDurationSeconds: options.totalDurationSeconds
    });
    if (windows.length === 0) {
        console.log('ℹ️  话题切片: 命中关键词但未形成有效窗口');
        return [];
    }

    // AI 验证：过滤唱歌/哼旋律等 ASR 误识别的假命中
    // 给每个 window 附加上下文文本（供 AI 理解用）
    for (const w of windows) {
        w.allSegmentTexts = parsed.segments
            .filter(s => Number(s.start) >= w.start - 5 && Number(s.end) <= w.end + 5)
            .map(s => s.text);
        // 扩展上下文：切片之前/之后的句子，帮 AI 理解前因后果
        w.preContext = parsed.segments
            .filter(s => Number(s.end) <= w.start && Number(s.end) >= w.start - 60)
            .map(s => s.text)
            .slice(-10);
        w.postContext = parsed.segments
            .filter(s => Number(s.start) >= w.end && Number(s.start) <= w.end + 60)
            .map(s => s.text)
            .slice(0, 10);
    }

    const aiVerifiedWindows = [];
    const aiConfig = options.config || {};
    console.log(`\n🤖 AI 验证 ${windows.length} 个候选切片...`);
    for (const w of windows) {
        const verification = await verifyClipWithAI(w, config.keywords, aiConfig);
        if (verification.verified) {
            aiVerifiedWindows.push(w);
            console.log(`  ✅ [${formatClock(w.start)}] 通过: ${verification.reason}`);
        } else {
            console.log(`  ❌ [${formatClock(w.start)}] 过滤: ${verification.reason}`);
        }
    }
    console.log(`🤖 AI 验证完成: ${aiVerifiedWindows.length}/${windows.length} 通过\n`);

    if (aiVerifiedWindows.length === 0) {
        console.log('ℹ️  AI 验证后无有效切片');
        return [];
    }

    const info = parseRecordingInfo(source.mediaPath, options.context || {});
    if (isIgnoredRoom(info.roomId, config)) {
        console.log(`ℹ️  话题切片跳过: roomId=${info.roomId} 命中忽略名单`);
        return [];
    }
    const streamerName = resolveStreamerName(options.config || {}, info.roomId, options.context || {});
    const outputRoot = path.join(path.dirname(source.mediaPath), config.outputDirName);
    fs.mkdirSync(outputRoot, { recursive: true });

    const results = [];
    for (const window of aiVerifiedWindows) {
        const base = sanitizeFileName(`${path.basename(source.mediaPath, path.extname(source.mediaPath))}_topic_${String(window.index).padStart(2, '0')}_${formatClock(window.start).replace(/:/g, '')}`);
        const mediaExt = source.kind === 'audio' ? path.extname(source.mediaPath).toLowerCase() : '.mp4';
        const mediaPath = path.join(outputRoot, `${base}${mediaExt || '.m4a'}`);
        const srtPath = path.join(outputRoot, `${base}.srt`);
        const metadataPath = path.join(outputRoot, `${base}.json`);
        const copyPath = path.join(outputRoot, `${base}_投稿文案.md`);

        const srtResult = writeClipSrt(parsed.segments, window, srtPath);
        const copy = await buildClipCopy(window, info, streamerName, config, options.titleGenerator, options.descriptionGenerator);

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
    verifyClipWithAI,
    writeClipSrt,
    parseRecordingInfo,
    resolveStreamerName,
    isIgnoredRoom,
    buildDefaultTitle,
    buildClipCopy,
    generateTopicClips,
    notifyTopicClipResults,
    buildTopicNotifyMarkdown,
    formatClock,
    sanitizeFileName
};
