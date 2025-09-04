const fs = require('fs');
const xml2js = require('xml2js');
const moment = require('moment');

// ====== 可调参数 ======
const KEEP_THRESHOLD_TEXT = 3;     // “高信号文本”次数阈值
const KEEP_THRESHOLD_USERS = 3;    // “高信号文本”唯一用户阈值

const EMOTE_DROP_MULT = 1.8;       // 纯表情惩罚（用于评分）
const LOW_SIGNAL_DROP_MULT = 2.2;  // 低信号惩罚（用于评分）

const COUNT_PROTECT_STEP = 8;      // 次数保护：每多1次，降低“被删倾向”8 个百分点
const USERS_PROTECT_STEP = 6;      // 用户保护：每多1人，降低“被删倾向”6 个百分点

const MAX_EFFECTIVE_DROP = 99;     // 评分上限约束（最终 clamp）
const DROP_RATE_BASE = 85;         // 评分基准（仅排序依据，不做随机）

const TARGET_LINES = 1000;         // 目标总行数（含分钟标题；可在调用处覆盖）
const MINUTE_CAP = 5;              // 每分钟最多保留多少条（不含“必留”）
const MY_USER_ID = '14279';        // 你的用户ID：出现即“必留”

const DEBUG = false;               // 调试输出（true 可打印时间范围等信息）

// ====== 工具函数 ======

// 将原始时间戳（秒或毫秒）转为【绝对毫秒】与 moment 实例
function normalizeTs(tsRaw) {
    const tsNum = Number(tsRaw);
    if (!Number.isFinite(tsNum)) return null;
    const ms = tsNum > 1e12 ? tsNum : tsNum * 1000; // 13位≈毫秒，否则按秒
    return { ms, m: moment(ms) };
}

// 用“绝对分钟索引”聚合，避免跨天/跨小时合并
function minuteIndexFromMs(ms) {
    return Math.floor(ms / 60000); // 自 1970-01-01 起的第 N 分钟
}

// 输出标签：自动在跨天时显示日期
function fmtLabel(m, showDate) {
    return m.format(showDate ? 'MM-DD HH:mm' : 'HH:mm');
}

// 是否纯表情块（如：[笑]）
function isPureEmote(text) {
    if (!text) return false;
    return /^\s*\[[^\]]+\]\s*$/.test(text);
}

// 估算 emoji/符号占比（粗略）
function emojiSymbolRatio(text) {
    if (!text) return 0;
    const chars = Array.from(text);
    const nonSpace = chars.filter(ch => !/\s/.test(ch));
    if (nonSpace.length === 0) return 0;
    // Node 需支持 Unicode 属性类
    const symbolRe = /[\p{Extended_Pictographic}\p{S}\p{P}]/u;
    const symbolCount = nonSpace.reduce((acc, ch) => acc + (symbolRe.test(ch) ? 1 : 0), 0);
    return symbolCount / nonSpace.length;
}

// 是否“表情/应援墙”或重复花纹
function isEmojiHeavyOrPattern(text) {
    const t = String(text || '');
    if (emojiSymbolRatio(t) >= 0.5) return true;
    // 大量心心/音符/星星/斜杠等连发
    if (/(❤|💖|💕|🎵|🎶|✨|💘|💝|🌟|[\\\/]){6,}/u.test(t)) return true;
    // 短块重复（1~6字）+ 分隔符 >=3 次：如 “小岁/小岁/小岁”
    if (/^(.{1,6})([\/\\\s、，,·-]\1){2,}$/u.test(t)) return true;
    return false;
}

// 低信号判定（增强）
function isLowSignal(text) {
    if (!text) return true;
    if (isPureEmote(text)) return true;
    if (isEmojiHeavyOrPattern(text)) return true;

    const t = String(text).trim();
    const LOW_SIGNAL_SET = new Set([
        '草','问号','？','??','???','xswl','看看','好家伙','左扭','右扭',
        'omg','oh no','哦豁','啊','啊？','哇','哇哦','mua','打call', '💕岁岁💕岁岁💕岁岁💕岁岁💕岁岁💕岁岁💕', '💗小岁💗小岁💗小岁💗小岁💗小'
    ]);
    if (LOW_SIGNAL_SET.has(t.toLowerCase())) return true;

    if (
        /^哈+$/.test(t) || /(哈哈){2,}/.test(t) ||
        /^啊+$/.test(t) || /^哦+$/.test(t) || /^喔+$/.test(t) || /^唉+$/.test(t) ||
        /^妈(呀|呀呀)+$/.test(t) ||
        /^？+$/.test(t) || /^\?+$/.test(t)
    ) return true;

    return false;
}

// —— 批量表情精简 ——
// 1) 把 [系列_系列_..._名字] 抽成最后一段 [名字]
// 2) 别名精简（可扩）
const EMOTE_ALIAS = {
    '哈哈': '笑',
    '妈呀': '惊',
    '哭死': '哭',
    '啵啵': '亲',
    '我在': '在',
    '流汗了': '流汗',
    '喜欢': '喜欢',
    '好听': '好听',
    '好耶': '好耶',
    '哇': '惊',
    '凝视': '凝视',
    '对吗': '疑问',
};

function simplifyEmotes(text) {
    if (!text) return text;
    return text.replace(/\[([^\]]+)\]/g, (_m, inner) => {
        const parts = inner.split('_');
        let last = parts[parts.length - 1] || inner;
        if (EMOTE_ALIAS[last]) last = EMOTE_ALIAS[last];
        return `[${last}]`;
    });
}

// 信息度加分：越像一句话越加分（长度/字母数字汉字占比）
function informativeBonus(text) {
    const t = String(text || '');
    const core = t.replace(/[^\p{Letter}\p{Number}\p{Script=Han}\s]/gu, '').trim();
    const len = Array.from(core).length;

    let bonus = 0;
    if (len >= 8) bonus += 10;
    else if (len >= 6) bonus += 6;
    else if (len >= 4) bonus += 3;

    if (/[a-zA-Z0-9]/.test(core)) bonus += 2; // 混有英文/数字，略加分
    return bonus;
}

/**
 * 把“被删倾向”转为“保留分数”（越高越该留）
 * 修正顺序：先乘惩罚 -> 再减保护 -> clamp -> 转 100-值 -> 加信息度&我的加成
 */
function computeKeepScore({ content, count, users, hasMy }) {
    const emote = isPureEmote(content);
    const lowSig = isLowSignal(content);

    // 先乘惩罚
    let effectiveDrop = DROP_RATE_BASE;
    if (lowSig) {
        effectiveDrop = effectiveDrop * LOW_SIGNAL_DROP_MULT;
    } else if (emote) {
        effectiveDrop = effectiveDrop * EMOTE_DROP_MULT;
    }

    // 再减保护（高频/多人 -> 更不该丢）
    effectiveDrop -= (count - 1) * COUNT_PROTECT_STEP;
    effectiveDrop -= (users - 1) * USERS_PROTECT_STEP;

    // 最后限制范围
    effectiveDrop = Math.max(0, Math.min(MAX_EFFECTIVE_DROP, effectiveDrop));

    // 转为保留分，并加信息度/我的加成
    let score = 100 - effectiveDrop;
    score += informativeBonus(content);
    if (hasMy) score += 50; // 我的弹幕强力加成（即便无此行也会“必留”）
    return score;
}

// “必留”：出现我的ID 或 （非低信号 且 计数/用户均达阈值）
function isMustKeepEntry({ content, count, users, hasMy }) {
    if (hasMy) return true;
    return !isLowSignal(content) && count >= KEEP_THRESHOLD_TEXT && users >= KEEP_THRESHOLD_USERS;
}

/**
 * 主流程：按目标总行数输出
 * @param {string} xmlFile
 * @param {string} outputFile
 * @param {object} options
 * @param {number} options.targetLines 期望总行数（分钟标题+内容行），默认 TARGET_LINES
 * @param {boolean} options.countHeadersInTarget 是否将分钟标题计入目标（默认 true）
 */
function processDanmaku(xmlFile, outputFile, options = {}) {
    const {
        targetLines = TARGET_LINES,
        countHeadersInTarget = true,
    } = options;

    const parser = new xml2js.Parser();

    fs.readFile(xmlFile, (err, data) => {
        if (err) {
            console.error("Error reading file:", err);
            return;
        }

        parser.parseString(data, (err, result) => {
            if (err) {
                console.error("Error parsing XML:", err);
                return;
            }

            // ====== 1) 按“绝对分钟索引 + 内容”聚合 ======
            const byMinute = new Map(); // minuteIndex -> { m: moment, map: {content: {count, users:Set}} }
            let danmakus = result.i.d || [];
            if (!Array.isArray(danmakus)) danmakus = [danmakus];

            for (const d of danmakus) {
                const attributes = String(d.$.p).split(",");
                const tsNorm = normalizeTs(attributes[4]);
                if (!tsNorm) continue;
                const { ms, m } = tsNorm;
                const minuteIdx = minuteIndexFromMs(ms);
                const userId = String(attributes[6]);
                const content = simplifyEmotes(d._);

                if (!byMinute.has(minuteIdx)) {
                    byMinute.set(minuteIdx, { m, map: {} });
                }
                const bucket = byMinute.get(minuteIdx).map;
                if (!bucket[content]) {
                    bucket[content] = { count: 0, users: new Set() };
                }
                bucket[content].count += 1;
                bucket[content].users.add(userId);
            }

            if (byMinute.size === 0) {
                fs.writeFileSync(outputFile, '', 'utf8');
                console.log(`弹幕内容已成功写入文件: ${outputFile}（无可输出项）`);
                return;
            }

            // ====== 2) 事后清理：明显弱的低信号直接去掉 ======
            for (const [, { map }] of byMinute) {
                for (const [content, info] of Object.entries(map)) {
                    const c = info.count;
                    const u = info.users.size;
                    if (isLowSignal(content) && c < 2 && u < 2) {
                        delete map[content];
                    }
                }
            }

            // ====== 3) 统计天数，决定标签是否带日期 ======
            const daySet = new Set();
            for (const [, { m }] of byMinute) {
                daySet.add(m.format('YYYY-MM-DD'));
            }
            const showDateInLabel = daySet.size > 1;

            // ====== 4) 分钟内上限预筛：必留全部 + 最高分补足到 MINUTE_CAP ======
            const keepSet = new Set(); // key: minuteIdx||content

            for (const [minuteIdx, { map, m }] of byMinute) {
                const arr = [];
                for (const [content, info] of Object.entries(map)) {
                    const count = info.count;
                    const users = info.users.size;
                    const hasMy = info.users.has(MY_USER_ID);
                    const mustKeep = isMustKeepEntry({ content, count, users, hasMy });
                    const score = mustKeep ? Number.POSITIVE_INFINITY
                        : computeKeepScore({ content, count, users, hasMy });
                    arr.push({ minuteIdx, m, content, count, users, hasMy, mustKeep, score });
                }

                const must = arr.filter(e => e.mustKeep);
                must.forEach(e => keepSet.add(`${e.minuteIdx}||${e.content}`));

                const rest = arr.filter(e => !e.mustKeep).sort((a, b) => b.score - a.score);
                const need = Math.max(0, MINUTE_CAP - must.length);
                for (let i = 0; i < need && i < rest.length; i++) {
                    keepSet.add(`${rest[i].minuteIdx}||${rest[i].content}`);
                }
            }

            // 将未入选的从结构中去掉（先控每分钟质量/数量）
            for (const [, { map }] of byMinute) {
                for (const content of Object.keys(map)) {
                    const key = `${content}`; // 先收集，后删
                }
            }
            for (const [minuteIdx, obj] of byMinute) {
                const { map } = obj;
                for (const content of Object.keys(map)) {
                    const key = `${minuteIdx}||${content}`;
                    if (!keepSet.has(key)) delete map[content];
                }
            }

            // ====== 5) 若仍超出目标：做全局精细裁（只在 keepSet 内、且非必留的项目里删） ======
            const currentTotalLines = () => {
                let lines = 0;
                for (const [, { map }] of byMinute) {
                    const n = Object.keys(map).length;
                    if (n > 0) {
                        lines += n; // 内容行
                        if (countHeadersInTarget) lines += 1; // 分钟标题
                    }
                }
                return lines;
            };

            let totalLines = currentTotalLines();

            if (totalLines > targetLines) {
                const removable = [];
                for (const [minuteIdx, { map, m }] of byMinute) {
                    for (const [content, info] of Object.entries(map)) {
                        const key = `${minuteIdx}||${content}`;
                        if (!keepSet.has(key)) continue; // 理论上不会进来
                        const count = info.count;
                        const users = info.users.size;
                        const hasMy = info.users.has(MY_USER_ID);
                        const mustKeep = isMustKeepEntry({ content, count, users, hasMy });
                        if (mustKeep) continue;
                        const score = computeKeepScore({ content, count, users, hasMy });
                        removable.push({ minuteIdx, m, content, count, users, score });
                    }
                }

                // 从最不重要开始删
                removable.sort((a, b) => {
                    if (a.score !== b.score) return a.score - b.score; // 分数低先删
                    if (a.count !== b.count) return a.count - b.count; // 次数少先删
                    if (a.users !== b.users) return a.users - b.users; // 用户少先删
                    if (a.minuteIdx !== b.minuteIdx) return a.minuteIdx - b.minuteIdx;
                    return String(a.content).localeCompare(String(b.content));
                });

                for (const e of removable) {
                    if (totalLines <= targetLines) break;
                    const { minuteIdx, content } = e;
                    const bucket = byMinute.get(minuteIdx);
                    if (!bucket || !bucket.map[content]) continue;

                    delete bucket.map[content];
                    totalLines -= 1; // 内容行 -1
                    if (Object.keys(bucket.map).length === 0) {
                        if (countHeadersInTarget) totalLines -= 1; // 该分钟标题也消失
                    }
                }

                if (totalLines > targetLines) {
                    console.warn(
                        `提示：必留项过多，无法收缩到目标 ${targetLines} 行；最终约为 ${totalLines} 行。` +
                        `可调高 KEEP_THRESHOLD_*、提高 LOW_SIGNAL_DROP_MULT 或降低 MINUTE_CAP。`
                    );
                }
            }

            // ====== 6) 输出（按真实时间顺序） ======
            const minuteIndices = Array.from(byMinute.keys())
                .filter(idx => Object.keys(byMinute.get(idx).map).length > 0)
                .sort((a, b) => a - b); // 按时间轴升序

            let lastDay = null;   // <=== 新增：记录上一条的日期

            if (DEBUG) {
                const first = byMinute.get(minuteIndices[0]).m;
                const last  = byMinute.get(minuteIndices[minuteIndices.length - 1]).m;
                console.log(
                    `[DEBUG] minutes: ${minuteIndices.length}, ` +
                    `range: ${first.format('YYYY-MM-DD HH:mm')} ~ ${last.format('YYYY-MM-DD HH:mm')}, ` +
                    `totalLines=${totalLines}`
                );
            }

            const output = [];
            for (const idx of minuteIndices) {
                const { m, map } = byMinute.get(idx);
                const items = Object.entries(map)
                    .map(([content, info]) => ({
                        content,
                        count: info.count,
                        users: info.users.size
                    }))
                    .sort((a, b) => {
                        if (b.count !== a.count) return b.count - a.count;
                        if (b.users !== a.users) return b.users - a.users;
                        return String(a.content).localeCompare(String(b.content));
                    });

                if (items.length === 0) continue;

                // 分钟标题（自动带日期或不带）
                const day = m.format('YYYY-MM-DD');
                const label = (day !== lastDay) ? m.format('MM-DD HH:mm') : m.format('HH:mm');
                output.push(label);
                lastDay = day;

                // 内容行
                for (const it of items) {
                    const userCount = it.users;
                    const totalCount = it.count;
                    if (userCount === 1 && totalCount === 1) {
                        output.push(`${it.content}`);
                    } else if (userCount === 1 && totalCount > 1) {
                        output.push(`${it.content} *${totalCount}`);
                    } else {
                        output.push(`${it.content} *${totalCount}by${userCount}人`);
                    }
                }
            }

            fs.writeFileSync(outputFile, output.join("\n"), 'utf8');
            console.log(`弹幕内容已成功写入文件: ${outputFile}`);
        });
    });
}

// ====== 调用示例 ======
// 期望总行数“包含分钟标题行”；目标 1000 行左右：
processDanmaku(
    '../../source/source.xml',
    '../../source/output.txt',
    { targetLines: TARGET_LINES, countHeadersInTarget: true }
);

// 如果你希望“目标只计算内容行、不含分钟标题”，改为：
// processDanmaku('../../source/source.xml','../../source/output.txt',{ targetLines: 1000, countHeadersInTarget: false });
