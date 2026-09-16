const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const asrBackends = require('../src/scripts/asr/asr_backends');
const fusion = require('../src/scripts/do_fusion_summary');
const ownStreamClipper = require('../src/scripts/own_stream_clipper');
const productionConfig = require('../config/production.json');


function parseArgs(argv) {
    const options = {
        audioPath: null,
        outputDir: path.resolve('tmp', 'sui-emotion-validation-20260729'),
        roomId: '25788785',
        runs: 2
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!options.audioPath && !arg.startsWith('--')) {
            options.audioPath = path.resolve(arg);
        } else if (arg === '--output-dir' && argv[index + 1]) {
            options.outputDir = path.resolve(argv[++index]);
        } else if (arg === '--room-id' && argv[index + 1]) {
            options.roomId = String(argv[++index]);
        } else if (arg === '--runs' && argv[index + 1]) {
            options.runs = Math.max(1, Number(argv[++index]) || 1);
        }
    }
    return options;
}

function waitForWorkerReady(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        const timeout = setTimeout(() => reject(new Error('ASR worker startup timeout')), timeoutMs);
        child.stdout.on('data', data => {
            stdout += data.toString();
            const lines = stdout.split(/\r?\n/);
            stdout = lines.pop() || '';
            for (const line of lines) {
                const marker = '[ASR_WORKER_READY] ';
                if (!line.startsWith(marker)) continue;
                clearTimeout(timeout);
                resolve(JSON.parse(line.slice(marker.length)));
                return;
            }
        });
        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            reject(new Error(`ASR worker exited before ready: code=${code}`));
        });
    });
}

function workerRequest(port, token, type, payload = null) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let buffer = '';
        socket.setTimeout(30_000, () => {
            socket.destroy();
            reject(new Error(`worker ${type} timeout`));
        });
        socket.once('error', reject);
        socket.once('connect', () => {
            socket.write(`${JSON.stringify({ type, token, payload })}\n`, 'utf8');
        });
        socket.on('data', data => {
            buffer += data.toString();
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex < 0) return;
            const response = JSON.parse(buffer.slice(0, newlineIndex));
            socket.end();
            if (!response.ok) {
                reject(new Error(response.error || `worker ${type} failed`));
                return;
            }
            resolve(response);
        });
    });
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.audioPath || !fs.existsSync(options.audioPath)) {
        throw new Error('Usage: node scripts/validate_sui_emotion_pipeline.js <15-minute.wav>');
    }
    fs.mkdirSync(options.outputDir, { recursive: true });

    const paraformerConfig = productionConfig.asr.paraformer;
    const python = asrBackends.resolvePythonCommand(paraformerConfig);
    const workerPath = path.resolve('src', 'scripts', 'python', 'asr_persistent_worker.py');
    const token = crypto.randomBytes(24).toString('hex');
    const child = spawn(
        python.executable,
        [...python.args, workerPath, '--port', '0', '--token', token],
        {
            cwd: path.resolve('.'),
            env: { ...process.env, PYTHONUTF8: '1' },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );
    child.stderr.on('data', data => process.stderr.write(data));

    const ready = await waitForWorkerReady(
        child,
        Math.max(30, Number(paraformerConfig.persistent_worker?.startup_timeout_s || 60)) * 1000
    );
    const previousPort = process.env.ASR_PERSISTENT_WORKER_PORT;
    const previousToken = process.env.ASR_PERSISTENT_WORKER_TOKEN;
    process.env.ASR_PERSISTENT_WORKER_PORT = String(ready.port);
    process.env.ASR_PERSISTENT_WORKER_TOKEN = token;

    try {
        const routingContext = {
            room_id: options.roomId,
            filename: path.basename(options.audioPath),
            streamer_name: '岁己SUI'
        };
        const resolvedBackend = asrBackends.resolveAsrBackend(productionConfig, routingContext, 'paraformer');
        const results = [];
        for (let index = 0; index < options.runs; index += 1) {
            const started = Date.now();
            const result = await asrBackends.transcribeParaformer(
                options.audioPath,
                productionConfig,
                { routingContext, resolvedBackend }
            );
            results.push({
                result,
                elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(3))
            });
            console.log(
                `run=${index + 1} elapsed=${results.at(-1).elapsedSeconds}s `
                + `paraformer_cache=${result.timings?.model_cache_hit} `
                + `emotion_cache=${result.emotion_analysis?.modelCacheHit}`
            );
        }

        const first = results[0].result;
        const normalized = asrBackends.normalizeAsrResult(first, productionConfig.subtitle);
        const baseName = 'sui_first_15m_emotion';
        const srtPath = path.join(options.outputDir, `${baseName}.srt`);
        const metaPath = path.join(options.outputDir, `${baseName}.asr_meta.json`);
        asrBackends.writeSrt(normalized, srtPath, productionConfig.subtitle);
        const meta = {
            backend: normalized.backend,
            routingReason: resolvedBackend.reason,
            stageTimings: first.timings || null,
            speakerProcessing: first.speaker_processing || null,
            emotionAnalysis: first.emotion_analysis || null,
            segments: normalized.segments.length,
            generatedAt: new Date().toISOString()
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        await fusion.processLiveData([srtPath]);

        const clipConfig = ownStreamClipper.getOwnStreamClipsConfig(productionConfig);
        const totalDuration = Number(normalized.segments.at(-1)?.end || 0);
        const persistedEmotionAnalysis = ownStreamClipper.loadEmotionAnalysisForSrt(srtPath);
        if (persistedEmotionAnalysis.status !== 'completed') {
            throw new Error('Persisted ASR emotion analysis could not be reloaded for clipping');
        }
        const candidates = ownStreamClipper.buildCandidateWindows(
            normalized,
            [],
            clipConfig,
            totalDuration,
            persistedEmotionAnalysis
        );
        const candidatePath = path.join(options.outputDir, `${baseName}.emotion_candidates.json`);
        fs.writeFileSync(candidatePath, JSON.stringify(candidates, null, 2), 'utf8');

        const health = await workerRequest(ready.port, token, 'health');
        const report = {
            source: options.audioPath,
            roomId: options.roomId,
            runs: results.map(({ result, elapsedSeconds }, index) => ({
                run: index + 1,
                elapsedSeconds,
                paraformerCacheHit: Number(result.timings?.model_cache_hit || 0) === 1,
                emotionModelCacheHit: result.emotion_analysis?.modelCacheHit === true,
                stageTimings: result.timings || {},
                emotionTimings: result.emotion_analysis?.timings || {},
                segments: result.segments?.length || 0
            })),
            health: health,
            emotionCounts: first.emotion_analysis?.emotionCounts || {},
            eventCounts: first.emotion_analysis?.eventCounts || {},
            emotionCandidateCount: candidates.length,
            outputs: {
                srtPath,
                metaPath,
                highlightPath: path.join(options.outputDir, `${baseName}_AI_HIGHLIGHT.txt`),
                candidatePath
            }
        };
        const reportPath = path.join(options.outputDir, 'validation-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify(report, null, 2));
    } finally {
        try {
            await workerRequest(ready.port, token, 'shutdown');
        } catch (error) {
            console.warn(`worker shutdown failed: ${error.message}`);
            child.kill();
        }
        if (previousPort === undefined) delete process.env.ASR_PERSISTENT_WORKER_PORT;
        else process.env.ASR_PERSISTENT_WORKER_PORT = previousPort;
        if (previousToken === undefined) delete process.env.ASR_PERSISTENT_WORKER_TOKEN;
        else process.env.ASR_PERSISTENT_WORKER_TOKEN = previousToken;
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArgs,
    workerRequest,
    waitForWorkerReady
};
