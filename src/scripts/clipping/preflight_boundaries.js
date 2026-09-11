'use strict';

const BOUNDARY_REVIEW_SCHEMA = '"boundaryReview":{"setupCueId":"G1","closureCueId":"G20","startReason":"Why the introduction is complete","endReason":"Why the response is closed before the next topic","dependencies":[{"cueId":"G18","dependsOnCueIds":["G2"],"reason":"What this delayed answer or reference refers back to"}],"unresolvedCueIds":[]}';

function requiresBoundaryReview(config) {
    return config.review?.qualityRules === true || config.review?.strategy === 'audited';
}

function reviewPreflightBoundaries(raw, bounds, input, required) {
    const issues = [];
    if (!raw) return { review: null, issues: required ? ['缺少起因、收尾及回指依赖复核'] : [] };
    const nonempty = value => typeof value === 'string' && value.trim().length > 0;
    const visible = new Map(input.subtitles.map(cue => [cue.id, cue]));
    const inside = id => {
        const cue = visible.get(id);
        return cue && cue.start >= bounds.start && cue.end <= bounds.end;
    };
    if (!nonempty(raw.setupCueId) || !nonempty(raw.closureCueId)
        || !nonempty(raw.startReason) || !nonempty(raw.endReason)
        || !Array.isArray(raw.dependencies) || !Array.isArray(raw.unresolvedCueIds)) {
        return { review: { status: 'needs_review', assessment: raw }, issues: ['起因与收尾复核格式不完整'] };
    }
    for (const [label, id] of [['起因', raw.setupCueId], ['收尾', raw.closureCueId]]) {
        if (!visible.has(id)) issues.push(`${label}引用不可见字幕：${id}`);
        else if (!inside(id)) issues.push(`${label}仍在选窗外：${id}`);
    }
    if (visible.get(raw.setupCueId)?.start > visible.get(raw.closureCueId)?.start) issues.push('起因与收尾顺序颠倒');
    const dependencies = new Map();
    for (const dependency of raw.dependencies) {
        if (!dependency || !nonempty(dependency.cueId) || !nonempty(dependency.reason)
            || !Array.isArray(dependency.dependsOnCueIds) || !dependency.dependsOnCueIds.length
            || dependency.dependsOnCueIds.some(id => !nonempty(id) || id === dependency.cueId)) {
            issues.push('回指依赖缺少具体起因或理由');
            continue;
        }
        for (const id of [dependency.cueId, ...dependency.dependsOnCueIds]) {
            if (!visible.has(id)) issues.push(`回指依赖引用不可见字幕：${id}`);
            else if (!inside(id)) issues.push(`回指依赖仍在选窗外：${id}`);
        }
        dependencies.set(dependency.cueId, [...new Set([
            ...(dependencies.get(dependency.cueId) || []), ...dependency.dependsOnCueIds
        ])]);
    }
    // Prerequisites may occur later as an explanation, but a cycle cannot establish an origin.
    const completed = new Set();
    const path = [];
    const visit = id => {
        if (completed.has(id)) return false;
        const index = path.indexOf(id);
        if (index >= 0) {
            issues.push(`回指依赖存在循环：${[...path.slice(index), id].join(' → ')}`);
            return true;
        }
        path.push(id);
        if ((dependencies.get(id) || []).some(visit)) return true;
        path.pop();
        completed.add(id);
        return false;
    };
    [...dependencies.keys()].some(visit);
    for (const id of raw.unresolvedCueIds) {
        if (!visible.has(id)) issues.push(`未解回指引用不可见字幕：${id}`);
        else issues.push(`未找到必要起因或收尾：${id}`);
    }
    return { review: { ...raw, status: issues.length ? 'needs_review' : 'linked' }, issues: [...new Set(issues)] };
}

module.exports = { BOUNDARY_REVIEW_SCHEMA, requiresBoundaryReview, reviewPreflightBoundaries };
