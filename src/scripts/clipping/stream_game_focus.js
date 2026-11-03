'use strict';
const { windowStats } = require('./stream_game_audience');

/**
 * Episode titles used to be the first three grounded names in chapter order, so a
 * long session produced "斧老大连续挑战、斧光大：彭猛、阿花": a retry-noise suffix,
 * two spellings of the same boss, and no place name at all.
 *
 * A fixed "two bosses + one area" quota is equally wrong the other way: a night with
 * three boss fights that all mattered would drop the third, and a quiet exploration
 * night would still be forced to name a boss. Instead every candidate is scored from
 * the recording itself — danmaku bursts, how often chat and the streamer name it,
 * gifts, retries, duration — and the title keeps the highest-scoring names that fit.
 * With no audience data the same ranking falls back to structure alone.
 */
const RETRY_NOISE = /(连续挑战|连续失败|连续尝试|连续死亡|重复挑战|反复挑战|反复尝试|多次挑战|挑战失败|再次挑战|连续|重复)+$/u;
const GENERIC_LABEL = /^(游戏|游戏开始|开始游戏|启动游戏|进入游戏|继续游戏|回到游戏|游戏设置|设置|按键|键位|手柄|调整键位|准备|预热|闲聊|休息|等待|加载|读条|探索|战斗|推进|剧情|对话|整理|整理背包|菜单|游戏菜单|整备|出发)$/u;
// Session bookkeeping is never the interesting part of an episode.
const GENERIC_PREFIX = /^(启动|进入|离开|调整|设置|准备|整理|等待|继续|重新|再次|开始|测试|完成|结束|探索与|战斗与|反复|多次)/u;
const GENERIC_CONTAINS = /(键位|手柄|菜单|加载|存档|键位调整)/u;
const LOCATION_VERB = /^(前往|进入|来到|抵达|探索|搜查|返回|离开|深入|穿过|赶往)/u;
// "升级后前往叶师傅" is a boss chapter whose title carries the walk-up to it.
const LEADING_STATE = /^(升级后|强化后|整备后|补给后|休息后|备战|初次|首次|随后|然后|之后|接着|再次前往|继续前往)/u;
// A trailing area word belongs to the movement phrase; a trailing "探索" is often the
// actual activity the chapter describes ("回魔法学院补探索"), so it only goes when the
// phrase already started with a movement verb.
const HARD_TAIL = /(外围|内部|附近|周边|一带|区域|方向|入口|深处|处)$/u;
const SOFT_TAIL = /(探索|搜查)$/u;
// "探索与战斗" or "村落探索与战斗" is an activity, not a place, even though it starts with a movement verb.
const ACTIVITY_WORD = /(战斗|交战|交谈|对话|移动|搜寻|搜查|调整|升级|修行|清理|获取|选择|尝试|推进|准备|应对|失败|重来|获胜|收集|寻路)/u;
// "沿溪流探索" is a walk, not a place name.
const LEADING_ACTIVITY = /^(沿|顺|寻找|搜寻|清理|收集|获取|整理|补充)/u;
const MAX_LABELS = 4;
const MAX_UNITS = 30;
// Candidates below this share of the best score are background noise, not a title.
const KEEP_RATIO = .55;
// A rest stop is not an area: it has a name but nothing happens there.
const FACILITY = /(驿站|营地|篝火|存档点|商人|商店|铁匠|休整点|传送点|补给点)/u;
const REGION_GAP_SECONDS = 15 * 60;

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
    // A chapter title that starts with the approach or the prep step still names the
    // thing that matters afterwards ("升级后前往叶师傅" → 叶师傅).
    for (const strip of [LEADING_STATE, LOCATION_VERB]) {
        const stripped = label.replace(strip, '');
        if (stripped !== label && displayUnits(stripped) >= 2 && !/^[与和的及等]/u.test(stripped)) label = stripped;
    }
    return label;
}

/** Boss titles arrive as "与叶师傅交手" / "叶师傅处"; publish the name once. */
function bossLabel(value) {
    let label = cleanLabel(String(value || '').replace(/^[与和的及]+/u, ''));
    let previous;
    do {
        previous = label;
        const stripped = label.replace(/(交手|战斗|交战|对战|挑战|之战|处|战)$/u, '');
        if (stripped !== label && displayUnits(stripped) >= 2 && !/[补再又多些了着过与和]/u.test(stripped)) label = stripped;
    } while (label !== previous);
    return label;
}

/** Drop a movement verb and a generic area suffix only when a real name remains. */
function locationLabel(value) {
    let label = cleanLabel(value);
    const moved = LOCATION_VERB.test(label);
    let previous;
    do {
        previous = label;
        let stripped = label.replace(LOCATION_VERB, '').replace(HARD_TAIL, '');
        const withoutActivity = stripped.replace(SOFT_TAIL, '');
        // A short remainder is a place name ("高塔探索" → 高塔); a long one is the
        // activity itself ("回魔法学院补探索"), especially when it ends on a filler.
        if ((moved || displayUnits(withoutActivity) <= 5) && withoutActivity !== stripped
            && !/[补再又多些了着过]$/u.test(withoutActivity)) stripped = withoutActivity;
        stripped = stripped.replace(/[与和的及等]+$/u, '');
        if (displayUnits(stripped) >= 2 && !/^[与和的及]/u.test(stripped)) label = stripped;
    } while (label !== previous);
    // "塔内回路与射箭探索" is a place plus whatever happened there.
    const [head, ...rest] = label.split(/[与和及]/u);
    if (rest.length && displayUnits(head) >= 2 && (ACTIVITY_WORD.test(rest.join('')) || SOFT_TAIL.test(rest.join('')))) label = head;
    // "地下室寻路" keeps the walk in the name; the place is 地下室.
    const core = label.replace(/(寻路|清理|搜寻|搜查|探索)$/u, '');
    if (core !== label && displayUnits(core) >= 2 && !/[补再又多些了着过]$/u.test(core)) label = core;
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
        // A boss chapter beats a place chapter for the same entity: "叶师傅" over "叶师傅处".
        const label = [...cluster.entries].sort((a, b) => (b.kind === 'boss') - (a.kind === 'boss')
            || displayUnits(b.label) - displayUnits(a.label))[0].label;
        const duration = cluster.entries.reduce((total, entry) => total + (entry.duration || 0), 0);
        const location = cluster.entries.some(entry => entry.kind === 'location');
        // A place the game itself returns to ("塔" across several chapters) is more of a
        // landmark than a one-off rest stop, which makes a better title element.
        const recurrence = location ? Math.min(10, support(label) * 2) : 0;
        return { label, key: entityKey(label), keys: cluster.keys, count: cluster.entries.length,
            grounded: cluster.entries.some(entry => entry.grounded),
            boss: cluster.entries.some(entry => entry.kind === 'boss'), location,
            start: Math.min(...cluster.entries.map(entry => entry.start || 0)), duration, recurrence,
            entries: cluster.entries, orders: cluster.entries.map(entry => entry.order ?? 0),
            score: cluster.entries.length * 10 + (cluster.entries.some(entry => entry.grounded) ? 25 : 0) + duration / 600 + recurrence };
    });
}

/**
 * Chapter detection splits one area into several place names — 驿站 (rest stop),
 * 杀气塔, 高塔, 地下室 are one 40-minute sweep. Publishing them separately spends the
 * whole title budget on map fragments, so *consecutive* place chapters (nothing but
 * another place in between) become one region, named after the first real area.
 */
function mergeRegions(clusters) {
    const places = clusters.filter(cluster => cluster.location && !cluster.boss).sort((a, b) => a.start - b.start);
    const absorbed = new Set();
    for (const head of places) {
        if (absorbed.has(head.key)) continue;
        let lastOrder = Math.max(...head.orders);
        for (const other of places) {
            if (other === head || absorbed.has(other.key)) continue;
            if (Math.min(...other.orders) !== lastOrder + 1) continue;
            if (other.start - (head.start + (head.duration || 0)) > REGION_GAP_SECONDS) continue;
            absorbed.add(other.key);
            head.entries.push(...other.entries);
            head.orders = [...head.orders, ...other.orders];
            head.count += other.count;
            head.duration += other.duration;
            head.recurrence = Math.max(head.recurrence || 0, other.recurrence || 0);
            lastOrder = Math.max(...other.orders);
        }
    }
    return clusters.filter(cluster => !absorbed.has(cluster.key)).map(cluster => {
        // Only pure places merge; a cluster that also contains a boss chapter keeps its
        // boss name, or the boss would vanish from the title behind an area label.
        if (!cluster.location || cluster.boss) return cluster;
        const named = cluster.entries.filter(entry => !FACILITY.test(entry.label));
        const label = (named.length ? named : cluster.entries).sort((a, b) => a.start - b.start)[0].label;
        return { ...cluster, label, key: entityKey(label), keys: [...new Set(cluster.entries.map(entry => entityKey(entry.label)))],
            facility: FACILITY.test(label) };
    });
}

/**
 * Two chapters can name the same boss differently ("阿花" / "鬼新娘") without sharing
 * a substring, so spelling alone cannot merge them. Chat settles it: if the window
 * labelled 鬼新娘 mostly talks about 阿花, it is the same fight under another phase
 * name. Only nearby boss windows are considered, and the alias must be clearly
 * outnumbered by the headline's own mentions (25 vs 1 in the 2026-11-01 session).
 */
function mergeAliases(clusters, audience) {
    if (!audience?.danmaku?.length && !audience?.subtitles?.length) return clusters;
    const merged = new Set();
    const bosses = clusters.filter(cluster => cluster.boss).sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const headline of bosses) {
        if (merged.has(headline.key)) continue;
        for (const other of bosses) {
            if (other === headline || merged.has(other.key)) continue;
            if (Math.abs((other.start || 0) - (headline.start || 0)) > 60 * 60) continue;
            let cross = 0, own = 0;
            for (const entry of other.entries) {
                const end = (entry.start || 0) + (entry.duration || 0);
                const crossStats = windowStats(audience, entry.start || 0, end, headline.keys);
                const ownStats = windowStats(audience, entry.start || 0, end, other.keys);
                cross += crossStats.named + crossStats.spoken;
                own += ownStats.named + ownStats.spoken;
            }
            if (cross >= Math.max(3, own * 2)) {
                merged.add(other.key);
                headline.entries.push(...other.entries);
                headline.count += other.count;
                headline.duration += other.duration;
                headline.start = Math.min(headline.start, other.start);
                headline.aliases = [...(headline.aliases || []), other.label];
            }
        }
    }
    return clusters.filter(cluster => !merged.has(cluster.key));
}

/**
 * What the audience did during a candidate's chapters. A boss chat screams at and
 * gifts over is more of a headline than one the streamer cleared silently.
 */
function audienceTotals(cluster, audience) {
    if (!audience?.danmaku?.length && !audience?.subtitles?.length) return null;
    const totals = { peak: 0, named: 0, spoken: 0, giftValue: 0, giftCount: 0, comments: 0, minutes: 0, peakRatio: 0 };
    for (const entry of cluster.entries) {
        const end = (entry.start || 0) + (entry.duration || 0);
        const stats = windowStats(audience, entry.start || 0, end, cluster.keys);
        totals.peak = Math.max(totals.peak, stats.peak);
        totals.named += stats.named;
        totals.spoken += stats.spoken;
        totals.giftValue += stats.giftValue;
        totals.giftCount += stats.giftCount || 0;
        totals.comments += stats.comments;
        totals.minutes += stats.minutes;
    }
    totals.peakRatio = totals.peak / Math.max(1, audience.baseline.peakMedian);
    totals.mentionRate = (totals.named + totals.spoken * 2) / Math.max(1, totals.minutes);
    return totals;
}

/**
 * Structure plus audience. Bosses and grounded names start ahead because they are
 * what an episode is remembered by; chat, speech and gifts decide the rest.
 */
function importanceOf(cluster, audience) {
    const base = (cluster.boss ? 12 : 0) + (cluster.location && !cluster.boss ? (cluster.facility ? 2 : 5) : 0) + (cluster.grounded ? 6 : 0)
        + 2 * Math.log2(1 + Math.max(0, cluster.count - 1)) + Math.min(6, (cluster.duration || 0) / 300);
    if (!audience) return base;
    const totals = cluster.audience;
    if (!totals) return base;
    const burst = Math.log2(1 + Math.max(0, totals.peakRatio - 1));
    // Naming density is scale free: five mentions inside a two-minute fight is louder
    // than forty inside an hour of the same area.
    const talk = Math.log2(1 + totals.mentionRate);
    const gift = (totals.giftValue > 0 ? Math.min(5, Math.log2(1 + totals.giftValue / 50)) : 0)
        + (totals.giftCount > 0 ? Math.min(3, Math.log2(1 + totals.giftCount / 3)) : 0);
    return base + 2.2 * burst + 3 * talk + gift;
}

/**
 * @param chapters event chapters in chronological order
 * @param options.audience optional `stream_game_audience.loadAudience()` result
 * @returns {{ labels: string[], focus: string, details: Array<object> }} labels in play order
 */
function selectFocus(chapters = [], options = {}) {
    const maxUnits = Number.isFinite(options.maxUnits) ? options.maxUnits : MAX_UNITS;
    const maxLabels = Number.isFinite(options.maxLabels) ? options.maxLabels : MAX_LABELS;
    const entries = [];
    for (const [index, chapter] of chapters.entries()) {
        const title = String(chapter?.title || '').trim();
        if (!title) continue;
        // Chapters carry a start but not an end; the next chapter bounds this phase and
        // the last one runs to the end of the event.
        const next = chapters.slice(index + 1).find(row => Number.isFinite(row?.start) && row.start > (chapter.start || 0));
        const end = next?.start ?? options.end;
        const duration = Number.isFinite(end) ? Math.max(0, end - (chapter.start || 0)) : 0;
        const locationish = chapter.kind === 'location'
            || (LOCATION_VERB.test(title) || HARD_TAIL.test(title) || SOFT_TAIL.test(title))
            && !ACTIVITY_WORD.test(title) && !LEADING_ACTIVITY.test(title);
        const label = chapter.kind === 'boss' ? bossLabel(title)
            : locationish ? locationLabel(title) : cleanLabel(title);
        if (isGeneric(label)) continue;
        entries.push({ label, kind: locationish ? 'location' : (chapter.kind || 'phase'),
            grounded: Boolean(chapter.nameEvidence), start: chapter.start || 0, duration, order: index });
    }
    const audience = options.audience && (options.audience.danmaku?.length || options.audience.subtitles?.length)
        ? options.audience : null;
    const clusters = mergeAliases(mergeRegions(clusterEntries(entries, chapters)), audience).map(cluster => {
        const enriched = { ...cluster, audience: audience ? audienceTotals(cluster, audience) : null };
        return { ...enriched, importance: importanceOf(enriched, audience) };
    });
    const chosen = [], used = new Set();
    const fits = cluster => !used.has(cluster.key)
        && displayUnits([...chosen.map(row => row.label), cluster.label].join('、')) <= maxUnits;
    const take = cluster => {
        if (chosen.length < maxLabels && fits(cluster)) { chosen.push(cluster); used.add(cluster.key); return true; }
        return false;
    };
    const ranked = clusters.sort((a, b) => b.importance - a.importance || a.start - b.start);

    // No quota and no per-kind cap: the strongest names win, up to the title budget.
    // A floor keeps the tail of minor places from padding the title.
    const best = ranked[0]?.importance || 0;
    for (const cluster of ranked) {
        if (cluster.importance < best * KEEP_RATIO) break;
        take(cluster);
    }
    // If the floor left an obvious headline out (one loud area, no boss on a quiet
    // night), add the best boss, then the best area, while the budget allows.
    for (const pick of [ranked.find(row => row.boss), ranked.find(row => row.location && !row.boss && !row.facility),
        ranked.find(row => row.location && !row.boss)]) {
        if (pick && !used.has(pick.key)) take(pick);
    }

    // Bosses lead the title, then the area they were fought in; each group stays in play order.
    const labels = [...chosen].sort((a, b) => (a.boss === b.boss ? a.start - b.start : a.boss ? -1 : 1));
    const describe = row => ({ label: row.label, kind: row.boss ? 'boss' : row.location ? 'location' : 'phase',
        importance: Number(row.importance.toFixed(2)), chapters: row.count, minutes: Math.round((row.duration || 0) / 60),
        ...(row.aliases?.length ? { aliases: row.aliases } : {}),
        ...(row.audience ? { peakDanmaku: row.audience.peak, peakRatio: Number(row.audience.peakRatio.toFixed(2)),
            named: row.audience.named, spoken: row.audience.spoken, giftValue: row.audience.giftValue,
            giftCount: row.audience.giftCount } : {}) });
    const details = labels.map(describe);
    // Why a name was left out, so a reviewer can overrule the ranking without re-running it.
    const candidates = ranked.slice(0, 8).filter(row => !used.has(row.key)).map(describe);
    return { labels: labels.map(row => row.label), focus: labels.map(row => row.label).join('、') || '探索与推进', details, candidates };
}

module.exports = { selectFocus, cleanLabel, bossLabel, locationLabel, displayUnits, clusterEntries, mergeRegions, mergeAliases,
    importanceOf, audienceTotals, MAX_UNITS, MAX_LABELS, KEEP_RATIO };
