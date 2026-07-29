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
const STOP_WORDS = new Set(['晚上好', '晚安', '来了', '打call', '拜拜', '卡了', '嗯', '好', '草', '哈哈', '确实', '牛', '可爱', '感谢观看', '谢谢观看', '优优独播剧场——YoYo Television Series Exclusive', '杨茜茜', '李宗盛']);
const FILLER_REGEX = /^(呃|那个|就是|然后|哪怕|其实|我觉得|算是|哎呀|有点|怎么说呢|所以|这种|啊|哦)+/g;
const HALLUCINATION_REGEX = /字幕志愿者|中文字幕志愿者|优优独播剧场|感谢观看|谢谢观看|谢谢大家观看/;

function loadAsrSpeakerSidecarForSrt(srtPath) {
    try {
        if (!srtPath) return {};
        const parsed = path.parse(srtPath);
        const baseName = parsed.name.replace(/\.speaker$/i, '');
        const candidates = [
            path.join(parsed.dir, `${baseName}.asr_speakers.json`),
            path.join(parsed.dir, `${parsed.name}.asr_speakers.json`)
        ];
        const sidecarPath = candidates.find((candidate) => fs.existsSync(candidate));
        if (!sidecarPath) return {};
        const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (error) {
        console.warn(`读取 ASR speaker sidecar 失败: ${error.message}`);
        return {};
    }
}

function loadAsrMetaSidecarForSrt(srtPath) {
    try {
        if (!srtPath) return {};
        const parsed = path.parse(srtPath);
        const baseName = parsed.name.replace(/\.speaker$/i, '');
        const candidates = [
            path.join(parsed.dir, `${baseName}.asr_meta.json`),
            path.join(parsed.dir, `${parsed.name}.asr_meta.json`)
        ];
        const sidecarPath = candidates.find(candidate => fs.existsSync(candidate));
        if (!sidecarPath) return {};
        const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (error) {
        console.warn(`读取 ASR meta sidecar 失败: ${error.message}`);
        return {};
    }
}

const EMOTION_LABELS = {
    ANGRY: '生气/激动',
    CONTEMPT: '轻蔑',
    DISGUST: '厌恶',
    FEAR: '害怕',
    HAPPY: '开心',
    NEUTRAL: '平静',
    SAD: '难过',
    SURPRISE: '惊讶'
};

const EVENT_LABELS = {
    Applause: '掌声',
    BGM: '背景音乐',
    Cry: '哭声',
    Laughter: '笑声',
    Sneeze: '喷嚏',
    Speech: '说话'
};

function getEmotionAnalysis(meta) {
    const analysis = meta?.emotionAnalysis || meta?.emotion_analysis || {};
    return analysis && typeof analysis === 'object' ? analysis : {};
}

function getEmotionEvidenceForInterval(analysis, start, end) {
    const timeline = Array.isArray(analysis?.timeline) ? analysis.timeline : [];
    const overlaps = timeline
        .map(item => ({
            item,
            overlap: Math.max(0, Math.min(Number(end), Number(item.end)) - Math.max(Number(start), Number(item.start)))
        }))
        .filter(entry => entry.overlap > 0);
    if (overlaps.length === 0) return null;
    const emotionScores = {};
    const events = [];
    for (const { item, overlap } of overlaps) {
        if (item.emotion) {
            emotionScores[item.emotion] = (emotionScores[item.emotion] || 0) + overlap;
        }
        for (const event of item.events || []) {
            if (!events.includes(event)) events.push(event);
        }
    }
    const emotion = Object.entries(emotionScores).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return emotion || events.length > 0 ? { emotion, events } : null;
}

function formatEmotionEvidence(evidence) {
    if (!evidence) return '';
    const parts = [];
    if (evidence.emotion) {
        parts.push(`情感: ${EMOTION_LABELS[evidence.emotion] || evidence.emotion}`);
    }
    const notableEvents = (evidence.events || []).filter(event => !['Speech', 'BGM'].includes(event));
    if (notableEvents.length > 0) {
        parts.push(`声音: ${notableEvents.map(event => EVENT_LABELS[event] || event).join('、')}`);
    }
    return parts.length > 0 ? `  [${parts.join('；')}]` : '';
}

function buildEmotionSummaryLines(analysis) {
    if (!analysis || analysis.status !== 'completed') return [];
    const emotionEntries = Object.entries(analysis.emotionCounts || {}).sort((a, b) => b[1] - a[1]);
    const eventEntries = Object.entries(analysis.eventCounts || {})
        .filter(([event]) => !['Speech', 'BGM'].includes(event))
        .sort((a, b) => b[1] - a[1]);
    if (emotionEntries.length === 0 && eventEntries.length === 0) return [];
    const emotionText = emotionEntries
        .slice(0, 5)
        .map(([emotion, count]) => `${EMOTION_LABELS[emotion] || emotion}${count}段`)
        .join('、');
    const eventText = eventEntries
        .slice(0, 5)
        .map(([event, count]) => `${EVENT_LABELS[event] || event}${count}次`)
        .join('、');
    return [
        `【情感概览】${emotionText || '无明确情感标签'}${eventText ? `；明显声音事件: ${eventText}` : ''}`,
        '【情感说明】标签来自 SenseVoiceSmall，仅作语气和选段线索，具体事实仍以字幕内容为准。',
        '---'
    ];
}

function buildStrongEmotionMomentLines(analysis, maxMoments = 8) {
    if (!analysis || analysis.status !== 'completed') return [];
    const emotionScores = { SURPRISE: 40, FEAR: 38, SAD: 34, DISGUST: 34, CONTEMPT: 28 };
    const eventScores = { Cry: 45, Laughter: 38, Applause: 30 };
    const ranked = (analysis.timeline || [])
        .map(item => ({
            ...item,
            score: (emotionScores[item.emotion] || 0)
                + Math.max(0, ...(item.events || []).map(event => eventScores[event] || 0))
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.start - b.start);
    const selected = [];
    for (const item of ranked) {
        if (selected.some(existing => Math.abs(Number(existing.start) - Number(item.start)) < 20)) continue;
        selected.push(item);
        if (selected.length >= maxMoments) break;
    }
    if (selected.length === 0) return [];
    return [
        '【显著情感时刻】',
        ...selected
            .sort((a, b) => a.start - b.start)
            .map(item => {
                const minute = Math.floor(Number(item.start) / 60);
                const second = Math.floor(Number(item.start) % 60);
                const evidence = formatEmotionEvidence(item);
                const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                return `[${minute}m${String(second).padStart(2, '0')}s]${evidence}${text ? ` ${text}` : ''}`;
            }),
        '---'
    ];
}

function buildParticipantSummaryLines(sidecar) {
    if (!sidecar || typeof sidecar !== 'object') return [];
    const participants = Array.isArray(sidecar.participants) ? sidecar.participants : [];
    if (participants.length === 0) return [];
    const planned = participants.filter((item) => item.planned !== false);
    const appeared = participants.filter((item) => item.appeared === true);
    const plannedText = planned.map((item) => item.displayName || item.streamerId).filter(Boolean).join('、') || '无';
    const appearedText = appeared.map((item) => item.displayName || item.streamerId).filter(Boolean).join('、') || '无';
    return [
        `【参与者】计划参与: ${plannedText}`,
        `【参与者】实际出声: ${appearedText}`,
        '---'
    ];
}

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
     const baseName = path.basename(inputFiles[0]).replace(/\.speaker$/i, '').replace(/\.(srt|xml|mp4|flv|mkv)$/i, '').replace(/_fix$/, '');
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
    const participantSummaryLines = [];
    let primaryEmotionAnalysis = null;
    for (const srtPath of srtFiles) {
        try {
            const sidecar = loadAsrSpeakerSidecarForSrt(srtPath);
            const asrMeta = loadAsrMetaSidecarForSrt(srtPath);
            const emotionAnalysis = getEmotionAnalysis(asrMeta);
            if (!primaryEmotionAnalysis && emotionAnalysis.status === 'completed') {
                primaryEmotionAnalysis = emotionAnalysis;
            }
            if (participantSummaryLines.length === 0) {
                participantSummaryLines.push(...buildParticipantSummaryLines(sidecar));
            }
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

                if (text.length < 2 || STOP_WORDS.has(text) || HALLUCINATION_REGEX.test(text)) continue;

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
                        isHighEnergy, // 标记一下，方便后面排版
                        emotionAnalysis
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
    if (participantSummaryLines.length > 0) {
        output.push(...participantSummaryLines);
    }
    output.push(...buildEmotionSummaryLines(primaryEmotionAnalysis));
    output.push(...buildStrongEmotionMomentLines(primaryEmotionAnalysis));

    let currentBlock = { startTime: -1, lines: [], isHighlight: false, emotionAnalysis: null };

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
        const evidence = getEmotionEvidenceForInterval(
            currentBlock.emotionAnalysis,
            currentBlock.startTime / 1000,
            (currentBlock.lastMs + 5000) / 1000
        );
        finalLine += formatEmotionEvidence(evidence);

        output.push(finalLine);

        // 重置
        currentBlock = { startTime: -1, lines: [], isHighlight: false, emotionAnalysis: null };
    };

    for (const sub of subtitles) {
        // 如果跟上一句时间差太多（超过60秒），说明中间被大量删减了，强制分段
        if (currentBlock.startTime !== -1 && (sub.ms - currentBlock.lastMs > 60000)) {
            flushBlock();
        }

        if (currentBlock.startTime === -1) {
            currentBlock.startTime = sub.ms;
            currentBlock.isHighlight = sub.isHighEnergy; // 以段首定性
            currentBlock.emotionAnalysis = sub.emotionAnalysis;
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

module.exports = {
    processLiveData,
    loadAsrMetaSidecarForSrt,
    getEmotionEvidenceForInterval,
    formatEmotionEvidence,
    buildEmotionSummaryLines,
    buildStrongEmotionMomentLines
};
