const path = require('path');

process.env.NODE_PATH = [
    path.resolve('.'),
    path.resolve('local-scripts/src-scripts'),
    path.resolve('src')
].join(';');
require('module')._initPaths();

const fs = require('fs');
const asrBackends = require('./asr_backends');

async function main() {
    const wavPath = process.argv[2];
    const outSrt = process.argv[3];

    if (!wavPath || !outSrt) {
        console.error('Usage: node src/scripts/asr/standalone_asr.js <wav> <srt_out>');
        process.exit(1);
    }

    if (!fs.existsSync(wavPath)) {
        console.error(`Input WAV does not exist: ${wavPath}`);
        process.exit(1);
    }

    const config = { asr: { default_backend: 'paraformer' } };
    const runtime = { hotwords: [], corrections: [] };

    const raw = await asrBackends.transcribeParaformer(wavPath, config, runtime);
    const normalized = asrBackends.normalizeAsrResult(raw, asrBackends.getSubtitleConfig(config));
    asrBackends.writeSrt(normalized, outSrt);
    console.log(`OK:${normalized.segments.length}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
