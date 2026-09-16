'use strict';

const { requestSelectionText } = require('./selection_request');
const { getTopicClipAiModel } = require('./topic_config');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
const { buildKeywordEvidence, buildKeywordReviewPrompt, normalizeKeywordReview } = require('./keyword_review');
const { buildTopicQualityEvidence, buildTopicQualityPrompt, normalizeTopicQualityReview } = require('./topic_quality_review');

async function runTopicShadowReview(clip, segments, config, rootConfig, info, diagnostics) {
    if (config.review?.enabled !== true || rootConfig.ai?.text?.enabled === false) return null;
    const evidence = buildSubtitleEvidence(segments);
    const review = { mode: 'shadow', applied: false, sourceSha256: evidence.sourceSha256,
        window: { start: clip.window.start, end: clip.window.end } };
    const request = async (phase, build, normalize) => {
        try {
            const { prompt, input } = build();
            if (prompt.length > config.review.maxEvidenceChars) throw new Error('Review evidence exceeds budget');
            const validate = result => { try { normalize(result.text, input); return true; } catch { return false; } };
            const result = await requestSelectionText(prompt, { wordLimit: 1400,
                primaryModel: getTopicClipAiModel(rootConfig), timeoutMs: config.review.timeoutMs },
            config, rootConfig, info, phase, diagnostics, validate);
            return { ...normalize(result.text, input), model: result.meta?.model || getTopicClipAiModel(rootConfig),
                cacheKey: result.meta?.selectionCache?.key || null };
        } catch (error) {
            diagnostics.failures.push({ stage: 'ai_review', severity: 'warning', window: review.window, error: `${phase}: ${error.message}` });
            return { status: 'unavailable', reason: error.message };
        }
    };
    review.keyword = await request('topic_keyword_review_v1', () => {
        const input = buildKeywordEvidence(segments, clip.window.matchSegments.map(segment => ({
            segment, matchedKeywords: segment.matchedKeywords
        })), { maxEvidenceChars: config.review.maxEvidenceChars });
        return { input, prompt: buildKeywordReviewPrompt(input) };
    }, normalizeKeywordReview);
    review.quality = await request('topic_quality_review_v1', () => {
        const input = buildTopicQualityEvidence(clip, evidence);
        return { input, prompt: buildTopicQualityPrompt(input) };
    }, (text, input) => normalizeTopicQualityReview(text, clip, evidence, input, config));
    return review;
}

function topicReviewLines(review, humanReview = null) {
    if (!review) return [];
    const resolved = humanReview?.sourceSha256 === review.sourceSha256
        && humanReview?.copyGrounding?.issues?.length === 0 && Boolean(humanReview?.note);
    if (review.mode === 'preflight') return [
        `   烧录前复核: ${review.status} | ${review.model} ${review.reasoningEffort} | ${review.strategy}`,
        ...(resolved ? [`   人工复核: 已核对 | ${humanReview.note}`] : []),
        ...(review.qualityAudit ? [`   独立校审: ${review.qualityAudit.model} | ${review.qualityAudit.verdict}`,
            ...review.qualityAudit.issues.map(issue => `   ${issue.kind}: ${issue.reason}`)] : []),
        `   选片理由: ${review.reason || ''}`,
        `   字幕校对: ${(review.subtitleEdits || []).length} 处${review.applied ? '已应用到切片副本' : '未应用，等待审核'}`,
        ...(review.subtitleEdits || []).map(edit => `   ${edit.cueId}: ${edit.original} -> ${edit.replacement} | ${edit.reason}`),
        ...(review.rejectedSubtitleEdits || []).map(edit => `   未应用校对 ${edit.cueId}: ${edit.original} -> ${edit.replacement} | ${edit.validationError}`),
        ...(review.quality?.issues || []).map(issue => `   ${resolved ? '预审历史问题（已复核）' : '待核查'}: ${issue}`),
        ...(review.warnings || []).map(warning => `   提示: ${warning}`)
    ];
    const lines = [`   AI复核（仅建议）: 关键词=${review.keyword?.status || 'unavailable'}; 文案=${review.quality?.status || 'unavailable'}; 未自动修改`];
    for (const hit of review.keyword?.hits || []) {
        if (hit.verdict !== 'confirmed') lines.push(`   关键词 ${hit.start.toFixed(3)}s [${hit.verdict}]: ${hit.reason}`);
    }
    for (const issue of review.quality?.issues || []) lines.push(`   ${issue.field} [${issue.evidenceCueIds.join(',')}]: ${issue.reason}`);
    if (review.quality?.proposedCopy) {
        lines.push(`   建议标题: ${review.quality.proposedCopy.title}`);
        lines.push(`   建议简介: ${review.quality.proposedCopy.description}`);
        lines.push(`   建议封面: ${review.quality.proposedCopy.coverText.replace(/\n/g, ' / ')}`);
    }
    if (review.quality?.boundaryProposal) {
        const proposal = review.quality.boundaryProposal;
        lines.push(`   建议起止: ${proposal.start}-${proposal.end}s; ${proposal.reason}`);
    }
    for (const suggestion of review.quality?.subtitleSuggestions || []) {
        lines.push(`   字幕建议 ${suggestion.cueId}: ${suggestion.proposedText || '(待确认)'}; ${suggestion.reason}`);
    }
    for (const error of review.quality?.proposalErrors || []) lines.push(`   建议已拦截 ${error.field}: ${error.reason}`);
    for (const field of ['keyword', 'quality']) {
        if (review[field]?.status === 'unavailable') lines.push(`   复核不可用 ${field}: ${review[field].reason}`);
    }
    return lines;
}

module.exports = { runTopicShadowReview, topicReviewLines };
