'use strict';
const fs = require('fs');
const path = require('path');
const { selectPublication, publicationMarkdown } = require('./publication_policy');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function readSource(plan) {
    const parsed = require('../asr/asr_backends').parseSrt(plan.source.srtPath);
    // Match production evidence grouping and hashes, including trusted speaker/ASR sidecars.
    parsed.segments = require('../asr/evidence_sidecar').loadAsrEvidence(plan.source.srtPath, parsed.segments).segments;
    return parsed;
}
function saveNew(file, value) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
function originalClips(plan) {
    if (!plan.publication || plan.publication.policy.mode === 'all') return plan.clips;
    const byIndex = new Map();
    // Shadow plans have both rendered and deferred copies of the same candidate.
    for (const clip of [...plan.publication.deferred, ...plan.clips]) {
        if (!Number.isInteger(clip.publication?.index)) throw new Error('Missing original publication index');
        byIndex.set(clip.publication.index, clip);
    }
    if (byIndex.size !== plan.publication.inputCount) throw new Error('Incomplete saved candidate pool');
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, clip]) => {
        const { publication, ...original } = clip; return original;
    });
}
function parseArgs(argv) {
    const options = { command: argv[0] || 'help' };
    const values = new Set(['plan', 'output', 'mode', 'min-score', 'max-standalone', 'standout-score', 'indices', 'group', 'room']);
    for (let i = 1; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        if (key === 'suggest-bundles' || key === 'all') options[key] = true;
        else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
        else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    }
    return options;
}
async function run(options, dependencies = {}) {
    if (options.command === 'help') {
        console.log('clips:publication preview --plan PLAN.json --output preview.json [--mode curated|score|shadow|all] [--min-score 80] [--max-standalone 18] [--standout-score 92] [--suggest-bundles]\n'
            + 'clips:publication restore --plan PLAN.json --indices 2,5 --output restored.json (or --all)\n'
            + 'clips:publication build-bundle --plan preview.json --group 1 --output bundle.mp4\n'
            + 'All commands save new local files. No registration, notifications or upload.');
        return;
    }
    if (!['preview', 'restore', 'build-bundle'].includes(options.command)) throw new Error('Unknown publication command');
    if (!options.plan || !options.output) throw new Error('--plan and --output are required');
    if (fs.existsSync(options.output)) throw new Error(`Output already exists: ${options.output}`);
    const plan = readJson(options.plan);
    if (!Array.isArray(plan.clips)) throw new Error('Missing plan.clips');
    if (options.command === 'restore') {
        const clips = originalClips(plan);
        if (!options.all && !options.indices) throw new Error('Choose --indices or --all explicitly');
        const indices = options.all ? clips.map((_, index) => index + 1) : String(options.indices).split(',').map(Number);
        if (!indices.length || new Set(indices).size !== indices.length || indices.some(n => !Number.isInteger(n) || n < 1 || n > clips.length)) throw new Error('Invalid original candidate indices');
        const restored = { version: 1, source: plan.source, restoredFrom: path.resolve(options.plan),
            clips: indices.map(n => clips[n - 1]), config: { publicationPolicy: { mode: 'all' } } };
        saveNew(options.output, restored);
        console.log(`Exported ${restored.clips.length} candidates. Render with own_stream_clipper --use-plan and --publication-mode all.`);
        return restored;
    }
    const rootConfig = dependencies.rootConfig || require('../config-loader').getConfig();
    const ownConfig = require('../own_stream_clipper').getOwnStreamClipsConfig(rootConfig);
    if (options.command === 'build-bundle') {
        if (!plan.publication) throw new Error('A preview/production plan with publication proposals is required');
        const index = Number(options.group);
        const group = plan.publication.bundles.proposals[index - 1];
        if (!Number.isInteger(index) || index < 1 || !group) throw new Error('Invalid bundle group');
        const parsed = readSource(plan);
        const compilation = require('./publication_bundles').compilationPlan(plan, group, parsed);
        const planPath = options.output + '.plan.json';
        saveNew(planPath, compilation);
        const result = await (dependencies.buildCompilation || require('./topic_compilation').buildCompilation)(compilation, options.output,
            { rootConfig, planPath, overlayTemplate: '片段{sequence}', workDir: path.join(path.dirname(path.resolve(options.output)), 'temp', path.basename(options.output)),
                reviewTitle: '关联合辑待审核（未登记、未授权上传）' });
        console.log(JSON.stringify(result)); return result;
    }
    const roomId = options.room || plan.roomId || require('../own_stream_clipper').parseRecordingInfo(plan.source?.mediaPath || '').roomId;
    const raw = { ...ownConfig.publicationPolicy, mode: options.mode || 'curated' };
    for (const [flag, name] of [['min-score', 'minScore'], ['max-standalone', 'maxStandalone'], ['standout-score', 'standoutScore']]) {
        if (options[flag] !== undefined) raw[name] = Number(options[flag]);
    }
    raw.bundles = { ...raw.bundles, enabled: Boolean(options['suggest-bundles']) };
    const selection = selectPublication(originalClips(plan), raw, roomId);
    const report = selection.report;
    const diagnostics = { requests: [], errors: [] };
    if (raw.bundles.enabled) {
        const parsed = readSource(plan);
        report.bundles = await require('./publication_bundles').proposeBundles(report, parsed,
            { roomId, selectionCacheDirectory: path.join(path.dirname(path.resolve(options.output)), '.publication-cache') }, ownConfig, rootConfig, diagnostics);
    }
    report.reviewPath = path.resolve(options.output.replace(/\.json$/i, '') + '.md');
    report.requests = diagnostics.requests;
    const preview = { ...plan, clips: selection.clips, publication: report, status: 'publication_preview', roomId,
        generatedAt: new Date().toISOString(), previewOf: path.resolve(options.plan) };
    saveNew(options.output, preview); saveNew(report.reviewPath, publicationMarkdown(report));
    console.log(JSON.stringify({ input: report.inputCount, standalone: report.recommendedCount, deferred: report.deferredCount,
        bundles: report.bundles.proposals.length, bundleStatus: report.bundles.status, output: path.resolve(options.output) }));
    return preview;
}
if (require.main === module) run(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, parseArgs, originalClips };
