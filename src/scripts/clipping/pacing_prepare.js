'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadWorkflow } = require('../workflow-runtime');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const run = (exe, args, maxBuffer = 1024 * 1024) => new Promise((resolve, reject) => execFile(exe, args,
    { encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer }, (error, stdout) => error ? reject(error) : resolve(stdout)));

function sourceIdentity(mediaPath, srtPath) {
    const stat = fs.statSync(mediaPath);
    return { path: path.resolve(mediaPath), size: stat.size, mtimeMs: stat.mtimeMs, subtitles: hash(fs.readFileSync(srtPath)) };
}

async function preparePacingBatch(clips, parsed, config, info, options, dependencies = {}) {
    const { protectedPauseWindows, detectQuietPcm, usefulPauseEvidence, pacingSettings } = loadWorkflow('clipping/enhancement');
    const { buildExperimentSelection, assignExperiment } = loadWorkflow('clipping/experiment');
    const { buildSubtitleEvidence } = require('./subtitle_evidence');
    const settings = pacingSettings(config.enhancements.pacing);
    const packet = buildExperimentSelection(clips, parsed.segments, config.enhancements.experiment, buildSubtitleEvidence(parsed.segments).sourceSha256);
    const summary = { version: 1, workflow: 'pacing', total: clips.length, maxSelected: packet.maxSelected,
        batchId: packet.batchId, selected: [], selectionLog: null, status: 'ordinary_control',
        eligibleCount: packet.eligibleIds.length, excludedCounts: { ...packet.excludedCounts }, scannedSeconds: 0, cachedWindows: 0 };
    const finish = (choices, reason, preparations = new Map()) => ({ summary: { ...summary, selected: choices, reason,
        status: choices.length ? 'selected' : 'ordinary_control' },
        clips: assignExperiment(clips, packet, choices).map((clip, index) => ({ ...clip,
            ...(preparations.has(index + 1) ? { precisionPreparation: preparations.get(index + 1) } : {}) })) });
    if (!packet.maxSelected || !packet.eligibleIds.length) return finish([], 'no_eligible_candidates');
    if (!options?.mediaPath || !options?.srtPath || !config.enhancements.editing) return finish([], 'pacing_source_unavailable');
    const identity = sourceIdentity(options.mediaPath, options.srtPath), sourceId = hash(JSON.stringify(identity));
    const ffmpeg = options.ffmpegPath || config.ffmpegPath || 'ffmpeg';
    const ffprobe = options.ffprobePath || (path.basename(ffmpeg).toLowerCase().startsWith('ffmpeg')
        ? path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe');
    const cacheRoot = path.join(info.selectionCacheDirectory, 'pacing-audio');
    fs.mkdirSync(cacheRoot, { recursive: true });
    const eligible = clips.map((clip, index) => ({ clip, id: index + 1,
        gaps: packet.eligibleIds.includes(index + 1) ? protectedPauseWindows(parsed.segments, clip, settings.minRemovedSeconds + .6) : [] }));
    if (!eligible.some(item => item.gaps.length)) return finish([], 'no_verified_pauses');
    try {
        const probe = dependencies.probe || (async () => JSON.parse((await run(ffprobe,
            ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', options.mediaPath])).toString('utf8')));
        const data = await probe();
        if (![1, 2].includes(data.streams?.[0]?.channels)) return finish([], 'unsupported_audio_channels');
    } catch (error) { return { ...finish([], 'pacing_source_unavailable'), error: error.message }; }
    const preparations = new Map(), choices = [], pendingVad = [], perClip = [];
    for (const item of eligible) {
        const events = [], scans = [];
        for (const gap of item.gaps) {
            const duration = gap.end - gap.start;
            if (duration > 30) continue;
            const key = hash(JSON.stringify({ version: 2, sourceId, gap, settings }));
            const file = path.join(cacheRoot, key + '.json');
            let scan;
            if (fs.existsSync(file)) {
                try { const cached = JSON.parse(fs.readFileSync(file, 'utf8')); if (cached.key === key) { scan = cached; summary.cachedWindows++; } } catch { /* Recompute broken local cache. */ }
            }
            if (!scan) {
                if (summary.scannedSeconds + duration > settings.maxScannedSeconds) continue;
                summary.scannedSeconds += duration;
                try {
                    const pcm = dependencies.decode ? await dependencies.decode(gap) : await run(ffmpeg,
                        ['-v', 'error', '-nostdin', '-ss', String(gap.start), '-i', options.mediaPath, '-t', String(duration),
                            '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '2', '-f', 's16le', 'pipe:1'], Math.ceil((duration + 1) * 64000));
                    if (Math.abs(pcm.length / 64000 - duration) > .05) throw new Error('Incomplete PCM scan');
                    scan = { version: 1, key, sourceId, source: identity, window: gap, pcmSha256: hash(pcm),
                        method: 'stereo_peak_10ms', noiseDb: settings.noiseDb,
                        events: detectQuietPcm(pcm, gap.start, sourceId, settings) };
                    if (!scan.events.length && config.enhancements.pacing?.nonSpeechVad !== false) {
                        scan.pcmPath = path.join(cacheRoot, key + '.pcm');
                        fs.writeFileSync(scan.pcmPath, pcm);
                    }
                    const temporary = file + `.${process.pid}.tmp`;
                    fs.writeFileSync(temporary, JSON.stringify(scan), 'utf8'); fs.renameSync(temporary, file);
                } catch (error) { scans.push({ window: gap, error: error.message }); continue; }
            }
            events.push(...scan.events); scans.push({ window: gap, path: file, pcmSha256: scan.pcmSha256 });
            if (!scan.events.length && scan.pcmPath && config.enhancements.pacing?.nonSpeechVad !== false) {
                let cachedVad;
                try {
                    const saved = JSON.parse(fs.readFileSync(file + '.vad.json', 'utf8'));
                    if (saved.key === key && saved.pcmSha256 === scan.pcmSha256
                        && Math.abs(fs.statSync(path.join(saved.vad.modelPath, 'model.pt')).mtimeMs - saved.vad.modelMtimeMs) < 1) cachedVad = saved;
                } catch { /* No compatible VAD result. */ }
                if (cachedVad) events.push(...cachedVad.events);
                else pendingVad.push({ scan, file, events });
            }
        }
        perClip.push({ item, events, scans });
    }
    if (pendingVad.length) {
        try {
            const requestPath = path.join(cacheRoot, `vad-${process.pid}.json`);
            fs.writeFileSync(requestPath, JSON.stringify({ modelPath: config.enhancements.pacing?.vadModelPath,
                windows: pendingVad.map(({ scan }) => ({ key: scan.key, pcmPath: scan.pcmPath, pcmSha256: scan.pcmSha256 })) }), 'utf8');
            const response = dependencies.vad ? await dependencies.vad(pendingVad.map(x => x.scan))
                : JSON.parse((await run(config.enhancements.pacing?.pythonPath || 'python',
                    [path.join(__dirname, '../python/pacing_vad.py'), requestPath])).toString('utf8'));
            for (const { scan, events, file } of pendingVad) {
                const proof = response.results?.find(row => row.key === scan.key && row.pcmSha256 === scan.pcmSha256);
                if (!proof || !Array.isArray(proof.speechIntervalsMs) || proof.speechIntervalsMs.length !== 2
                    || proof.speechIntervalsMs.some(rows => !Array.isArray(rows))) continue;
                if (proof.nonSpeech !== true || proof.speechIntervalsMs.some(rows => rows.length)) {
                    fs.writeFileSync(file + '.vad.json', JSON.stringify({ ...scan, vad: proof, events: [] }), 'utf8');
                    continue;
                }
                const event = { id: `pause-${Math.round(scan.window.start * 1000)}`, sourceId, kind: 'non_speech',
                    verified: true, precisionSeconds: .01, start: scan.window.start, end: scan.window.end,
                    verification: { method: 'protected_asr_gap_and_two_channel_fsmn', ...proof } };
                events.push(event);
                fs.writeFileSync(file + '.vad.json', JSON.stringify({ ...scan, vad: proof, events: [event] }), 'utf8');
            }
        } catch (error) { summary.vadError = error.message; summary.error = error.message; }
    }
    for (const { item, events, scans } of perClip) {
        const usable = usefulPauseEvidence(events, sourceId, item.clip, parsed.segments, settings);
        if (usable.length) {
            const seconds = usable.reduce((n, row) => n + row.end - row.start - .6, 0);
            preparations.set(item.id, { version: 1, sourceId, source: identity, events: usable, scans,
                possibleRemovedSeconds: seconds, settings });
            choices.push({ id: item.id, reason: `音频检查发现 ${usable.length} 处无对白长停顿，可缩短约 ${seconds.toFixed(1)} 秒`, seconds });
        }
    }
    if (JSON.stringify(sourceIdentity(options.mediaPath, options.srtPath)) !== JSON.stringify(identity)) throw new Error('Source changed during precision scan');
    const selected = choices.sort((a, b) => b.seconds - a.seconds).slice(0, packet.maxSelected);
    return finish(selected, selected.length ? 'verified_pause_candidates' : summary.vadError ? 'pacing_source_unavailable' : 'no_verified_pauses', preparations);
}
module.exports = { preparePacingBatch, sourceIdentity };
