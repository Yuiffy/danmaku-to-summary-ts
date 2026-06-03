#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DOCTOR_SCRIPT = path.join(__dirname, 'asr_vllm_doctor.js');
const BENCHMARK_SCRIPT = path.join(__dirname, 'hotword_benchmark.js');

const DEFAULT_POSITIVE_ROOT = 'D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01';
const DEFAULT_NEGATIVE_ROOT = 'D:/files/videos/DDTV录播/80397_阿梓从小就很可爱/2026_06_02';

function parseArgs(argv) {
    const options = {
        positiveRoot: DEFAULT_POSITIVE_ROOT,
        negativeRoot: DEFAULT_NEGATIVE_ROOT,
        outputDir: path.join(process.cwd(), 'tmp', 'asr-vllm-experiment'),
        backend: 'fun_asr_nano,fun_asr_nano_vllm',
        limit: 1,
        windowSec: 20,
        noAsr: false,
        requireReady: false,
        skipDoctor: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--positive-root') {
            options.positiveRoot = argv[++i];
        } else if (arg.startsWith('--positive-root=')) {
            options.positiveRoot = arg.slice('--positive-root='.length);
        } else if (arg === '--negative-root') {
            options.negativeRoot = argv[++i];
        } else if (arg.startsWith('--negative-root=')) {
            options.negativeRoot = arg.slice('--negative-root='.length);
        } else if (arg === '--output') {
            options.outputDir = argv[++i];
        } else if (arg.startsWith('--output=')) {
            options.outputDir = arg.slice('--output='.length);
        } else if (arg === '--backend') {
            options.backend = argv[++i];
        } else if (arg.startsWith('--backend=')) {
            options.backend = arg.slice('--backend='.length);
        } else if (arg === '--limit') {
            options.limit = Number(argv[++i]);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Number(arg.slice('--limit='.length));
        } else if (arg === '--window') {
            options.windowSec = Number(argv[++i]);
        } else if (arg.startsWith('--window=')) {
            options.windowSec = Number(arg.slice('--window='.length));
        } else if (arg === '--no-asr') {
            options.noAsr = true;
        } else if (arg === '--require-ready') {
            options.requireReady = true;
        } else if (arg === '--skip-doctor') {
            options.skipDoctor = true;
        }
    }

    options.limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 1;
    options.windowSec = Number.isFinite(options.windowSec) && options.windowSec > 0 ? options.windowSec : 20;
    options.outputDir = String(options.outputDir || '').trim() || path.join(process.cwd(), 'tmp', 'asr-vllm-experiment');
    options.backend = String(options.backend || '').trim() || 'fun_asr_nano,fun_asr_nano_vllm';
    return options;
}

function runNode(args, label, options = {}) {
    console.log(`[experiment] ${label}: node ${args.join(' ')}`);
    const result = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 64
    });
    if (result.stdout && !options.quietStdout) {
        process.stdout.write(result.stdout);
    }
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    return result;
}

function runDoctor() {
    const result = runNode([DOCTOR_SCRIPT, '--json'], 'doctor', { quietStdout: true });
    let report = null;
    try {
        report = JSON.parse(result.stdout || '{}');
    } catch (error) {
        report = {
            ok: false,
            errors: [`doctor json parse failed: ${error.message}`],
            rawStdout: result.stdout
        };
    }
    report.exitCode = result.status;
    return report;
}

function runBenchmark(name, root, options) {
    const outputDir = path.join(options.outputDir, name);
    const args = [
        BENCHMARK_SCRIPT,
        '--root', root,
        '--limit', String(options.limit),
        '--window', String(options.windowSec),
        '--backend', options.backend,
        '--output', outputDir
    ];
    if (options.noAsr) {
        args.push('--no-asr');
    }

    const result = runNode(args, `${name} benchmark`);
    const reportPath = path.join(outputDir, 'report.json');
    let report = null;
    if (fs.existsSync(reportPath)) {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
    }
    return {
        name,
        root,
        outputDir,
        reportPath,
        exitCode: result.status,
        ok: result.status === 0 && Boolean(report),
        report
    };
}

function pickBackendSummary(report, backend) {
    if (!report?.summary?.byBackend) {
        return null;
    }
    return report.summary.byBackend[backend] || null;
}

function buildSummary(options, doctor, benchmarks) {
    const backendNames = options.backend.split(',').map(item => item.trim()).filter(Boolean);
    const byBackend = {};
    for (const backend of backendNames) {
        byBackend[backend] = {};
        for (const item of benchmarks) {
            byBackend[backend][item.name] = pickBackendSummary(item.report, backend);
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        options,
        doctor: {
            ok: Boolean(doctor?.ok),
            exitCode: doctor?.exitCode,
            errors: doctor?.errors || [],
            warnings: doctor?.warnings || [],
            recommendations: doctor?.recommendations || []
        },
        benchmarks: benchmarks.map(item => ({
            name: item.name,
            root: item.root,
            ok: item.ok,
            exitCode: item.exitCode,
            reportPath: item.reportPath,
            summary: item.report?.summary || null
        })),
        byBackend
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    fs.mkdirSync(options.outputDir, { recursive: true });

    const doctor = options.skipDoctor ? { ok: null, skipped: true } : runDoctor();
    if (options.requireReady && doctor && doctor.ok === false) {
        const summary = buildSummary(options, doctor, []);
        const summaryPath = path.join(options.outputDir, 'summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
        console.error('[experiment] doctor 未通过，已按 --require-ready 停止。');
        console.error(`[experiment] summary: ${summaryPath}`);
        process.exit(1);
    }

    const benchmarks = [
        runBenchmark('positive-sui', options.positiveRoot, options),
        runBenchmark('negative-random', options.negativeRoot, options)
    ];
    const summary = buildSummary(options, doctor, benchmarks);
    const summaryPath = path.join(options.outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`[experiment] summary: ${summaryPath}`);
}

main();
