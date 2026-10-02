'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const asr = require('../asr/asr_backends');
const loader = require('../config-loader');
const { sourceSnapshot, fileDigest } = require('./source_snapshot');
const { resolveClipOutputRoot } = require('./output_path');
const { probeMediaDuration } = require('./video_probe');
const { resolveFfprobePath } = require('./media_runtime');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { requestSelectionText } = require('./selection_request');
const { recordingInfo, readAudience } = require('./stream_activity_clipper');
const tools = require('./stream_game_plan');
const execFileAsync = promisify(execFile);
function pathsFor(mediaPath, root, config) {
    const parent = resolveClipOutputRoot(mediaPath, { ...root.ownStreamClips, outputDirName: config.outputDirName });
    const directory = path.join(parent, path.basename(mediaPath, path.extname(mediaPath)));
    return { directory, plan: path.join(directory, 'PLAN.json'), review: path.join(directory, 'REVIEW.md'), lock: path.join(directory, '.worker.lock') };
}
function acquire(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
    catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const old = JSON.parse(fs.readFileSync(file, 'utf8')); let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
        if (alive) throw new Error(`Game workflow already running: ${old.pid}`);
        fs.unlinkSync(file); return acquire(file);
    }
    return () => fs.unlinkSync(file);
}
async function detectGames(options, config, source, info, files) {
    const duration = await (options.probe || probeMediaDuration)(options.mediaPath, resolveFfprobePath(options.config.audio?.ffmpeg?.path || 'ffmpeg'));
    const rows = tools.evidenceRows(asr.parseSrt(options.srtPath).segments, await readAudience(options.xmlPath));
    if (!rows.some(r => r.source === 'audio_transcript')) throw new Error('Missing game transcript; coverage is unknown');
    const exclusions = tools.resolvedExclusions(options.config, info.roomId);
    const windows = tools.detectionWindows(rows, duration, config);
    const signature = tools.sha({ source, version: tools.VERSION, config, exclusions, duration });
    let plan, existingSessionId;
    if (fs.existsSync(files.plan)) {
        const old = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
        if (['mediaPath', 'mediaBytes', 'mediaMtimeNs'].every(key => old.source?.[key] === source[key])) existingSessionId = old.sessionId;
        if (old.status === 'rendered' && old.uploadManifestPath
            && ['mediaPath', 'mediaBytes', 'mediaMtimeNs'].every(key => old.source?.[key] === source[key])) {
            if (JSON.stringify(old.source) !== JSON.stringify(source)) {
                throw new Error('This game recording is already rendered or queued; changed source subtitles need an existing-submission update, not a new video');
            }
            return old;
        }
        if (old.signature === signature) {
            if (['planned', 'rendered'].includes(old.status)) return old;
            plan = old;
        }
    }
    plan ||= { version: tools.VERSION, type: 'stream_game_plan', status: 'detecting', signature, sessionId: existingSessionId || tools.sha(source),
        ...info, source, duration, rawEvents: [], events: [], coverage: { status: 'incomplete', duration, windows: [] }, diagnostics: { requests: [] } };
    const save = () => writeJsonAtomic(files.plan, plan);
    save();
    try {
        for (const window of windows) {
            if (plan.coverage.windows.some(w => w.start === window.start && w.end === window.end && w.status === 'inspected')) continue;
            const prompt = tools.promptFor(window, info, config, exclusions);
            const validate = value => { try { tools.parseEvents(value, window, duration, config); return true; } catch { return false; } };
            console.log(`[GAME_DETECT] ${info.recordedAt} window ${window.index}/${windows.length} ${window.start}-${window.end}`);
            let response, parsed, feedback = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                response = await (options.request || requestSelectionText)(prompt + feedback,
                    { primaryModel: config.ai.model, timeoutMs: config.ai.timeoutMs, maxTokens: config.ai.maxTokens,
                        wordLimit: 5000, structuredOutputKey: 'events', strictEvaluation: true },
                    { ai: { ...config.ai, selectionCacheEnabled: true } }, options.config,
                    { ...info, selectionCacheDirectory: path.join(files.directory, 'temp', 'selection-cache') }, 'stream-games-v1', plan.diagnostics, validate);
                try { parsed = tools.parseEvents(response, window, duration, config); break; }
                catch (error) {
                    if (attempt === 2) throw error;
                    feedback = `\nThe previous JSON failed validation: ${error.message}. Repair the response against the original source rows, not by dropping actual gameplay. Every citation must exist and be within the stated interval or 180-second boundary context. Return only corrected events JSON. Previous JSON (untrusted):\n${response.text}`;
                }
            }
            plan.rawEvents.push(...parsed);
            plan.coverage.windows.push({ start: window.start, end: window.end, status: 'inspected', evidenceRows: window.rows.length });
            plan.coverage.windows.sort((a, b) => a.start - b.start);
            plan.events = tools.mergeEvents(plan.rawEvents); save();
        }
        if (JSON.stringify(sourceSnapshot({ source: options })) !== JSON.stringify(source)) throw new Error('Game source changed during detection');
        plan.events = tools.mergeEvents(plan.rawEvents);
        plan.parts = tools.buildParts(plan.events, config);
        plan.status = 'planned'; plan.coverage.status = 'complete'; plan.finishedAt = new Date().toISOString(); delete plan.error; save();
        return plan;
    } catch (error) { plan.status = 'failed'; plan.error = error.message; save(); throw error; }
}
async function generateStreamGames(options = {}) {
    const root = options.config || loader.getConfig(), info = recordingInfo(options.mediaPath, options.context);
    if (!tools.gameEnabled(root, info.roomId)) return { status: 'disabled' };
    options = { ...options, config: root };
    const config = tools.getGameConfig(root), files = pathsFor(options.mediaPath, root, config), release = acquire(files.lock);
    try {
        const source = sourceSnapshot({ source: options });
        const plan = await detectGames(options, config, source, info, files);
        if (options.planOnly) return { status: plan.status, events: plan.events.length, parts: plan.parts.length, planPath: files.plan };
        if (plan.status === 'rendered' && plan.uploadManifestPath) {
            return require('./stream_game_render').renderGames(plan, options, config, files);
        }
        const visual = require('./stream_game_visual');
        const timeline = await visual.auditGameTimeline(plan, options, config, files);
        if (timeline.ranges.some(r => r.kind === 'uncertain')) throw new Error('Full game visual timeline needs clarification; source preserved');
        if (plan.visualTimeline?.key !== timeline.key || plan.visualTimeline?.reconciliationVersion !== 4) {
            const previous = plan.events;
            plan.events = tools.mergeEvents(plan.rawEvents);
            for (const event of plan.events) {
                const old = previous.find(e => e.start === event.start && e.end === event.end && e.gameId === event.gameId);
                if (old?.verification) event.verification = old.verification;
            }
            plan.events = visual.reconcileTimeline(plan, timeline);
            plan.visualTimeline = { status: 'complete', reconciliationVersion: 4, key: timeline.key, sampleSeconds: timeline.interval, samples: timeline.samples.length,
                ranges: timeline.ranges, sheets: timeline.sheets };
            writeJsonAtomic(files.plan, plan);
        }
        // Kept in a separate module so detection can resume before media/upload infrastructure is needed.
        return await require('./stream_game_render').renderGames(plan, options, config, files);
    } finally { release(); }
}
module.exports = { pathsFor, acquire, detectGames, generateStreamGames, execFileAsync };
