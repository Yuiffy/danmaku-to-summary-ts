'use strict';

const { windowStats } = require('./stream_game_audience');

const EMOTION = /(啊啊|啊啊啊|我靠|我去|卧槽|完了|寄了|救命|不是吧|什么鬼|吓死|好痛|痛死|快跑|跑啊|不行了|哈哈|笑死|离谱|太难|差一点|赢了|死了|回档|我花钱|算了|气死)/iu;
const QUIET = /(调整键位|设置|菜单|背包|装备|商店|购买|查看|说明|加载|读条|走过去|继续探索|寻找物品|整理|修行|对话|聊天)/u;
const BOSS = /(阿花|鬼新娘|斧老大|彭猛|红花|花形敌人)/iu;

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clampRange(start, end, bounds) {
    const from = Math.max(bounds.start, finite(start));
    const to = Math.min(bounds.end, finite(end));
    return to > from ? { start: from, end: to, duration: to - from } : null;
}

function chapterEnd(chapters, index, eventEnd) {
    const next = chapters.slice(index + 1).find(row => finite(row.start) > finite(chapters[index].start));
    return finite(next?.start, eventEnd);
}

function scoreCue(cue, chapter, audience, bounds) {
    const text = String(cue?.text || '');
    const stats = audience ? windowStats(audience, bounds.start, bounds.end, [chapter?.title, chapter?.nameEvidence].filter(Boolean)) : null;
    const boss = chapter?.kind === 'boss' || BOSS.test(`${chapter?.title || ''} ${chapter?.description || ''}`);
    let score = boss ? 9 : chapter?.kind === 'location' ? 3 : 1;
    if (EMOTION.test(text)) score += 8;
    if (QUIET.test(text)) score -= 2;
    if (text.length >= 8 && text.length <= 80) score += 1;
    if (stats) {
        score += Math.min(8, Math.log2(1 + stats.peak / Math.max(1, audience.baseline.peakMedian)) * 2.5);
        score += Math.min(5, Math.log2(1 + stats.comments / Math.max(1, stats.minutes)));
        score += Math.min(4, stats.named + stats.spoken * 2);
        score += Math.min(3, Math.log2(1 + stats.giftValue / 50));
    }
    return score;
}

function candidateWindows(events, audience, options = {}) {
    const maxBossSeconds = finite(options.maxBossSeconds, 95);
    const maxPhaseSeconds = finite(options.maxPhaseSeconds, 48);
    const padBefore = finite(options.padBefore, 5);
    const padAfter = finite(options.padAfter, 9);
    const result = [];
    for (const event of events || []) {
        const chapters = [...(event.chapters || [])].sort((a, b) => finite(a.start) - finite(b.start));
        for (let index = 0; index < chapters.length; index++) {
            const chapter = chapters[index];
            const start = finite(chapter.start, event.start);
            const end = chapterEnd(chapters, index, event.end);
            const bounds = { start: Math.max(event.start, start), end: Math.min(event.end, end) };
            if (!(bounds.end > bounds.start)) continue;
            const isBoss = chapter.kind === 'boss' || BOSS.test(`${chapter.title || ''} ${chapter.description || ''}`);
            const durationLimit = isBoss ? maxBossSeconds : maxPhaseSeconds;
            const cues = (audience?.subtitles || []).filter(cue => cue.end > bounds.start && cue.start < bounds.end);
            const scored = cues.map(cue => ({ cue, score: scoreCue(cue, chapter, audience, bounds) }))
                .sort((a, b) => b.score - a.score || a.cue.start - b.cue.start);
            const selected = scored[0];
            if (!selected && !isBoss) continue;
            const center = selected ? (selected.cue.start + selected.cue.end) / 2 : bounds.start + Math.min(10, (bounds.end - bounds.start) / 3);
            const window = clampRange(Math.max(bounds.start, center - durationLimit / 2 - padBefore),
                Math.min(bounds.end, center + durationLimit / 2 + padAfter), { start: event.start, end: event.end });
            if (!window) continue;
            const score = (selected?.score || 0) + (isBoss ? 7 : 0) + Math.min(4, (bounds.end - bounds.start) / 300);
            result.push({ ...window, eventId: event.id, gameId: event.gameId, chapter, score,
                reason: `${isBoss ? 'Boss/战斗' : '章节'}：${chapter.title}${selected ? `；台词“${selected.cue.text.slice(0, 42)}”` : ''}`,
                evidence: selected ? [{ source: 'subtitle', start: selected.cue.start, end: selected.cue.end, text: selected.cue.text }] : [] });
        }
    }
    return result.sort((a, b) => b.score - a.score || a.start - b.start);
}

function mergeRanges(ranges, gap = 8) {
    const merged = [];
    for (const row of [...ranges].sort((a, b) => a.start - b.start)) {
        const old = merged.at(-1);
        if (old && row.start <= old.end + gap && row.eventId === old.eventId) {
            old.end = Math.max(old.end, row.end); old.duration = old.end - old.start;
            old.score = Math.max(old.score, row.score); old.reason = `${old.reason}；${row.reason}`;
            old.evidence = [...(old.evidence || []), ...(row.evidence || [])];
        } else merged.push({ ...row });
    }
    return merged;
}

function chooseBody(candidates, options = {}) {
    const budget = finite(options.bodySeconds, 18 * 60);
    const chosen = [];
    const bossCandidates = candidates.filter(row => row.chapter?.kind === 'boss' || BOSS.test(row.chapter?.title || ''));
    const add = row => {
        if (!row || chosen.some(old => old.eventId === row.eventId && Math.abs(old.start - row.start) < 2)) return false;
        const used = chosen.reduce((sum, item) => sum + item.duration, 0);
        if (used + row.duration > budget) return false;
        chosen.push({ ...row }); return true;
    };
    // Preserve every distinct Boss encounter that fits, then spend the rest on the
    // strongest emotional or audience-backed moments.
    for (const row of bossCandidates.sort((a, b) => b.score - a.score || a.start - b.start)) add(row);
    for (const row of candidates) add(row);
    return mergeRanges(chosen).sort((a, b) => a.start - b.start);
}

function teaserFromBody(body, audience, options = {}) {
    const budget = finite(options.teaserSeconds, 36);
    const maxSegments = Math.max(1, Math.floor(finite(options.teaserSegments, 4)));
    const selected = [];
    let used = 0;
    for (const row of [...body].sort((a, b) => b.score - a.score || a.start - b.start)) {
        if (selected.length >= maxSegments) break;
        const cues = (audience?.subtitles || []).filter(cue => cue.end > row.start && cue.start < row.end)
            .sort((a, b) => scoreCue(b, row.chapter, audience, row) - scoreCue(a, row.chapter, audience, row));
        const cue = cues[0];
        const length = Math.min(10, Math.max(4, cue ? cue.end - cue.start + 2 : row.duration));
        if (used + length > budget) continue;
        const center = cue ? (cue.start + cue.end) / 2 : row.start + row.duration / 2;
        const range = clampRange(center - length / 2, center + length / 2, row);
        if (!range) continue;
        selected.push({ ...row, ...range, type: 'teaser', teaserOf: { start: row.start, end: row.end }, score: row.score + 2 });
        used += range.duration;
    }
    return selected.sort((a, b) => b.score - a.score || a.start - b.start);
}

function buildHighlightPlan(input = {}) {
    const events = (input.events || []).filter(event => event.verification?.decision === 'keep' || event.verification == null);
    const candidates = candidateWindows(events, input.audience, input);
    const body = chooseBody(candidates, input);
    const teaser = teaserFromBody(body, input.audience, input);
    const op = { type: 'op', assetId: input.opAssetId || 'shikamochi-op-watch-v1' };
    return { version: 1, mode: 'game_highlights', teaser, op, body,
        sourceOrder: [...body].sort((a, b) => a.start - b.start).map(row => ({ start: row.start, end: row.end, chapter: row.chapter?.title || null })),
        budgets: { teaserSeconds: teaser.reduce((sum, row) => sum + row.duration, 0), bodySeconds: body.reduce((sum, row) => sum + row.duration, 0) },
        candidates: candidates.slice(0, 80) };
}

module.exports = { candidateWindows, mergeRanges, chooseBody, teaserFromBody, buildHighlightPlan, scoreCue };
