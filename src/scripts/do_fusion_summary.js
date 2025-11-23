const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const moment = require('moment');

// ====== 配置区域 ======
const TARGET_LINES = 2000;
const MINUTE_CAP_DANMAKU = 8;
const MY_USER_ID = '14279';

// ====== SRT 解析工具 ======
function parseSrtTimestamp(timeStr) {
    const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;
    const [_, h, m, s, ms] = match;
    return (parseInt(h)*3600 + parseInt(m)*60 + parseInt(s))*1000 + parseInt(ms);
}

function parseSrtFile(srtPath) {
    if (!fs.existsSync(srtPath)) return [];
    const content = fs.readFileSync(srtPath, 'utf8');
    const blocks = content.split(/\n\s*\n/);
    const subs = [];

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length < 3) continue;

        const timeLineIndex = lines.findIndex(l => l.includes('-->'));
        if (timeLineIndex === -1) continue;

        const timeLine = lines[timeLineIndex];
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
function isLowSignal(text) {
    if (!text) return true;
    const t = String(text).trim();
    if (/^[\s\p{P}]+$/u.test(t)) return true;
    if (/^(哈哈|草|\?|!|.+扭|啊)+$/i.test(t)) return true;
    if (/^(888|666)+$/.test(t)) return true;
    return false;
}

function simplifyEmotes(text) {
    if (!text) return text;
    return text.replace(/\[([^\]]+)\]/g, '[表情]');
}

// ====== 主逻辑 ======
async function processLiveData(inputFiles) {
    const srtFiles = inputFiles.filter(f => /\.srt$/i.test(f));
    const xmlFiles = inputFiles.filter(f => /\.xml$/i.test(f));

    if (srtFiles.length === 0 && xmlFiles.length === 0) {
        console.log("❌ 没收到有效文件！");
        return;
    }

    const baseDir = path.dirname(inputFiles[0]);
    // 文件名清理
    const baseName = path.basename(inputFiles[0])
        .replace(/\.(srt|xml|mp4|flv|mkv|m4a)$/i, '')
        .replace(/_fix$/, '');
    const outputFile = path.join(baseDir, `${baseName}_AI_SUMMARY.txt`);

    console.log(`📝 正在融合: SRT x ${srtFiles.length}, XML x ${xmlFiles.length}`);

    // 1. 读取 SRT
    let subtitles = [];
    for (const srtPath of srtFiles) {
        subtitles = subtitles.concat(parseSrtFile(srtPath));
    }

    // 2. 读取 XML
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

                // 关键修改: 使用相对视频时间 (第0位)
                const videoSeconds = parseFloat(attrs[0]);
                if (isNaN(videoSeconds)) continue;

                const ms = videoSeconds * 1000;
                const content = simplifyEmotes(d._);
                const userId = String(attrs[6]);

                if (isLowSignal(content)) continue;

                danmakus.push({ ms, content, userId, type: 'danmaku' });
            }
        } catch (e) {
            console.error(`❌ XML解析失败: ${path.basename(file)}`);
        }
    }

    // 3. 融合
    const timeBuckets = new Map();

    subtitles.forEach(sub => {
        const idx = Math.floor(sub.ms / 60000);
        if (!timeBuckets.has(idx)) timeBuckets.set(idx, { subs: [], danmakus: [] });
        timeBuckets.get(idx).subs.push(sub.content);
    });

    danmakus.forEach(dm => {
        const idx = Math.floor(dm.ms / 60000);
        if (!timeBuckets.has(idx)) timeBuckets.set(idx, { subs: [], danmakus: [] });
        timeBuckets.get(idx).danmakus.push(dm);
    });

    // 4. 输出
    const sortedKeys = Array.from(timeBuckets.keys()).sort((a, b) => a - b);
    const outputLines = [];
    const zeroTime = moment().startOf('day'); // 基准时间 00:00:00

    for (const idx of sortedKeys) {
        const bucket = timeBuckets.get(idx);
        if (bucket.subs.length === 0 && bucket.danmakus.length === 0) continue;

        const timeLabel = moment(zeroTime).add(idx, 'minutes').format('HH:mm');
        const anchorText = bucket.subs.join(' ');

        const dmCounter = {};
        bucket.danmakus.forEach(d => {
            if(!dmCounter[d.content]) dmCounter[d.content] = 0;
            dmCounter[d.content]++;
        });

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

// 入口
const files = process.argv.slice(2);
if (files.length > 0) {
    processLiveData(files);
} else {
    console.log("请通过 PowerShell 传入文件路径。");
}
// 文件结束
