'use strict';

// Editorial hints only. Labels and hooks never grant attribution or upload approval.
const PROMPT_LINES = [
    '用可重叠的观看动机辅助找看点：语音与台词、初见与发现、角色互动、反差与事故、故事与观点、观众共创与才艺，以及其他通用趣事。标签允许自定义或为空，不按类别分配名额，不为覆盖类型凑数。',
    '低弹幕不等于无趣；同时考虑路人能理解的看点与粉丝在意的语气、称呼、角色关系。热度、粉丝吸引力、证据可靠性和事件完整性分别判断，不能用其中一项替代另一项。',
    '联动安排、活动预告、近期计划和明确的期待也可有独立信息价值，不需要事故、反转或高弹幕。区分已约定、暂定、愿望与观众猜测；游戏名或日期转写可疑时保留待核原话，不能直接把ASR噪声当作主播口误笑点，也不能凭弹幕补成确定消息。',
    '同一窗口可有主看点和独立次看点；不要只用一句事件摘要盖过特殊台词或相遇互动。仅找人、初次对话、求助、召唤等过程也可独立收束，不默认延伸到之后的战斗或通关。',
    '标签是寻找线索的角度，不是事实结论。“首次”、角色身份、语气和声音魅力需对应证据；只读字幕不能声称已听过音频或看过画面。弹幕解释、模型概述不能替代主播原话。'
];
function anglePromptLines(recall = false) {
    return [...PROMPT_LINES, ...(recall ? [
        '每个候选可附 viewingAngles 数组（0至3项，主看点在前）：{label:"语音与台词",hook:"一句具体看点",evidenceCueIds:["G1"],evidenceDanmakuIds:[]}。label优先用上述观看动机以便检索，也允许新增标签；具体情节写hook。每项至少1个、最多8个片内G-ID，最多6个片内D-ID。引用必须同时落在该候选startCueId/endCueId内并出现在本次输入中，不能拿前一战或后续情节做本窗口依据。不另写猜测的台词。',
        '看点锚点通常只需1至3条关键原话，不要为覆盖整段罗列引用。hook未描述观众行为时，evidenceDanmakuIds留空即可；不根据相邻编号猜出未展示的D-ID。',
        '发现计划或邀约时，回看同一话题内后续的何时、和谁、为何等待及本人态度；窗口应覆盖实际回答与收尾，不停在中途的名称辨认或玩笑。只保留本次输入中确有的问答，缺失或识别不清的安排标为待核，不猜日期或参与者。',
        '看点不同且可各自收束时，分别提出窄窗口候选；同一事件的重复表述保留在一个候选里。提交前回看是否被连续战斗、热闹弹幕挤掉了短台词或角色互动。'
    ] : [])];
}
function normalizeViewingAngles(value, window, evidence, danmaku = [], allowed = {}) {
    const angles = [], issues = [];
    if (value == null) return { angles, issues };
    if (!Array.isArray(value)) return { angles, issues: ['viewing_angles_not_array'] };
    if (value.length > 3) issues.push('viewing_angles_limit');
    for (const [index, item] of value.slice(0, 3).entries()) {
        const ids = item?.evidenceCueIds, dids = item?.evidenceDanmakuIds ?? [];
        const cues = Array.isArray(ids) ? ids.map(id => evidence?.byId?.get(id)) : [];
        const valid = typeof item?.label === 'string' && item.label.trim().length > 0 && item.label.length <= 32
            && typeof item.hook === 'string' && item.hook.trim().length > 0 && item.hook.length <= 240
            && !/[\r\n]/u.test(item.label + item.hook)
            && cues.length > 0 && cues.length <= 8 && new Set(ids).size === ids.length
            && cues.every((cue, i) => cue && (!allowed.cueIds || allowed.cueIds.has(ids[i]))
                && cue.start >= window.start - .001 && cue.end <= window.end + .001)
            && Array.isArray(dids) && dids.length <= 6 && new Set(dids).size === dids.length
            && dids.every(id => {
                if (!/^D[1-9]\d*$/.test(id) || (allowed.danmakuIds && !allowed.danmakuIds.has(id))) return false;
                const row = danmaku[Number(id.slice(1)) - 1];
                return row && row.time >= window.start && row.time <= window.end;
            });
        if (!valid) { issues.push(`invalid_viewing_angle:${index + 1}`); continue; }
        angles.push({ label: item.label.trim(), hook: item.hook.trim(), evidenceCueIds: ids,
            evidenceDanmakuIds: dids, sourceSha256: evidence.sourceSha256, authority: 'unverified_editorial_hint',
            start: Math.min(...cues.map(cue => cue.start)), end: Math.max(...cues.map(cue => cue.end)) });
    }
    return { angles, issues };
}
function anglesForWindow(candidate, window, evidence, danmaku = []) {
    const matching = (candidate?.viewingAngles || []).filter(angle => angle.sourceSha256 === evidence.sourceSha256);
    return normalizeViewingAngles(matching, window, evidence, danmaku).angles;
}
function mergeViewingAngles(first, second, window) {
    const rows = [...(first.viewingAngles || []), ...(second.viewingAngles || [])];
    const unique = new Map();
    for (const row of rows) {
        if (row.start < window.start || row.end > window.end) continue;
        const key = JSON.stringify([row.label, row.hook, row.evidenceCueIds, row.evidenceDanmakuIds]);
        if (!unique.has(key)) unique.set(key, row);
    }
    return [...unique.values()].slice(0, 3);
}

// Keep original rows/IDs. Lexical overlap and explanatory wording are discovery
// signals, not semantic verification, causality or proof of who is speaking.
function contextualComments(danmaku, window, cues, preferredIds = [], max = 4) {
    const preferred = new Set(preferredIds), chosen = new Set();
    const words = text => String(text || '').replace(/\[[^\]]*\]/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const grams = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
    const source = cues.map(cue => ({ ...cue, words: words(cue.text) }));
    return danmaku.map((item, i) => ({ item, id: `D${i + 1}` })).filter(({ item }) => item.time >= window.start && item.time <= window.end)
        .map(row => {
            const text = words(row.item.text), pairs = grams(text);
            let matches = 0;
            for (const cue of source) {
                if (row.item.time < cue.start - 8 || row.item.time > cue.end + 25) continue;
                const overlap = [...pairs].filter(pair => cue.words.includes(pair)).length;
                matches = Math.max(matches, overlap);
            }
            const explanation = /(?:这.{0,6}是|那.{0,6}是|叫做|小心|不是|召唤|NPC|角色)/iu.test(row.item.text);
            return { ...row, text, score: (preferred.has(row.id) ? 100 : 0) + Math.min(8, matches) * 3 + (explanation ? 2 : 0) };
        }).filter(row => row.score > 0 && row.text.length >= 3 && new Set(row.text).size >= 2)
        .sort((a, b) => b.score - a.score || a.item.time - b.item.time)
        .filter(row => { if (chosen.has(row.text)) return false; chosen.add(row.text); return true; })
        .slice(0, max).map(({ item, id }) => ({ id, time: item.time, text: item.text, authority: 'audience_context_hint' }));
}

function quoteEchoes(danmaku, window, cues, max = 3) {
    const seen = new Set(), rows = [];
    for (const [index, row] of danmaku.entries()) {
        if (row.time < window.start || row.time > window.end) continue;
        const quote = String(row.text || '').trim();
        if (quote.length < 3 || quote.length > 30 || new Set(quote).size < 2 || /\[[^\]]*\]/u.test(quote)) continue;
        const cue = cues.find(cue => cue.start >= window.start && cue.end <= window.end
            && row.time >= cue.start - 8 && row.time <= cue.end + 25 && cue.text.includes(quote));
        if (!cue || seen.has(quote)) continue;
        seen.add(quote);
        const offset = Math.max(0, cue.text.indexOf(quote) - 80);
        const partial = cue.text.length > 240;
        const sourceText = partial ? `${offset ? '…' : ''}${cue.text.slice(offset, offset + 220)}${offset + 220 < cue.text.length ? '…' : ''}` : cue.text;
        rows.push({ cueId: cue.id, quote, sourceText, ...(partial ? { sourceTextPartial: true } : {}), start: cue.start, end: cue.end,
            audienceId: `D${index + 1}`, audienceTime: row.time, authority: 'literal_overlap_not_attribution' });
    }
    // Prefer distinctive longer overlaps; matching is a hint, never proof of a meme.
    return rows.sort((a, b) => b.quote.length - a.quote.length || a.start - b.start).slice(0, max);
}
module.exports = { anglePromptLines, normalizeViewingAngles, anglesForWindow, mergeViewingAngles, contextualComments, quoteEchoes };
