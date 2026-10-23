'use strict';
const ownReview = require('./own_review_report');
const publicationPolicy = require('./publication_policy');

// Presentation extracted from the CLI; all existing formatting helpers remain compatible exports there.
function buildNotifyMarkdown(results, metadata, hooks) {
    metadata = ownReview.withRegistryIndices(results, metadata);
    results = require('../workflow-runtime').loadWorkflow('clipping/reviewSelectionHistory').reviewDisplayRows(results);
    results = ownReview.numberedResults(results, metadata);
    const aiStatusLine = hooks.buildAiStatusLine(metadata.aiStatus);
    const uploadIds = !metadata.planOnly && Array.isArray(metadata.uploadRegistry?.clipIds) ? [...metadata.uploadRegistry.clipIds].sort((a, b) => a - b) : [];
    const streamerName = String(metadata.streamerName || '岁己').trim() || '岁己';
    const summary = metadata.fatalError && !results.length
        ? ['候选统计尚未完成；本次未返回可核对的成片清单。']
        : ownReview.summaryLines(results, metadata).map(line => metadata.fatalError ? line.replace(/^总候选/u, '已记录候选') : line);
    const lines = [
        `## ${streamerName}直播有趣切片${metadata.planOnly ? '计划' : '候选'}`, '',
        `直播: **${metadata.streamTitle || metadata.sourceFileName || '未知'}**`,
        `录制时间: ${metadata.recordedAt || '未知'}`,
        `切片目录: ${hooks.toFwdSlash(metadata.outputRoot) || (metadata.fatalError ? '未生成或尚未返回' : '')}`,
        metadata.reviewPath ? `Review: ${hooks.toFwdSlash(metadata.reviewPath)}` : null,
        results.length ? `来源统计: ${hooks.formatSelectionSourceCounts(results)}` : null,
        uploadIds.length ? `全部候选ID: ${uploadIds.join(',')}` : null,
        metadata.fatalError ? '状态: 批次处理失败，自动切片尚未完成。' : null,
        metadata.fatalError && results.length ? '以下为中断前已记录的候选，清单可能不完整。' : null,
        ...summary, ...publicationPolicy.summaryLines(metadata.publication),
        metadata.planOnly && !metadata.fatalError ? '状态: 仅规划，尚未生成上传ID；候选序号不是上传ID。' : null,
        aiStatusLine, ...hooks.buildProcessingSummaryLines(metadata.processingStats), '', '\u5207\u7247\u5217\u8868:'
    ].filter(line => line !== null);
    if (!metadata.planOnly) lines.splice(lines.length - 1, 0,
        ...(require('../workflow-runtime').loadWorkflow('clipping/reviewDigest').reviewAttentionLines?.(results.map(result => ({
            id: ownReview.clipId(result, metadata), status: ownReview.reviewStatus(result, metadata),
            rejected: !result.clipIntent?.needsHumanReview && Boolean(result.selectionRejection || result.sourceReview?.status === 'rejected' || result.publicationDecision?.action === 'rejected')
        })), metadata) || []), '');
    const entries = hooks.buildNotifyClipLines(results, metadata);
    results.forEach((result, index) => {
        lines.push('');
        lines.push(entries[index]);
        if (!metadata.planOnly) lines.push(`   状态: ${ownReview.reviewStatus(result, metadata)}`);
        lines.push(...ownReview.reviewDetailLines(result, metadata, { includeIssues: false }));
    });
    lines.push(...require('../workflow-runtime').loadWorkflow('clipping/reviewDigest').deferredReviewLines(metadata, results, { compact: true }));
    const diagnostics = require('../workflow-runtime').loadWorkflow('clipping/reviewDigest').compactDiagnosticLines(metadata);
    if (diagnostics.length) lines.push('', '批次告警:', ...diagnostics);
    return lines.join('\n');
}
async function withNotifyExcerpts(results) {
    const brief = require('../workflow-runtime').loadWorkflow('clipping/reviewDigest');
    return brief.withReviewExcerpts(require('../workflow-runtime').loadWorkflow('clipping/reviewSelectionHistory').reviewDisplayRows(results), {
        exists: file => require('fs').existsSync(file),
        subtitles: file => require('../asr/asr_backends').parseSrt(file).segments,
        audience: brief.readReviewAudience
    });
}
async function sendReviewList(results, metadata, webhook, sendMarkdown, buildMarkdown) {
    const enriched = await withNotifyExcerpts(results);
    const detail = require('../workflow-runtime').loadWorkflow('clipping/experiment').experimentDetailMarkdown(enriched, metadata, { compact: true });
    return sendMarkdown(webhook, [buildMarkdown(enriched, metadata), detail].filter(Boolean).join('\n\n'));
}
module.exports = { buildNotifyMarkdown, sendReviewList, withNotifyExcerpts };
