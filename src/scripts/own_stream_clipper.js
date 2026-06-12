const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const fetch = require('node-fetch');
const asrBackends = require('./asr/asr_backends');
const configLoader = require('./config-loader');
const topicClipper = require('./topic_clipper');

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
    maxCandidates: 28,
    maxClips: 12,
    chunkSeconds: 2700,
    aiConcurrency: 3,
    maxSubtitleCharsPerChunk: 14000,
    maxDanmakuLinesPerChunk: 220,
    alignBoundaries: true,
    boundaryStartBacktrackSeconds: 12,
    boundaryEndExtendSeconds: 35,
    boundarySilenceGapSeconds: 2.0,
    boundaryTrailingSilenceLookbackSeconds: 14,
    densityWindowSeconds: 30,
    densityPercentile: 0.2,
    minDanmakuCount: 12,
    burnSubtitles: true,
    outputDirName: 'own_stream_fun_clips',
    ai: {
        enabled: true,
        strategy: 'chunked',
        maxCandidateLines: 32
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
        notify: {
            ...DEFAULT_OWN_STREAM_CLIPS_CONFIG.notify,
            ...(raw.notify || {})
        }
    };
}

function formatClock(seconds) {
    return topicClipper.formatClock(seconds);
}

function buildClipDescription({ streamerName, streamTitle, recordedAt, start, end, reason }) {
    const liveName = streamerName || '\u4e3b\u64ad';
    const title = streamTitle || '\u672a\u77e5\u76f4\u64ad';
    const time = recordedAt || '\u672a\u77e5';
    const clipStart = formatClock(start);
    const clipEnd = formatClock(end);
    const lines = [
        '\u6765\u81ea ' + liveName + ' \u7684\u76f4\u64ad\u300a' + title + '\u300b\uff0c\u5f55\u5236\u65f6\u95f4 ' + time + '\u3002',
        '\u7247\u6bb5\u65f6\u95f4 ' + clipStart + '-' + clipEnd + '\u3002'
    ];

    const extraReason = String(reason || '').trim();
    if (extraReason) {
        lines.push('');
        lines.push(extraReason);
    }

    return lines.join('\n');
}

function timeStringToSeconds(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
    if (!match) return NaN;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function clamp(value, min, max = Number.POSITIVE_INFINITY) {
    return Math.min(Math.max(value, min), max);
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, pct) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => b - a);
    const index = clamp(Math.floor(sorted.length * pct), 0, sorted.length - 1);
    return sorted[index] || 0;
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

function buildDanmakuDensity(danmaku = [], totalDuration, config) {
    const windowSeconds = Math.max(5, Number(config.densityWindowSeconds) || 30);
    const bucketCount = Math.max(1, Math.ceil(Math.max(totalDuration, 1) / windowSeconds));
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
        index,
        start: index * windowSeconds,
        end: (index + 1) * windowSeconds,
        count: 0,
        keywords: 0,
        samples: []
    }));
    const reactionKeywords = config.reactionKeywords || [];
    for (const item of danmaku) {
        const index = clamp(Math.floor(item.time / windowSeconds), 0, bucketCount - 1);
        const bucket = buckets[index];
        bucket.count += 1;
        if (reactionKeywords.some(keyword => item.text.includes(keyword))) {
            bucket.keywords += 1;
            if (bucket.samples.length < 12) bucket.samples.push(item.text);
        } else if (bucket.samples.length < 6) {
            bucket.samples.push(item.text);
        }
    }
    const counts = buckets.map(bucket => bucket.count);
    const threshold = Math.max(
        Number(config.minDanmakuCount) || 0,
        percentile(counts, Number(config.densityPercentile) || 0.2),
        Math.ceil(median(counts) * 1.8)
    );
    return { buckets, threshold, windowSeconds };
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

function buildCandidateWindows(parsed, danmaku, config, totalDuration) {
    const segments = parsed.segments || [];
    const density = buildDanmakuDensity(danmaku, totalDuration, config);
    const raw = [];

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
        .slice(0, Math.max(1, Number(config.maxCandidates) || 28))
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

function buildChunkSources(parsed, danmaku, totalDuration, config) {
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
        chunks.push({
            index,
            start,
            end,
            segments: chunkSegments,
            danmaku: chunkDanmaku,
            sourceText: [
                `分段 #${index} ${formatClock(start)}-${formatClock(end)}`,
                `弹幕总数: ${chunkDanmaku.length}`,
                '',
                '高弹幕/高反应时间点:',
                densityLines.slice(0, 80).join('\n') || '无',
                '',
                '反应弹幕样例:',
                reactionLines.slice(0, Number(config.maxDanmakuLinesPerChunk) || 220).join('\n') || '无',
                '',
                '字幕:',
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
        .slice(0, Math.max(1, Number(config.maxClips) || 12))
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

async function planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig = {}) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false) return [];
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const chunks = buildChunkSources(parsed, danmaku, totalDuration, config);
    const worker = async (chunk) => {
        const prompt = [
            '你是直播切片编辑。下面是一段岁己SUI自己直播的字幕和弹幕摘要。',
            '请直接找这个分段里所有可能值得本地 review 的切片：有趣、弹幕很多、弹幕很在意、体现岁己想法与众不同、岁己傻事，或弹幕觉得她傻/特别/有趣/可爱。',
            '不要只看关键词；弹幕密度、弹幕反应和上下文都要考虑。不要选普通问好、普通感谢礼物、纯唱歌、无明确看点的片段。',
            '每段 35 秒到 3 分半，尽量切在句子边界。一个分段最多返回 8 段，没有就返回空数组。',
            '输出纯 JSON，不要 Markdown：',
            'Boundary rules are critical:',
            '- startTime must include the setup/premise, not start from the punchline.',
            '- endTime must include the explanation, follow-up reactions, and the final closing sentence.',
            '- If the streamer continues explaining the same incident after a short pause, extend endTime until that explanation is complete.',
            '- Stop before a truly new topic, gift thanks, unrelated chat, or reading unrelated danmaku.',
            '- Prefer a natural silence after a complete sentence; never end in the middle of a sentence or continuous story.',
            '',
            '标题风格很重要，要像人工改过的 B 站切片标题，抓冲突和节目效果，而不是写摘要。',
            '标题要求：',
            '- 18-42 字，最多 52 字；可以稍长一点换取信息量，不要写成空泛短句。',
            '- 必须点出一个具体看点：反差、翻车、嘴硬、弹幕急眼/破防/炸锅、岁己锐评、离谱发言、操作失误、当场社死、越说越怪等。',
            '- 优先使用主播原话、弹幕反应、游戏/事件名，形成“具体事件 + 反应/槽点”的结构。',
            '- 不要用“直播有趣片段”“精彩瞬间”“很可爱的一段”“岁己聊到了XX”这种弱标题。',
            '- 不要堆关键词，不要解释标题，不要加引号。标题可以不写“岁己：”，投稿阶段会另外处理前缀。',
            '人工标题参考风格：',
            '- 第二次复活怎么还往回走，弹幕急死了，路痴实锤',
            '- 蚊子式刮痧打剑盾大怪，怪都睡着了',
            '- 妈妈突然进房间，赶紧把电脑画面切到桌面',
            '- 弹幕突然聊戒色，岁己当场社死',
            '- 三斤小龙虾算减肥？这逻辑没法反驳',
            '{"clips":[{"startTime":"HH:MM:SS","endTime":"HH:MM:SS","title":"人工风格标题，18-42字","reason":"一句话说明为什么值得看","score":1}]}',
            '',
            `直播标题: ${info.streamTitle || '未知'}`,
            `录制时间: ${info.recordedAt || '未知'}`,
            '',
            chunk.sourceText
        ].join('\n');
        try {
            const result = provider === 'tuZi'
                ? await generator.generateTextWithTuZi(prompt, { wordLimit: 1000 })
                : await generator.generateTextWithGemini(prompt, { wordLimit: 1000 });
            const text = String(result.text || '').trim();
            const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
            if (!match) {
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
            console.warn(`AI chunk #${chunk.index} failed: ${error.message}`);
            return [];
        }
    };
    const nested = await runPool(chunks, config.aiConcurrency, worker);
    return dedupePlannedClips(nested.flat(), config);
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
                reason: String(clip.reason || base?.reason || '').trim(),
                candidateIndex: base?.index || clip.candidateIndex || index + 1,
                score: Number(base?.score || 0),
                base
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start)
        .slice(0, Math.max(1, Number(config.maxClips) || 12));
}

async function refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig = {}) {
    if (!config.ai?.enabled || rootConfig.ai?.text?.enabled === false || candidates.length === 0) {
        return [];
    }
    const provider = rootConfig.ai?.text?.provider || 'gemini';
    const generator = require('./ai_text_generator');
    const candidateLines = candidates
        .slice(0, config.ai.maxCandidateLines)
        .map(candidate => [
            `#${candidate.index} ${formatClock(candidate.start)}-${formatClock(candidate.end)} score=${candidate.score} reason=${candidate.reason}`,
            `弹幕样例: ${getWindowDanmaku(danmaku, candidate, 8).join(' / ') || '无'}`,
            `字幕: ${getWindowText(parsed.segments, candidate, 520) || '无'}`
        ].join('\n'))
        .join('\n\n');

    const prompt = [
        '你是直播切片编辑。下面是岁己SUI自己直播的候选片段。',
        '请从中挑出适合本地 review 的有趣切片：有趣、弹幕量大、弹幕很在意、体现岁己想法与众不同、岁己做了傻事，或者弹幕指出她傻/特别/有趣/可爱。',
        '不要选纯唱歌、普通问好、普通感谢礼物、没有可看点的片段。',
        '每段 35 秒到 3 分半，尽量切在句子边界。最多 12 段。',
        '输出纯 JSON，不要 Markdown：',
        'Boundary rules are critical:',
        '- startTime must include the setup/premise, not start from the punchline.',
        '- endTime must include the explanation, follow-up reactions, and the final closing sentence.',
        '- If the streamer continues explaining the same incident after a short pause, extend endTime until that explanation is complete.',
        '- Stop before a truly new topic, gift thanks, unrelated chat, or reading unrelated danmaku.',
        '- Prefer a natural silence after a complete sentence; never end in the middle of a sentence or continuous story.',
        '',
        '标题风格很重要，要像人工改过的 B 站切片标题，抓冲突和节目效果，而不是写摘要。',
        '标题要求：',
        '- 18-42 字，最多 52 字；可以稍长一点换取信息量，不要写成空泛短句。',
        '- 必须点出一个具体看点：反差、翻车、嘴硬、弹幕急眼/破防/炸锅、岁己锐评、离谱发言、操作失误、当场社死、越说越怪等。',
        '- 优先使用主播原话、弹幕反应、游戏/事件名，形成“具体事件 + 反应/槽点”的结构。',
        '- 不要用“直播有趣片段”“精彩瞬间”“很可爱的一段”“岁己聊到了XX”这种弱标题。',
        '- 不要堆关键词，不要解释标题，不要加引号。标题可以不写“岁己：”，投稿阶段会另外处理前缀。',
        '人工标题参考风格：',
        '- 第二次复活怎么还往回走，弹幕急死了，路痴实锤',
        '- 蚊子式刮痧打剑盾大怪，怪都睡着了',
        '- 妈妈突然进房间，赶紧把电脑画面切到桌面',
        '- 弹幕突然聊戒色，岁己当场社死',
        '- 三斤小龙虾算减肥？这逻辑没法反驳',
        '{"clips":[{"candidateIndex":1,"startTime":"HH:MM:SS","endTime":"HH:MM:SS","title":"人工风格标题，18-42字","reason":"一句话说明为什么值得看"}]}',
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
            : await generator.generateTextWithGemini(prompt, { wordLimit: 1200 });
        const text = String(result.text || '').trim();
        const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/);
        if (!match) {
            console.warn(`AI did not return clips JSON: ${text.slice(0, 180)}`);
            return [];
        }
        const parsedJson = JSON.parse(match[0]);
        return normalizeAiClips(parsedJson.clips, candidates, parsed.segments.at(-1)?.end || 0, config);
    } catch (error) {
        console.warn(`AI clip refinement failed, using local candidates: ${error.message}`);
        return [];
    }
}

function fallbackClipsFromCandidates(candidates, config) {
    return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(config.maxClips) || 12))
        .map(candidate => ({
            start: candidate.start,
            end: candidate.end,
            duration: candidate.duration,
            title: buildFallbackTitle(candidate),
            reason: candidate.reason,
            candidateIndex: candidate.index,
            score: candidate.score,
            base: candidate
        }))
        .sort((a, b) => a.start - b.start);
}

function filterClipsBySelection(clips, selectedIndices = null) {
    if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
        return clips;
    }
    const wanted = new Set(selectedIndices.map(value => Number(value)).filter(Number.isFinite));
    return clips.filter((_, index) => wanted.has(index + 1));
}

function buildReviewMarkdown(results, metadata) {
    const lines = [
        '# 小岁直播有趣切片 review',
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot}`,
        '',
        '## 切片列表',
        ''
    ];
    results.forEach((result, index) => {
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        const filePath = result.output.mediaPath;
        lines.push(`${index + 1}. ${result.copy.title} | ${start} | ${duration} | ${filePath}`);
    });
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function buildPlanReviewMarkdown(clips, metadata) {
    const lines = [
        '# 小岁直播有趣切片计划',
        '',
        `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `输出目录: ${metadata.outputRoot}`,
        '',
        '## 候选列表',
        ''
    ];
    clips.forEach((clip, index) => {
        lines.push(`${index + 1}. ${clip.title} | ${formatClock(clip.start)} | ${formatClock(clip.duration)} | ${clip.reason || ''}`);
    });
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function buildNotifyMarkdown(results, metadata) {
    const lines = [
        '## \u5c81\u5df1\u76f4\u64ad\u6709\u8da3\u5207\u7247\u5019\u9009',
        '',
        `直播: **${metadata.streamTitle || metadata.sourceFileName || '未知'}**`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `切片目录: ${metadata.outputRoot}`,
        metadata.reviewPath ? `Review: ${metadata.reviewPath}` : null,
        '',
        '\u5207\u7247\u5217\u8868:'
    ].filter(line => line !== null);
    results.forEach((result, index) => {
        const title = result.copy.title;
        const start = formatClock(result.window.start);
        const duration = formatClock(result.window.duration);
        lines.push(`${index + 1}. ${title} | ${start} | ${duration}`);
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
        const line = `${index + 1}. ${title} | ${start} | ${duration}`;
        if ((compact.join('\n').length + line.length + 24) > 3880) {
            compact.push(`${index + 1}. ...还有 ${results.length - index} 段，请看 Review`);
            break;
        }
        compact.push(line);
    }
    return compact.join('\n');
}

async function sendWeChatMarkdown(webhookUrl, content) {
    if (!webhookUrl) return false;
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content }
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
    const candidates = buildCandidateWindows(parsed, danmaku, config, totalDuration);
    const info = parseRecordingInfo(options.mediaPath, options.context || {});
    const outputRoot = path.join(path.dirname(options.mediaPath), config.outputDirName);
    fs.mkdirSync(outputRoot, { recursive: true });
    const reviewMetadata = {
        streamerName: options.streamerName || '岁己SUI',
        streamTitle: info.streamTitle,
        roomId: info.roomId,
        recordedAt: info.recordedAt,
        outputRoot,
        sourceFileName: info.fileName
    };
    if (candidates.length === 0 && danmaku.length === 0) {
        console.log('No own-stream clip candidates found.');
        return [];
    }

    let clips = [];
    if (options.planPath) {
        const plan = JSON.parse(fs.readFileSync(options.planPath, 'utf8'));
        clips = Array.isArray(plan.clips) ? plan.clips : [];
    } else {
        if (config.ai?.enabled && config.ai?.strategy !== 'candidate_only') {
            clips = await planClipsWithAIChunks(parsed, danmaku, info, totalDuration, config, rootConfig);
        }
        if (clips.length === 0) {
            const clipsFromAi = await refineCandidatesWithAI(candidates, parsed, danmaku, info, config, rootConfig);
            clips = clipsFromAi.length > 0 ? clipsFromAi : fallbackClipsFromCandidates(candidates, config);
        }
    }
    clips = filterClipsBySelection(clips, options.selectedIndices);
    clips = alignClipsToSubtitleBoundaries(clips, parsed.segments, config, totalDuration);
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
            aiStrategy: config.ai?.strategy || null
        },
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
        const copy = {
            title: clip.title,
            description: buildClipDescription({
                streamerName,
                streamTitle: info.streamTitle,
                recordedAt: info.recordedAt,
                start: window.start,
                end: window.end,
                reason: clip.reason
            }),
            tags: info.roomId === '25788785'
                ? ['小岁', '虚拟主播', '直播切片', '岁AI切片']
                : [streamerName, '虚拟主播', '直播切片']
        };
        let mediaResult = null;
        let mediaError = null;
        try {
            mediaResult = await topicClipper.cutClipMedia(source, window, srtPath, mediaPath, {
                burnSubtitles: config.burnSubtitles,
                ffmpegPath: options.ffmpegPath
            });
        } catch (error) {
            mediaError = error.message;
            console.warn(`clip media generation failed, metadata kept: ${error.message}`);
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
                srtSegmentCount: srtResult.segmentCount,
                mediaError
            }
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        results.push(metadata);
        console.log(`${index + 1}. ${copy.title} ${formatClock(window.start)} ${formatClock(window.duration)} ${metadata.output.mediaPath}`);
    }

    fs.writeFileSync(reviewPath, buildReviewMarkdown(results, reviewMetadata), 'utf8');
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
        else if (arg === '--plan-only') options.planOnly = true;
        else if (arg === '--max-clips') options.maxClips = Number(argv[++i]);
        else if (arg === '--chunk-seconds') options.chunkSeconds = Number(argv[++i]);
        else if (arg === '--ai-concurrency') options.aiConcurrency = Number(argv[++i]);
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
            ...(Number.isFinite(cli.maxClips) ? { maxClips: cli.maxClips } : {}),
            ...(Number.isFinite(cli.chunkSeconds) ? { chunkSeconds: cli.chunkSeconds } : {}),
            ...(Number.isFinite(cli.aiConcurrency) ? { aiConcurrency: cli.aiConcurrency } : {})
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
    parseDanmakuXml,
    buildDanmakuDensity,
    buildCandidateWindows,
    buildChunkSources,
    planClipsWithAIChunks,
    alignClipToSubtitleBoundaries,
    alignClipsToSubtitleBoundaries,
    buildNotifyMarkdown,
    buildReviewMarkdown,
    buildPlanReviewMarkdown,
    buildClipDescription,
    filterClipsBySelection,
    generateOwnStreamClips
};
