import * as fs from 'fs';
import { deferredSelectionRows } from './reviewSelectionHistory';

type Data = Record<string, any>;
const short = (text: unknown, limit = 80): string => {
    const value = String(text || '').replace(/\s+/gu, ' ').trim();
    return Array.from(value).length > limit ? Array.from(value).slice(0, limit - 1).join('') + '…' : value;
};
const clock = (seconds: number): string => {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const labels: Array<[RegExp, string]> = [
    [/^selection_rejected:duration_out_of_bounds/u, '时长超出规则范围'],
    [/^selection_rejected:overlap/u, '与保留片段重叠'],
    [/^selection_rejected:max_clips_limit/u, '超出本批候选数上限'],
    [/^selection_rejected:public_copy_evidence_dropped/u, '公开文案缺少片内依据'],
    [/^selection_rejected:topic_boundary_incomplete/u, '话题边界未闭合'],
    [/^subtitle_revision_needs_render/u, '新字幕待重压'],
    [/^media_failed/u, '视频制作失败'], [/^cover_failed/u, '封面制作失败'],
    [/^publication_review_unavailable|^automatic_activity_review_unavailable/u, '未获得可用的最终成片审核'],
    [/^actor_review|^actor_evidence/u, '未获得可用的人物复核结果'],
    [/^missing_speech_evidence/u, '缺少可核查的原话证据'],
    [/source_window_incomplete|final_content_not_passed|story_repair_pending/u, '片段结尾或上下文不完整'],
    [/final_subtitles_not_passed|subtitle_review_groups_pending/u, '字幕疑词待核原音'],
    [/final_attribution_not_passed|missing_speaker|unproven_|audience_attribution/u, '人物或原话归属待确认'],
    [/unsupported_quote/u, '引号内容与原话不符'], [/unsupported_number/u, '文案数字缺少依据'],
    [/danmaku_outside_clip/u, '引用弹幕不在本段'], [/invalid_action_citation/u, '文案动作缺少片内依据'],
    [/final_visuals_not_passed/u, '字幕、封面或画面待核'],
    [/final_policy_not_passed/u, '选材范围待核'],
    [/ending boundary|continuous viewing session ends|boundar.*(?:unclosed|uncertain)/iu, '视听结束点缺少完整上下文'],
    [/family.*(?:cannot|unseen|not.*verif)|排除类别.*(?:不足|无法)|家庭.*未展示/iu, '完整内容的家庭话题排除检查缺少证据'],
    [/required_qa_not_passed|technical_review_not_passed/u, '成片质检未通过'],
    [/^required review flag removed:/u, '来源复核条件有变化，需重新审核'],
    [/public_copy_pending/u, '发布文案待确认'],
    [/timeout|timed out|time_budget_exhausted/iu, '处理超时，结果待核'],
    [/request_budget_exhausted|budget.*(?:exceed|exhaust)/iu, '本轮审核额度已用完'],
    [/automatic submission outcome unknown/iu, '旧投稿结果未确认，需核对线上稿件'],
    [/automatic publication source identity changed/iu, '本次修订需更新投稿授权'],
    [/source.*changed|evidence.*(?:changed|stale)/iu, '来源或审核证据已变动'],
    [/^duplicate|^与.*重复/iu, '与既有稿件重复'],
    [/schema|omitted|invalid.*response/iu, '审核返回内容不完整'],
    [/invalid.*(?:dialogue|evidence)/iu, '人物或对话证据未通过'],
    [/transport|network|fetch|connection/iu, '审核服务连接失败'],
    [/missing.*enqueue.*receipt/iu, '缺少可确认的入队回执'],
    [/^creative_|^pacing_/u, '精切未通过，保留普通版'],
    [/^no_eligible_candidates$/u, '未通过精切入选条件，未调用抽选模型'],
    [/^no_verified_pauses$/u, '没有适合删减的停顿，保留普通版'],
    [/^batch_below_minimum$/u, '本批没有精切名额，保留普通版'],
    [/^model_selected_none$/u, '本批未选中适合精切的片段']
];

/** Machine details stay in local records; original foreign words belong in the separate SRT evidence line. */
export function shortChineseReason(value: unknown, fallback = '发布文案或证据待确认'): string {
    const text = String(value || '').trim();
    const label = labels.find(([pattern]) => pattern.test(text))?.[1];
    if (label) return label;
    const translated = text.replace(/\bASR\b/giu, '语音识别').replace(/\bSC\b/gu, '醒目留言').replace(/\bQA\b/giu, '质检').replace(/\bID(?=\d)/giu, '编号');
    if (/[a-z]{2,}/iu.test(translated)) {
        if (/字幕|错识|识别|乱码|断句/u.test(translated)) return '字幕含疑似乱码或错词，需核对原音';
        return fallback;
    }
    return /[\u3400-\u9fff]/u.test(translated)
        ? short(translated.split(/[；;\n]/u)[0].replace(/(?:需核实|需要核实|现有证据不足).*$/u, ''), 60) || fallback : fallback;
}

/** Presentation only: complete issues and approval remain untouched. */
export function shortReviewReasons(issues: unknown[], fallback = '发布文案或证据待确认'): string[] {
    const values = [...new Set(issues.map(value => String(value || '').trim()).filter(Boolean))]
        .filter(value => !/^(?:final publication review has not passed every required check|clip public copy is pending)/iu.test(value));
    const natural = values.filter(value => /[\u3400-\u9fff]/u.test(value) && !/^[a-z][a-z_]+(?::|$)/u.test(value)
        && !/^(?:The supplied|The generic|本地音频引文和画面支持)/u.test(value));
    const selected = natural.length ? natural : values;
    const reasons = selected.map(value => shortChineseReason(value, fallback)).filter(Boolean);
    return [...new Set(reasons.length ? reasons : [fallback])].slice(0, 2);
}

export function compactReviewLines(result: Data, issues: unknown[]): string[] {
    const lines = [`   理由: ${shortReviewReasons(issues).join('；')}`];
    if (result.reviewPresentation?.windowAuthority === 'recall_context') lines.push('   主题来自原召回记录；展示窗口供查找，裁切边界仍待核。');
    if (result.reviewExcerpt?.timingAuthority === 'recall_context') {
        const topic = String(result.reviewPresentation?.title || result.copy?.title || '');
        const terms = [...new Set([...topic.matchAll(/[\u3400-\u9fff]{2,}/gu)]
            .flatMap(match => Array.from(match[0]).slice(1).map((char, index) => match[0][index] + char)))];
        const affinity = (cue: Data) => terms.filter(term => String(cue.text).includes(term)).length;
        const excerpts = [...(result.reviewExcerpt.subtitles || [])].sort((a, b) => affinity(b) - affinity(a)).slice(0, 2);
        lines.push(excerpts.length ? `   SRT（原召回，时间待校准）: ${excerpts.map((cue: Data) => `“${short(cue.text, 100)}”`).join(' / ')}` : '   SRT: 原召回无完整字幕，待校准后检查');
        lines.push('   弹幕: 范围待校准，暂不引用');
        return lines;
    }
    const window = result.window || {};
    const bounded = Number.isFinite(window.start) && Number.isFinite(window.end);
    const humanEvidence = (result.attributionReview?.humanChecks || []).flatMap((check: Data) => check.evidence || []);
    const supplied = result.reviewExcerpt?.subtitles || [
        ...(result.grounding?.subtitles || []), ...humanEvidence, ...(window.contextSegments || [])
    ];
    const relevant = supplied.filter((cue: Data) => cue.text && (!bounded || cue.timeBasis === 'clip_seconds' || cue.start === undefined
        || cue.end > window.start && cue.start < window.end));
    const citedText = issues.map(String).join(' ');
    const quotes = [...citedText.matchAll(/[“「"『]([^”」"』]{2,80})[”」"』]/gu)].map(match => match[1]);
    const score = (cue: Data) => quotes.reduce((total, quote) => total + (String(cue.text).includes(quote)
        || String(cue.text).length >= 4 && quote.includes(cue.text) ? quote.length : 0), 0);
    relevant.sort((a: Data, b: Data) => score(b) - score(a));
    const ending = /结尾|片尾|收尾|source_window_incomplete/u.test(citedText);
    const selected = quotes.length ? relevant.slice(0, 2) : ending ? relevant.slice(-2) : relevant.slice(0, 2);
    const unique = selected.filter((cue: Data, index: number) => selected.findIndex((other: Data) => other.text === cue.text) === index);
    if (unique.length) lines.push(`   SRT: ${unique.map((cue: Data) => `${Number.isFinite(cue.start) ? `${cue.timeBasis === 'clip_seconds' ? '片内' : '录播'}${clock(cue.start)} ` : ''}${cue.id ? `${cue.id} ` : ''}“${short(cue.text, 65)}”`).join(' / ')}`);
    else lines.push('   SRT: 本地字幕待检查');
    const audience = result.reviewExcerpt?.audience || result.grounding?.audience || window.danmakuContext || [];
    const rows = audience.map((cue: Data | string) => typeof cue === 'string' ? { text: cue } : cue)
        .filter((cue: Data) => cue.text && (!bounded || cue.time === undefined || cue.time >= window.start && cue.time <= window.end));
    if (rows.length) {
        const time = unique.find((cue: Data) => cue.timeBasis !== 'clip_seconds' && Number.isFinite(cue.start))?.start;
        const nearby = Number.isFinite(time) ? rows.filter((cue: Data) => !Number.isFinite(cue.time) || Math.abs(cue.time - time) <= 30) : rows;
        nearby.sort((a: Data, b: Data) => Number.isFinite(time) ? Math.abs((a.time ?? time) - time) - Math.abs((b.time ?? time) - time) : 0);
        lines.push(nearby.length ? `   弹幕（观众）: ${nearby.slice(0, 2).map((cue: Data) => `${Number.isFinite(cue.time) ? `录播${clock(cue.time)} ` : ''}“${short(cue.text, 45)}”`).join(' / ')}` : '   弹幕: 未引用相关弹幕');
    } else lines.push('   弹幕: 未引用相关弹幕');
    return lines;
}

export interface ReviewContextReaders {
    exists(file: string): boolean;
    subtitles(file: string): Data[];
    audience(file: string): Promise<Data[]>;
}
export async function readReviewAudience(file: string): Promise<Data[]> {
    const { parseStringPromise } = await import('xml2js');
    const value = await parseStringPromise(fs.readFileSync(file, 'utf8'), { strict: false, trim: true });
    return (value.i?.d || value.I?.D || []).map((cue: Data) => ({ time: Number(String(cue.$?.p || cue.$?.P || '').split(',')[0]), text: String(cue._ || '') }))
        .filter((cue: Data) => Number.isFinite(cue.time) && cue.text);
}

/** Read current rendered SRT first, converting its times to source seconds; never persist or approve evidence. */
export async function withReviewExcerpts(results: Data[], readers: ReviewContextReaders): Promise<Data[]> {
    const chats = new Map<string, Promise<Data[]>>();
    return Promise.all(results.map(async result => {
        if (result.selectionRejection && !result.output?.mediaPath && result.reviewPresentation?.windowAuthority === 'recall_context') {
            return { ...result, reviewExcerpt: { subtitles: result.reviewPresentation.recallSubtitles || [], audience: [], timingAuthority: 'recall_context' } };
        }
        const window = result.window;
        if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return result;
        let subtitles = result.grounding?.subtitles || [], audience = result.grounding?.audience || [];
        try {
            const rendered = result.output?.srtPath, source = result.source?.srtPath;
            const edited = result.editPlan || result.creativePlan?.timeline;
            if (rendered && readers.exists(rendered)) subtitles = readers.subtitles(rendered)
                .map(cue => edited ? { ...cue, timeBasis:'clip_seconds' } : { ...cue, start: cue.start + window.start, end: cue.end + window.start });
            else if (source && readers.exists(source)) subtitles = readers.subtitles(source)
                .filter(cue => cue.end > window.start && cue.start < window.end);
        } catch { /* Retain saved evidence when a local artifact is unavailable. */ }
        try {
            const xml = result.source?.xmlPath;
            if (xml && readers.exists(xml)) {
                if (!chats.has(xml)) chats.set(xml, readers.audience(xml));
                audience = (await chats.get(xml))!.filter(cue => cue.time >= window.start && cue.time <= window.end);
            }
        } catch { /* An unavailable XML cannot be replaced with invented audience speech. */ }
        return { ...result, reviewExcerpt: { subtitles, audience } };
    }));
}

export function deferredReviewLines(metadata: Data, results: Data[] = []): string[] {
    const rows: Data[] = deferredSelectionRows(metadata).map(row => ({ ...row,
        reason: row.phase === 'publication' ? ({below_score:'低于分数线', batch_budget:'本场优先名额以外', unscored:'缺少可比较分数'} as Data)[row.reason] || row.reason : row.reason }));
    if (!rows.length) return [];
    rows.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    const pathKey = (value: unknown) => String(value || '').replace(/\\/gu, '/').toLowerCase();
    return ['', '低分及其他未入选话题:', '回复“补切备选编号”可选择；R是初选编号，P是发布筛选编号，均不是上传ID。已补切项仍保留原筛选记录。',
        ...rows.map(row => {
            const changedTiming = row.sourceSrtPath && metadata.source?.srtPath && pathKey(row.sourceSrtPath) !== pathKey(metadata.source.srtPath);
            const window = Number.isFinite(row.start) && Number.isFinite(row.end) ? `${clock(row.start)}–${clock(row.end)}` : '时间待查';
            const made = results.find(result => !changedTiming && result.output?.burnedSubtitles === true
                && !result.rebuildRequired && Number.isFinite(row.start) && Number.isFinite(row.end)
                && pathKey(result.source?.srtPath) === pathKey(row.sourceSrtPath || metadata.source?.srtPath)
                && result.window?.start <= row.start && result.window?.end >= row.end);
            const id = made && metadata.uploadRegistry?.clipIdsByReviewIndex?.[made.reviewIndex ?? made.window?.index];
            const resolved = metadata.deferredResolutions?.find((resolution: Data) => resolution.selectionKey === row.selectionKey);
            const resolvedId = id || resolved?.clipId;
            return `- ${row.label} | ${changedTiming ? `原窗口${window}（待校准）` : window} | ${row.score ?? '未评分'}分 | ${short(row.title || `初选话题 ${row.candidateIndex}`, 40)} | ${shortChineseReason(row.reason, '本场暂未优先选择')}${resolvedId ? ` | 已补切ID${resolvedId}` : ''}`;
        })];
}

export function compactDiagnosticLines(metadata: Data): string[] {
    const status = metadata.aiStatus || {}, attribution = status.attribution || {}, values: string[] = [];
    const add = (phase: string, reason: unknown, fallback: string) => values.push(`${phase}：${shortChineseReason(reason, fallback)}`);
    for (const event of attribution.events || []) {
        const ids = (event.clipIds || []).map((id: string) => metadata.uploadRegistry?.clipIdsByReviewIndex?.[Number(String(id).replace(/^c/u, ''))]).filter(Boolean);
        add(`人物复核${ids.length ? `（编号${ids.join('、')}）` : ''}`, event.error || event.reason || event.status, '审核未完成');
    }
    for (const key of ['dialogueError', 'repairError']) if (attribution[key]) add('人物复核', attribution[key], '审核未完成');
    for (const request of status.requests || []) if (request.status && request.status !== 'success') add('智能审核', request.error || request.status, '审核未完成');
    for (const error of status.errors || []) add('选材', typeof error === 'string' ? error : error.message, '选材未完成');
    if (status.skippedChunks?.length) values.push(`选材：${status.skippedChunks.length}个分块未完成`);
    for (const failed of status.renderErrors || []) add(`候选${failed.index}制作`, failed.error, '视频制作失败');
    if (metadata.registrationError) add('编号登记', metadata.registrationError, '登记未完成');
    const publication = metadata.automaticPublication;
    if (publication?.outcomeUnknown) values.push('自动入队：结果待确认，请以列表状态为准');
    if (publication?.error) add('自动入队', publication.error, '入队未完成');
    if (metadata.fatalError) add('批次处理', metadata.fatalError, '处理未完成');
    return [...new Set(values)].slice(0, 4).map(value => `- ${value}`);
}
