const fs = require('fs');
const xml2js = require('xml2js');
const moment = require('moment');

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
            const danmakus = result.i.d;  // 获取所有 <d> 标签

            danmakus.forEach(d => {
                // 随机丢弃弹幕
                if (!shouldKeepDanmaku(dropRate)) {
                    return;
                }

                const attributes = d.$.p.split(",");
                const timestamp = attributes[4]; // 时间戳
                const userId = attributes[6]; // 用户ID
                const content = d._; // 弹幕内容

                const formattedMinute = convertTimestampToMinute(timestamp);

                // 如果当前分钟还没有记录，则初始化该分钟
                if (!danmakuByMinute[formattedMinute]) {
                    danmakuByMinute[formattedMinute] = {};
                }

                // 合并相同的弹幕内容
                if (!danmakuByMinute[formattedMinute][content]) {
                    danmakuByMinute[formattedMinute][content] = {
                        count: 0,
                        users: new Set()
                    };
                }

                danmakuByMinute[formattedMinute][content].count += 1;
                danmakuByMinute[formattedMinute][content].users.add(userId);
            });

            // console.log("danmakuByMinute=", danmakuByMinute);

            // 输出按照分钟分组的弹幕
            const output = [];
            for (const [minute, danmakuList] of Object.entries(danmakuByMinute)) {
                if(Object.keys(danmakuList).length === 0) continue;
                // console.log("minute=", minute, "danmakuList=", danmakuList);
                output.push(minute);
                for (const [content, info] of Object.entries(danmakuList)) {
                    const userCount = info.users.size;
                    const totalCount = info.count;

                    // 简化输出格式
                    if (userCount === 1 && totalCount === 1) {
                        // const userLetter = String.fromCharCode(65 + parseInt(userId) % 26); // 生成 A-Z 的用户标识
                        output.push(`${content}`);  // 1人发1次，省略信息
                    } else if (userCount === 1 && totalCount > 1) {
                        output.push(`${content} *${totalCount}`);  // 1人发多次，简化为 *n
                    } else {
                        output.push(`${content} *${totalCount}by${userCount}人`);  // 多人发多次
                    }
                }
            }

            // 写入到文件
            fs.writeFileSync(outputFile, output.join("\n"), 'utf8');
            console.log(`弹幕内容已成功写入文件: ${outputFile}`);
        });
    });
}

// 调用函数处理文件，传入丢弃比例
processDanmaku('../../source/source.xml', '../../source/output.txt', 90);
