const fs = require('fs');
const xml2js = require('xml2js');
const moment = require('moment');

// 降噪策略参数（可按需调整）
const KEEP_THRESHOLD = 3;       // 相同内容出现次数 >= 3 的一律保留
const EMOTE_DROP_MULT = 1.6;    // 纯表情的丢弃加权倍率（>1 更容易被丢弃）
const MAX_EFFECTIVE_DROP = 95;  // 有上限，避免概率过大
const DROP_RATE = 70;           // 丢弃比例（0-100）

function isPureEmote(text) {
    if (!text) return false;
    return /^\s*\[[^\]]+\]\s*$/.test(text);
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

                    // 高重复：必保留
                    if (c >= KEEP_THRESHOLD) continue;

                    // 计算有效丢弃率
                    let effectiveDrop = dropRate;
                    if (isPureEmote(content)) {
                        effectiveDrop = Math.min(MAX_EFFECTIVE_DROP, dropRate * EMOTE_DROP_MULT);
                    }
                    // 也可以按出现次数微调（次数越多越不容易丢）
                    // effectiveDrop = Math.max(0, effectiveDrop - (c - 1) * 10);

                    // 抽样决定是否保留该“内容项”
                    if (!shouldKeepDanmaku(effectiveDrop)) {
                        delete danmakuList[content];
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
