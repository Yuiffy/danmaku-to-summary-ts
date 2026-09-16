'use strict';
const { areDuplicateClipWindows, formatClock } = require('./topic_selection');
const { previewReviewLines } = require('./candidate_preview');

function bounds(window) {
    if (window?.start == null || window?.end == null) return null;
    const start = Number(window.start), end = Number(window.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function candidateReference(clip) {
    return { candidateId: clip.window?.index ?? null, window: bounds(clip.window),
        title: clip.aiTitle || clip.copy?.title || clip.editorial?.event || '未生成标题' };
}

function buildTopicDedupeFailures(candidates, selected, options = { dedupeMatchText: false }) {
    const retained = new Set(selected);
    return candidates.filter(clip => !retained.has(clip)).map(clip => {
        const window = bounds(clip.window);
        const covering = selected.map(item => bounds(item.window)).filter(Boolean).sort((a, b) => a.start - b.start);
        const uncoveredRanges = [];
        // Subtract the union of retained intervals; overlap alone is not full coverage.
        if (window) {
            let cursor = window.start;
            for (const kept of covering) {
                if (kept.end <= cursor || kept.start >= window.end) continue;
                if (kept.start > cursor) uncoveredRanges.push({ start: cursor, end: Math.min(kept.start, window.end) });
                cursor = Math.max(cursor, Math.min(kept.end, window.end));
            }
            if (cursor < window.end) uncoveredRanges.push({ start: cursor, end: window.end });
        }
        return { stage: 'planning', severity: 'warning', code: 'overlap_suppressed', ...candidateReference(clip),
            error: '候选因重复或重叠被去重，未生成独立视频',
            retainedClips: selected.filter(kept => areDuplicateClipWindows(kept, clip, options)).map(candidateReference),
            uncoveredRanges, uncoveredSeconds: Number(uncoveredRanges.reduce((sum, item) => sum + item.end - item.start, 0).toFixed(3)),
            uncoveredSubtitleSamples: (clip.window?.contextSegments || []).filter(segment => uncoveredRanges.some(range =>
                segment.end > range.start && segment.start < range.end)).slice(0, 3).map(segment => ({
                start: segment.start, end: segment.end, text: segment.text })) };
    });
}

function describeTopicIssue(issue) {
    const value = String(issue || '').trim();
    const match = value.match(/^unsupported_(quote|number):([^:]+):([\s\S]+)$/);
    if (match) {
        const field = { title: '标题', description: '简介', coverText: '封面文案' }[match[2]] || match[2];
        return `${field}中的${match[1] === 'quote' ? '引号原话' : '数字'}缺少证据：${match[3]}`;
    }
    if (value === 'Model requests human review or identity remains uncertain') return '模型要求人工核对，或关键词所指身份尚未确认';
    const status = value.match(/API返回错误\s+(\d{3})/);
    if (status) return `AI 服务返回 HTTP ${status[1]}，本段预审未完成`;
    return value || '预审尚未完成';
}

function isPendingTopicResult(result) {
    return result?.status === 'pending_preflight'
        || (result?.aiReview?.mode === 'preflight' && result.aiReview.status !== 'ready' && !result?.output?.mediaPath);
}

function buildPendingTopicBlock(result) {
    const review = result.aiReview || {};
    const window = result.window || {};
    const issues = [...new Set((review.quality?.issues || []).map(describeTopicIssue))];
    const warnings = [...new Set((review.warnings || []).filter(Boolean))];
    const lines = [
        `- [待预审/${result.reviewPreview?.status === 'ready' ? '已有粗剪' : '粗剪未就绪'}] ${result.candidateId ? `候选ID ${result.candidateId} | ` : ''}${window.index || ''} | ${formatClock(window.start)}-${formatClock(window.end)} | ${result.copy?.title || result.editorial?.event || '未生成标题'}`,
        `  原因: ${issues.length ? issues.join('；') : describeTopicIssue(review.reason)}`,
        ...(result.candidateSubtitles?.path ? [`  待定字幕: ${result.candidateSubtitles.path}`] : []),
        ...previewReviewLines(result),
        ...warnings.map(warning => `  说明: ${warning}`),
        ...(window.matchSegments || []).slice(0, 3).map(segment => `  命中字幕: [${formatClock(segment.start)}] ${segment.text}`)
    ];
    return lines.join('\n');
}

function buildTopicDedupeDetailLines(failure, results = []) {
    if (failure.code !== 'overlap_suppressed') return [];
    const lines = [`  未生成候选: ${failure.candidateId || '未知'} | ${failure.title || '未生成标题'}`];
    for (const kept of failure.retainedClips || []) {
        const result = results.find(item => String(item.window?.index) === String(kept.candidateId));
        lines.push(`  保留候选: ${kept.candidateId || '未知'}${result?.uploadId ? ` | 上传ID ${result.uploadId}` : ''} | ${formatClock(kept.window?.start)}-${formatClock(kept.window?.end)} | ${kept.title}`);
    }
    if (failure.uncoveredRanges?.length) {
        lines.push(`  存在漏片风险: ${failure.uncoveredRanges.map(range => `${formatClock(range.start)}-${formatClock(range.end)}`).join('，')} 未被保留候选覆盖，共 ${failure.uncoveredSeconds}秒，需恢复审核。`);
        lines.push(...(failure.uncoveredSubtitleSamples || []).map(segment => `  未覆盖字幕摘录: [${formatClock(segment.start)}] ${segment.text}`));
    } else if (failure.window) {
        lines.push('  时间区间已被保留候选完全覆盖，本次去重未舍弃独有画面。');
    } else {
        lines.push('  时间覆盖无法确认，不能排除漏片风险。');
    }
    return lines;
}

module.exports = { buildTopicDedupeFailures, describeTopicIssue, isPendingTopicResult,
    buildPendingTopicBlock, buildTopicDedupeDetailLines };
