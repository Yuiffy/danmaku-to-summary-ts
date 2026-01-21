const fs = require('fs');
const path = require('path');
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
function normalizeTs(tsRaw) {
    const tsNum = Number(tsRaw);
    if (!Number.isFinite(tsNum)) return null;
    const ms = tsNum > 1e12 ? tsNum : tsNum * 1000; // 13位≈毫秒，否则按秒
    return { ms, m: moment(ms) };
}
function minuteIndexFromMs(ms) {
    return Math.floor(ms / 60000); // 自 1970-01-01 起的第 N 分钟
}

function isPureEmote(text) {
    if (!text) return false;
    return /^\s*\[[^\]]+\]\s*$/.test(text);
}
function emojiSymbolRatio(text) {
    if (!text) return 0;
    const chars = Array.from(text);
    const nonSpace = chars.filter(ch => !/\s/.test(ch));
    if (nonSpace.length === 0) return 0;
    const symbolRe = /[\p{Extended_Pictographic}\p{S}\p{P}]/u;
    const symbolCount = nonSpace.reduce((acc, ch) => acc + (symbolRe.test(ch) ? 1 : 0), 0);
    return symbolCount / nonSpace.length;
}
function isEmojiHeavyOrPattern(text) {
    const t = String(text || '');
    if (emojiSymbolRatio(t) >= 0.5) return true;
    if (/(❤|💖|💕|🎵|🎶|✨|💘|💝|🌟|[\\\/]){6,}/u.test(t)) return true;
    if (/^(.{1,6})([\/\\\s、，,·-]\1){2,}$/u.test(t)) return true;
    return false;
}
function isLowSignal(text) {
    if (!text) return true;
    if (isPureEmote(text)) return true;
    if (isEmojiHeavyOrPattern(text)) return true;

    const t = String(text).trim();
    const LOW_SIGNAL_SET = new Set([
        '草','问号','？','??','???','xswl','看看','好家伙','左扭','右扭',
        'omg','oh no','哦豁','啊','啊？','哇','哇哦','mua','打call',
        '💕岁岁💕岁岁💕岁岁💕岁岁💕岁岁💕岁岁💕','💗小岁💗小岁💗小岁💗小岁💗小'
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

// —— 批量表情精简 —— //
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

function informativeBonus(text) {
    const t = String(text || '');
    const core = t.replace(/[^\p{Letter}\p{Number}\p{Script=Han}\s]/gu, '').trim();
    const len = Array.from(core).length;

    let bonus = 0;
    if (len >= 8) bonus += 10;
    else if (len >= 6) bonus += 6;
    else if (len >= 4) bonus += 3;

    if (/[a-zA-Z0-9]/.test(core)) bonus += 2;
    return bonus;
}

function computeKeepScore({ content, count, users, hasMy }) {
    const emote = isPureEmote(content);
    const lowSig = isLowSignal(content);

    let effectiveDrop = DROP_RATE_BASE;
    if (lowSig) {
        effectiveDrop = effectiveDrop * LOW_SIGNAL_DROP_MULT;
    } else if (emote) {
        effectiveDrop = effectiveDrop * EMOTE_DROP_MULT;
    }
    effectiveDrop -= (count - 1) * COUNT_PROTECT_STEP;
    effectiveDrop -= (users - 1) * USERS_PROTECT_STEP;
    effectiveDrop = Math.max(0, Math.min(MAX_EFFECTIVE_DROP, effectiveDrop));

    let score = 100 - effectiveDrop;
    score += informativeBonus(content);
    if (hasMy) score += 50;
    return score;
}
function isMustKeepEntry({ content, count, users, hasMy }) {
    if (hasMy) return true;
    return !isLowSignal(content) && count >= KEEP_THRESHOLD_TEXT && users >= KEEP_THRESHOLD_USERS;
}

// ====== 多文件入口：把文件夹内所有 .xml 一起处理 ======
async function processDanmakuFromDir(sourceDir, outputFile, options = {}) {
    const {
        targetLines = TARGET_LINES,
        countHeadersInTarget = true,
    } = options;

    // 1) 枚举目录下所有 .xml
    const files = fs.readdirSync(sourceDir)
      .filter(f => /\.xml$/i.test(f))
      .map(f => path.join(sourceDir, f));

    if (files.length === 0) {
        fs.writeFileSync(outputFile, '', 'utf8');
        console.log(`[WARN] 目录无 XML：${sourceDir}`);
        return;
    }

    // 2) 逐个解析并合并到 byMinute
    const parser = new xml2js.Parser({
        strict: false,        // 允许不严格的 XML 格式
        normalize: true,      // 规范化空白字符
        trim: true,           // 修剪文本内容
        explicitArray: false, // 单个元素不强制为数组
        mergeAttrs: false,    // 不合并属性到父节点
        attrValueProcessors: [
            // 处理属性值中的特殊字符
            (value) => {
                if (typeof value === 'string') {
                    // 移除或转义可能导致问题的字符
                    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                }
                return value;
            }
        ]
    });
    const byMinute = new Map(); // minuteIdx -> { m: moment, map: {content: {count, users:Set}} }

    for (const file of files) {
        try {
            const data = fs.readFileSync(file);
            const result = await parser.parseStringPromise(data);
            let danmakus = result?.i?.d || [];
            if (!Array.isArray(danmakus)) danmakus = [danmakus];

            for (const d of danmakus) {
                if (!d || !d.$ || !d.$.p) continue;
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
                if (!bucket[content]) bucket[content] = { count: 0, users: new Set() };
                bucket[content].count += 1;
                bucket[content].users.add(userId);
            }
        } catch (e) {
            console.error(`[ERROR] 解析失败：${file}`, e.message);
        }
    }

    // 若没有弹幕
    if (byMinute.size === 0) {
        fs.writeFileSync(outputFile, '', 'utf8');
        console.log(`弹幕内容已成功写入文件: ${outputFile}（无可输出项）`);
        return;
    }

    // 3) 事后清理：弱低信号去掉
    for (const [, { map }] of byMinute) {
        for (const [content, info] of Object.entries(map)) {
            const c = info.count;
            const u = info.users.size;
            if (isLowSignal(content) && c < 2 && u < 2) {
                delete map[content];
            }
        }
    }

    // 4) 统计天数，用于第一条跨日才带日期
    const daySet = new Set();
    for (const [, { m }] of byMinute) {
        daySet.add(m.format('YYYY-MM-DD'));
    }

    // 5) 分钟内上限预筛：必留 + 补足到 MINUTE_CAP
    const keepSet = new Set(); // minuteIdx||content
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

    // 未入选先删掉
    for (const [minuteIdx, obj] of byMinute) {
        const { map } = obj;
        for (const content of Object.keys(map)) {
            const key = `${minuteIdx}||${content}`;
            if (!keepSet.has(key)) delete map[content];
        }
    }

    // 6) 全局精细裁到 targetLines
    const currentTotalLines = () => {
        let lines = 0;
        for (const [, { map }] of byMinute) {
            const n = Object.keys(map).length;
            if (n > 0) {
                lines += n; // 内容
                if (countHeadersInTarget) lines += 1; // 标题
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
                if (!keepSet.has(key)) continue;
                const count = info.count;
                const users = info.users.size;
                const hasMy = info.users.has(MY_USER_ID);
                const mustKeep = isMustKeepEntry({ content, count, users, hasMy });
                if (mustKeep) continue;
                const score = computeKeepScore({ content, count, users, hasMy });
                removable.push({ minuteIdx, m, content, count, users, score });
            }
        }

        removable.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            if (a.count !== b.count) return a.count - b.count;
            if (a.users !== b.users) return a.users - b.users;
            if (a.minuteIdx !== b.minuteIdx) return a.minuteIdx - b.minuteIdx;
            return String(a.content).localeCompare(String(b.content));
        });

        for (const e of removable) {
            if (totalLines <= targetLines) break;
            const { minuteIdx, content } = e;
            const bucket = byMinute.get(minuteIdx);
            if (!bucket || !bucket.map[content]) continue;

            delete bucket.map[content];
            totalLines -= 1;
            if (Object.keys(bucket.map).length === 0) {
                if (countHeadersInTarget) totalLines -= 1;
            }
        }

        if (totalLines > targetLines) {
            console.warn(
              `提示：必留项过多，无法收缩到目标 ${targetLines} 行；最终约为 ${totalLines} 行。` +
              `可调高 KEEP_THRESHOLD_*、提高 LOW_SIGNAL_DROP_MULT 或降低 MINUTE_CAP。`
            );
        }
    }

    // 7) 输出（全局按真实时间先后）
    const minuteIndices = Array.from(byMinute.keys())
      .filter(idx => Object.keys(byMinute.get(idx).map).length > 0)
      .sort((a, b) => a - b);

    if (DEBUG) {
        const first = byMinute.get(minuteIndices[0]).m;
        const last  = byMinute.get(minuteIndices[minuteIndices.length - 1]).m;
        console.log(
          `[DEBUG] files=${files.length}, minutes=${minuteIndices.length}, ` +
          `range: ${first.format('YYYY-MM-DD HH:mm')} ~ ${last.format('YYYY-MM-DD HH:mm')}, ` +
          `totalLines=${totalLines}`
        );
    }

    let lastDay = null; // 只有跨日的第一条带日期
    const output = [];
    for (const idx of minuteIndices) {
        const { m, map } = byMinute.get(idx);
        const items = Object.entries(map)
          .map(([content, info]) => ({ content, count: info.count, users: info.users.size }))
          .sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              if (b.users !== a.users) return b.users - a.users;
              return String(a.content).localeCompare(String(b.content));
          });

        if (items.length === 0) continue;

        const day = m.format('YYYY-MM-DD');
        const label = (day !== lastDay) ? m.format('MM-DD HH:mm') : m.format('HH:mm');
        output.push(label);
        lastDay = day;

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
}

// ====== 调用示例（多文件目录） ======
(async () => {
    await processDanmakuFromDir(
      path.resolve(__dirname, '../../source'),           // 目录：把其中所有 .xml 合并处理
      path.resolve(__dirname, '../../source/output.txt'),
      { targetLines: TARGET_LINES, countHeadersInTarget: true }
    );
})();
