#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const CLIPS_DIR = 'D:\\files\\videos\\DDTV录播\\31368705_米汀Nagisa\\2026_06_03\\topic_clips';
const OUTPUT_DIR = path.join(process.cwd(), 'tmp', 'asr_rerun');
const BACKEND = 'paraformer';

const TOPIC_FILES = [
    '录制-31368705-20260603-222803-754-六月米出没_topic_01_002055.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_02_002614.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_03_003624.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_04_010005.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_05_010249.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_06_011119.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_07_011936.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_08_012642.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_09_013046.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_10_014217.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_11_015959.m4a',
    '录制-31368705-20260603-222803-754-六月米出没_topic_12_020450.m4a',
];

async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const config = configLoader.getConfig();
    const runtime = asrBackends.resolveAsrHotwords(config, { room_id: '31368705' });
    const results = [];

    for (let i = 0; i < TOPIC_FILES.length; i++) {
        const filename = TOPIC_FILES[i];
        const audioPath = path.join(CLIPS_DIR, filename);
        const baseName = path.parse(filename).name;
        const outputSrt = path.join(OUTPUT_DIR, `${baseName}.srt`);

        console.log(`\n[${i + 1}/${TOPIC_FILES.length}] ${filename}`);

        if (!fs.existsSync(audioPath)) {
            console.log(`  SKIP: file not found`);
            results.push({ file: filename, status: 'missing', text: '', xiaosui: false });
            continue;
        }

        try {
            const t0 = Date.now();
            const rawResult = await asrBackends.transcribeParaformer(audioPath, config, runtime);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const normalized = asrBackends.normalizeAsrResult(rawResult, asrBackends.getSubtitleConfig(config));
            const corrected = asrBackends.applyCorrectionsToAsrResult(normalized, runtime.corrections);
            const text = corrected.segments.map(s => s.text).join('');
            const xiaosui = /小岁/.test(text);
            const sui = /岁己/.test(text);

            asrBackends.writeSrt(corrected, outputSrt);
            console.log(`  OK (${elapsed}s): ${text.slice(0, 120)}`);
            console.log(`  小岁=${xiaosui}, 岁己=${sui}`);
            results.push({ file: filename, status: 'ok', text, xiaosui, sui, srt: outputSrt });
        } catch (error) {
            console.log(`  FAIL: ${error.message}`);
            results.push({ file: filename, status: 'failed', error: error.message, text: '', xiaosui: false });
        }
    }

    const summaryPath = path.join(OUTPUT_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        backend: BACKEND,
        generatedAt: new Date().toISOString(),
        results
    }, null, 2));
    console.log(`\n=== 汇总 ===`);
    console.log(`总计: ${results.length}`);
    results.forEach(r => {
        const mark = r.xiaosui ? '⚠️ 小岁' : (r.status === 'ok' ? '✅' : '❌');
        console.log(`  ${mark} [${r.status}] ${r.file}: ${(r.text || '').slice(0, 80)}`);
    });
    console.log(`\n报告: ${summaryPath}`);
}

main().catch(err => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
});
