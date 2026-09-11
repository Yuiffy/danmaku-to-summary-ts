'use strict';
const { timeStringToSeconds, clamp } = require('./own_selection');
const { resolveEvidenceBoundaries, linkClipEvidence, parseClipResponse } = require('./subtitle_evidence');

function normalizeCoverText(value) {
    const lines = String(value || '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n/)
        .map(line => line.replace(/[【】]/g, '').replace(/\s+/g, '').trim())
        .filter(Boolean)
        .slice(0, 2);
    return lines.length >= 2 ? lines.join('\n') : '';
}

function buildFallbackTitle(candidate, streamerLabel = '小岁') {
    const label = String(streamerLabel || '小岁').trim() || '小岁';
    const reason = String(candidate.reason || '');
    if (reason.includes('danmaku_density')) return `${label}：弹幕突然很在意的片段`;
    if (reason.includes('danmaku_keyword')) return `${label}：弹幕觉得这里很有趣`;
    if (reason.includes('subtitle_keyword')) return `${label}：很有${label}想法的一段`;
    return `${label}：直播有趣片段`;
}

function reusableRecall(candidate, evidence, config, danmaku = []) {
    const grounding = candidate?.grounding;
    if (!evidence || grounding?.status !== 'linked' || grounding.sourceSha256 !== evidence.sourceSha256) return null;
    try {
        const bounds = resolveEvidenceBoundaries(candidate, evidence);
        if (!bounds || Math.abs(bounds.start - candidate.start) > 0.001 || Math.abs(bounds.end - candidate.end) > 0.001) return null;
        if (bounds.end - bounds.start < (config.minClipSeconds || 0) || bounds.end - bounds.start > (config.maxClipSeconds || Infinity) + 5) return null;
        const ids = grounding.subtitleIds || [];
        if (!ids.length || ids.some(id => {
            const cue = evidence.byId.get(id);
            return !cue || cue.start < bounds.start || cue.end > bounds.end;
        })) return null;
        if ((grounding.danmakuIds || []).some(id => {
            const original = grounding.audience?.find(item => item.id === id);
            const current = danmaku[Number(String(id).slice(1)) - 1];
            return !original || !current || original.time !== current.time || original.text !== current.text;
        })) return null;
        return { startCueId: bounds.startCueId, endCueId: bounds.endCueId,
            durationSeconds: Number((bounds.end - bounds.start).toFixed(3)),
            evidenceCueIds: ids, evidenceDanmakuIds: grounding.danmakuIds || [], sourceKind: grounding.sourceKind };
    } catch { return null; }
}

function normalizeAiClips(rawClips, candidates, totalDuration, config, streamerLabel = '小岁', evidence = null, danmaku = [], allowedCueIds = null, allowedDanmakuIds = null, rejections = null) {
    const candidateByIndex = new Map(candidates.map(candidate => [String(candidate.index), candidate]));
    const normalized = (Array.isArray(rawClips) ? rawClips : [])
        .map((clip, index) => {
            const reject = (reason, extra = {}) => {
                rejections?.push({ index: index + 1, candidateIndex: clip.candidateIndex, reason,
                    title: typeof clip.title === 'string' ? clip.title : null, score: clip.score ?? null,
                    startCueId: clip.startCueId, endCueId: clip.endCueId, startTime: clip.startTime, endTime: clip.endTime, ...extra });
                return null;
            };
            if (['title', 'description', 'coverText', 'reason'].some(field => clip[field] != null && typeof clip[field] !== 'string')) return reject('invalid_copy_type');
            if (clip.score != null && !Number.isFinite(Number(clip.score))) return reject('invalid_score');
            const base = candidateByIndex.get(String(clip.candidateIndex));
            if (!base) return reject('unknown_candidate');
            const reusable = reusableRecall(base, evidence, config, danmaku);
            const noBoundaryOverride = !['startCueId', 'endCueId', 'startTime', 'endTime'].some(key => clip[key] !== undefined);
            if (evidence && noBoundaryOverride && !reusable) return reject('missing_explicit_boundaries', {
                requiredFields: ['startCueId', 'endCueId'], recallReusable: false
            });
            const resolved = reusable ? {
                ...clip,
                ...(noBoundaryOverride ? { startCueId: reusable.startCueId, endCueId: reusable.endCueId } : {}),
                evidenceCueIds: clip.evidenceCueIds ?? reusable.evidenceCueIds,
                evidenceDanmakuIds: clip.evidenceDanmakuIds ?? reusable.evidenceDanmakuIds,
                sourceKind: clip.sourceKind ?? reusable.sourceKind
            } : clip;
            let boundaries;
            try { boundaries = evidence ? resolveEvidenceBoundaries(resolved, evidence) : null; } catch { return reject('invalid_boundary_ids'); }
            if (boundaries && allowedCueIds
                && (!allowedCueIds.has(boundaries.startCueId) || !allowedCueIds.has(boundaries.endCueId))) return reject('unprovided_boundary_ids');
            const start = boundaries?.start ?? timeStringToSeconds(clip.startTime);
            const end = boundaries?.end ?? timeStringToSeconds(clip.endTime);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return reject('invalid_time_range');
            const boundedStart = clamp(start, 0, totalDuration);
            const boundedEnd = clamp(end, 0, totalDuration);
            const duration = boundedEnd - boundedStart;
            if (duration < config.minClipSeconds || duration > config.maxClipSeconds + 5) return reject('duration_out_of_bounds', {
                duration, start: boundedStart, end: boundedEnd, minClipSeconds: config.minClipSeconds, maxClipSeconds: config.maxClipSeconds });
            if (boundedStart >= base.end || boundedEnd <= base.start) return reject('no_candidate_overlap');
            if (boundedStart < base.start - (Number(config.boundaryStartBacktrackSeconds) || 12) - 12
                || boundedEnd > base.end + (Number(config.boundaryEndExtendSeconds) || 45) + 12) return reject('outside_candidate_context');
            return {
                ...boundaries,
                start: boundedStart,
                end: boundedEnd,
                duration,
                title: String(resolved.title || '').trim() || (base ? buildFallbackTitle(base, streamerLabel) : `${streamerLabel}：直播有趣片段`),
                coverText: normalizeCoverText(resolved.coverText),
                description: String(resolved.description || '').trim(),
                reason: String(clip.reason || base?.reason || '').trim(),
                candidateIndex: base?.index || clip.candidateIndex || index + 1,
                score: Number(clip.score ?? base?.recallScore ?? base?.score ?? 0),
                selectionSource: 'model_global_rerank',
                ...(evidence ? { grounding: { ...linkClipEvidence(resolved, { start: boundedStart, end: boundedEnd }, evidence, danmaku,
                    { cueIds: allowedCueIds, danmakuIds: allowedDanmakuIds }), reusedRecall: Boolean(reusable && (
                        noBoundaryOverride || clip.evidenceCueIds === undefined || clip.evidenceDanmakuIds === undefined || clip.sourceKind === undefined
                    )) } } : {}),
                base: base ? {
                    ...base,
                    selectionSource: 'model_global_rerank'
                } : null
            };
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.start) - Number(b.start));
    const limit = Math.max(1, Number(config.maxClips) || 50);
    normalized.slice(limit).forEach(clip => rejections?.push({ ...clip, reason: 'max_clips_limit' }));
    return normalized.slice(0, limit).sort((a, b) => Number(a.start) - Number(b.start));
}

function isRerankResponseValid(result, candidates, totalDuration, config, evidence, danmaku, allowedCueIds, allowedDanmakuIds = null) {
    try {
        const raw = parseClipResponse(result.text);
        if (raw.some(clip => !String(clip.title || '').trim())) return false;
        const normalized = normalizeAiClips(raw, candidates, totalDuration, config, '', evidence, danmaku, allowedCueIds, allowedDanmakuIds);
        return normalized.length === raw.length && normalized.every(clip => !clip.grounding.issues.some(issue =>
            /^(?:unknown_|unseen_|subtitle_outside_clip|danmaku_outside_clip)/u.test(issue)));
    } catch { return false; }
}

function clipsConflict(first, second, toleranceSeconds = 12) {
    const tolerance = Math.max(0, Number(toleranceSeconds) || 0);
    return Number(first.start) <= Number(second.end) + tolerance
        && Number(second.start) <= Number(first.end) + tolerance;
}

function buildGroundingReviewLine(grounding) {
    if (!grounding) return null;
    return grounding.status === 'linked'
        ? `   事实证据: 字幕 ${grounding.subtitleIds.join(',')}；来源 ${grounding.sourceKind}（已关联片内原文，仍需人工听审）`
        : `   事实待核对: ${grounding.issues.join(', ')}`;
}

module.exports = { buildFallbackTitle, reusableRecall, normalizeAiClips, isRerankResponseValid, clipsConflict, buildGroundingReviewLine, normalizeCoverText };
