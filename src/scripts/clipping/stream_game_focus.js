'use strict';

/**
 * Episode titles used to be the first three grounded names in chapter order, so a
 * long session produced "斧老大连续挑战、斧光大：彭猛、阿花": a retry-noise suffix,
 * two spellings of the same boss, and no place name at all. The focus here is the
 * shape people actually read: the two hardest named bosses in the order they were
 * fought, then one named area, within a title budget.
 */
const RETRY_NOISE = /(连续挑战|连续失败|连续尝试|连续死亡|重复挑战|反复挑战|反复尝试|多次挑战|挑战失败|再次挑战|连续|重复)+$/u;
const GENERIC_LABEL = /^(游戏|游戏开始|开始游戏|启动游戏|进入游戏|继续游戏|回到游戏|游戏设置|设置|按键|键位|手柄|调整键位|准备|预热|闲聊|休息|等待|加载|读条|探索|战斗|推进|剧情|对话|整理|整理背包|菜单|游戏菜单|整备|出发)$/u;
// Session bookkeeping is never the interesting part of an episode.
const GENERIC_PREFIX = /^(启动|进入|离开|调整|设置|准备|整理|等待|继续|重新|再次|开始|测试|完成|结束|探索与|战斗与|反复|多次)/u;
const GENERIC_CONTAINS = /(键位|手柄|菜单|加载|存档|键位调整)/u;
const LOCATION_VERB = /^(前往|进入|来到|抵达|探索|搜查|返回|离开|深入|穿过|赶往)/u;
const LOCATION_TAIL = /(外围|内部|附近|周边|一带|区域|方向|入口|深处|探索|搜查|附近区域)$/u;
// "探索与战斗" or "村落探索与战斗" is an activity, not a place, even though it starts with a movement verb.
const ACTIVITY_WORD = /(战斗|交战|交谈|对话|移动|搜寻|搜查|调整|升级|修行|清理|获取|选择|尝试|推进|准备|应对|失败|重来|获胜|收集|寻路)/u;
const MAX_LABELS = 3;
const MAX_BOSSES = 2;
const MAX_UNITS = 22;

/** CJK characters count 1, latin/digits half, so the budget matches what the title bar shows. */
function displayUnits(value) {
    return [...String(value || '')].reduce((total, character) => total + (/[\u0000-\u00ff]/u.test(character) ? .5 : 1), 0);
}

function cleanLabel(value) {
    let label = String(value || '').trim().replace(/（\d+\/\d+）/gu, '');
    let previous;
    do {
        previous = label;
        label = label.replace(RETRY_NOISE, '').replace(/[、，,。;；:\s]+$/u, '').replace(/[与和的及等]+$/u, '');
    } while (label !== previous);
    return label;
}

/** Drop a movement verb and a generic area suffix only when a real name remains. */
function locationLabel(value) {
    let label = cleanLabel(value), previous;
    do {
        previous = label;
        const stripped = label.replace(LOCATION_VERB, '').replace(LOCATION_TAIL, '').replace(/[与和的及等]+$/u, '');
        if (displayUnits(stripped) >= 2 && !/^[与和的及]/u.test(stripped)) label = stripped;
    } while (label !== previous);
    return label;
}

const entityKey = value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function isGeneric(label) {
    return !label || GENERIC_LABEL.test(label) || GENERIC_PREFIX.test(label) || GENERIC_CONTAINS.test(label) || displayUnits(label) < 2;
}

function clusterEntries(entries, chapters = []) {
    const clusters = [];
    for (const entry of entries) {
        const key = entityKey(entry.label);
        const found = clusters.find(cluster => cluster.keys.some(other => other.includes(key) || key.includes(other)));
        if (found) { found.keys.push(key); found.entries.push(entry); }
        else clusters.push({ keys: [key], entries: [entry] });
    }
    const support = label => {
        const key = entityKey(label);
        const characters = [...new Set(key)];
        if (characters.length < 2) return 0;
        return chapters.filter(chapter => {
            const title = entityKey(chapter.title);
            return title && !title.includes(key) && characters.some(character => title.includes(character));
        }).length;
    };
    return clusters.map(cluster => {
        // 阿花 / 新娘阿花 / 斩娘阿花 are one boss; publish the most specific spelling once.
        const label = [...cluster.entries].sort((a, b) => displayUnits(b.label) - displayUnits(a.label))[0].label;
        const duration = cluster.entries.reduce((total, entry) => total + (entry.duration || 0), 0);
        const location = cluster.entries.some(entry => entry.kind === 'location');
        // A place the game itself returns to ("塔" across several chapters) is more of a
        // landmark than a one-off rest stop, which makes a better title element.
        const recurrence = location ? Math.min(10, support(label) * 2) : 0;
        return { label, key: entityKey(label), count: cluster.entries.length,
            grounded: cluster.entries.some(entry => entry.grounded),
            boss: cluster.entries.some(entry => entry.kind === 'boss'), location,
            start: Math.min(...cluster.entries.map(entry => entry.start || 0)), duration, recurrence,
            score: cluster.entries.length * 10 + (cluster.entries.some(entry => entry.grounded) ? 25 : 0) + duration / 600 + recurrence };
    });
}

/**
 * @param chapters event chapters in chronological order
 * @returns {{ labels: string[], focus: string }} labels in play order, focus joined with 、
 */
function selectFocus(chapters = [], options = {}) {
    const maxUnits = Number.isFinite(options.maxUnits) ? options.maxUnits : MAX_UNITS;
    const maxLabels = Number.isFinite(options.maxLabels) ? options.maxLabels : MAX_LABELS;
    const entries = [];
    for (const [index, chapter] of chapters.entries()) {
        const title = String(chapter?.title || '').trim();
        if (!title) continue;
        // Chapters carry a start but not an end; the next chapter bounds this phase.
        const next = chapters.slice(index + 1).find(row => Number.isFinite(row?.start) && row.start > (chapter.start || 0));
        const end = Number.isFinite(options.end) ? options.end : next?.start;
        const duration = Number.isFinite(end) ? Math.max(0, end - (chapter.start || 0)) : 0;
        const locationish = chapter.kind === 'location'
            || (LOCATION_VERB.test(title) || LOCATION_TAIL.test(title)) && !ACTIVITY_WORD.test(title);
        const label = locationish ? locationLabel(title) : cleanLabel(title);
        if (isGeneric(label)) continue;
        entries.push({ label, kind: locationish ? 'location' : (chapter.kind || 'phase'),
            grounded: Boolean(chapter.nameEvidence), start: chapter.start || 0, duration });
    }
    const clusters = clusterEntries(entries, chapters);
    const chosen = [], used = new Set();
    const fits = cluster => !used.has(cluster.key)
        && displayUnits([...chosen.map(row => row.label), cluster.label].join('、')) <= maxUnits;
    const take = (cluster) => { if (chosen.length < maxLabels && fits(cluster)) { chosen.push(cluster); used.add(cluster.key); return true; } return false; };
    const ranked = (predicate) => clusters.filter(predicate).sort((a, b) => b.score - a.score || a.start - b.start);

    for (const cluster of ranked(cluster => cluster.boss)) {
        if (chosen.filter(row => row.boss).length >= MAX_BOSSES) break;
        take(cluster);
    }
    for (const cluster of ranked(cluster => cluster.location)) { if (take(cluster)) break; }
    // Once a boss is named, one area is enough context; a second one crowds out the story.
    const anotherArea = chosen.every(row => !row.boss);
    for (const cluster of ranked(cluster => anotherArea || !cluster.location)) { if (chosen.length >= maxLabels) break; take(cluster); }

    // Bosses lead the title, then the area they were fought in; each group stays in play order.
    const labels = [...chosen].sort((a, b) => (a.boss === b.boss ? a.start - b.start : a.boss ? -1 : 1)).map(row => row.label);
    return { labels, focus: labels.join('、') || '探索与推进' };
}

module.exports = { selectFocus, cleanLabel, locationLabel, displayUnits, clusterEntries, MAX_UNITS, MAX_LABELS };
