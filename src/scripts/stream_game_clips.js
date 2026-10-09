'use strict';
const path = require('path');
const fs = require('fs');
const workflow = require('./clipping/stream_game_clipper');
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);
function parseArgs(argv) {
    const [command = 'help', ...args] = argv, options = {};
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (['--enqueue', '--enable', '--no-register'].includes(key)) options[key.slice(2)] = true;
        else if (/^--[a-z-]+$/u.test(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
        else throw new Error(`Unknown or incomplete argument ${key}`);
    }
    return { command, options };
}
async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArgs(argv);
    if (['run', 'plan'].includes(command)) {
        if (!options.media || !options.srt) throw new Error('Games need --media and --srt');
        const config = require('./config-loader').getConfig();
        if (options.enable) config.streamGameClips = { ...(config.streamGameClips || {}), enabled: true };
        const result = await workflow.generateStreamGames({ mediaPath: path.resolve(options.media), srtPath: path.resolve(options.srt),
            xmlPath: options.xml ? path.resolve(options.xml) : null, context: { roomId: options['room-id'] || '25788785' }, config,
            planOnly: command === 'plan', registerUpload: !options['no-register'], enqueue: options.enqueue, episode: options.episode ? Number(options.episode) : null });
        console.log(JSON.stringify(result, null, 2)); return result;
    }
    if (command === 'inventory') {
        if (!options.root) throw new Error('inventory needs --root');
        const records = [], walk = folder => { for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
            if (e.isDirectory() && !['temp', 'node_modules', '.git'].includes(e.name)) walk(path.join(folder, e.name));
            else if (e.name === 'PLAN.json') { const p = path.join(folder, e.name), row = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (row.type === 'stream_game_plan') records.push({ planPath: p, recordedAt: row.recordedAt, status: row.status,
                    coverage: row.coverage.status, events: row.events, parts: row.parts?.length || 0 }); }
        } };
        walk(path.resolve(options.root)); console.log(JSON.stringify(records, null, 2)); return records;
    }
    if (command === 'approve') {
        if (!options.metadata || !options.note) throw new Error('approve requires --metadata and --note');
        const metadata = path.resolve(options.metadata), manifestPath = path.join(path.dirname(metadata), 'UPLOAD_MANIFEST.json');
        await execFileAsync('python', [path.join(__dirname, 'stream_game_review.py'), '--metadata', metadata,
            '--authorization-note', options.note], { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
        const result = await execFileAsync('python', [path.join(__dirname, 'clip_upload_registry.py'), 'import-json', '--manifest', manifestPath, '--include-pending'],
            { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
        const registered = JSON.parse(result.stdout.split('REGISTRY_RESULT:')[1].trim());
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const index = manifest.clips.find(row => path.resolve(row.metadataPath) === metadata)?.reviewIndex;
        const id = registered.clipIdsByReviewIndex[String(index)];
        if (!id) throw new Error('Reviewed game submission has no registry ID');
        if (options.enqueue && registered.clipStatusByReviewIndex[String(index)] !== 'uploaded') {
            await execFileAsync('python', [path.join(__dirname, 'clip_upload_registry.py'), 'enqueue', '--ids', String(id),
                '--timeout-seconds', '14400', '--batch-size', '1', '--note', options.note],
            { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
        }
        console.log(JSON.stringify({ id, metadataPath: metadata, status: registered.clipStatusByReviewIndex[String(index)] }, null, 2));
        return;
    }
    if (command !== 'help') throw new Error(`Unknown game command ${command}`);
    console.log('node src/scripts/stream_game_clips.js plan|run --media <recording> --srt <SRT> [--xml <XML>] [--episode <number>] [--enqueue]\n'
        + 'node src/scripts/stream_game_clips.js approve --metadata <game submission JSON> --note <review/authorization> [--enqueue]\n'
        + 'node src/scripts/stream_game_clips.js inventory --root <game output root>');
}
module.exports = { parseArgs, main };
if (require.main === module) main().catch(e => { console.error(`[ERROR] ${e.message}`); process.exitCode = 1; });
