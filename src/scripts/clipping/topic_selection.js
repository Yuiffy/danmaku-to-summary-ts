// Pure keyword, context, and boundary decisions; no media IO or provider calls.
const { DEFAULT_CLIP_TOPICS_CONFIG } = require('./topic_config');
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
    takeEvenly(focusNonHitIndexes, focusSlots).forEach(index => selected.add(index));

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
    if (options.dedupeMatchText !== false && firstBurstIndex !== null
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
        options.duplicateOverlapRatio ?? 0
    )));
    // Even a short shared tail repeats footage; touching ranges are not overlaps.
    return overlap > 0 && overlapRatio >= duplicateOverlapRatio;
}

function compareClipQuality(first, second) {
    const firstBounds = getClipWindowBounds(first);
    const secondBounds = getClipWindowBounds(second);
    if (!firstBounds || !secondBounds) return 0;

    const editorialScore = Number(first.editorial?.score || 0) - Number(second.editorial?.score || 0);
    if (editorialScore) return editorialScore;
    // Legacy or tied assessments retain the longer range, then input order.
    return firstBounds.duration - secondBounds.duration;
}

function dedupeClipsByStart(clips = [], options = {}) {
    const ranked = [];
    const passthrough = [];

    for (const [order, clip] of clips.entries()) {
        if (!getClipWindowBounds(clip)) {
            passthrough.push(clip);
            continue;
        }
        ranked.push({ clip, order });
    }

    ranked.sort((a, b) => compareClipQuality(b.clip, a.clip) || a.order - b.order);
    const deduped = [];
    for (const { clip } of ranked) {
        // Check every retained range, not rejected candidates that can bridge
        // otherwise independent clips. Keep original boundaries and copy intact.
        if (!deduped.some(existing => areDuplicateClipWindows(existing, clip, options))) {
            deduped.push(clip);
        }
    }

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

function formatClock(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(safe);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function segmentKey(segment = {}) {
    return `${Number(segment.start).toFixed(3)}-${Number(segment.end).toFixed(3)}`;
}

module.exports = {
    findKeywordMatches,
    clamp,
    buildClipWindows,
    getOverlappingSegments,
    buildTopicBursts,
    normalizeAiClipSelection,
    dedupeClipsByStart,
    areDuplicateClipWindows,
    buildFallbackAiClipSelection,
    buildTopicBurstPrompt,
    formatClock,
    segmentKey
};
