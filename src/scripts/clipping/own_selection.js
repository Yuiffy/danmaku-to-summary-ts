// Candidate recall and subtitle alignment, independent of queue and rendering IO.
const { formatClock } = require('./topic_selection');
const { notableEmotionEvents, emotionMomentScore, buildDanmakuDensity, buildEmotionContextLines } = require('../full_live_context');
const { buildSubtitleEvidence, cuesForWindow, formatEvidenceCues } = require('./subtitle_evidence');
const { identityDanmaku } = require('./participant_context');
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

function rescoreCandidateWindow(candidate, segments, danmaku, config, emotionAnalysis) {
    const comments = danmaku.map((item, index) => ({ ...item, id: `D${index + 1}` }))
        .filter(item => item.time >= candidate.start && item.time < candidate.end);
    const reactions = comments.map(item => ({ ...item,
        hits: (config.reactionKeywords || []).filter(word => String(item.text).includes(word)) }));
    const speech = segments.map((item, index) => ({ ...item, id: `S${index + 1}`,
        hits: (config.subtitleKeywords || []).filter(word => String(item.text || '').includes(word)) }))
        .filter(item => item.end > candidate.start && item.start < candidate.end && item.hits.length);
    const emotion = getEmotionEvidenceForWindow(emotionAnalysis, candidate, config.emotionScoring || {});
    const reactionCount = reactions.filter(item => item.hits.length).length;
    // Each source row contributes once, even when density/keyword windows cover it twice.
    const scores = {
        audience: comments.length + reactions.reduce((sum, item) => sum + (item.hits.length ? 20 + item.hits.length * 8 : 0), 0),
        speech: speech.reduce((sum, item) => sum + 16 + item.hits.length * 6, 0),
        emotion: config.emotionScoring?.enabled === false ? 0 : emotion.maxScore
    };
    return { ...candidate, score: scores.audience + scores.speech + scores.emotion, scoreComponents: scores,
        danmakuCount: comments.length, reactionCount,
        sourceRecordIds: [...comments.map(item => item.id), ...speech.map(item => item.id)],
        matchedKeywords: Array.from(new Set([...reactions, ...speech].flatMap(item => item.hits))),
        danmakuSamples: uniqueTextSamples(comments, 10),
        emotions: emotion.emotions, events: emotion.events, emotionEvidence: emotion.items };
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
            last.reason = Array.from(new Set(String(last.reason).split('+').concat(candidate.reason))).join('+');
            continue;
        }
        merged.push({ ...candidate });
    }

    return merged
        .map(candidate => rescoreCandidateWindow(candidate, segments, danmaku, config, emotionAnalysis))
        .map((candidate, index) => ({
            ...candidate,
            index: index + 1,
            duration: candidate.end - candidate.start
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(config.maxCandidates) || 80))
        .sort((a, b) => a.start - b.start);
}

function getWindowText(segments, window, maxChars = 700) {
    const text = segments
        .filter(segment => Number(segment.end) > window.start && Number(segment.start) < window.end)
        .map(segment => `${formatClock(segment.start)} ${String(segment.text || '').trim()}`)
        .join('\n');
    if (text.length <= maxChars) return text;
    const marker = '\n...(中段省略)...\n';
    const headChars = Math.max(1, Math.floor((maxChars - marker.length) * 0.65));
    const tailChars = Math.max(1, maxChars - marker.length - headChars);
    return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

function createWindowDanmakuReader(danmaku, reactionKeywords = []) {
    // This snapshot belongs to one synchronous planning pass, never a global cache.
    const rows = danmaku.map(item => ({ item, time: Number(item.time) }))
        .filter(row => !Number.isNaN(row.time)).sort((a, b) => a.time - b.time);
    const boundary = (time, afterEqual) => {
        let low = 0, high = rows.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (rows[middle].time < time || (afterEqual && rows[middle].time === time)) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    return (window, max = 14) => {
        const start = Number(window.start), end = Number(window.end);
        const items = Number.isNaN(start) || Number.isNaN(end) || end < start ? []
            : rows.slice(boundary(start, false), boundary(end, true)).map(row => row.item);
        return getWindowDanmakuEvidence(items, window, reactionKeywords, max);
    };
}

function getWindowDanmakuEvidence(danmaku, window, reactionKeywords = [], max = 14) {
    const items = (danmaku || [])
        .filter(item => Number(item.time) >= Number(window.start) && Number(item.time) <= Number(window.end))
        .sort((a, b) => Number(a.time) - Number(b.time));
    const limit = Math.max(1, Math.floor(Number(max) || 14));
    const reactionRows = items
        .map(item => ({
            item,
            hits: reactionKeywords.filter(keyword => String(item.text || '').includes(keyword)).length
        }))
        .filter(row => row.hits > 0)
        .sort((a, b) => b.hits - a.hits || Number(a.item.time) - Number(b.item.time));
    const counts = new Map();
    for (const item of items) {
        const text = String(item.text || '').trim();
        if (!text) continue;
        const current = counts.get(text) || { text, count: 0, first: item };
        current.count += 1;
        counts.set(text, current);
    }
    const frequentRows = Array.from(counts.values())
        .sort((a, b) => b.count - a.count || Number(a.first.time) - Number(b.first.time));
    const evenlySpaced = [];
    if (items.length > 0) {
        for (let index = 0; index < limit; index += 1) {
            const sourceIndex = limit === 1
                ? 0
                : Math.round(index * (items.length - 1) / (limit - 1));
            evenlySpaced.push(items[sourceIndex]);
        }
    }

    const selected = new Map();
    const add = item => {
        if (!item || selected.size >= limit) return;
        const key = `${Number(item.time).toFixed(3)}\u0000${String(item.text || '').trim()}`;
        if (!selected.has(key)) selected.set(key, item);
    };
    add(items[0]);
    add(items.at(-1));
    reactionRows.slice(0, Math.ceil(limit / 2)).forEach(row => add(row.item));
    frequentRows.slice(0, Math.min(4, limit)).forEach(row => add(row.first));
    evenlySpaced.forEach(add);
    const sampleItems = Array.from(selected.values()).sort((a, b) => Number(a.time) - Number(b.time));

    return {
        totalCount: items.length,
        reactionCount: reactionRows.length,
        repeatedMessageCount: Array.from(counts.values())
            .filter(row => row.count > 1)
            .reduce((sum, row) => sum + row.count, 0),
        repeatedTextCount: Array.from(counts.values()).filter(row => row.count > 1).length,
        activeSpanSeconds: items.length > 1
            ? Number((Number(items.at(-1).time) - Number(items[0].time)).toFixed(1))
            : 0,
        topTexts: frequentRows.slice(0, 6).map(({ text, count }) => count > 1 ? `${text}(x${count})` : text),
        topItems: frequentRows.slice(0, 6).map(row => ({ item: row.first, count: row.count })),
        sampleItems,
        sampleLines: sampleItems.map(item => `${formatClock(item.time)} ${item.text}`)
    };
}

function recallWindowOverlap(first, second) {
    const intersection = Math.max(
        0,
        Math.min(Number(first.end), Number(second.end)) - Math.max(Number(first.start), Number(second.start))
    );
    if (intersection <= 0) return { matches: false, score: 0 };
    const firstDuration = Math.max(0.1, Number(first.end) - Number(first.start));
    const secondDuration = Math.max(0.1, Number(second.end) - Number(second.start));
    const smallerCoverage = intersection / Math.min(firstDuration, secondDuration);
    const largerCoverage = intersection / Math.max(firstDuration, secondDuration);
    const centerDistance = Math.abs(
        (Number(first.start) + Number(first.end)) / 2
        - (Number(second.start) + Number(second.end)) / 2
    );
    return {
        matches: smallerCoverage >= 0.65 || (centerDistance <= 30 && largerCoverage >= 0.35),
        score: smallerCoverage + largerCoverage
    };
}

function normalizeRecallCandidate(candidate, source, order) {
    const base = candidate.base || {};
    const isLocal = source === 'local_signals';
    const modelScore = isLocal
        ? 0
        : Number(base.score ?? candidate.modelScore ?? candidate.score ?? 0);
    return {
        ...candidate,
        start: Number(candidate.start),
        end: Number(candidate.end),
        duration: Number(candidate.end) - Number(candidate.start),
        recallSources: [source],
        recallReasons: [String(candidate.reason || base.reason || source)].filter(Boolean),
        localScore: isLocal ? Number(candidate.score || 0) : 0,
        modelScore: Number.isFinite(modelScore) ? modelScore : 0,
        sourceCandidateIndices: [String(candidate.index ?? candidate.candidateIndex ?? `${source}-${order + 1}`)],
        selectionSource: 'recall_pool'
    };
}

function mergeRecallCandidateEvidence(first, second) {
    const firstHasModel = (first.recallSources || []).includes('model_chunked');
    const secondHasModel = (second.recallSources || []).includes('model_chunked');
    let preferred = first;
    let other = second;
    if (
        (!firstHasModel && secondHasModel)
        || (firstHasModel === secondHasModel && Number(second.modelScore || 0) > Number(first.modelScore || 0))
    ) {
        preferred = second;
        other = first;
    }
    const reasonParts = Array.from(new Set([
        ...(first.recallReasons || []),
        ...(second.recallReasons || [])
    ].filter(Boolean)));
    return {
        ...other,
        ...preferred,
        recallSources: Array.from(new Set([...(first.recallSources || []), ...(second.recallSources || [])])),
        recallReasons: reasonParts,
        reason: reasonParts.join(' | '),
        localScore: Math.max(Number(first.localScore || 0), Number(second.localScore || 0)),
        modelScore: Math.max(Number(first.modelScore || 0), Number(second.modelScore || 0)),
        sourceCandidateIndices: Array.from(new Set([
            ...(first.sourceCandidateIndices || []),
            ...(second.sourceCandidateIndices || [])
        ])),
        danmakuCount: Math.max(Number(first.danmakuCount || 0), Number(second.danmakuCount || 0)),
        reactionCount: Math.max(Number(first.reactionCount || 0), Number(second.reactionCount || 0)),
        matchedKeywords: Array.from(new Set([...(first.matchedKeywords || []), ...(second.matchedKeywords || [])])),
        danmakuSamples: Array.from(new Set([...(first.danmakuSamples || []), ...(second.danmakuSamples || [])])).slice(0, 14),
        emotions: Array.from(new Set([...(first.emotions || []), ...(second.emotions || [])])),
        events: Array.from(new Set([...(first.events || []), ...(second.events || [])])),
        emotionEvidence: [...(first.emotionEvidence || []), ...(second.emotionEvidence || [])],
        selectionSource: 'recall_pool'
    };
}

function buildRecallCandidatePool(localCandidates = [], modelCandidates = [], config = {}) {
    const normalized = [
        ...localCandidates.map((candidate, index) => normalizeRecallCandidate(candidate, 'local_signals', index)),
        ...modelCandidates.map((candidate, index) => normalizeRecallCandidate(candidate, 'model_chunked', index))
    ].filter(candidate => (
        Number.isFinite(candidate.start)
        && Number.isFinite(candidate.end)
        && candidate.end > candidate.start
    ));
    const deduped = [];
    for (const candidate of normalized) {
        let matchIndex = -1;
        let matchScore = 0;
        deduped.forEach((existing, index) => {
            const overlap = recallWindowOverlap(existing, candidate);
            if (overlap.matches && overlap.score > matchScore) {
                matchIndex = index;
                matchScore = overlap.score;
            }
        });
        if (matchIndex >= 0) {
            deduped[matchIndex] = mergeRecallCandidateEvidence(deduped[matchIndex], candidate);
        } else {
            deduped.push(candidate);
        }
    }

    const localRanked = deduped
        .filter(candidate => Number(candidate.localScore || 0) > 0)
        .sort((a, b) => Number(b.localScore || 0) - Number(a.localScore || 0));
    const localPercentiles = new Map(localRanked.map((candidate, index) => [
        candidate,
        100 * (localRanked.length - index) / Math.max(1, localRanked.length)
    ]));
    deduped.forEach(candidate => {
        const localPriority = localPercentiles.get(candidate) || 0;
        const modelPriority = clamp(Number(candidate.modelScore || 0), 0, 100);
        const sourceBonus = (candidate.recallSources || []).length > 1 ? 8 : 0;
        candidate.recallScore = Number((Math.max(localPriority, modelPriority) + sourceBonus).toFixed(2));
        candidate.score = candidate.recallScore;
    });

    const limit = Math.max(1, Math.floor(Number(config.ai?.maxCandidateLines) || 100));
    return deduped
        .sort((a, b) => Number(b.recallScore || 0) - Number(a.recallScore || 0) || Number(a.start) - Number(b.start))
        .slice(0, limit)
        .map((candidate, index) => ({
            ...candidate,
            index: index + 1,
            base: {
                ...(candidate.base || {}),
                reason: 'staged_recall_pool',
                selectionSource: 'recall_pool',
                recallSources: candidate.recallSources,
                recallReasons: candidate.recallReasons,
                localScore: candidate.localScore,
                modelScore: candidate.modelScore,
                recallScore: candidate.recallScore,
                sourceCandidateIndices: candidate.sourceCandidateIndices
            }
        }));
}

function budgetSubtitleWindows(evidence, totalDuration, config) {
    const seconds = Math.max(600, Number(config.chunkSeconds) || 2700);
    const budget = Math.floor(Number(config.maxSubtitleCharsPerChunk) || 14000);
    if (budget < 128) throw new Error('maxSubtitleCharsPerChunk must be at least 128');
    const overlap = Math.min(30, Math.max(0, Number(config.chunkOverlapSeconds ?? 30)));
    const windows = [];
    const lineLength = cue => formatEvidenceCues([cue]).length;
    for (let start = 0; start < totalDuration; start += seconds) {
        const end = Math.min(start + seconds, totalDuration);
        const original = cuesForWindow(evidence, { start, end });
        const rows = original.flatMap(cue => {
            if (lineLength(cue) <= budget) return [cue];
            const pieces = [];
            const characters = Array.from(cue.text);
            let offset = 0;
            while (offset < characters.length) {
                const marker = `[text-part offset=${offset}; original cue time] `;
                const available = budget - lineLength({ ...cue, text: marker });
                let text = '';
                const first = offset;
                while (offset < characters.length && text.length + characters[offset].length <= available) text += characters[offset++];
                if (offset === first) throw new Error('Subtitle evidence ID exceeds chunk budget');
                pieces.push({ ...cue, text: marker + text, partial: true, textOffset: first });
            }
            return pieces;
        });
        if (!rows.length) { windows.push({ start, end, cues: [] }); continue; }
        let cursor = 0;
        while (cursor < rows.length) {
            const fresh = cursor;
            const context = [];
            let length = 0;
            for (let back = cursor - 1; back >= 0 && rows[back].start >= rows[cursor].start - overlap; back--) {
                if (overlap === 0 || rows[back].partial || rows[cursor].partial) break;
                const cost = lineLength(rows[back]) + 1;
                if (length + cost + lineLength(rows[cursor]) > budget) break;
                context.unshift(rows[back]);
                length += cost;
            }
            const cues = [...context];
            while (cursor < rows.length) {
                const cost = lineLength(rows[cursor]) + (cues.length ? 1 : 0);
                // Context already reserves a separator for the first fresh row.
                const effective = cursor === fresh && context.length ? cost - 1 : cost;
                if (length + effective > budget) break;
                cues.push(rows[cursor++]);
                length += effective;
            }
            windows.push({
                start: Math.max(start, Math.min(fresh === 0 ? start : rows[fresh].start, cues[0].start)),
                end: Math.min(end, Math.max(cursor === rows.length ? end : rows[cursor].start, ...cues.map(cue => cue.end))),
                cues
            });
        }
    }
    return windows;
}

function buildChunkSources(parsed, danmaku, totalDuration, config, emotionAnalysis = null) {
    const density = buildDanmakuDensity(danmaku, totalDuration, config);
    const chunks = [];
    const evidence = buildSubtitleEvidence(parsed.segments);
    const danmakuIds = new Map(danmaku.map((item, index) => [item, `D${index + 1}`]));
    for (const [order, window] of budgetSubtitleWindows(evidence, totalDuration, config).entries()) {
        const { start, end } = window;
        const index = order + 1;
        const chunkSegments = parsed.segments.filter(segment => Number(segment.end) > start && Number(segment.start) < end);
        const chunkDanmaku = danmaku.filter(item => item.time >= start && item.time < end);
        const buckets = density.buckets.filter(bucket => bucket.end > start && bucket.start < end);
        const allowedDanmakuIds = new Set();
        const densityLines = buckets
            .filter(bucket => bucket.count >= density.threshold || bucket.keywords > 0)
            .slice(0, 80)
            .map(bucket => {
                const items = chunkDanmaku.filter(item => item.time >= bucket.start && item.time < bucket.end);
                const top = getWindowDanmakuEvidence(items, bucket).topItems.map(({ item, count }) => {
                    const id = danmakuIds.get(item);
                    allowedDanmakuIds.add(id);
                    return `${id} ${item.time} ${JSON.stringify(item.text)}${count > 1 ? `(x${count})` : ''}`;
                }).join(' / ');
                return `${formatClock(bucket.start)} count=${bucket.count} reaction=${bucket.keywords}${top ? ` | ${top}` : ''}`;
            });
        const reactionLines = chunkDanmaku
            .filter(item => (config.reactionKeywords || []).some(keyword => item.text.includes(keyword)))
            .slice(0, Math.max(1, Number(config.maxDanmakuLinesPerChunk) || 220))
            .map(item => {
                const id = danmakuIds.get(item);
                allowedDanmakuIds.add(id);
                return `${id} ${item.time} ${JSON.stringify(item.text)}`;
            });
        const identityLines = identityDanmaku(chunkDanmaku, window, parsed.participantContext,
            Number(config.attribution?.identityCommentsPerChunk ?? 12)).map(item => {
            const id = danmakuIds.get(item);
            allowedDanmakuIds.add(id);
            return `${id} ${item.time} ${JSON.stringify(item.text)}`;
        });
        const subtitleCues = window.cues;
        const subtitleText = formatEvidenceCues(subtitleCues);
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
            evidence,
            allowedDanmakuIds,
            subtitleCues,
            subtitleChars: subtitleText.length,
            omittedSubtitleChars: 0,
            sourceText: [
                `分段 #${index} ${formatClock(start)}-${formatClock(end)}`,
                `弹幕总数: ${chunkDanmaku.length}`,
                '',
                '高弹幕/高反应时间点（行首为统计桶起点，D-ID 后为该条弹幕的精确绝对秒数）:',
                densityLines.slice(0, 80).join('\n') || '无',
                '',
                '观众反应弹幕样例（D-ID 后为精确绝对秒数，保留原始小数）:',
                reactionLines.slice(0, Number(config.maxDanmakuLinesPerChunk) || 220).join('\n') || '无',
                ...(identityLines.length ? ['人物线索弹幕（仍是观众评论，不是说话人或动作真值）:', identityLines.join('\n')] : []),
                '',
                'SenseVoice 情感/声音事件（辅助线索，不作为事实）:',
                emotionLines.join('\n') || '无',
                '',
                '直播音轨字幕（text-part 只拆文本，共用原始 ID 和时间，不是词级时间）:',
                subtitleText || '无'
            ].join('\n')
        });
    }
    return chunks;
}

function dedupePlannedClips(clips, config) {
    const sorted = clips
        .filter(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start)
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const clip of sorted) {
        const matches = out.filter(existing => recallWindowOverlap(existing, clip).matches);
        if (matches.some(existing => (existing.score || 0) >= (clip.score || 0))) continue;
        for (const match of matches) out.splice(out.indexOf(match), 1);
        out.push(clip);
    }
    return out
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(1, Number(config.maxClips) || 50))
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
    if (clip.boundaryFromEvidence) return clip;
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

module.exports = {
    timeStringToSeconds,
    clamp,
    getEmotionEvidenceForWindow,
    buildEmotionCandidates,
    attachEmotionEvidenceToClips,
    buildCandidateWindows,
    getWindowText,
    createWindowDanmakuReader,
    getWindowDanmakuEvidence,
    buildRecallCandidatePool,
    buildChunkSources,
    dedupePlannedClips,
    alignClipToSubtitleBoundaries,
    alignClipsToSubtitleBoundaries,
    removeOverlappingClips
};
