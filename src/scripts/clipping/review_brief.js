'use strict';

const short = (text, length = 90) => String(text || '').replace(/\s+/g, ' ').slice(0, length);
const clock = seconds => {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

function issueQuestion(issue, claim = {}) {
    const action = short(claim.action, 28);
    const name = short(claim.narrator || claim.actor, 16);
    if (/^(missing_speaker_citation|speaker_citation_conflict|speaker_dialogue_conflict|unproven_narrator|unproven_dialogue_narrator|unresolved_named_actor)/u.test(issue)) {
        return `确认${name ? `“${name}”` : '是谁'}说的${action ? `“${action}”` : '这句话'}，有无插话或转述？`;
    }
    if (/^invalid_action_citation/u.test(issue)) return `确认${action ? `“${action}”` : '文案描述的事情'}确实在这一段发生，还是借用了前后话题？`;
    if (/^(unproven_actor|unproven_target|person_only_in_danmaku|unproven_role|role_reference)/u.test(issue)) return `确认${short(claim.target || claim.actor, 16) || '被提到的人'}是谁，原话中的称呼是否支持文案？`;
    if (/^unsupported_quote/u.test(issue)) return `核对${short(String(issue).split(':').slice(2).join(':'), 35) || '引号里的话'}是否原话；非原话建议去掉引号。`;
    if (/^unsupported_number/u.test(issue)) return `核对文案中的数字${short(String(issue).split(':').slice(2).join(':'), 24)}，是否听错或夸大。`;
    if (/^(unseen_danmaku|danmaku_outside_clip|audience_attribution|audience_claim|invalid_audience_claim)/u.test(issue)) return '确认观众的这句话是否属于本段，文案有没有写成主播说的？';
    if (/^(question_action_removed|recount_as_live)/u.test(issue)) return '确认这里是在提问或转述，文案是否误写成已经发生的事实？';
    if (/^actor_(review_|evidence_)/u.test(issue)) return 'AI复核未完成；需要核对本段人物、原话和发布文案。';
    if (/^media_failed/u.test(issue)) return '视频或字幕制作失败，需要重试制作。';
    if (/^cover_failed/u.test(issue)) return '封面制作失败，需要重试封面。';
    if (/^subtitle_revision_needs_render/u.test(issue)) return '字幕已经改好，需要重压后再看成片。';
    if (/^selection_rejected/u.test(issue)) return '候选未制作；确认是否值得保留及时间范围。';
    if (/^(known_person_anonymized|guest_name_missing)/u.test(issue)) return '人物已经有依据，请把文案中的泛称改成她的公开称呼。';
    return '确认本段原话是否支持标题和封面，指出需要改的那一句。';
}

function fallbackChecks(packet, review, issues) {
    return issues.filter(issue => issue !== 'model_requires_review').map(issue => {
        const index = /:(\d+)$/u.exec(issue)?.[1];
        const claim = index ? review?.claims?.[Number(index) - 1] : null;
        const ids = (Array.isArray(claim?.cueIds) ? claim.cueIds : []).filter(id => packet.cueIds.has(id));
        return { question: issueQuestion(issue, claim || {}), suggestion: '', cueIds: [...new Set(ids)],
            evidence: [...new Set(ids)].slice(0, 3).map(id => {
                const { start, end, text } = packet.evidence.byId.get(id);
                return { id, start, end, text };
            }) };
    }).filter((check, index, all) => all.findIndex(other => other.question === check.question) === index);
}

function briefLines(result, issues = []) {
    if (result.ownStreamHumanReview?.status === 'approved' && !result.rebuildRequired) return [];
    const pending = result.publicCopyPending || result.uploadReady === false || result.attributionReview?.status === 'needs_review';
    if (!pending || result.selectionRejection) return [];
    const checks = result.attributionReview?.humanChecks?.length ? result.attributionReview.humanChecks
        : issues.map(issue => ({ question: issueQuestion(issue), evidence: [] }));
    const unique = checks.filter((check, index) => checks.findIndex(other => other.question === check.question) === index);
    return unique.flatMap(check => {
        const evidence = (check.evidence || []).filter(row => Number.isFinite(row.start) && Number.isFinite(row.end)
            && row.start >= result.window.start && row.end <= result.window.end);
        const time = evidence.length ? `片内${clock(evidence[0].start - result.window.start)}（录播${clock(evidence[0].start)}）` : '本段';
        return [`   请确认: ${time}，${short(check.question, 100)}${check.suggestion ? ` 建议：${short(check.suggestion)}` : ''}`,
            ...(evidence.length ? [`   对应原话: ${evidence.slice(0, 2).map(row => `“${short(row.text, 70)}”`).join(' / ')}`] : [])];
    });
}

module.exports = { issueQuestion, fallbackChecks, briefLines };
