const fs = require('fs');
const xml2js = require('xml2js');
const moment = require('moment');

// 降噪策略参数（可按需调整）
const KEEP_THRESHOLD_TEXT = 3;     // 仅“高信号文本”达到该次数才考虑保留
const KEEP_THRESHOLD_USERS = 3;    // 且需要至少这么多唯一用户参与

const EMOTE_DROP_MULT = 1.8;       // 纯表情丢弃倍率（>1 更易被丢）
const LOW_SIGNAL_DROP_MULT = 2.2;  // 低信号（含“草/？/哈哈/妈呀”等）丢弃倍率

const COUNT_PROTECT_STEP = 8;      // 次数保护：每多出现1次，丢弃率减少的百分点
const USERS_PROTECT_STEP = 6;      // 用户保护：每多1个唯一用户，丢弃率减少的百分点

const MAX_EFFECTIVE_DROP = 99;     // 丢弃率上限
const DROP_RATE = 95;              // 基础丢弃比例（0-100）

function isPureEmote(text) {
    if (!text) return false;
    return /^\s*\[[^\]]+\]\s*$/.test(text);
}

function isLowSignal(text) {
    if (!text) return true;
    if (isPureEmote(text)) return true;

    const t = String(text).trim();

    // 典型低信号：问号/草/哈哈/妈呀/xswl/嗯/哦/啊/喔/唉/看看/好家伙 等
    const LOW_SIGNAL_SET = new Set(['草', '问号', '？', '??', '???', 'xswl', '看看', '好家伙']);

    if (LOW_SIGNAL_SET.has(t.toLowerCase())) return true;

    // 正则类低信号：大量重复的情绪词或标点
    if (
        /^哈+$/.test(t) || /(哈哈){2,}/.test(t) ||
        /^啊+$/.test(t) || /^哦+$/.test(t) || /^喔+$/.test(t) || /^唉+$/.test(t) ||
        /^妈(呀|呀呀)+$/.test(t) ||
        /^？+$/.test(t) || /^\?+$/.test(t)
    ) return true;

    return false;
}


// 将时间戳转换为 "时:分" 格式
function convertTimestampToMinute(timestamp) {
    // 转成数字
    const ts = Number(timestamp);

    // 判断长度：大于 1e12 基本就是毫秒级（13 位）
    if (ts > 1e12) {
        return moment(ts).format('HH:mm'); // 毫秒
    } else {
        return moment.unix(ts).format('HH:mm'); // 秒
    }
}

// 随机丢弃部分弹幕
function shouldKeepDanmaku(dropRate) {
    return Math.random() * 100 >= dropRate;
}

// —— 批量表情精简 ——
// 1) 通用规则：把 [系列_系列_..._名字] 抽取为最后一个段落 [名字]
// 2) 别名精简：可按需扩展
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
    // 按需继续补充……
};

function simplifyEmotes(text) {
    if (!text) return text;
    // 匹配所有 [ ... ]，把最后一个下划线后的部分拿出来
    return text.replace(/\[([^\]]+)\]/g, (_m, inner) => {
        const parts = inner.split('_');
        let last = parts[parts.length - 1] || inner;
        // 二次精简（可选）
        if (EMOTE_ALIAS[last]) last = EMOTE_ALIAS[last];
        return `[${last}]`;
    });
}

// 读取并处理 XML 文件
function processDanmaku(xmlFile, outputFile, dropRate = 0) {
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

            // 1) 先合并（不做随机丢弃）
            danmakus.forEach(d => {
                const attributes = d.$.p.split(",");
                const timestamp = attributes[4];  // 绝对时间戳（秒/毫秒都有可能）
                const userId = attributes[6];     // 用户ID
                const content = simplifyEmotes(d._); // 表情批量精简

                const formattedMinute = convertTimestampToMinute(timestamp);

                if (!danmakuByMinute[formattedMinute]) {
                    danmakuByMinute[formattedMinute] = {};
                }

                if (!danmakuByMinute[formattedMinute][content]) {
                    danmakuByMinute[formattedMinute][content] = {
                        count: 0,
                        users: new Set()
                    };
                }

                danmakuByMinute[formattedMinute][content].count += 1;
                danmakuByMinute[formattedMinute][content].users.add(userId);
            });

            // 2) 合并后再做“内容级”抽样：高重复保留，纯表情更易被丢弃
            for (const [minute, danmakuList] of Object.entries(danmakuByMinute)) {
                for (const [content, info] of Object.entries(danmakuList)) {
                    const c = info.count;
                    const u = info.users.size;
                    const emote = isPureEmote(content);
                    const lowSig = isLowSignal(content); // 包含纯表情/哈哈/草/问号等

                    // 仅“高信号文本”才有“必留”资格：次数 & 多用户
                    if (!lowSig && c >= KEEP_THRESHOLD_TEXT && u >= KEEP_THRESHOLD_USERS) {
                        continue; // 必留
                    }

                    // 计算有效丢弃率
                    let effectiveDrop = DROP_RATE;

                    // 低信号内容：提高丢弃概率
                    if (lowSig) {
                        effectiveDrop = Math.min(MAX_EFFECTIVE_DROP, effectiveDrop * LOW_SIGNAL_DROP_MULT);
                    } else if (emote) {
                        //（严格来说 emote 已被 lowSig 覆盖，这行保底）
                        effectiveDrop = Math.min(MAX_EFFECTIVE_DROP, effectiveDrop * EMOTE_DROP_MULT);
                    }

                    // 次数/用户保护（线性降低丢弃率，但不至于“必留”）
                    effectiveDrop -= (c - 1) * COUNT_PROTECT_STEP;
                    effectiveDrop -= (u - 1) * USERS_PROTECT_STEP;

                    // 限幅
                    effectiveDrop = Math.max(0, Math.min(MAX_EFFECTIVE_DROP, effectiveDrop));

                    // 抽样：如果没通过，就从本分钟里删掉该内容
                    if (!shouldKeepDanmaku(effectiveDrop)) {
                        delete danmakuList[content];
                    }
                }
            }

// 可选：一步“事后清理”——对仍然留下的低信号做最低门槛
            for (const [minute, danmakuList] of Object.entries(danmakuByMinute)) {
                for (const [content, info] of Object.entries(danmakuList)) {
                    const c = info.count;
                    const u = info.users.size;
                    if (isLowSignal(content) && c < 2 && u < 2) {
                        delete danmakuList[content]; // 太弱信号，直接去掉
                    }
                }
            }

            // 3) 输出
            const output = [];
            for (const [minute, danmakuList] of Object.entries(danmakuByMinute)) {
                if (Object.keys(danmakuList).length === 0) continue;
                output.push(minute);
                for (const [content, info] of Object.entries(danmakuList)) {
                    const userCount = info.users.size;
                    const totalCount = info.count;

                    if (userCount === 1 && totalCount === 1) {
                        output.push(`${content}`);
                    } else if (userCount === 1 && totalCount > 1) {
                        output.push(`${content} *${totalCount}`);
                    } else {
                        output.push(`${content} *${totalCount}by${userCount}人`);
                    }
                }
            }

            fs.writeFileSync(outputFile, output.join("\n"), 'utf8');
            console.log(`弹幕内容已成功写入文件: ${outputFile}`);
        });
    });
}

// 调用函数处理文件，传入丢弃比例
processDanmaku('../../source/source.xml', '../../source/output.txt', DROP_RATE);
