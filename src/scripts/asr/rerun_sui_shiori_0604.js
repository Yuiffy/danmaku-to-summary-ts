#!/usr/bin/env node
/**
 * 重新跑 6/4 岁己×栞栞联动录播的 ASR
 * 使用 paraformer + speaker references (岁己SUI + 栞栞)
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = 'D:\\workspace\\myrepo\\danmaku-to-summary-ts';
process.chdir(PROJECT_ROOT);

const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const MEDIA_PATH = 'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\2026_06_04\\录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.flv';
const ROOM_ID = '25788785';
const OUTPUT_DIR = path.join(path.dirname(MEDIA_PATH));

async function main() {
    console.log('=== 重新跑 ASR: 岁己×栞栞 6/4 联动 ===');
    console.log(`媒体文件: ${MEDIA_PATH}`);
    
    if (!fs.existsSync(MEDIA_PATH)) {
        throw new Error(`媒体文件不存在: ${MEDIA_PATH}`);
    }

    const config = configLoader.getConfig();
    console.log(`ASR backend: ${config.asr?.default_backend || 'paraformer'}`);
    
    // Resolve hotwords for this room
    const runtime = asrBackends.resolveAsrHotwords(config, { room_id: ROOM_ID });
    console.log(`Hotwords: ${runtime.hotwords?.length || 0} entries`);
    console.log(`Corrections: ${runtime.corrections?.length || 0} entries`);

    const t0 = Date.now();
    console.log('\n开始 ASR 转录 (paraformer + speaker references)...');
    
    const rawResult = await asrBackends.transcribeParaformer(MEDIA_PATH, config, runtime);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nASR 完成，耗时 ${elapsed}s`);

    // Normalize and apply corrections
    const subtitleConfig = asrBackends.getSubtitleConfig(config);
    const normalized = asrBackends.normalizeAsrResult(rawResult, subtitleConfig);
    const corrected = asrBackends.applyCorrectionsToAsrResult(normalized, runtime.corrections);

    // Write outputs
    const baseName = path.parse(MEDIA_PATH).name;
    
    // 1. speaker.srt (with speaker labels)
    const speakerSrtPath = path.join(OUTPUT_DIR, `${baseName}.speaker.srt`);
    asrBackends.writeSpeakerReviewSrt(corrected, speakerSrtPath);
    console.log(`\n写入 speaker.srt: ${speakerSrtPath}`);

    // 2. regular srt
    const srtPath = path.join(OUTPUT_DIR, `${baseName}.srt`);
    asrBackends.writeSrt(corrected, srtPath);
    console.log(`写入 srt: ${srtPath}`);

    // 3. asr_speakers.json
    const speakersPath = path.join(OUTPUT_DIR, `${baseName}.asr_speakers.json`);
    const speakersSummary = asrBackends.summarizeAsrSpeakers(corrected, MEDIA_PATH, 'paraformer', ROOM_ID);
    asrBackends.writeAsrSpeakersSidecar(speakersSummary, speakersPath);
    console.log(`写入 asr_speakers.json: ${speakersPath}`);

    // Summary
    console.log('\n=== 汇总 ===');
    console.log(`总 segments: ${corrected.segments.length}`);
    const speakerCounts = {};
    for (const seg of corrected.segments) {
        const spk = seg.speaker || 'UNKNOWN';
        if (!speakerCounts[spk]) speakerCounts[spk] = { count: 0, duration: 0 };
        speakerCounts[spk].count++;
        speakerCounts[spk].duration += (seg.end - seg.start);
    }
    for (const [spk, info] of Object.entries(speakerCounts)) {
        console.log(`  ${spk}: ${info.count} segments, ${info.duration.toFixed(1)}s`);
    }

    console.log(`\n总耗时: ${elapsed}s`);
    console.log('DONE');
}

main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
