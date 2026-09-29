'use strict';

const roles = ['setup', 'context', 'escalation', 'reaction', 'payoff', 'step', 'explanation', 'performance', 'closing'];
const round = n => Math.round(n * 1000) / 1000;

function contextSeconds(config = {}) {
    return Math.max(45, Math.min(600, Number(config.ai?.topicContextSeconds) || 180));
}

function planSchema(cueIds) {
    const string = { type: 'string' };
    const cue = cueIds ? { type: 'string', enum: [...cueIds] } : string;
    return { type: 'object', additionalProperties: false,
        required: ['ranges', 'closingReason', 'continuation', 'nextCueId'], properties: {
            ranges: { type: 'array', minItems: 1, maxItems: 32, items: {
                type: 'object', additionalProperties: false,
                required: ['startCueId', 'endCueId', 'action', 'role', 'reason'], properties: {
                    startCueId: cue, endCueId: cue, action: { type: 'string', enum: ['keep', 'drop'] },
                    role: { type: 'string', enum: roles }, reason: string } } },
            closingReason: string, continuation: { type: 'string', enum: ['next_topic', 'source_end', 'needs_more'] }, nextCueId: cueIds ? { type: 'string', enum: ['', ...cueIds] } : string } };
}

function promptLines() {
    return [
        '选材时同时制定topicEditPlan，不要先截一个笑点再让精切在狭窄窗口里补救。startCueId/endCueId界定完整话题素材窗口，允许明显长于最终成片。',
        'topicEditPlan.ranges按原顺序穷尽窗口内所有G组，每组startCueId/endCueId、action=keep/drop、role、reason。可把同一话题的铺垫、两次尝试、后续回应与结论拼成一个切片，中间无关等待或重复标drop并说明；不能拼无关事件或改变因果。',
        'G编号不连续（相邻多句会合成一组），必须逐字复制表中的实际ID，不能用编号加一推测下一组。段落首尾都用已提供的ID，下一段从上一段之后的实际下一组开始，不重叠不漏组。不要把全部话题无差别keep；逐段判断重复、无进展找图等可删部分，但必要澄清和收束要留。',
        '第一段保留起因，最后一段必须keep且role=closing。角色可用setup/context/escalation/reaction/payoff/step/explanation/performance/closing；一个短交流也可只有一段closing。不能把首次笑点当话题结束，核对第二个例子、后续解释、自我纠正和观众追问是否仍属本题。',
        '必须阅读结束后的第一组字幕：nextCueId填写它，continuation=next_topic并用closingReason解释话题为何确已结束。若仍在继续就扩展窗口；提供的上下文仍不足则continuation=needs_more，不伪造收尾。真正录播结束才用source_end和空nextCueId。',
        '同一个G组可能前半段接完上一句话、后半段才换话题。必须先保留前半段的完整收束；不能只因组内出现新话题就把整组排除。按真实字幕组边界扩展素材窗，不猜词级时间。',
        '短片允许短，但最后一句后程序会保留最多3秒自然余韵，并在下一句开口前停止；需要继续接话时必须选入完整接话，不能靠加静音代替收尾。文案引用必须落在keep段中。'
    ];
}

function normalizePlan(raw, bounds, evidence, allowedIds) {
    if (!raw || !Array.isArray(raw.ranges) || !raw.ranges.length || raw.ranges.length > 32) throw new Error('missing_topic_edit_plan');
    if (!String(raw.closingReason || '').trim() || !['next_topic', 'source_end'].includes(raw.continuation)) throw new Error('topic_needs_more_context');
    const cues = evidence.cues.filter(c => c.start >= bounds.start - .001 && c.end <= bounds.end + .001);
    let cursor = 0;
    const ranges = raw.ranges.map(row => {
        let a = cues.findIndex(c => c.id === row.startCueId);
        const b = cues.findIndex(c => c.id === row.endCueId);
        // Two successive keep descriptions can share a boundary group. Keep it once;
        // conflicting keep/drop decisions and reordering still fail.
        const previous = raw.ranges[raw.ranges.indexOf(row) - 1];
        if (a >= 0 && a < cursor && b >= cursor && previous?.action === row.action
            && row.action === 'keep' && a >= cues.findIndex(c => c.id === previous.startCueId)) a = cursor;
        if (a !== cursor || b < a || !['keep', 'drop'].includes(row.action) || !roles.includes(row.role)
            || !String(row.reason || '').trim() || cues.slice(a, b + 1).some(c => allowedIds && !allowedIds.has(c.id))) {
            throw new Error(`invalid_topic_ranges: expected start ${cues[cursor]?.id || 'END'}, got ${row.startCueId}-${row.endCueId}; end exists=${b >= 0}; actual IDs=${cues.map(c => c.id).join(',')}`);
        }
        cursor = b + 1;
        return { ...row, startCueId: cues[a].id, start: cues[a].start, end: cues[b].end };
    });
    if (cursor !== cues.length || ranges[0].action !== 'keep' || ranges.at(-1).action !== 'keep'
        || ranges.at(-1).role !== 'closing') throw new Error('missing_topic_closure');
    const next = evidence.cues.find(c => c.start >= bounds.end - .001 && c.id !== bounds.endCueId);
    if (next ? raw.continuation !== 'next_topic' || raw.nextCueId !== next.id || (allowedIds && !allowedIds.has(next.id))
        : raw.continuation !== 'source_end' || raw.nextCueId !== '') throw new Error('unverified_topic_continuation');
    return { version: 1, sourceSha256: evidence.sourceSha256, sourceStart: bounds.start, sourceEnd: bounds.end,
        ranges, closingReason: raw.closingReason, continuation: raw.continuation, nextCueId: raw.nextCueId };
}

function withEndingHold(clip, segments, totalDuration, seconds = 3) {
    const end = Number(clip.end);
    if (!Number.isFinite(end) || clip.endingHold) return clip;
    // Do not grab the beginning of the next utterance or extend through overlapping speech.
    const next = segments.filter(c => c.end > end + .001).reduce((n, c) => Math.min(n, c.start), Infinity);
    const target = Math.min(end + seconds, totalDuration, next - .08);
    const padded = round(Math.max(end, target));
    return { ...clip, end: padded, duration: padded - clip.start,
        endingHold: { speechEnd: end, seconds: round(padded - end), requestedSeconds: seconds } };
}

function validatePlanBinding(plan, evidence, window) {
    if (plan.sourceSha256 !== evidence.sourceSha256 || Math.abs(plan.sourceStart - window.start) > .002
        || plan.sourceEnd > window.end + .002) throw new Error('Stale topic edit plan');
    const valid = normalizePlan(plan, { start: plan.sourceStart, end: plan.sourceEnd,
        endCueId: plan.ranges.at(-1)?.endCueId }, evidence);
    if (JSON.stringify(valid.ranges) !== JSON.stringify(plan.ranges)) throw new Error('Changed topic edit ranges');
    return valid;
}

function storyConstraints(plan, evidence, window) {
    validatePlanBinding(plan, evidence, window);
    return plan.ranges.filter(row => row.action === 'keep').map((row, i) => ({ id: `topic-${i + 1}`,
        start: row.start - window.start,
        end: (row === plan.ranges.at(-1) ? window.end : row.end) - window.start,
        text: row.reason }));
}

function assertDroppedRanges(timeline, plan, window) {
    for (const row of plan.ranges.filter(r => r.action === 'drop')) {
        if (timeline.keep.some(s => s.start < row.end - window.start - .001 && s.end > row.start - window.start + .001)) {
            throw new Error('Story retained a selection-stage dropped range');
        }
    }
}

function subtitleKeepDraft(plan, cues, window) {
    return plan.ranges.filter(row => row.action === 'keep').map(row => {
        const selected = cues.filter(c => c.end > row.start - window.start + .001 && c.start < row.end - window.start - .001);
        if (!selected.length) throw new Error('Topic range has no rendered subtitle cues');
        return { fromCue: selected[0].id, toCue: selected.at(-1).id, role: row.role, reason: row.reason };
    });
}

module.exports = { contextSeconds, planSchema, promptLines, normalizePlan, withEndingHold, storyConstraints, assertDroppedRanges, subtitleKeepDraft };
