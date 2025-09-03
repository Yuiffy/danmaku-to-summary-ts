const fs = require('fs');
const xml2js = require('xml2js');
const moment = require('moment');

// —— 参数（与你原来一致/兼容）——
const KEEP_THRESHOLD_TEXT = 3;     // “高信号文本”次数阈值
const KEEP_THRESHOLD_USERS = 3;    // “高信号文本”唯一用户阈值

const EMOTE_DROP_MULT = 1.8;       // 纯表情惩罚（用于评分）
const LOW_SIGNAL_DROP_MULT = 2.2;  // 低信号惩罚（用于评分）

const COUNT_PROTECT_STEP = 8;      // 次数保护：每多1次，降低“被删倾向”8 个百分点
const USERS_PROTECT_STEP = 6;      // 用户保护：每多1人，降低“被删倾向”6 个百分点

const MAX_EFFECTIVE_DROP = 99;     // 评分上限的约束
const DROP_RATE_BASE = 85;         // 评分的基准（不再真正“丢弃”，仅作排序依据）
const TARGET_LINES = 1000;

function isPureEmote(text) {
    if (!text) return false;
    return /^\s*\[[^\]]+\]\s*$/.test(text);
}

function isLowSignal(text) {
    if (!text) return true;
    if (isPureEmote(text)) return true;

    const t = String(text).trim();
    const LOW_SIGNAL_SET = new Set(['草', '问号', '？', '??', '???', 'xswl', '看看', '好家伙', '左扭', '右扭']);
    if (LOW_SIGNAL_SET.has(t.toLowerCase())) return true;

    if (
        /^哈+$/.test(t) || /(哈哈){2,}/.test(t) ||
        /^啊+$/.test(t) || /^哦+$/.test(t) || /^喔+$/.test(t) || /^唉+$/.test(t) ||
        /^妈(呀|呀呀)+$/.test(t) ||
        /^？+$/.test(t) || /^\?+$/.test(t)
    ) return true;

    return false;
}

function convertTimestampToMinute(timestamp) {
    const ts = Number(timestamp);
    if (ts > 1e12) return moment(ts).format('HH:mm');     // 毫秒
    else return moment.unix(ts).format('HH:mm');           // 秒
}

// —— 批量表情精简 ——
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

/**
 * 计算“被删倾向”值（越大越该删）。沿用你原来的丢弃率公式，但不做随机，只拿来排序。
 * 然后我们用 score = 100 - effectiveDrop，score 越高越应保留。
 */
function computeKeepScore({ content, count, users }) {
    const emote = isPureEmote(content);
    const lowSig = isLowSignal(content);

    let effectiveDrop = DROP_RATE_BASE;
    if (lowSig) {
        effectiveDrop = Math.min(MAX_EFFECTIVE_DROP, effectiveDrop * LOW_SIGNAL_DROP_MULT);
    } else if (emote) {
        effectiveDrop = Math.min(MAX_EFFECTIVE_DROP, effectiveDrop * EMOTE_DROP_MULT);
    }

    effectiveDrop -= (count - 1) * COUNT_PROTECT_STEP;
    effectiveDrop -= (users - 1) * USERS_PROTECT_STEP;
    effectiveDrop = Math.max(0, Math.min(MAX_EFFECTIVE_DROP, effectiveDrop));

    // 分数越大越“值得保留”
    return 100 - effectiveDrop;
}

// 根据你的“必留”定义：非低信号 + 次数/用户均达阈值
function isMustKeepEntry({ content, count, users }) {
    return !isLowSignal(content) && count >= KEEP_THRESHOLD_TEXT && users >= KEEP_THRESHOLD_USERS;
}

/**
 * 主流程：按目标行数（包含分钟标题行）输出
 * @param {string} xmlFile
 * @param {string} outputFile
 * @param {object} options
 * @param {number} options.targetLines 期望总行数（分钟标题+内容行），默认 1000
 * @param {boolean} options.countHeadersInTarget 是否将分钟标题计入目标（默认 true）
 */
function processDanmaku(xmlFile, outputFile, options = {}) {
    const {
        targetLines = 1000,
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

            const danmakuByMinute = {};
            let danmakus = result.i.d || [];
            if (!Array.isArray(danmakus)) danmakus = [danmakus];

            // 1) 先按分钟+内容聚合（不做随机）
            danmakus.forEach(d => {
                const attributes = d.$.p.split(",");
                const timestamp = attributes[4];  // 绝对时间戳（秒/毫秒都有可能）
                const userId = attributes[6];     // 用户ID
                const content = simplifyEmotes(d._);

                const minute = convertTimestampToMinute(timestamp);
                if (!danmakuByMinute[minute]) danmakuByMinute[minute] = {};

                if (!danmakuByMinute[minute][content]) {
                    danmakuByMinute[minute][content] = { count: 0, users: new Set() };
                }
                danmakuByMinute[minute][content].count += 1;
                danmakuByMinute[minute][content].users.add(userId);
            });

            // 2) 可选“事后清理”：对明显弱的低信号做最低门槛
            for (const [minute, dict] of Object.entries(danmakuByMinute)) {
                for (const [content, info] of Object.entries(dict)) {
                    const c = info.count;
                    const u = info.users.size;
                    if (isLowSignal(content) && c < 2 && u < 2) {
                        delete dict[content]; // 太弱信号，直接去掉
                    }
                }
            }

            // 3) 把剩余聚合项拍扁为 entries，并计算 score / mustKeep
            const entries = []; // { minute, content, count, users, score, mustKeep }
            const minuteStats = new Map(); // minute -> { total, mustKeep }
            for (const [minute, dict] of Object.entries(danmakuByMinute)) {
                for (const [content, info] of Object.entries(dict)) {
                    const count = info.count;
                    const users = info.users.size;
                    const mustKeep = isMustKeepEntry({ content, count, users });
                    const score = mustKeep ? Number.POSITIVE_INFINITY : computeKeepScore({ content, count, users });

                    entries.push({ minute, content, count, users, score, mustKeep });
                    if (!minuteStats.has(minute)) minuteStats.set(minute, { total: 0, mustKeep: 0 });
                    minuteStats.get(minute).total += 1;
                    if (mustKeep) minuteStats.get(minute).mustKeep += 1;
                }
            }

            // 如果全被清空，直接输出空
            if (entries.length === 0) {
                fs.writeFileSync(outputFile, '', 'utf8');
                console.log(`弹幕内容已成功写入文件: ${outputFile}（无可输出项）`);
                return;
            }

            // 4) 计算当前总行数
            function currentTotalLines() {
                let lines = 0;
                for (const [minute, stat] of minuteStats) {
                    if (stat.total > 0) {
                        if (countHeadersInTarget) lines += 1; // 分钟标题
                        lines += stat.total;                  // 内容行
                    }
                }
                return lines;
            }

            let totalLines = currentTotalLines();

            // 5) 如超出目标，按“最不重要优先删除”
            //    删除一条时，若该分钟最后一条也被删，则标题行也一并消失。
            if (totalLines > targetLines) {
                const removable = entries.filter(e => !e.mustKeep);

                // 从“最不重要”到“较重要”
                removable.sort((a, b) => {
                    if (a.score !== b.score) return a.score - b.score; // 分数低的先删
                    if (a.count !== b.count) return a.count - b.count; // 次数少的先删
                    if (a.users !== b.users) return a.users - b.users; // 用户少的先删
                    if (a.minute !== b.minute) return a.minute.localeCompare(b.minute);
                    return String(a.content).localeCompare(String(b.content));
                });

                // 记录是否已删除
                const removed = new Set(); // key = minute + '||' + content

                for (const e of removable) {
                    if (totalLines <= targetLines) break;
                    const key = `${e.minute}||${e.content}`;
                    if (removed.has(key)) continue;

                    // 删掉该聚合项
                    removed.add(key);
                    const stat = minuteStats.get(e.minute);
                    if (!stat || stat.total <= 0) continue;

                    // 内容行减少 1
                    stat.total -= 1;
                    totalLines -= 1;

                    // 如果该分钟已无内容，则标题行也要去掉
                    if (stat.total === 0) {
                        if (countHeadersInTarget) totalLines -= 1;
                    }
                }

                // 把被删的从 danmakuByMinute 结构中去掉
                if (removed.size > 0) {
                    for (const key of removed) {
                        const [m, c] = key.split('||');
                        if (danmakuByMinute[m] && danmakuByMinute[m][c]) {
                            delete danmakuByMinute[m][c];
                        }
                    }
                }

                // 如果删到极限仍然超标（因为全是必留），给个提示
                totalLines = currentTotalLines();
                if (totalLines > targetLines) {
                    console.warn(
                        `提示：必留项过多，无法收缩到目标 ${targetLines} 行；最终约为 ${totalLines} 行。` +
                        `如需更强收缩，调高 KEEP_THRESHOLD_* 或放宽低信号门槛。`
                    );
                }
            }

            // 6) 输出（按时间排序分钟；同一分钟内可按 count/用户降序）
            const sortedMinutes = Object.keys(danmakuByMinute)
                .filter(m => Object.keys(danmakuByMinute[m]).length > 0)
                .sort((a, b) => a.localeCompare(b));

            const output = [];
            for (const minute of sortedMinutes) {
                const dict = danmakuByMinute[minute];
                const items = Object.entries(dict)
                    .map(([content, info]) => ({ content, count: info.count, users: info.users.size }))
                    .sort((a, b) => {
                        if (b.count !== a.count) return b.count - a.count;
                        if (b.users !== a.users) return b.users - a.users;
                        return String(a.content).localeCompare(String(b.content));
                    });

                if (items.length === 0) continue;

                // 分钟标题
                output.push(minute);

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

// —— 调用示例 ——
// 期望总行数含“分钟标题行”；想要 1000 行左右：
processDanmaku(
    '../../source/source.xml',
    '../../source/output.txt',
    { targetLines: TARGET_LINES, countHeadersInTarget: true }
);

// 如果你希望“目标只计算内容行、不含分钟标题”，改为：
// processDanmaku('../../source/source.xml','../../source/output.txt',{ targetLines: 1000, countHeadersInTarget: false });
