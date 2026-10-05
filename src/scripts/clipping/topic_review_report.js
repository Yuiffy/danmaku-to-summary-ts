'use strict';

const path = require('path');
const { formatClock } = require('./topic_selection');
const ownReview = require('./own_review_report');
const { isPendingTopicResult, buildPendingTopicBlock, buildTopicDedupeDetailLines } = require('./topic_failure_details');

// The facade supplies existing pure formatters; this report never imports its parent CLI.
function createTopicReviewReport({ compactNotifyText, toFwdSlash, buildSubtitleContextLines,
    buildGroundingReviewLine, topicReviewLines, previewReviewLines }) {
    function automaticRows(results, metadata) {
        const registry = metadata.uploadRegistry || {};
        const reserved = [...Object.keys(registry.clipIdsByReviewIndex || {}), ...results.map(row => row.reviewIndex)]
            .map(Number).filter(Number.isSafeInteger);
        const unregisteredIndex = Math.max(results.length, ...reserved) + 1;
        const rows = results.map((result, index) => ({ ...result,
            reviewIndex: registry.clipIdsByReviewIndex && !Number.isSafeInteger(result.reviewIndex)
                ? unregisteredIndex + index : ownReview.reviewIndex(result, index),
            uploadReady: result.uploadReady === true && !isPendingTopicResult(result) && Boolean(result.output?.mediaPath) }));
        const clipIdsByReviewIndex = registry.clipIdsByReviewIndex || Object.fromEntries(rows.map(result => [
            result.reviewIndex, result.uploadId || result.candidateId
        ]).filter(([, id]) => Number.isSafeInteger(Number(id)) && Number(id) > 0));
        const resolvedMetadata = { ...metadata, uploadRegistry: { ...registry, clipIdsByReviewIndex } };
        return { results: ownReview.chronologicalResults(rows.map(result => ({ ...result,
            uploadId: ownReview.clipId(result, resolvedMetadata),
            ...(isPendingTopicResult(result) ? { candidateId: ownReview.clipId(result, resolvedMetadata) } : {})
        }))), metadata: resolvedMetadata };
    }

    function resultId(result, metadata) {
        if (metadata.automaticPublication?.enabled || metadata.uploadRegistry?.clipIdsByReviewIndex) return ownReview.clipId(result, metadata);
        const value = Number(result.uploadId || result.candidateId);
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }

    function resultStatus(result, metadata) {
        if (isPendingTopicResult(result)) return '待预审（未自动投稿）';
        return ownReview.reviewStatus(result, metadata);
    }

    function buildClipNotifyBlock(result = {}, notifyConfig = {}, metadata = {}) {
        const window = result.window || {};
        const uploadId = resultId(result, metadata);
        const idPrefix = uploadId ? `ID ${uploadId} | ` : '';
        const mediaPath = toFwdSlash(result.output?.mediaPath || '');
        const fileName = mediaPath ? path.basename(mediaPath) : '文件未生成';
        const title = compactNotifyText(result.copy?.title || '', 120);
        const lines = [
            `- ${idPrefix}${formatClock(window.start || 0)}-${formatClock(window.end || 0)} | ${fileName}`
        ];

        if (title) {
            lines.push(`  - 标题: ${title}`);
        }
        if (metadata.automaticPublication?.enabled) {
            lines.push(`  - 状态: ${resultStatus(result, metadata)}`);
            lines.push(...ownReview.reviewDetailLines(result, metadata, { includeIssues: false }));
            return lines.join('\n');
        }
        if (result.aiReview) lines.push(result.aiReview.mode === 'preflight'
            ? `  - 烧录前复核: ${result.aiReview.status}; 字幕校对 ${result.aiReview.subtitleEdits.length} 处`
            : `  - AI复核: 关键词=${result.aiReview.keyword.status}, 文案=${result.aiReview.quality.status}; 建议未自动应用`);

        if (notifyConfig.includeSubtitleContext !== false) {
            const subtitleContext = buildSubtitleContextLines(
                window,
                notifyConfig.subtitleContextLines
            );
            if (subtitleContext.length > 0) {
                lines.push('  - 字幕上下文:');
                lines.push(...subtitleContext.map(line => `    ${line}`));
            }
        }

        if (notifyConfig.includeDanmakuContext !== false) {
            const danmakuContext = Array.isArray(window.danmakuContext)
                ? window.danmakuContext.filter(Boolean)
                : [];
            if (danmakuContext.length > 0) {
                lines.push('  - 附近弹幕:');
                lines.push(...danmakuContext.map(line => `    ${line}`));
            }
        }

        return lines.join('\n');
    }

    const TOPIC_FAILURE_STAGE_LABELS = {
        preflight: '烧录前预审',
        planning: 'AI 分段',
        subtitle: '字幕生成',
        subtitle_burn: '字幕烧录降级',
        copy: '文案生成',
        media: '媒体生成',
        cover: '封面生成',
        metadata: '元数据写入',
        review: '审核文件写入',
        registry: '上传注册',
        topic_clipper: '话题切片'
    };

    function collectTopicFailures(results = [], failures = []) {
        const collected = Array.isArray(failures) ? [...failures] : [];
        for (const result of results) {
            const mediaError = result?.output?.mediaError;
            if (!mediaError) continue;
            const duplicate = collected.some(item =>
                item?.stage === 'media'
                && Number(item?.window?.start) === Number(result?.window?.start)
                && String(item?.error || '') === String(mediaError)
            );
            if (!duplicate) {
                collected.push({
                    stage: 'media',
                    window: result.window,
                    title: result.copy?.title || null,
                    error: mediaError
                });
            }
        }
        return collected;
    }

    function buildTopicFailureBlock(failure = {}, results = []) {
        const stage = TOPIC_FAILURE_STAGE_LABELS[failure.stage] || failure.stage || '未知阶段';
        const window = failure.window || {};
        const hasWindow = Number.isFinite(Number(window.start)) || Number.isFinite(Number(window.end));
        const range = hasWindow
            ? `${formatClock(window.start || 0)}-${formatClock(window.end || window.start || 0)} | `
            : '';
        const severity = failure.severity === 'warning' ? '降级' : '失败';
        const error = compactNotifyText(failure.error || failure.message || '未知错误', 360);
        return [`- [${severity}/${stage}] ${range}${error}`,
            ...buildTopicDedupeDetailLines(failure, results)].join('\n');
    }


    function buildTopicNotifyMarkdown(results = [], metadata = {}) {
        if (metadata.automaticPublication?.enabled) ({ results, metadata } = automaticRows(results, metadata));
        const notifyConfig = metadata.notify || {};
        const aiModels = Array.isArray(metadata.aiModels) && metadata.aiModels.length > 0
            ? metadata.aiModels.join(', ')
            : '规则兜底（未调用 AI）';
        const failures = collectTopicFailures(results, metadata.failures);
        const successfulResults = results.filter(result => !isPendingTopicResult(result) && !result?.output?.mediaError && result?.output?.mediaPath);
        const pendingResults = results.filter(isPendingTopicResult);
        const windowSummary = (metadata.automaticPublication?.enabled ? results : successfulResults)
            .map(result => isPendingTopicResult(result)
                ? buildPendingTopicBlock(result) : buildClipNotifyBlock(result, notifyConfig, metadata))
            .join('\n\n');
        const failureSummary = failures.map(failure => buildTopicFailureBlock(failure, results)).join('\n\n');
        const incomplete = failures.length > 0 || pendingResults.length > 0;
        const title = failures.length ? '## 话题切片提醒（存在失败）' : pendingResults.length ? '## 话题切片提醒（含待切候选）' : '## 话题切片提醒';
        const outcome = incomplete || metadata.automaticPublication?.enabled
            ? `本次候选 **${results.length}** 段,成功生成 **${successfulResults.length}** 段${pendingResults.length ? `,待预审 **${pendingResults.length}** 段` : ''}${failures.length ? `,另有 **${failures.length}** 条失败或降级记录` : ''}。`
            : `找到其中 **${results.length}** 段提到岁己的地方,已分别切为切片。`;

        return [
            title,
            '',
            `在 **${metadata.streamerName || '主播'}** 的直播 **${metadata.streamTitle || metadata.sourceFileName || '未知直播'}** 结束后,`,
            outcome,
            '',
            `- 直播间: ${metadata.roomId || '未知'}`,
            `- 录制时间: ${metadata.recordedAt || '未知'}`,
            `- AI模型: ${aiModels}`,
            `- 切片目录: ${toFwdSlash(metadata.outputRoot || '未知')}`,
            metadata.reviewPath ? `- 审核文件: ${toFwdSlash(metadata.reviewPath)}` : null,
            metadata.uploadRegistry?.clipIds?.length ? `- 投稿短id: ${metadata.uploadRegistry.clipIds.join(',')}` : null,
            metadata.candidateIds?.length ? `- 待切候选ID: ${metadata.candidateIds.join(',')}` : null,
            ...(metadata.automaticPublication?.enabled ? ownReview.summaryLines(results, metadata) : []),
            '',
            metadata.automaticPublication?.enabled ? '切片总清单（按时间排序）:' : '成功切片:',
            windowSummary || '- 无',
            pendingResults.length && !metadata.automaticPublication?.enabled ? '待预审候选（粗剪视频配同名 SRT，确认后可按候选ID烧录）:' : null,
            ...(!metadata.automaticPublication?.enabled ? pendingResults.flatMap(result => ['', buildPendingTopicBlock(result)]) : []),
            failures.length > 0 ? '' : null,
            failures.length > 0 ? '失败与降级详情:' : null,
            failures.length > 0 ? failureSummary : null,
            ...(metadata.automaticPublication?.enabled ? ownReview.diagnosticLines(metadata) : [])
        ].filter(line => line !== null && line !== undefined).join('\n');
    }


    function buildTopicReviewMarkdown(results = [], metadata = {}) {
        if (metadata.automaticPublication?.enabled) return buildAutomaticTopicReviewMarkdown(results, metadata);
        const uploadIds = Array.isArray(metadata.uploadRegistry?.clipIds)
            ? metadata.uploadRegistry.clipIds
            : [];
        const failures = collectTopicFailures(results, metadata.failures);
        const uploadableResults = results.filter(result => result?.uploadReady && !result?.output?.mediaError);
        const localOnlyResults = results.filter(result => !result?.output?.mediaError && !result?.uploadReady);
        const lines = [
            '# 话题切片 review',
            '',
            `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
            `录制时间: ${metadata.recordedAt || '未知'}`,
            `输出目录: ${metadata.outputRoot || ''}`,
            metadata.planPath ? `事件编排记录: ${metadata.planPath}` : null,
            uploadIds.length ? `上传短ID: ${uploadIds.join(',')}` : null,
            metadata.candidateIds?.length ? `待切候选ID: ${metadata.candidateIds.join(',')}` : null,
            '',
            '## 切片列表',
            ''
        ].filter(line => line !== null);

        uploadableResults.forEach((result, index) => {
            const start = formatClock(result.window?.start || 0);
            const duration = formatClock(result.window?.duration || ((result.window?.end || 0) - (result.window?.start || 0)));
            lines.push(`${index + 1}. ${result.copy?.title || '话题切片'} | ${start} | ${duration} | ${result.output?.mediaPath || ''}`);
            if (uploadIds[index]) {
                lines.push(`   上传ID: ${uploadIds[index]}`);
            }
            if (result.output?.coverPath) {
                lines.push(`   封面: ${result.output.coverPath}`);
            }
            if (result.editorial) {
                lines.push(`   事件编排: ${result.editorial.status} | ${result.editorial.event || result.editorial.reason}`);
                if (result.editorial.extensionReason) lines.push(`   完整性延长: ${result.editorial.extensionReason}`);
                const grounding = buildGroundingReviewLine(result.editorial.copyGrounding);
                if (grounding) lines.push(grounding);
            }
            lines.push(...topicReviewLines(result.aiReview, result.humanReview));
        });
        if (uploadableResults.length === 0) {
            lines.push('- 无可上传切片');
        }
        if (localOnlyResults.length > 0) {
            lines.push('', '## 仅本地结果', '');
            localOnlyResults.forEach(result => {
                lines.push(`- ${result.copy?.title || '话题切片'} | ${formatClock(result.window?.start || 0)} | ${result.output?.mediaPath || ''}`);
                if (result.candidateId) lines.push(`   候选ID: ${result.candidateId} | ${result.window?.index || ''}`);
                if (result.candidateSubtitles?.path) lines.push(`   待定字幕: ${result.candidateSubtitles.path}`);
                lines.push(...previewReviewLines(result));
                if (result.status === 'pending_preflight') lines.push(`   待烧录前审核: ${result.output?.metadataPath || ''}`);
                lines.push(...topicReviewLines(result.aiReview, result.humanReview));
            });
        }
        if (failures.length > 0) {
            lines.push('', '## 失败与降级记录', '');
            lines.push(...failures.map(failure => buildTopicFailureBlock(failure, results)));
        }
        lines.push('');
        return `${lines.join('\n')}\n`;
    }

    function buildAutomaticTopicReviewMarkdown(results, metadata) {
        ({ results, metadata } = automaticRows(results, metadata));
        const failures = collectTopicFailures(results, metadata.failures);
        const lines = ['# 话题切片 review',
            '<!-- topic-clip-review:v2; machine uploads must use the JSON manifest -->', '',
            `直播: ${metadata.streamTitle || metadata.sourceFileName || '未知'}`,
            `录制时间: ${metadata.recordedAt || '未知'}`, `输出目录: ${metadata.outputRoot || ''}`,
            ...(metadata.planPath ? [`事件编排记录: ${metadata.planPath}`] : []),
            ...ownReview.summaryLines(results, metadata), '', '## 切片总清单（按时间排序）', ''];
        for (const [index, result] of results.entries()) {
            const id = resultId(result, metadata);
            lines.push(`${index + 1}. ${id ? `ID${id} ` : '未登记ID '}${result.copy?.title || '话题切片'} | ${formatClock(result.window?.start || 0)} | ${result.output?.mediaPath || '未生成视频'}`,
                `   状态: ${resultStatus(result, metadata)}`);
            if (id) lines.push(`   候选ID: ${id}`);
            if (result.output?.coverPath) lines.push(`   封面: ${result.output.coverPath}`);
            if (result.output?.srtPath) lines.push(`   字幕: ${result.output.srtPath}`);
            if (result.editorial) {
                lines.push(`   事件编排: ${result.editorial.status} | ${result.editorial.event || result.editorial.reason}`);
                if (result.editorial.extensionReason) lines.push(`   完整性延长: ${result.editorial.extensionReason}`);
                const grounding = buildGroundingReviewLine(result.editorial.copyGrounding);
                if (grounding) lines.push(grounding);
            }
            if (isPendingTopicResult(result)) {
                lines.push(buildPendingTopicBlock(result));
                if (result.candidateSubtitles?.path) lines.push(`   待定字幕: ${result.candidateSubtitles.path}`);
            }
            lines.push(...topicReviewLines(result.aiReview, result.humanReview), ...ownReview.reviewDetailLines(result, metadata));
        }
        if (failures.length) lines.push('', '## 失败与降级记录', ...failures.map(failure => buildTopicFailureBlock(failure, results)));
        const diagnostics = ownReview.diagnosticLines(metadata);
        if (diagnostics.length) lines.push('', '## 自动投稿诊断', ...diagnostics);
        return `${lines.join('\n')}\n`;
    }

    return { buildClipNotifyBlock, buildTopicNotifyMarkdown, buildTopicReviewMarkdown, collectTopicFailures };
}

module.exports = { createTopicReviewReport };
