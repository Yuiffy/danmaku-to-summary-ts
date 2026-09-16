const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

process.env.NODE_PATH = [
    projectRoot,
    path.join(projectRoot, 'local-scripts', 'src-scripts'),
    path.join(projectRoot, 'src')
].join(';');
require('module')._initPaths();

const asrBackends = require(path.join(projectRoot, 'src', 'scripts', 'asr', 'asr_backends'));

async function main() {
    const mediaPath = process.argv[2];
    const outSrt = process.argv[3];
    const modelDir = process.argv[4];

    if (!mediaPath || !outSrt || !modelDir) {
        console.error('Usage: node scripts/run_project_paraformer_review.js <media> <srt_out> <model_dir>');
        process.exit(1);
    }

    if (!fs.existsSync(mediaPath)) {
        console.error(`Input media does not exist: ${mediaPath}`);
        process.exit(1);
    }

    if (!fs.existsSync(modelDir)) {
        console.error(`Model dir does not exist: ${modelDir}`);
        process.exit(1);
    }

    const config = {
        asr: { default_backend: 'paraformer' },
        paraformer: {
            model: modelDir,
            vad_model: 'fsmn-vad',
            punc_model: 'ct-punc',
            enable_speaker: false,
            vad_max_single_segment_time_ms: 60000,
            batch_size_s: 300,
            batch_size_threshold_s: 60,
        },
        subtitle: {
            max_chars_per_line: 18,
            max_chars_per_segment: 30,
            min_duration: 0.7,
            max_duration: 5.5,
            gap_split_threshold: 0.45,
            merge_short_segments: true,
            avoid_overlap: true,
            strip_punctuation: false,
        },
    };
    const runtime = { hotwords: [], corrections: [] };

    const raw = await asrBackends.transcribeParaformer(mediaPath, config, runtime);
    const normalized = asrBackends.normalizeAsrResult(raw, asrBackends.getSubtitleConfig(config));
    asrBackends.writeSrt(normalized, outSrt);
    console.log(JSON.stringify({ segmentCount: normalized.segments.length, outSrt }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
