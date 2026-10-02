'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const workflow = require('./clipping/stream_activity_clipper');
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
    const [command = 'help', ...args] = argv, options = {};
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (['--no-register', '--enqueue', '--scan'].includes(key)) options[key.slice(2)] = true;
        else if (/^--[a-z-]+$/u.test(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
        else throw new Error(`Unknown or incomplete argument: ${key}`);
    }
    return { command, options };
}
function songStatistics(root) {
    const records = [], sessions = new Map();
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory() && !entry.isSymbolicLink() && !['temp', 'node_modules', '.git'].includes(entry.name)) walk(full);
            else if (entry.isFile() && entry.name === 'SONGS.json') records.push(JSON.parse(fs.readFileSync(full, 'utf8')));
        }
    };
    walk(path.resolve(root));
    for (const record of records) if (record.type === 'sui_stream_song_record') sessions.set(record.sessionId, record);
    const counts = new Map(); let unknownPerformances = 0, performances = 0, fragments = 0, inspectedSessions = 0, unverifiedPerformances = 0;
    for (const record of sessions.values()) {
        if (record.coverage?.status !== 'complete' || !['planned', 'rendered'].includes(record.status)) continue;
        inspectedSessions++;
        for (const song of record.songs) {
            if (song.verificationStatus === 'uncertain' || (song.reviewIssues || []).some(issue =>
                ['media_verification_unconfirmed', 'source_transcript_timing_unreliable'].includes(issue))) {
                unverifiedPerformances++; continue;
            }
            performances++; if (song.performance === 'fragment') fragments++;
            if (!song.name) { unknownPerformances++; continue; }
            const row = counts.get(song.name) || { name: song.name, performances: 0, fragments: 0, sessions: new Set() };
            row.performances++; if (song.performance === 'fragment') row.fragments++;
            row.sessions.add(record.sessionId); counts.set(song.name, row);
        }
    }
    return { schemaVersion: 1, sessions: sessions.size, inspectedSessions, incompleteSessions: sessions.size - inspectedSessions,
        performances, fragments, unknownPerformances, unverifiedPerformances, songs: [...counts.values()].map(row => ({ ...row, sessions: row.sessions.size }))
            .sort((a, b) => b.performances - a.performances || a.name.localeCompare(b.name, 'zh')) };
}
async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArgs(argv);
    if (command === 'restyle') {
        if (!options.metadata && !options.manifest) throw new Error('restyle requires --metadata or --manifest');
        const result = await workflow.restyleStreamActivities({
            metadataPath: options.metadata ? path.resolve(options.metadata) : null,
            manifestPath: options.manifest ? path.resolve(options.manifest) : null, registerUpload: !options['no-register'],
            contentName: options['content-name'], evidenceFrame: options['evidence-frame'], evidenceNote: options['evidence-note'] });
        console.log(JSON.stringify(result, null, 2)); return result;
    }
    if (['run', 'plan'].includes(command)) {
        if (!options.media || !options.srt) throw new Error('run/plan requires --media and --srt');
        const result = await workflow.generateStreamActivities({ mediaPath: path.resolve(options.media), srtPath: path.resolve(options.srt),
            xmlPath: options.xml ? path.resolve(options.xml) : null, context: { roomId: options['room-id'] },
            summaryPath: options.summary ? path.resolve(options.summary) : null,
            fullLiveContextPath: options['full-context'] ? path.resolve(options['full-context']) : null, scan: options.scan === true,
            planOnly: command === 'plan', registerUpload: !options['no-register'] });
        console.log(JSON.stringify(result, null, 2)); return result;
    }
    if (command === 'approve') {
        if (!options.metadata || !options.note) throw new Error('approve requires --metadata and --note');
        const metadataPath = path.resolve(options.metadata);
        const approved = await execFileAsync('python', [path.join(__dirname, 'stream_activity_review.py'), '--metadata', metadataPath,
            '--note', options.note], { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
        console.log(approved.stdout.trim());
        const registered = await workflow.register(path.join(path.dirname(metadataPath), 'UPLOAD_MANIFEST.json'));
        if (options.enqueue) {
            const preflight = await execFileAsync('python', [path.join(__dirname, 'bilibili_upload_capabilities.py'),
                '--metadata', metadataPath], { windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024 });
            console.log(`投稿权限预检: ${preflight.stdout.trim()}`);
            const payload = JSON.parse(registered.split('REGISTRY_RESULT:')[1].trim());
            const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(metadataPath), 'UPLOAD_MANIFEST.json'), 'utf8'));
            const index = manifest.clips.find(row => path.resolve(row.metadataPath) === metadataPath)?.reviewIndex;
            const id = payload.clipIdsByReviewIndex[String(index)];
            if (!id) throw new Error('Reviewed submission has no registry ID');
            const queued = await execFileAsync('python', [path.join(__dirname, 'clip_upload_registry.py'), 'enqueue', '--ids', String(id),
                '--timeout-seconds', '14400'], { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024 });
            console.log(queued.stdout.trim());
        }
        return;
    }
    if (command === 'stats') {
        if (!options.root) throw new Error('stats requires --root');
        const result = songStatistics(options.root); console.log(JSON.stringify(result, null, 2)); return result;
    }
    if (command !== 'help') throw new Error(`Unknown command: ${command}`);
    console.log('activity:clips run|plan --media <recording> --srt <SRT> [--xml <XML>] [--summary <LIVE_CONTENT.json>] [--full-context <FULL_LIVE_CONTEXT.json>] [--scan] [--room-id 25788785] [--no-register]\n'
        + 'activity:clips approve --metadata <songs.json|watch.json> --note <review note> [--enqueue]\n'
        + 'activity:clips restyle --manifest <UPLOAD_MANIFEST.json> | --metadata <songs.json|watch.json> [--no-register]\n'
        + 'activity:clips stats --root <recording root>');
}
module.exports = { parseArgs, songStatistics, main };
if (require.main === module) main().catch(error => { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; });
