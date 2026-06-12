#!/usr/bin/env node
/**
 * 岁己×栞栞 6/4 联动切片工具
 * 扫雷 + 飞行棋 精剪切片，双色字幕（岁己暗红 #8B0000，栞栞咖啡 #6F4E37）
 * 
 * 用法: node clip_sui_shiori.js --segments <json_file>
 * 或直接运行使用预设时间点
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ============ 配置 ============
const RECORDING_DIR = 'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\2026_06_04';
const BASE_NAME = '录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged';
const VIDEO_PATH = path.join(RECORDING_DIR, `${BASE_NAME}.flv`);
const SPEAKER_SRT_PATH = path.join(RECORDING_DIR, `${BASE_NAME}.speaker.srt`);

// 字幕颜色
const COLOR_SUI = '#8B0000';     // 岁己：暗红
const COLOR_SHIORI = '#6F4E37';  // 栞栞：咖啡色
const COLOR_DEFAULT = '#FFFFFF'; // 默认白色

// 输出目录
const OUTPUT_DIR = path.join(RECORDING_DIR, 'clips_0607');

// ffmpeg 路径
const FFMPEG = 'ffmpeg';

// ============ 工具函数 ============

function parseTimeToSeconds(timeStr) {
    // "HH:MM:SS,mmm" or "HH:MM:SS.mmm" or seconds
    if (typeof timeStr === 'number') return timeStr;
    const match = timeStr.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!match) return parseFloat(timeStr);
    return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
}

function secondsToAssTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.round((sec % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function secondsToSrtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Parse speaker SRT into segments
function parseSpeakerSrt(srtPath) {
    const content = fs.readFileSync(srtPath, 'utf-8');
    const blocks = content.trim().split(/\n\s*\n/);
    const segments = [];
    
    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 2) continue;
        
        const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
        if (!timeMatch) continue;
        
        const start = parseTimeToSeconds(timeMatch[1]);
        const end = parseTimeToSeconds(timeMatch[2]);
        
        // Speaker is typically in the text line like "{岁己SUI} text" or "[岁己SUI] text"
        let text = lines.slice(2).join(' ');
        let speaker = 'UNKNOWN';
        
        const speakerMatch = text.match(/^\{([^}]+)\}/) || text.match(/^\[([^\]]+)\]/);
        if (speakerMatch) {
            speaker = speakerMatch[1].trim();
            text = text.substring(speakerMatch[0].length).trim();
        }
        
        segments.push({ start, end, speaker, text });
    }
    
    return segments;
}

// Generate ASS subtitle file with colored speakers
function generateAss(segments, clipStart, clipEnd, outputPath) {
    const clipSegments = segments.filter(s => s.start >= clipStart && s.end <= clipEnd);
    
    const assHeader = `[Script Info]
Title: 岁己×栞栞 联动切片
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 岁己SUI,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1
Style: 栞栞,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1
Style: Default,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    function getAssColor(hexColor) {
        // Convert #RRGGBB to ASS &H00BBGGRR
        const r = parseInt(hexColor.substr(1, 2), 16);
        const g = parseInt(hexColor.substr(3, 2), 16);
        const b = parseInt(hexColor.substr(5, 2), 16);
        return `&H00${b.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${r.toString(16).padStart(2,'0')}`.toUpperCase();
    }

    function getStyleForSpeaker(speaker) {
        if (speaker.includes('岁己') || speaker.includes('SUI') || speaker.includes('sui')) return '岁己SUI';
        if (speaker.includes('栞') || speaker.includes('Shiori') || speaker.includes('shiori')) return '栞栞';
        return 'Default';
    }

    function getOverrideForSpeaker(speaker) {
        if (speaker.includes('岁己') || speaker.includes('SUI') || speaker.includes('sui')) {
            return `{\\1c${getAssColor(COLOR_SUI).replace('&H','&H')}}`;
        }
        if (speaker.includes('栞') || speaker.includes('Shiori') || speaker.includes('shiori')) {
            return `{\\1c${getAssColor(COLOR_SHIORI).replace('&H','&H')}}`;
        }
        return '';
    }

    const events = [];
    for (const seg of clipSegments) {
        const style = getStyleForSpeaker(seg.speaker);
        const override = getOverrideForSpeaker(seg.speaker);
        const startAss = secondsToAssTime(seg.start - clipStart);
        const endAss = secondsToAssTime(seg.end - clipStart);
        const text = seg.text.replace(/\n/g, '\\N');
        events.push(`Dialogue: 0,${startAss},${endAss},${style},${seg.speaker},0,0,0,,${override}${text}`);
    }

    const ass = `${assHeader}\n${events.join('\n')}\n`;
    fs.writeFileSync(outputPath, ass, 'utf-8');
    console.log(`  ASS 字幕: ${outputPath} (${events.length} 条对话)`);
    return outputPath;
}

// Smart clip: cut multiple segments and concat
function cutAndBurnClip(clipName, videoPath, segments, cuts, outputDir) {
    const clipDir = path.join(outputDir, clipName);
    fs.mkdirSync(clipDir, { recursive: true });
    
    const finalOutput = path.join(outputDir, `${clipName}.mp4`);
    const tempDir = path.join(clipDir, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Generate full ASS for the entire clip range
    const clipStart = Math.min(...cuts.map(c => c.start));
    const clipEnd = Math.max(...cuts.map(c => c.end));
    
    const assPath = path.join(clipDir, `${clipName}.ass`);
    generateAss(segments, clipStart, clipEnd, assPath);
    
    // For multi-cut: extract each segment, then concat
    const partFiles = [];
    for (let i = 0; i < cuts.length; i++) {
        const cut = cuts[i];
        const partFile = path.join(tempDir, `part_${String(i).padStart(2,'0')}.mp4`);
        const startStr = secondsToSrtTime(cut.start).replace(',', '.');
        const duration = cut.end - cut.start;
        
        // Calculate ASS subtitle offset for this part
        const partAssPath = path.join(tempDir, `part_${String(i).padStart(2,'0')}.ass`);
        generateAssForRange(segments, cut.start, cut.end, partAssPath);
        
        console.log(`  切片 ${i+1}/${cuts.length}: ${cut.start.toFixed(1)}s - ${cut.end.toFixed(1)}s (${duration.toFixed(1)}s)`);
        
        const args = [
            '-y', '-ss', startStr, '-i', videoPath,
            '-t', duration.toFixed(3),
            '-vf', `ass=${partAssPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-c:a', 'aac', '-b:a', '128k',
            '-progress', 'pipe:1',
            partFile
        ];
        
        console.log(`  ffmpeg ${args.join(' ')}`);
        execSync(`"${FFMPEG}" ${args.map(a => `"${a}"`).join(' ')}`, { stdio: 'inherit', timeout: 600000 });
        partFiles.push(partFile);
    }
    
    // Concat parts
    if (partFiles.length === 1) {
        fs.copyFileSync(partFiles[0], finalOutput);
    } else {
        const concatList = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(concatList, partFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
        console.log(`  合并 ${partFiles.length} 段...`);
        execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatList}" -c copy "${finalOutput}"`, { stdio: 'inherit', timeout: 300000 });
    }
    
    // Cleanup temp
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
    
    const stat = fs.statSync(finalOutput);
    console.log(`  ✅ 输出: ${finalOutput} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return finalOutput;
}

function generateAssForRange(segments, rangeStart, rangeEnd, outputPath) {
    const rangeSegments = segments.filter(s => s.start >= rangeStart && s.end <= rangeEnd);
    
    const assHeader = `[Script Info]
Title: Clip Subtitle
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 岁己SUI,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1
Style: 栞栞,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1
Style: Default,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,1,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    function getAssColor(hexColor) {
        const r = parseInt(hexColor.substr(1, 2), 16);
        const g = parseInt(hexColor.substr(3, 2), 16);
        const b = parseInt(hexColor.substr(5, 2), 16);
        return `&H00${b.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${r.toString(16).padStart(2,'0')}`.toUpperCase();
    }

    function getColorForSpeaker(speaker) {
        if (speaker.includes('岁己') || speaker.includes('SUI') || speaker.includes('sui')) {
            return getAssColor(COLOR_SUI);
        }
        if (speaker.includes('栞') || speaker.includes('Shiori') || speaker.includes('shiori')) {
            return getAssColor(COLOR_SHIORI);
        }
        return '&H00FFFFFF';
    }

    function getStyleForSpeaker(speaker) {
        if (speaker.includes('岁己') || speaker.includes('SUI') || speaker.includes('sui')) return '岁己SUI';
        if (speaker.includes('栞') || speaker.includes('Shiori') || speaker.includes('shiori')) return '栞栞';
        return 'Default';
    }

    const events = [];
    for (const seg of rangeSegments) {
        const style = getStyleForSpeaker(seg.speaker);
        const colorOverride = getColorForSpeaker(seg.speaker);
        const startAss = secondsToAssTime(seg.start - rangeStart);
        const endAss = secondsToAssTime(seg.end - rangeStart);
        const text = seg.text.replace(/\n/g, '\\N');
        events.push(`Dialogue: 0,${startAss},${endAss},${style},${seg.speaker},0,0,0,,{\\1c${colorOverride}}${text}`);
    }

    const ass = `${assHeader}\n${events.join('\n')}\n`;
    fs.writeFileSync(outputPath, ass, 'utf-8');
}

// ============ 主流程 ============

async function main() {
    console.log('=== 岁己×栞栞 6/4 联动切片工具 ===');
    
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    
    // Parse speaker SRT
    console.log(`\n读取 speaker.srt: ${SPEAKER_SRT_PATH}`);
    if (!fs.existsSync(SPEAKER_SRT_PATH)) {
        console.error('speaker.srt 不存在！请先运行 ASR。');
        process.exit(1);
    }
    const segments = parseSpeakerSrt(SPEAKER_SRT_PATH);
    console.log(`解析到 ${segments.length} 条字幕段`);
    
    // 统计说话人
    const speakerStats = {};
    for (const seg of segments) {
        if (!speakerStats[seg.speaker]) speakerStats[seg.speaker] = 0;
        speakerStats[seg.speaker]++;
    }
    console.log('说话人分布:', speakerStats);
    
    // 读取预设切片时间点
    const segmentsFile = process.argv.includes('--segments') 
        ? process.argv[process.argv.indexOf('--segments') + 1]
        : null;
    
    let clipDefs;
    if (segmentsFile && fs.existsSync(segmentsFile)) {
        clipDefs = JSON.parse(fs.readFileSync(segmentsFile, 'utf-8'));
        console.log(`从 ${segmentsFile} 读取切片定义`);
    } else {
        console.log('\n⚠️ 未提供 --segments 参数。');
        console.log('请先运行 node analyze_sui_shiori.js 分析精彩片段，');
        console.log('然后将结果保存为 JSON 并用 --segments 指定。');
        process.exit(0);
    }
    
    // 执行切片
    for (const clip of clipDefs) {
        console.log(`\n--- 切片: ${clip.name} ---`);
        console.log(`  描述: ${clip.description || ''}`);
        cutAndBurnClip(clip.name, VIDEO_PATH, segments, clip.cuts, OUTPUT_DIR);
    }
    
    console.log('\n=== 全部完成 ===');
    console.log(`输出目录: ${OUTPUT_DIR}`);
}

main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
