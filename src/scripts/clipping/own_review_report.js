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

function automaticEnqueueIssue(result, metadata = {}) {
    const publication = metadata.automaticPublication;
    if (!publication?.enabled) return null;
    const state = metadata.uploadRegistry?.clipStatusByReviewIndex?.[reviewIndex(result, 0)];
    if (['uploaded', 'queued', 'uploading', 'rendering'].includes(state)) return null;
    const id = clipId(result, metadata);
    const receipt = id && publication.results?.find(row => Number(row.id) === id);
    if (receipt?.status === 'duplicate') {
        const duplicateOf = Number(receipt.duplicateOf);
        return { kind: 'duplicate', message: Number.isSafeInteger(duplicateOf) && duplicateOf > 0
            ? `与既有ID${duplicateOf}重复，已跳过，无需处理。` : '与既有稿件重复，已跳过，无需处理。' };
    }
    if (receipt?.status === 'needs_human' || receipt?.error) return {
        kind: 'blocked', message: String(receipt.error || '自动入队条件未通过，请检查本地审核和队列记录。')
    };
    if (result.publicationDecision?.action !== 'auto_queue') return null;
    if (publication.outcomeUnknown) return { kind: 'unknown', message: '入队结果尚未确认，请先核对队列，勿重复入队。' };
    if (publication.error) return { kind: 'blocked', message: String(publication.error) };
    return null;
}

function summaryLines(results, metadata = {}) {
    if (metadata.planOnly) return [];
    if (metadata.automaticPublication?.enabled) {
        const status = result => metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex];
        const uploaded = results.filter(result => status(result) === 'uploaded');
        const queued = results.filter(result => status(result) === 'queued');
        const processing = results.filter(result => ['uploading', 'rendering'].includes(status(result)));
        const remaining = results.filter(result => !uploaded.includes(result) && !queued.includes(result) && !processing.includes(result));
        const cancelled = remaining.filter(result => status(result) === 'cancelled');
        const rejected = remaining.filter(result => !cancelled.includes(result) && (result.selectionRejection || result.publicationDecision?.action === 'rejected'));
        const duplicates = remaining.filter(result => !cancelled.includes(result) && !rejected.includes(result) && automaticEnqueueIssue(result, metadata)?.kind === 'duplicate');
        const ready = remaining.filter(result => !cancelled.includes(result) && !rejected.includes(result) && uploadEligible(result)
            && !automaticEnqueueIssue(result, metadata) && !metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex] && status(result) !== 'failed');
        return [`总候选 ${results.length} | 已投稿 ${uploaded.length} | 已排队 ${queued.length}${processing.length ? ` | 投稿处理中 ${processing.length}` : ''} | 待入队 ${ready.length} | 待人工复核或异常 ${remaining.length - ready.length - rejected.length - duplicates.length - cancelled.length}${duplicates.length ? ` | 重复已跳过 ${duplicates.length}` : ''}${cancelled.length ? ` | 已跳过 ${cancelled.length}` : ''} | 未通过 ${rejected.length}`,
            'AI审核通过的切片自动入队，只需处理待复核或异常项。投稿状态在清单内展示，不另发成功通知。'];
    }
    const uploaded = results.filter(result => metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex] === 'uploaded');
    const uploadActive = results.filter(result => ['queued', 'uploading', 'rendering'].includes(metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex]));
    const ready = results.filter(result => uploadEligible(result) && !metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]
        && !uploaded.includes(result) && !uploadActive.includes(result));
    const rejected = results.filter(result => result.selectionRejection);
    const readyIds = ready.map((result, index) => clipId(result, metadata, index)).filter(Boolean);
    const deferred = results.filter(result => result.preRenderHold).length;
    return [`总候选 ${results.length}${uploaded.length ? ` | 已上传 ${uploaded.length}` : ''}${uploadActive.length ? ` | 投稿处理中 ${uploadActive.length}` : ''} | 成片待审核 ${ready.length} | 待复核或异常 ${results.length - ready.length - rejected.length - uploaded.length - uploadActive.length} | 剔除 ${rejected.length}`,
        ...(readyIds.length ? [`上传短ID: ${readyIds.join(',')}`] : []),
        ...(deferred ? [`${deferred}条已暂缓烧录，确认后按原编号制作。`] : []),
        ...(metadata.aiStatus?.attribution?.automaticallyRepaired ? [`AI复查已自动解决${metadata.aiStatus.attribution.automaticallyRepaired}条候选的问题。`] : []),
        '候选 ID 用于定位，不代表已审核或已授权上传。'];
}

function uploadEligible(result) {
    return !result.preRenderHold && !result.rebuildRequired && !result.publicCopyPending && !result.selectionRejection && result.uploadReady !== false
        && !result.output?.mediaError && !result.output?.coverError
        && (!result.automaticPublicationRequired || result.ownStreamHumanReview?.status === 'approved'
            || (result.publicationReview?.status === 'passed' && result.publicationDecision?.action === 'auto_queue'))
        && (!(result.qaRequired || result.attributionRequired) || result.uploadReady === true);
}

function reviewIssues(result, metadata = {}) {
    const humanApproved = result.ownStreamHumanReview?.status === 'approved';
    const issues = [
        ...(!humanApproved && result.sourceReview?.status !== 'passed' ? result.sourceReview?.issues || [] : []),
        ...(!humanApproved ? result.attributionReview?.issues || [] : []), ...(!humanApproved ? result.qaResult?.issues || [] : []),
        ...(!humanApproved && result.publicationReview?.status !== 'passed' ? result.publicationReview?.issues || [] : []),
        ...(!humanApproved && result.publicationDecision?.action !== 'auto_queue' ? result.publicationDecision?.reasons || [] : []),
        ...(result.grounding?.issues || []),
        ...(metadata.uploadRegistry?.reviewIssuesByReviewIndex?.[result.reviewIndex] || [])
    ];
    if (result.selectionRejection) issues.unshift(`selection_rejected:${result.selectionRejection.reason}`);
    if (result.rebuildRequired) issues.unshift('subtitle_revision_needs_render');
    if (result.output?.mediaError) issues.unshift(`media_failed:${result.output.mediaError}`);
    if (result.output?.coverError) issues.unshift(`cover_failed:${result.output.coverError}`);
    if (!humanApproved && result.attributionRequired && result.attributionReview?.status !== 'passed' && !issues.length) issues.push('actor_review_unavailable');
    if (result.publicCopyPending && !issues.length) issues.push('public_copy_pending');
    if (!humanApproved && result.automaticPublicationRequired && result.publicationReview?.status !== 'passed' && !issues.length) issues.push('publication_review_unavailable');
    return [...new Set(issues.map(String))].filter(issue => !(result.publicCopyPending && issue.startsWith('clip public copy is pending;')));
}

function reviewStatus(result, metadata = {}) {
    const state = metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex];
    const uploadedLabel = metadata.automaticPublication?.enabled ? '已投稿' : '已上传';
    if (state === 'uploaded') return metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex] ? `${uploadedLabel}（当前资料待复核）` : uploadedLabel;
    if (state === 'queued') return metadata.automaticPublication?.enabled ? '已排队投稿' : '已排队上传';
    if (state === 'uploading') return '正在上传';
    if (state === 'rendering') return '上传队列正在制作';
    if (state === 'cancelled') return '已跳过投稿';
    if (state === 'failed') return '投稿失败';
    const enqueueIssue = automaticEnqueueIssue(result, metadata);
    if (enqueueIssue?.kind === 'duplicate') return `重复已跳过（${enqueueIssue.message}）`;
    if (enqueueIssue?.kind === 'unknown') return '入队结果待确认（勿重复入队）';
    if (enqueueIssue?.kind === 'blocked') return '自动入队受阻（待处理）';
    if (result.rebuildRequired) return '字幕已修订（待重压）';
    if (result.sourceReview?.status === 'rejected') return '选材未通过（未制作）';
    if (result.selectionRejection) return '已剔除（未切）';
    if (result.preRenderHold) return '待确认（已暂缓烧录）';
    if (result.output?.mediaError || result.output?.coverError) return '制作异常';
    if (result.automaticPublicationRequired && result.ownStreamHumanReview?.status !== 'approved') {
        if (result.publicationDecision?.action === 'rejected' || result.publicationReview?.status === 'rejected') return '审核未通过';
        if (!result.publicationReview || result.publicationReview.status === 'unavailable') return '最终复核不可用';
        if (result.publicationReview.status !== 'passed' || result.publicationDecision?.action !== 'auto_queue') return '待人工复核';
    }
    if (reviewIssues(result).some(issue => /actor_review_(unavailable|failed|time_budget)|actor_evidence_exceeds_budget/.test(issue))) return '复核不可用';
    if (!uploadEligible(result) || metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]) return '待复核';
    if (metadata.automaticPublication?.enabled && result.publicationDecision?.action === 'auto_queue') return 'AI审核通过（待入投稿队列）';
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
        [/^publication_review_unavailable/, '未取得可用的最终成片审核，需要人工核对'],
        [/^final_content_not_passed|^source_window_incomplete|^story_repair_pending/, '片段起承转合或结尾需核对'],
        [/^final_attribution_not_passed|^attribution_not_passed/, '人物、原话和动作归属需核对'],
        [/^final_subtitles_not_passed|^subtitle_review_groups_pending/, '字幕仍有疑点，需要核对原音'],
        [/^final_visuals_not_passed/, '字幕、封面或画面需核对'],
        [/^final_policy_not_passed/, '内容是否符合本房间选材范围需核对'],
        [/^(?:attribution|parsed|required_qa)_evidence_stale|^publication_evidence_changed_during_review/, '内容或来源已变动，需要重新审核'],
        [/^audio_(?:qa_not_passed|listening_review_pending)/, '音频或听审未通过'],
        [/^missing_actual_cover_or_video_frames/, '缺少实际封面或成片画面证据'],
        [/^missing_burned_subtitles/, '未确认字幕已经烧入视频'],
        [/^missing_media_or_subtitles/, '缺少成片或字幕文件'],
        [/^missing_cover/, '缺少封面'],
        [/^incomplete_public_copy/, '发布文案不完整'],
        [/^required_qa_not_passed|^technical_review_not_passed|^final_review_(?:needs_review|rejected)/, '成片质检未通过，需要核对本地审核记录'],
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
    const state = metadata.uploadRegistry?.clipStatusByReviewIndex?.[result.reviewIndex];
    if (!includeIssues && state === 'cancelled') return [`   理由: ${require('../workflow-runtime').loadWorkflow('clipping/reviewDigest').shortChineseReason(metadata.uploadRegistry?.editorialExclusionsByReviewIndex?.[result.reviewIndex]?.reason, '已取消本候选的投稿')}`];
    const enqueueIssue = automaticEnqueueIssue(result, metadata);
    if (!includeIssues && enqueueIssue?.kind === 'duplicate') return [];
    if (!includeIssues && metadata.automaticPublication?.enabled
        && ['uploaded', 'queued', 'uploading', 'rendering'].includes(state)
        && !metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]) return [];
    const issues = reviewIssues(result, metadata);
    if (!includeIssues) {
        const pending = !uploadEligible(result) || metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex];
        const brief = require('../workflow-runtime').loadWorkflow('clipping/reviewDigest');
        const lines = pending ? brief.compactReviewLines(result, issues) : [];
        if (enqueueIssue && enqueueIssue.kind !== 'duplicate') lines.unshift(`   自动投稿: ${brief.shortChineseReason(enqueueIssue.message, '入队条件待核')}`);
        if (pending) lines.push(state === 'uploaded' ? '   已投稿；如有异常请在B站修改。' : '   暂不可上传，回复编号＋改法。');
        return lines;
    }
    const lines = require('./review_brief').briefLines(result, issues);
    if (enqueueIssue && enqueueIssue.kind !== 'duplicate') lines.push(`   自动投稿: ${String(enqueueIssue.message).replace(/\s+/g, ' ').replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]').slice(0, 240)}`);
    if (includeIssues) lines.push(...issues.map(issue => `   核对项: ${explainIssue(issue)}`));
    else if (result.ownStreamHumanReview?.status !== 'approved' && result.publicationReview?.status !== 'passed') {
        const explanations = [...new Set((result.publicationReview?.issues || []).map(issue => {
            const text = String(issue), explained = explainIssue(text);
            return explained !== text ? explained.slice(0, -(text.length + 3))
                : /[\u3400-\u9fff]/u.test(text) ? text : '最终成片审核仍有未解决项，详情见本地REVIEW。';
        }))];
        if (explanations.length) lines.push(`   最终复核: ${explanations.slice(0, 3).join('；')}${explanations.length > 3 ? '；其余见本地REVIEW。' : ''}`);
    }
    if (result.preRenderHold) lines.push(`   审核方式: 先看字幕或打开源录播 ${result.source?.mediaPath || ''}；回复编号和改法，确认后再制作。`);
    const proofreading = result.subtitleProofreading;
    const angles = result.viewingAngles || [];
    const concise = !includeIssues && result.attributionReview?.humanChecks?.length > 0;
    if (angles.length && !concise) lines.push(`   看点线索（待核）: ${angles.map(angle => `${angle.label}：${angle.hook}`).join(' / ')}`);
    if (result.quoteEchoes?.length && !concise) lines.push(`   台词线索（字幕/弹幕重合）: ${result.quoteEchoes.map(row =>
        `${Math.max(0, row.start - result.window.start).toFixed(1)}秒 ${row.quote}`).join(' / ')}`);
    if (proofreading?.automaticEdits?.length) lines.push(`   自动字幕校对: ${proofreading.automaticEdits.length}处（保留原ASR与修订依据）`);
    for (const group of proofreading?.reviewGroups || []) {
        const label = group.type === 'possible_foreign_audio' ? '疑似外语串音，建议局部多语言转写核对'
            : group.type === 'superchat_reading' ? `SC朗读疑点（未自动改），原文：${Array.from(group.reference).slice(0, 180).join('')}`
                : `疑词 ${group.original}，候选 ${group.suggestion}（未自动改）`;
        const times = group.occurrences.slice(0, 3).map(row => `${Math.max(0, row.start - result.window.start).toFixed(1)}秒`).join('、');
        lines.push(`   字幕复核建议: ${label}；${group.occurrences.length}处，片内${times}${group.occurrences.length > 3 ? '等' : ''}`);
    }
    if (result.renderedSubtitles) lines.push(`   字幕修订: r${result.renderedSubtitles.revision} | ${result.renderedSubtitles.path}`);
    if (includeIssues && result.topicEditPlan) {
        lines.push(`   话题收束: ${result.topicEditPlan.closingReason}`);
        for (const row of result.topicEditPlan.ranges) lines.push(`   ${row.action === 'keep' ? '保留' : '删去'} ${row.start.toFixed(2)}-${row.end.toFixed(2)}秒（源录播）: ${row.reason}`);
    }
    if (includeIssues && result.endingHold) lines.push(`   结尾余韵: ${result.endingHold.seconds.toFixed(2)}秒`);
    if (result.durationApproval) lines.push(`   长片保留理由: ${result.durationApproval.note}`);
    if (result.ownStreamHumanReview?.status === 'approved') lines.push(`   人工复核记录: ${result.ownStreamHumanReview.note}`);
    if (!uploadEligible(result) || metadata.uploadRegistry?.reviewPendingByReviewIndex?.[result.reviewIndex]) {
        if (result.attributionReview?.reason && !concise) lines.push(`   复核说明: ${result.attributionReview.reason}`);
        else if (result.publicationReview?.reason && !concise) lines.push(`   复核说明: ${result.publicationReview.reason}`);
        else if (!includeIssues && !concise && !result.selectionRejection) {
            const status = reviewStatus(result, metadata);
            const explanation = result.output?.mediaError || result.output?.coverError
                || (status === '最终复核不可用' ? '未获得可用的最终成片审核，需要人工核对视频、字幕、封面和发布文案。'
                    : status === '复核不可用' ? '未获得可用的人物复核结果，需要人工确认片中人物和动作。' : '发布文案或证据尚未通过复核，请结合原文和视频确认。');
            lines.push(`   复核说明: ${explanation}`);
        }
        const excerpts = result.grounding?.subtitles?.slice(0, 2) || [];
        if (excerpts.length && !concise) {
            lines.push(`   原文节选: ${excerpts.map(row => `${row.id} ${Array.from(String(row.text || '')).slice(0, 180).join('')}`).join(' / ')}`);
        }
        if (result.selectionRejection) {
            const rejected = result.selectionRejection;
            lines.push(`   剔除详情: 原候选 ${rejected.candidateIndex ?? '?'}; ${rejected.startCueId || '?'} - ${rejected.endCueId || '?'}`);
            if (Number.isFinite(rejected.maxClipSeconds)) lines.push(`   时长上限: ${rejected.maxClipSeconds}秒`);
        }
        if (state === 'uploaded') lines.push('   已投稿，当前资料待复核；如有异常请在B站修改。');
        else lines.push(includeIssues ? '   暂不可上传；需先解决以上核对项。' : '   暂不可上传，待人工复核。');
    }
    return lines;
}

function quickReviewLines(results, metadata = {}) {
    const lines = [];
    for (const result of chronologicalResults(results)) {
        if (result.selectionRejection || (result.ownStreamHumanReview?.status === 'approved' && !result.rebuildRequired)) continue;
        const brief = require('./review_brief').briefLines(result, reviewIssues(result, metadata));
        const groups = result.subtitleProofreading?.reviewGroups || [];
        if (!brief.length && !groups.length) continue;
        const id = clipId(result, metadata);
        lines.push(`- ${id ? `ID${id}` : `候选${result.reviewIndex}`} ${String(result.copy?.title || '').slice(0, 60)}`);
        lines.push(...brief.map(line => `  ${line.trim()}`));
        if (groups.length) lines.push(`  字幕还有${groups.length}组疑点，见该编号下的字幕复核建议。`);
    }
    return lines.length ? ['## 快速确认', '', '回复“编号＋改法”即可，例如“ID123：这里是转述，标题加上回忆”。', '', ...lines, ''] : [];
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
    const publication = metadata.automaticPublication;
    if (publication?.enabled) {
        if (publication.outcomeUnknown) values.push('自动入队结果尚未确认；以注册表中的已排队/已投稿状态为准，其余先核对队列，勿重复入队。');
        if (publication.error) values.push(`自动入队异常: ${publication.error}`);
        for (const result of publication.results || []) {
            const index = Object.keys(metadata.uploadRegistry?.clipIdsByReviewIndex || {}).find(key => Number(metadata.uploadRegistry.clipIdsByReviewIndex[key]) === Number(result.id));
            if (['uploaded', 'queued', 'uploading', 'rendering'].includes(metadata.uploadRegistry?.clipStatusByReviewIndex?.[index])) continue;
            if (result.status === 'needs_human' || result.error) values.push(`自动入队 ID${result.id}: ${result.error || '入队条件未通过，待处理。'}`);
            else if (result.status === 'duplicate') values.push(`自动投稿 ID${result.id}: ${result.duplicateOf ? `与既有ID${result.duplicateOf}重复` : '与既有稿件重复'}，已跳过，无需处理。`);
        }
    }
    if (metadata.fatalError) values.push(`处理失败: ${metadata.fatalError}`);
    return [...new Set(values)].map(value => `- ${String(value).replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]')}`);
}

module.exports = { reviewIndex, chronologicalResults, withRegistryIndices, summaryLines, uploadEligible, reviewIssues, reviewStatus, explainIssue, clipId, reviewDetailLines, quickReviewLines, diagnosticLines };
