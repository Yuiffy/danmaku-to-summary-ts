'use strict';

function reviewIndex(result, index) {
    const value = Number(result.reviewIndex ?? result.window?.index ?? index + 1);
    return Number.isSafeInteger(value) && value > 0 ? value : index + 1;
}

function chronologicalResults(results = []) {
    return results.map((result, index) => ({ ...result, reviewIndex: reviewIndex(result, index) }))
        .sort((a, b) => {
            const start = item => Number.isFinite(item.window?.start ?? item.start) ? (item.window?.start ?? item.start) : Infinity;
            return start(a) - start(b) || a.reviewIndex - b.reviewIndex;
        });
}

function withRegistryIndices(results, metadata = {}) {
    const registry = metadata.uploadRegistry;
    if (!registry?.clipIds || registry.clipIdsByReviewIndex) return metadata;
    return { ...metadata, uploadRegistry: { ...registry, clipIdsByReviewIndex: Object.fromEntries(
        results.map((result, index) => [reviewIndex(result, index), registry.clipIds[index]])) } };
}

function summaryLines(results, metadata = {}) {
    if (metadata.planOnly) return [];
    const uploaded = results.filter(result => metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex] === 'uploaded');
    const uploadActive = results.filter(result => ['queued', 'uploading', 'rendering'].includes(metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex]));
    const ready = results.filter(result => uploadEligible(result) && !metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]
        && !uploaded.includes(result) && !uploadActive.includes(result));
    const rejected = results.filter(result => result.selectionRejection);
    const readyIds = ready.map((result, index) => clipId(result, metadata, index)).filter(Boolean);
    return [`总候选 ${results.length}${uploaded.length ? ` | 已上传 ${uploaded.length}` : ''}${uploadActive.length ? ` | 投稿处理中 ${uploadActive.length}` : ''} | 成片待审核 ${ready.length} | 待复核或异常 ${results.length - ready.length - rejected.length - uploaded.length - uploadActive.length} | 剔除 ${rejected.length}`,
        ...(readyIds.length ? [`上传短ID: ${readyIds.join(',')}`] : []),
        '候选 ID 用于定位，不代表已审核或已授权上传。'];
}

function uploadEligible(result) {
    return !result.rebuildRequired && !result.publicCopyPending && !result.selectionRejection && result.uploadReady !== false
        && !result.output?.mediaError && !result.output?.coverError
        && (!(result.qaRequired || result.attributionRequired) || result.uploadReady === true);
}

function reviewIssues(result, metadata = {}) {
    const humanApproved = result.ownStreamHumanReview?.status === 'approved';
    const issues = [
        ...(!humanApproved ? result.attributionReview?.issues || [] : []), ...(!humanApproved ? result.qaResult?.issues || [] : []),
        ...(result.grounding?.issues || []),
        ...(metadata.uploadRegistry?.reviewIssuesByReviewIndex?.[result.reviewIndex] || [])
    ];
    if (result.selectionRejection) issues.unshift(`selection_rejected:${result.selectionRejection.reason}`);
    if (result.rebuildRequired) issues.unshift('subtitle_revision_needs_render');
    if (result.output?.mediaError) issues.unshift(`media_failed:${result.output.mediaError}`);
    if (result.output?.coverError) issues.unshift(`cover_failed:${result.output.coverError}`);
    if (!humanApproved && result.attributionRequired && result.attributionReview?.status !== 'passed' && !issues.length) issues.push('actor_review_unavailable');
    if (result.publicCopyPending && !issues.length) issues.push('public_copy_pending');
    return [...new Set(issues.map(String))].filter(issue => !(result.publicCopyPending && issue.startsWith('clip public copy is pending;')));
}

function reviewStatus(result, metadata = {}) {
    const state = metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex];
    if (state === 'uploaded') return metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex] ? '已上传（当前资料待复核）' : '已上传';
    if (state === 'queued') return '已排队上传';
    if (state === 'uploading') return '正在上传';
    if (state === 'rendering') return '上传队列正在制作';
    if (state === 'failed') return '投稿失败';
    if (result.rebuildRequired) return '字幕已修订（待重压）';
    if (result.selectionRejection) return '已剔除（未切）';
    if (result.output?.mediaError || result.output?.coverError) return '制作异常';
    if (reviewIssues(result).some(issue => /actor_review_(unavailable|failed|time_budget)|actor_evidence_exceeds_budget/.test(issue))) return '复核不可用';
    if (!uploadEligible(result) || metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]) return '待复核';
    if (result.ownStreamHumanReview?.status === 'approved') return '人工复核通过（未授权上传）';
    return '成片待审核';
}

function explainIssue(issue) {
    const text = String(issue);
    const labels = [
        [/^selection_rejected:duration_out_of_bounds/, '时长超出规则范围'],
        [/^selection_rejected:overlap/, '与保留片段重叠'],
        [/^selection_rejected:max_clips_limit/, '超出本批候选数上限'],
        [/^actor_review_unavailable/, '人物复核未执行或预算用尽'],
        [/^actor_review_time_budget/, '人物复核耗时超限'],
        [/^actor_review_failed/, '人物复核请求失败'],
        [/^actor_evidence_exceeds_budget/, '复核证据超出输入预算'],
        [/^unsupported_quote:/, '引号内容与原文不一致'],
        [/^unsupported_number:/, '数字缺少原文支持'],
        [/^invalid_action_citation:/, '动作引用未通过证据校验'],
        [/^audience_attribution_needs_review/, '观众或弹幕归属需核对'],
        [/^missing_speech_evidence/, '缺少发言证据'],
        [/^question_action_removed/, '疑问表述被改写为确定动作'],
        [/^uncertain_source/, '内容来源尚需人工确认'],
        [/^person_only_in_danmaku:/, '人物身份只有弹幕支持，缺少发言依据'],
        [/^danmaku_outside_clip:/, '引用的弹幕在片段时间窗外'],
        [/^public_copy_pending/, '发布文案待确认'],
        [/^subtitle_revision_needs_render/, '新字幕尚未重压到视频'],
        [/^media_failed:/, '视频或字幕制作失败'],
        [/^cover_failed:/, '封面制作失败']
    ];
    const label = labels.find(([pattern]) => pattern.test(text))?.[1];
    return label ? `${label} (${text})` : text;
}

function clipId(result, metadata = {}, index = 0) {
    const registry = metadata.uploadRegistry || {};
    const value = Number(registry.clipIdsByReviewIndex
        ? registry.clipIdsByReviewIndex[reviewIndex(result, index)] : registry.clipIds?.[index]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function reviewDetailLines(result, metadata = {}, options = {}) {
    const includeIssues = options.includeIssues !== false;
    const lines = includeIssues ? reviewIssues(result, metadata).map(issue => `   核对项: ${explainIssue(issue)}`) : [];
    const proofreading = result.subtitleProofreading;
    if (proofreading?.automaticEdits?.length) lines.push(`   自动字幕校对: ${proofreading.automaticEdits.length}处（保留原ASR与修订依据）`);
    for (const group of proofreading?.reviewGroups || []) {
        const label = group.type === 'possible_foreign_audio' ? '疑似外语串音，建议局部多语言转写核对'
            : group.type === 'superchat_reading' ? `SC朗读疑点（未自动改），原文：${Array.from(group.reference).slice(0, 180).join('')}`
                : `疑词 ${group.original}，候选 ${group.suggestion}（未自动改）`;
        const times = group.occurrences.slice(0, 3).map(row => `${Math.max(0, row.start - result.window.start).toFixed(1)}秒`).join('、');
        lines.push(`   字幕复核建议: ${label}；${group.occurrences.length}处，片内${times}${group.occurrences.length > 3 ? '等' : ''}`);
    }
    if (result.renderedSubtitles) lines.push(`   字幕修订: r${result.renderedSubtitles.revision} | ${result.renderedSubtitles.path}`);
    if (result.durationApproval) lines.push(`   长片保留理由: ${result.durationApproval.note}`);
    if (result.ownStreamHumanReview?.status === 'approved') lines.push(`   人工复核记录: ${result.ownStreamHumanReview.note}`);
    if (!uploadEligible(result) || metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]) {
        if (result.attributionReview?.reason) lines.push(`   复核说明: ${result.attributionReview.reason}`);
        else if (!includeIssues && !result.selectionRejection) {
            const status = reviewStatus(result, metadata);
            const explanation = result.output?.mediaError || result.output?.coverError
                || (status === '复核不可用' ? '未获得可用的人物复核结果，需要人工确认片中人物和动作。' : '发布文案或证据尚未通过复核，请结合原文和视频确认。');
            lines.push(`   复核说明: ${explanation}`);
        }
        const excerpts = result.grounding?.subtitles?.slice(0, 2) || [];
        if (excerpts.length) {
            lines.push(`   原文节选: ${excerpts.map(row => `${row.id} ${Array.from(String(row.text || '')).slice(0, 180).join('')}`).join(' / ')}`);
        }
        if (result.selectionRejection) {
            const rejected = result.selectionRejection;
            lines.push(`   剔除详情: 原候选 ${rejected.candidateIndex ?? '?'}; ${rejected.startCueId || '?'} - ${rejected.endCueId || '?'}`);
            if (Number.isFinite(rejected.maxClipSeconds)) lines.push(`   时长上限: ${rejected.maxClipSeconds}秒`);
        }
        lines.push(includeIssues ? '   暂不可上传；需先解决以上核对项。' : '   暂不可上传，待人工复核。');
    }
    return lines;
}

function diagnosticLines(metadata = {}) {
    const status = metadata.aiStatus || {};
    const values = [];
    for (const event of status.attribution?.events || []) {
        const ids = (event.clipIds || []).map(id => {
            const mapped = metadata.uploadRegistry?.clipIdsByReviewIndex?.[Number(String(id).replace(/^c/, ''))];
            return mapped ? `ID${mapped}` : id;
        });
        values.push(`${event.phase || 'actor-review'}: ${event.error || event.reason || event.status}${ids.length ? ` [${ids.join(',')}]` : ''}`);
    }
    for (const key of ['dialogueError', 'repairError']) {
        const error = status.attribution?.[key];
        if (error && !values.some(value => value.includes(error))) values.push(`${key}: ${error}`);
    }
    for (const request of status.requests || []) {
        if (request.status && request.status !== 'success') values.push(`${request.phase || 'AI'}: ${request.error || request.status}`);
    }
    for (const error of status.errors || []) values.push(typeof error === 'string' ? error : JSON.stringify(error));
    for (const skipped of status.skippedChunks || []) values.push(`跳过分块: ${JSON.stringify(skipped)}`);
    for (const failed of status.renderErrors || []) values.push(`候选 ${failed.index} ${failed.title || ''}: ${failed.error}`);
    if (metadata.registrationError) values.push(`编号登记失败: ${metadata.registrationError}`);
    if (metadata.fatalError) values.push(`处理失败: ${metadata.fatalError}`);
    return [...new Set(values)].map(value => `- ${String(value).replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]')}`);
}

module.exports = { reviewIndex, chronologicalResults, withRegistryIndices, summaryLines, uploadEligible, reviewIssues, reviewStatus, explainIssue, clipId, reviewDetailLines, diagnosticLines };
