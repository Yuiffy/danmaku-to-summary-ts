'use strict';

// Editorial scores are not probabilities. Never compare recall/heat scores with this scale.
const MODEL_SOURCES = new Set(['model_global_rerank', 'model_full_context', 'model_chunked']);
const DEFAULTS = Object.freeze({ mode: 'all', roomIds: ['25788785'], minScore: 80,
    maxStandalone: 18, standoutScore: 92,
    bundles: { enabled: false, minScore: 70, protectScore: 90, maxGroups: 2, maxMembers: 3,
        maxSeconds: 300, minCombinedScore: 85, minScoreGain: 5, maxCandidates: 20 } });

function resolvePolicy(raw = {}, roomId) {
    const policy = { ...DEFAULTS, ...raw, bundles: { ...DEFAULTS.bundles, ...raw.bundles } };
    if (!['all', 'score', 'curated', 'shadow'].includes(policy.mode)) throw new Error('Invalid publication mode');
    if (!Array.isArray(policy.roomIds) || !policy.roomIds.length) throw new Error('publicationPolicy.roomIds must be an explicit allowlist');
    const range = (name, value, min, max, integer = false) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new Error(`Invalid publicationPolicy.${name}`);
        }
    };
    for (const field of ['minScore', 'standoutScore']) range(field, policy[field], 0, 100);
    if (policy.standoutScore < policy.minScore) throw new Error('standoutScore must be >= minScore');
    range('maxStandalone', policy.maxStandalone, 1, 100, true);
    for (const field of ['minScore', 'protectScore', 'minCombinedScore', 'minScoreGain']) range(`bundles.${field}`, policy.bundles[field], 0, 100);
    for (const [field, min, max] of [['maxGroups', 1, 5], ['maxMembers', 2, 4], ['maxCandidates', 2, 50]]) {
        range(`bundles.${field}`, policy.bundles[field], min, max, true);
    }
    range('bundles.maxSeconds', policy.bundles.maxSeconds, 30, 900);
    if (typeof policy.bundles.enabled !== 'boolean') throw new Error('Invalid publicationPolicy.bundles.enabled');
    if (policy.bundles.minScore >= policy.bundles.protectScore) throw new Error('Bundle score interval must be nonempty');
    return { ...policy, requestedMode: policy.mode,
        mode: policy.roomIds.map(String).includes(String(roomId)) ? policy.mode : 'all' };
}

function editorialScore(clip) {
    if (!MODEL_SOURCES.has(clip.selectionSource)) return null;
    const score = clip.globalSelection?.score ?? (clip.selectionSource === 'model_chunked' ? clip.modelScore : clip.score);
    return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function selectPublication(clips, raw = {}, roomId) {
    const policy = resolvePolicy(raw, roomId);
    const rows = clips.map((clip, index) => ({ index: index + 1, clip, score: editorialScore(clip) }));
    const ranked = rows.filter(row => row.score !== null && row.score >= policy.minScore)
        .sort((a, b) => b.score - a.score || a.clip.start - b.clip.start || a.index - b.index);
    const protectedRows = ranked.filter(row => row.score >= policy.standoutScore);
    const selected = policy.mode === 'all' ? rows : policy.mode === 'score' ? ranked
        : ranked.slice(0, Math.max(policy.maxStandalone, protectedRows.length));
    const selectedIds = new Set(selected.map(row => row.index));
    const decisions = rows.map(row => ({ index: row.index, candidateIndex: row.clip.candidateIndex ?? null,
        start: row.clip.start, end: row.clip.end, title: row.clip.title, score: row.score,
        selected: selectedIds.has(row.index), protected: policy.mode !== 'all' && row.score !== null && row.score >= policy.standoutScore,
        reason: policy.mode === 'all' ? 'legacy_all' : row.score === null ? 'unscored'
            : row.score < policy.minScore ? 'below_score' : !selectedIds.has(row.index) ? 'batch_budget'
                : row.score >= policy.standoutScore ? 'standout' : 'selected' }));
    const deferred = rows.filter(row => !selectedIds.has(row.index)).map(row => ({ ...row.clip,
        publication: decisions[row.index - 1] }));
    const effective = policy.mode === 'shadow' ? rows : rows.filter(row => selectedIds.has(row.index));
    return { clips: effective.map(row => policy.mode === 'all' ? row.clip : { ...row.clip, publication: decisions[row.index - 1] }),
        report: { version: 1, policy, inputCount: clips.length, recommendedCount: selected.length,
            renderedCount: effective.length, deferredCount: deferred.length,
            protectedOverflow: ['curated', 'shadow'].includes(policy.mode) ? Math.max(0, protectedRows.length - policy.maxStandalone) : 0,
            decisions, deferred, bundles: { status: 'disabled', proposals: [] } } };
}

const REASONS = { legacy_all: '原模式', unscored: '没有可比较的模型分数', below_score: '低于分数底线',
    batch_budget: '本场优先名额以外', standout: '高分独立保留', selected: '优先独立投稿' };
function summaryLines(report) {
    if (!report || report.policy.mode === 'all') return [];
    return [`发布筛选${report.policy.mode === 'shadow' ? '（仅观察，仍制作全部）' : ''}: ${report.inputCount} 条候选 → ${report.recommendedCount} 条优先独立，${report.deferredCount} 条保留待选。`,
        ...(report.protectedOverflow ? [`高分独立片超过预算 ${report.protectedOverflow} 条，全部保留，不纳入合辑。`] : []),
        ...(report.bundles?.proposals?.length ? [`另有 ${report.bundles.proposals.length} 个关联合辑建议，需复核后单独制作。`] : []),
        ...(report.reviewPath ? [`筛选依据与待选库: ${report.reviewPath}`] : [])];
}

function publicationMarkdown(report) {
    const lines = ['# 本场发布取舍', '', ...summaryLines(report), '',
        '评分仅用于编辑比较，不代表播放量预测。待选项没有被删除，也没有获得投稿授权。', '',
        '| 原候选序号 | 分数 | 决定 | 标题 |', '| --- | --- | --- | --- |'];
    for (const row of report.decisions) lines.push(`| ${row.index} | ${row.score ?? '未知'} | ${REASONS[row.reason]} | ${String(row.title || '').replace(/\|/g, '／').replace(/[\r\n]/g, ' ')} |`);
    lines.push('', '## 关联合辑建议', '', '建议保留各段完整起因与收束，按原时间顺序拼接；新合辑需重新检查文案、归属和字幕，不能继承单片审核。');
    const bundles = report.bundles || {};
    if (!bundles.proposals?.length) lines.push('', `本次没有合辑建议（${bundles.status || 'disabled'}）。`);
    for (const [index, group] of (bundles.proposals || []).entries()) {
        lines.push('', `${index + 1}. ${group.title}（待核文案）`, `   原候选序号: ${group.memberIndices.join(',')}；合计 ${group.duration.toFixed(1)} 秒`,
            `   关系: ${group.relation}`, `   组合增益: ${group.payoff}；模型组合评分 ${group.combinedScore}`);
    }
    if (bundles.error) lines.push('', `合辑建议未完成: ${bundles.error}`);
    lines.push('', '原候选序号仅用于本文件与导出计划，不是上传 ID。');
    return lines.join('\n') + '\n';
}

module.exports = { DEFAULTS, resolvePolicy, editorialScore, selectPublication, summaryLines, publicationMarkdown };
