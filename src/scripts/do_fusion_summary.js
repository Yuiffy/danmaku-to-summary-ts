const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// ====== 🎛️ 核心参数配置 (可调整) ======

// 1. 热力图设置
const TIME_WINDOW_SEC = 30;      // 每 30秒 作为一个统计单元
const DENSITY_PERCENTILE = 0.35; // 【关键】只保留弹幕最密集的 前 35% 的时间段 (想更小就改小，比如 0.2)

// 2. 低能区处理策略
const LOW_ENERGY_SAMPLE_RATE = 0.1; // 低热度区域，只随机保留 10% 的字幕 (设为 0 就是完全丢弃)

// 3. 你的特权
const MY_USER_ID = '14279';      // 你的弹幕永不被删

// 4. 垃圾词过滤 (复用之前的)
const STOP_WORDS = new Set(['晚上好', '晚安', '来了', '打call', '拜拜', '卡了', '嗯', '好', '草', '哈哈', '确实', '牛', '可爱']);
const FILLER_REGEX = /^(呃|那个|就是|然后|哪怕|其实|我觉得|算是|哎呀|有点|怎么说呢|所以|这种|啊|哦)+/g;

// =======================================

function parseSrtTimestamp(timeStr) {
    const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;
    const [_, h, m, s, ms] = match;
    return (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms);
}

function aggressiveClean(text) {
    if (!text) return "";
    let t = text.trim().replace(/(.)\1{2,}/g, '$1').replace(FILLER_REGEX, ''); // 去口癖
    // 去除括号内的语气词
    t = t.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '');
    return t;
}

async function processLiveData(inputFiles) {
     const srtFiles = inputFiles.filter(f => /\.srt$/i.test(f));
     const xmlFiles = inputFiles.filter(f => /\.xml$/i.test(f));

     if (srtFiles.length === 0 && xmlFiles.length === 0) return;

     const baseDir = path.dirname(inputFiles[0]);
     const baseName = path.basename(inputFiles[0]).replace(/\.(srt|xml|mp4|flv|mkv)$/i, '').replace(/_fix$/, '');
     const outputFile = path.join(baseDir, `${baseName}_AI_HIGHLIGHT.txt`);

     console.log(`🔥 启动热力图采样模式...来源文件：${srtFiles.map(f => path.basename(f)).join(', ')} ${xmlFiles.map(f => path.basename(f)).join(', ')}`);

     // --- 1. 解析弹幕 (生成热力数据) ---
     const parser = new xml2js.Parser({
         strict: false,        // 允许不严格的 XML 格式
         normalize: true,      // 规范化空白字符
         trim: true,           // 修剪文本内容
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
     const danmakuMap = []; // 存储所有弹幕对象 {ms, text}
     let maxDuration = 0;

     for (const file of xmlFiles) {
         try {
             const data = fs.readFileSync(file, 'utf8');
             const result = await parser.parseStringPromise(data);
             // xml2js 的 normalize: true 会将标签名转换为大写
              // 所以 <i> 变成 I, <d> 变成 D, 属性p变成P
             const rawList = result?.I?.D || [];
             
            for (const d of rawList) {
                 if (!d || !d.$ || !d.$.P) continue;
                 const attrs = String(d.$.P).split(",");
                 const ms = parseFloat(attrs[0]) * 1000;
                 const content = String(d._).trim();
                 const uid = String(attrs[6]);

                 if (ms > maxDuration) maxDuration = ms;
                     danmakuMap.push({ ms, content, uid });
             }
         } catch (e) {
             console.error(`处理弹幕文件失败: ${e.message}`);
         }
     }
     console.log(`💬 总弹幕数: ${danmakuMap.length}, 直播总时长约 ${Math.floor(maxDuration/60000)} 分钟`);

    // --- 2. 计算热力阈值 ---
    const windowMs = TIME_WINDOW_SEC * 1000;
    const totalBuckets = Math.ceil(maxDuration / windowMs) + 1;
    const densityArr = new Array(totalBuckets).fill(0);

    // 填充每个时间桶的弹幕数
    danmakuMap.forEach(d => {
        const idx = Math.floor(d.ms / windowMs);
        densityArr[idx] = (densityArr[idx] || 0) + 1;
    });

    // 排序并找到阈值 (Top N%)
    const sortedDensity = [...densityArr].sort((a, b) => b - a);
    const thresholdIndex = Math.floor(totalBuckets * DENSITY_PERCENTILE);
    const thresholdCount = sortedDensity[thresholdIndex] || 1; // 至少要有1条弹幕才算有效

    console.log(`📊 统计完毕: 总时长 ${Math.floor(maxDuration/60000)}分`);
    console.log(`📉 阈值设定: 只有弹幕数 >= ${thresholdCount} 的时段会被完整保留`);

    // --- 3. 解析并过滤字幕 (核心逻辑) ---
    let subtitles = [];
    for (const srtPath of srtFiles) {
        try {
            const content = fs.readFileSync(srtPath, 'utf8');
            const blocks = content.split(/\n\s*\n/);

            for (const block of blocks) {
                const lines = block.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length < 3) continue;

                const timeLine = lines.find(l => l.includes('-->'));
                if (!timeLine) continue;

                const [startStr] = timeLine.split(' --> ');
                const ms = parseSrtTimestamp(startStr);
                const rawText = lines.slice(lines.indexOf(timeLine) + 1).join('');
                const text = aggressiveClean(rawText);

                if (text.length < 2 || STOP_WORDS.has(text)) continue;

                // === 🎯 命运的审判 ===
                const bucketIdx = Math.floor(ms / windowMs);
                const currentDensity = densityArr[bucketIdx] || 0;
                const isHighEnergy = currentDensity >= thresholdCount;

                // 策略：
                // 1. 如果是高能时刻 -> 保留
                // 2. 如果包含特定关键词(如"总结") -> 强制保留
                // 3. 否则 -> 随机丢弃 (Sample Rate)
                const isKeyword = /总结|最后|打算|明天|下播/.test(text);

                if (isHighEnergy || isKeyword || Math.random() < LOW_ENERGY_SAMPLE_RATE) {
                    subtitles.push({
                        ms,
                        text: text,
                        isHighEnergy // 标记一下，方便后面排版
                    });
                }
            }
        } catch (e) {
            console.error(`处理字幕文件失败: ${e.message}`);
        }
    }

    subtitles.sort((a, b) => a.ms - b.ms);

    // --- 4. 智能聚合输出 ---
    // 为了进一步压缩，我们把连续的字幕合并
    const output = [];
    output.push(`【摘要】(保留率: 前${DENSITY_PERCENTILE*100}%热度 + ${LOW_ENERGY_SAMPLE_RATE*100}%随机)`);
    output.push(`---`);

    let currentBlock = { startTime: -1, lines: [], isHighlight: false };

    // 辅助函数：写入一个块
    const flushBlock = () => {
        if (currentBlock.lines.length === 0) return;
        const timeLabel = `[${Math.floor(currentBlock.startTime / 60000)}m]`;
        const icon = currentBlock.isHighlight ? "🔥" : "▫️"; // 火苗代表高能，白点代表低能采样
        const body = currentBlock.lines.join("。");

        // 查找该时段的精华弹幕
        const sTime = currentBlock.startTime;
        const eTime = currentBlock.startTime + (TIME_WINDOW_SEC * 1000 * 2); // 稍微宽一点范围
        const rangeDms = danmakuMap.filter(d => d.ms >= sTime && d.ms < eTime);

        // 统计弹幕词频
        const dmCount = {};
        rangeDms.forEach(d => {
            if (d.uid === MY_USER_ID) {
                // 你的弹幕强制高亮
                if (!dmCount[`★我:${d.content}`]) dmCount[`★我:${d.content}`] = 999;
            } else if (!STOP_WORDS.has(d.content) && d.content.length > 1) {
                dmCount[d.content] = (dmCount[d.content] || 0) + 1;
            }
        });

        const topDm = Object.entries(dmCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([k, v]) => v > 2 && !k.startsWith('★') ? `${k}(x${v})` : k)
            .join(' / ');

        let finalLine = `${timeLabel} ${icon} ${body}`;
        if (topDm) finalLine += `  (💬 ${topDm})`;

        output.push(finalLine);

        // 重置
        currentBlock = { startTime: -1, lines: [], isHighlight: false };
    };

    for (const sub of subtitles) {
        // 如果跟上一句时间差太多（超过60秒），说明中间被大量删减了，强制分段
        if (currentBlock.startTime !== -1 && (sub.ms - currentBlock.lastMs > 60000)) {
            flushBlock();
        }

        if (currentBlock.startTime === -1) {
            currentBlock.startTime = sub.ms;
            currentBlock.isHighlight = sub.isHighEnergy; // 以段首定性
        }

        currentBlock.lines.push(sub.text);
        currentBlock.lastMs = sub.ms;

        // 如果积累太多字了，也切一下，方便AI看
        if (currentBlock.lines.join("").length > 150) {
            flushBlock();
        }
    }
    flushBlock(); // 收尾

    fs.writeFileSync(outputFile, output.join('\n'), 'utf8');
    const size = (fs.statSync(outputFile).size / 1024).toFixed(1);
    console.log(`✅ 浓缩完成: ${outputFile}`);
    console.log(`📦 文件大小: ${size}KB (适合直接投喂AI)`);
}

// 入口
if (require.main === module) {
    const files = process.argv.slice(2);
    if (files.length > 0) processLiveData(files);
}

module.exports = { processLiveData };
