const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const moment = require('moment');

// ====== 配置区域 ======
const TARGET_LINES = 2000;         // 稍微增加行数，容纳字幕
const MINUTE_CAP_DANMAKU = 8;      // 每分钟保留高热度弹幕数
const MY_USER_ID = '14279';        // 你的UID

// ====== SRT 解析工具 ======
function parseSrtTimestamp(timeStr) {
    // 格式: 00:00:23,450
    const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;
    const [_, h, m, s, ms] = match;
    return (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms);
}

function parseSrtFile(srtPath) {
    if (!fs.existsSync(srtPath)) return [];
    const content = fs.readFileSync(srtPath, 'utf8');
    // 简单的 SRT 解析
    const blocks = content.split(/\n\s*\n/);
    const subs = [];

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length < 3) continue;

        // 寻找时间轴行 (包含 -->)
        const timeLineIndex = lines.findIndex(l => l.includes('-->'));
        if (timeLineIndex === -1) continue;

        const timeLine = lines[timeLineIndex];
        // 时间轴之后的都是字幕内容，合并起来
        const textLines = lines.slice(timeLineIndex + 1).join(' ');

        const [startStr] = timeLine.split(' --> ');
        const ms = parseSrtTimestamp(startStr);

        if (textLines) {
            subs.push({ ms, content: textLines, type: 'sub' });
        }
    }
    return subs;
}

// ====== 弹幕处理工具 ======
function normalizeTs(tsRaw) {
    const tsNum = Number(tsRaw);
    if (!Number.isFinite(tsNum)) return null;
    return tsNum > 1e12 ? tsNum : tsNum * 1000;
}

function isLowSignal(text) {
    if (!text) return true;
    const t = String(text).trim();
    if (/^[\s\p{P}]+$/u.test(t)) return true;
    // 修复点在这里：? 改成了 \?
    if (/^(哈哈|草|\?|!|.+扭|啊)+$/i.test(t)) return true;
    if (/^(888|666)+$/.test(t)) return true;
    return false;
}

function simplifyEmotes(text) {
    if (!text) return text;
    return text.replace(/\[([^\]]+)\]/g, '[表情]');
}

// ====== 主逻辑：处理传入的文件列表 ======
async function processLiveData(inputFiles) {
    // 1. 区分文件类型
    const srtFiles = inputFiles.filter(f => /\.srt$/i.test(f));
    const xmlFiles = inputFiles.filter(f => /\.xml$/i.test(f));

    if (srtFiles.length === 0 && xmlFiles.length === 0) {
        console.log("❌ 没收到有效文件！请拖入 .srt (或视频生成的srt) 和 .xml");
        return;
    }

    // 输出路径：放在第一个文件所在的目录
    const baseDir = path.dirname(inputFiles[0]);
    // 输出文件名：取第一个文件的名字 + _SUMMARY.txt
    const baseName = path.basename(inputFiles[0], path.extname(inputFiles[0])).replace(/_fix$/, '');
    const outputFile = path.join(baseDir, `${baseName}_AI_SUMMARY.txt`);

    console.log(`📝 正在融合: SRT x ${srtFiles.length}, XML x ${xmlFiles.length}`);

    // 2. 读取 SRT (主播语音)
    let subtitles = [];
    for (const srtPath of srtFiles) {
        subtitles = subtitles.concat(parseSrtFile(srtPath));
    }

    // 3. 读取 XML (观众弹幕)
    const parser = new xml2js.Parser();
    let danmakus = [];

    for (const file of xmlFiles) {
        try {
            const data = fs.readFileSync(file);
            const result = await parser.parseStringPromise(data);
            const rawList = result?.i?.d || [];

            for (const d of rawList) {
                if (!d || !d.$ || !d.$.p) continue;
                const attrs = String(d.$.p).split(",");
                const ms = normalizeTs(attrs[4]);
                if (!ms) continue;

                const content = simplifyEmotes(d._);
                const userId = String(attrs[6]);

                if (isLowSignal(content)) continue; // 过滤废话

                danmakus.push({ ms, content, userId, type: 'danmaku' });
            }
        } catch (e) {
            console.error(`❌ XML解析失败: ${path.basename(file)}`);
        }
    }

    // 4. 按时间轴编织 (Minute Bucket)
    const timeBuckets = new Map();

    // 填入字幕
    subtitles.forEach(sub => {
        const idx = Math.floor(sub.ms / 60000);
        if (!timeBuckets.has(idx)) timeBuckets.set(idx, { subs: [], danmakus: [] });
        timeBuckets.get(idx).subs.push(sub.content);
    });

    // 填入弹幕
    danmakus.forEach(dm => {
        const idx = Math.floor(dm.ms / 60000);
        if (!timeBuckets.has(idx)) timeBuckets.set(idx, { subs: [], danmakus: [] });
        timeBuckets.get(idx).danmakus.push(dm);
    });

    // 5. 输出文本
    const sortedKeys = Array.from(timeBuckets.keys()).sort((a, b) => a - b);
    const outputLines = [];

    // 尝试找个基准时间（如果有弹幕的话）
    let baseTime = danmakus.length > 0 ? moment(danmakus[0].ms) : moment();

    for (const idx of sortedKeys) {
        const bucket = timeBuckets.get(idx);

        // 如果这分钟既没主播说话，也没弹幕，就跳过
        if (bucket.subs.length === 0 && bucket.danmakus.length === 0) continue;

        const timeLabel = moment(baseTime).startOf('day').add(idx, 'minutes').format('HH:mm');

        // 主播文本
        const anchorText = bucket.subs.join(' ');

        // 弹幕文本 (简单去重 + 计数 + 选Top)
        const dmCounter = {};
        bucket.danmakus.forEach(d => {
            if(!dmCounter[d.content]) dmCounter[d.content] = 0;
            dmCounter[d.content]++;
        });

        // 排序取前N条
        const sortedDm = Object.entries(dmCounter)
            .sort(([,a], [,b]) => b - a)
            .slice(0, MINUTE_CAP_DANMAKU)
            .map(([txt, count]) => count > 1 ? `${txt}(x${count})` : txt);

        outputLines.push(`\n=== [${timeLabel}] ===`);
        if (anchorText) outputLines.push(`🎤 主播: ${anchorText}`);
        if (sortedDm.length > 0) outputLines.push(`💬 弹幕: ${sortedDm.join('  |  ')}`);
    }

    fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf8');
    console.log(`✅ 搞定！文件生成在: ${outputFile}`);
}

// === 入口：接收命令行参数 ===
const files = process.argv.slice(2);
if (files.length > 0) {
    processLiveData(files);
} else {
    console.log("请通过 PowerShell 传入文件路径。");
}
