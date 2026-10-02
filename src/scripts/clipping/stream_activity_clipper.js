'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const xml2js = require('xml2js');
const asr = require('../asr/asr_backends');
const loader = require('../config-loader');
const { sourceSnapshot, fileDigest } = require('./source_snapshot');
const { resolveClipOutputRoot } = require('./output_path');
const { probeMediaDuration } = require('./video_probe');
const { resolveFfprobePath } = require('./media_runtime');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');
const { requestSelectionText } = require('./selection_request');
const { writeJsonAtomic } = require('./candidate_subtitles');
const media = require('./stream_activity_media');
const planTools = require('./stream_activity_plan');
const presentationTools = require('./stream_activity_presentation');
const { verifyActivity } = require('./stream_activity_verification');
const { prepareActivityTranscript } = require('./stream_activity_transcript');
const execFileAsync = promisify(execFile);

async function readAudience(xmlPath) {
    if (!xmlPath) return [];
    const parsed = await xml2js.parseStringPromise(fs.readFileSync(xmlPath, 'utf8'), { strict: false, trim: true });
    return (parsed?.i?.d || parsed?.I?.D || []).map(row => ({ time: Number(String(row.$?.p || row.$?.P || '').split(',')[0]),
        text: String(row._ || '') })).filter(row => Number.isFinite(row.time) && row.time >= 0 && row.text)
        .sort((a, b) => a.time - b.time);
}
function recordingInfo(mediaPath, context = {}) {
    const base = path.basename(mediaPath, path.extname(mediaPath));
    const match = base.match(/录制-(\d+)-(\d{8})-(\d{6})-\d+-(.+)$/u);
    return { roomId: String(context.roomId || match?.[1] || ''), streamerName: context.streamerName || '岁己SUI',
        recordedAt: match ? `${match[2].slice(0,4)}-${match[2].slice(4,6)}-${match[2].slice(6,8)} ${match[3].slice(0,2)}:${match[3].slice(2,4)}:${match[3].slice(4,6)}` : context.recordedAt || base,
        streamTitle: context.streamTitle || match?.[4] || '', base };
}
function pathsFor(mediaPath, root, config) {
    const parent = resolveClipOutputRoot(mediaPath, { ...root.ownStreamClips, outputDirName: config.outputDirName });
    const directory = path.join(parent, path.basename(mediaPath, path.extname(mediaPath)));
    return { directory, plan: path.join(directory, 'PLAN.json'), songs: path.join(directory, 'SONGS.json'),
        review: path.join(directory, 'REVIEW.md'), lock: path.join(directory, '.worker.lock') };
}
function acquire(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let pid;
        try { pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { throw new Error('Activity worker lock is unreadable'); }
        let alive = true;
        try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
        if (alive) throw new Error(`Activity worker already running: ${pid}`);
        fs.unlinkSync(file); return acquire(file);
    }
    return () => { fs.unlinkSync(file); };
}
function sameSource(source, snapshot) { return JSON.stringify(source) === JSON.stringify(snapshot); }
function planDigest(plan) { return planTools.sha({ events: plan.events, parts: plan.parts, coverage: plan.coverage,
    rejectedActivities: plan.rejectedActivities || [] }); }

async function detectActivities(options, config, source, info, files) {
    if (config.detectionMode === 'summary' && !options.scan) {
        return require('./stream_activity_summary_plan').detectSummaryActivities(options, config, source, info, files, await readAudience(options.xmlPath));
    }
    const duration = await (options.probe || probeMediaDuration)(options.mediaPath, resolveFfprobePath(options.config.audio?.ffmpeg?.path || 'ffmpeg'));
    let transcript;
    try { transcript = await (options.prepareTranscript || prepareActivityTranscript)({ source, root: options.config, directory: files.directory, duration }); }
    catch (error) {
        const failed = { type: 'sui_stream_activity_plan', status: 'failed', ...info, source, duration, events: [],
            sessionId: planTools.sha(source), coverage: { status: 'incomplete', duration, windows: [] }, error: error.message };
        failed.contentSha256 = planDigest(failed);
        writeJsonAtomic(files.plan, failed); writeJsonAtomic(files.songs, planTools.songRecord(failed)); throw error;
    }
    const rows = planTools.evidenceRows(asr.parseSrt(transcript.path).segments, await readAudience(options.xmlPath));
    if (!rows.some(row => row.source === 'audio_transcript')) throw new Error('Missing recording transcript; activity coverage is unknown');
    const windows = planTools.detectionWindows(rows, duration, config);
    const signature = planTools.sha({ source, transcript, version: planTools.VERSION, duration,
        detection: { chunkSeconds: config.chunkSeconds, contextSeconds: config.contextSeconds, maxEvidenceChars: config.maxEvidenceChars, ai: config.ai,
            verification: config.verification, verificationModel: rootVerificationModel(options.config, config) },
        parts: { songsEnabled: config.songs.enabled, songPadding: config.songs.paddingSeconds, watchEnabled: config.watch.enabled,
            target: config.watch.targetPartSeconds, max: config.watch.maxPartSeconds } });
    if (fs.existsSync(files.plan)) {
        const old = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
        if (old.signature === signature && ['planned', 'rendered'].includes(old.status) && sameSource(old.source, source)) {
            if (old.contentSha256 !== planDigest(old)) throw new Error('Activity plan changed outside the reviewed workflow');
            return old;
        }
    }
    const coverage = { status: 'incomplete', duration, windows: [] };
    const diagnostics = { requests: [] };
    const plan = { version: planTools.VERSION, type: 'sui_stream_activity_plan', status: 'detecting', signature,
        sessionId: planTools.sha(source), ...info, source, transcript, duration, events: [], coverage, diagnostics };
    const save = () => { plan.contentSha256 = planDigest(plan); writeJsonAtomic(files.plan, plan); writeJsonAtomic(files.songs, planTools.songRecord(plan)); };
    save();
    const events = [];
    try {
        for (const window of windows) {
            const initialPrompt = planTools.detectionPrompt(window, info);
            let prompt = initialPrompt, parsedEvents;
            const validate = result => { try { planTools.parseEvents(result, window, duration); return true; } catch { return false; } };
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await (options.request || requestSelectionText)(prompt,
                { primaryModel: config.ai.model, timeoutMs: config.ai.timeoutMs, maxTokens: config.ai.maxTokens,
                    wordLimit: 5000, structuredOutputKey: 'events', strictEvaluation: true },
                { ai: { ...config.ai, selectionCacheEnabled: true } }, options.config,
                { ...info, selectionCacheDirectory: path.join(files.directory, 'temp', 'selection-cache') },
                    'stream-activities-v1', diagnostics, validate);
                const responseDirectory = path.join(files.directory, 'temp', 'detector-responses');
                fs.mkdirSync(responseDirectory, { recursive: true });
                writeJsonAtomic(path.join(responseDirectory, `window-${window.index}-attempt-${attempt + 1}.json`), {
                    window: { start: window.start, end: window.end, from: window.from, to: window.to },
                    promptSha256: planTools.sha(prompt), response });
                try { parsedEvents = planTools.parseEvents(response, window, duration); break; }
                catch (error) {
                    if (attempt === 1) throw error;
                    prompt = `${initialPrompt}\n\nFORMAT/BOUNDARY REPAIR: The previous response failed validation: ${error.message}.\nPrevious output (untrusted): ${response.text}\nReturn corrected JSON from the original source. Report only events overlapping core ${window.start}-${window.end}. All reported boundaries MUST lie in context ${window.from}-${window.to}. If a performance/session continues outside the provided context, use that context edge and observed=false; do not guess the actual outer boundary. Recheck EVERY citation against SOURCE DATA: preserve its exact T/D prefix; numbers from a D row cannot be cited as T. Replace unseen IDs with actual supporting rows, not guessed nearby numbers. Every titleEvidenceId must also be in evidenceIds; otherwise keep name:null. Do not remove a genuine in-core activity to avoid fixing its fields.`;
                }
            }
            events.push(...parsedEvents);
            coverage.windows.push({ start: window.start, end: window.end, status: 'inspected', evidenceRows: window.rows.length });
            plan.events = planTools.mergeEvents(events); save();
        }
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed during detection');
        plan.events = planTools.mergeEvents(events);
        plan.status = 'verifying'; plan.rejectedActivities = []; save();
        const verifiedEvents = [];
        for (const event of plan.events) {
            const verified = await (options.verify || verifyActivity)(event, { root: options.config, config, source, info,
                directory: files.directory, rows, duration, diagnostics });
            if (verified.decision === 'exclude') plan.rejectedActivities.push({ ...event, verification: verified });
            else verifiedEvents.push(...verified.events);
        }
        plan.events = planTools.mergeEvents(verifiedEvents);
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed during media verification');
        if (fileDigest(transcript.path) !== transcript.sha256) throw new Error('Activity transcript changed during verification');
        // Conflicting simultaneous activities must be reviewed, never silently dropped.
        for (let i = 1; i < plan.events.length; i++) {
            const a = plan.events[i - 1], b = plan.events[i];
            if (a.end > b.start) { a.reviewIssues.push('overlapping_activity'); b.reviewIssues.push('overlapping_activity'); }
        }
        plan.parts = planTools.buildParts(plan.events, duration, config);
        plan.status = 'planned'; coverage.status = 'complete'; plan.finishedAt = new Date().toISOString(); save();
        return plan;
    } catch (error) { plan.status = 'failed'; plan.error = error.message; save(); throw error; }
}

function rootVerificationModel(root, config) { return config.verification.model || root.ai?.text?.gemini?.model || null; }

function publicCopy(plan, kind) {
    return presentationTools.presentationFor(plan, kind).copy;
}
function reviewText(plan, metadata, files) {
    const lines = ['# 本场歌切与同步视听', '', `录播: ${plan.source.mediaPath}`, `完整文本检测覆盖: ${plan.coverage.status}`,
        `检测转写: ${plan.transcript.path} (${plan.transcript.mode})`,
        '字幕来自混合音轨。实际演唱者、起止音符、前奏尾奏和观看边界仍需检查原始视频。',
        '歌切和视听保留原始音画，不把未经歌词校对的 ASR 字幕烧进视频。', '', `歌单 JSON: ${files.songs}`, ''];
    if (plan.efficiency) lines.push(`粗定位复用梗概：${plan.summary.path}`,
        `新增全场扫描 ${plan.efficiency.fullScanRequests} 次；整场 ASR ${plan.efficiency.wholeRecordingAsrRuns} 次；短音频校准 ${plan.efficiency.boundaryRequests} 批 (${plan.efficiency.boundaryAudioSeconds.toFixed(1)} 秒音频)`, '');
    lines.push('上传前检查平台多 P 权限；未开通时保留本包，不拆成多个单 P 投稿。', '');
    for (const event of plan.events) lines.push(`- ${event.kind === 'song' ? '演唱' : '视听'} ${event.start.toFixed(2)}–${event.end.toFixed(2)}: ${event.name || '标题待确认'}${event.reviewIssues.length ? `；待核 ${event.reviewIssues.join(', ')}` : ''}`);
    for (const row of metadata) lines.push('', `## ${row.kind === 'songs' ? '歌切' : '同步视听'}：一个投稿，${row.output.parts.length} P`,
        `投稿标题: ${row.upload.prefix}${row.copy.title}`, `栏目封面: ${row.output.coverPath}`,
        `元数据: ${row.output.metadataPath}`, `专用合集: season=${row.upload.collectionSeasonId || '未配置'} section=${row.upload.collectionSectionId || '未配置'}`,
        ...row.output.parts.map((part, i) => `- P${i + 1} ${part.title} (${part.duration.toFixed(2)} 秒): ${part.mediaPath}`),
        '', `审核命令: npm run activity:clips -- approve --metadata "${row.output.metadataPath}" --note "已检查完整演唱/观看边界、演唱者及标题"`,
        '审核后可用上传短 ID 加入已有单实例投稿队列；本场每类只占一个投稿名额。');
    return lines.join('\n') + '\n';
}

async function register(manifestPath, options = {}) {
    const result = await execFileAsync(options.pythonPath || 'python', [path.resolve(__dirname, '../clip_upload_registry.py'),
        'import-json', '--manifest', manifestPath, '--include-pending'], { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024 });
    console.log(result.stdout.trim());
    return result.stdout;
}
async function refreshPresentation(row, plan, root, options = {}) {
    const titleEvidence = options.titleEvidence || row.presentation?.titleEvidence || null;
    if (titleEvidence && fileDigest(titleEvidence.framePath) !== titleEvidence.frameSha256) throw new Error('Reviewed activity title frame changed');
    const presentation = presentationTools.presentationFor(plan, row.kind, row.output.parts, titleEvidence);
    if (row.presentation?.version === presentation.version && row.presentation?.signature === presentation.signature) return row;
    if (row.activityReview?.status === 'approved') throw new Error('Approved activity presentation requires an explicit reviewed revision');
    const coverPath = presentationTools.coverPathFor(row.output.metadataPath, presentation);
    await (options.cover || media.activityCover)(presentation.parts[0], coverPath, root, presentation.cover);
    return { ...row, copy: presentation.copy, upload: { ...row.upload, prefix: presentation.profile.prefix },
        output: { ...row.output, parts: presentation.parts, coverPath }, coverSha256: fileDigest(coverPath),
        presentation: { version: presentation.version, style: presentation.profile.style, signature: presentation.signature,
            ...(titleEvidence ? { titleEvidence } : {}) },
        uploadReady: false, activityReview: { version: 1, status: 'pending', checks: ['host_performance_or_actual_viewing', 'complete_boundaries', 'part_titles', 'public_copy', 'column_cover'] } };
}
async function restyleStreamActivities(options = {}) {
    const manifestPath = path.resolve(options.manifestPath || path.join(path.dirname(options.metadataPath), 'UPLOAD_MANIFEST.json'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const plan = JSON.parse(fs.readFileSync(manifest.planPath, 'utf8'));
    if (plan.contentSha256 !== planDigest(plan)) throw new Error('Activity plan changed outside the reviewed workflow');
    const files = { directory: path.dirname(manifest.planPath), plan: manifest.planPath,
        songs: path.join(path.dirname(manifest.planPath), 'SONGS.json'), review: manifest.reviewPath };
    const release = acquire(path.join(files.directory, '.worker.lock'));
    try {
        const root = options.config || loader.getConfig();
        if (!sameSource(sourceSnapshot({ source: plan.source }), plan.source)) throw new Error('Activity source changed before restyling');
        const rows = manifest.clips.map(clip => JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8')));
        const selected = rows.filter(row => !options.metadataPath || path.resolve(row.output.metadataPath) === path.resolve(options.metadataPath));
        if (!selected.length) throw new Error('Requested activity metadata is not in its manifest');
        if (options.contentName) {
            if (!options.evidenceFrame || !String(options.evidenceNote || '').trim() || selected.length !== 1 || selected[0].activities.length !== 1) {
                throw new Error('Content name needs one selected activity, its generated cover frame and a source evidence note');
            }
            const framePath = path.resolve(options.evidenceFrame);
            const frameDirectory = path.join(path.dirname(selected[0].output.metadataPath), 'temp', 'presentation') + path.sep;
            if (!framePath.toLowerCase().startsWith(frameDirectory.toLowerCase()) || path.basename(framePath) !== 'frame.jpg') {
                throw new Error('Content name evidence must be the source frame generated for this activity cover');
            }
            options = { ...options, titleEvidence: { name: String(options.contentName).trim(),
                activityId: selected[0].activities[0].id, framePath, frameSha256: fileDigest(framePath),
                method: 'source_frame_reading', note: options.evidenceNote } };
        }
        const registryPath = path.resolve(__dirname, '../../../data/runtime/clip_upload_registry.json');
        const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { clips: {} };
        for (const row of selected) {
            if (row.type !== 'stream_activity_submission' || row.planSignature !== plan.signature) throw new Error('Activity submission differs from its plan');
            const registered = Object.values(registry.clips).find(clip => clip.metadataPath
                && path.resolve(clip.metadataPath).toLowerCase() === path.resolve(row.output.metadataPath).toLowerCase());
            if (registered && !['needs_review', 'review'].includes(registered.status)) throw new Error(`Activity ID ${registered.id} is ${registered.status}; restyling only supports pending submissions`);
            if (row.activityReview?.status === 'approved') throw new Error('Approved activity presentation requires an explicit reviewed revision');
            for (const part of row.output.parts) if (fs.statSync(part.mediaPath).size !== part.bytes || fileDigest(part.mediaPath) !== part.sha256) throw new Error('Activity video changed before restyling');
            if (fileDigest(row.output.coverPath) !== row.coverSha256) throw new Error('Activity cover changed before restyling');
        }
        const changes = [];
        for (const row of selected) changes.push({ original: row, updated: await refreshPresentation(row, plan, root, options) });
        // Finish all covers before replacing any metadata; video files are never rebuilt.
        for (const { original, updated } of changes) if (original !== updated) {
            const backup = path.join(files.directory, 'temp', 'presentation-revisions', planTools.sha(original).slice(0, 16), `${original.kind}.json`);
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            writeJsonAtomic(backup, original);
            writeJsonAtomic(updated.output.metadataPath, updated);
            rows[rows.indexOf(original)] = updated;
        }
        fs.writeFileSync(files.review, reviewText(plan, rows, files), 'utf8');
        if (options.registerUpload !== false) await (options.register || register)(manifestPath, options);
        if (plan.uploadIds) fs.appendFileSync(files.review, '\n' + rows.map((row, index) =>
            `${row.kind === 'songs' ? '歌切' : '同步视听'}上传短 ID: ${plan.uploadIds[String(index + 1)]}`).join('\n') + '\n', 'utf8');
        return { status: 'restyled', updated: changes.filter(change => change.original !== change.updated).length,
            manifestPath, reviewPath: files.review, submissions: selected.map(row => row.output.metadataPath) };
    } finally { release(); }
}
async function generateStreamActivities(options = {}) {
    const root = options.config || loader.getConfig();
    const info = recordingInfo(options.mediaPath, options.context);
    if (!planTools.activityEnabled(root, info.roomId)) return { status: 'disabled' };
    options = { ...options, config: root };
    const config = planTools.getActivityConfig(root), files = pathsFor(options.mediaPath, root, config);
    const release = acquire(files.lock);
    let scheduler;
    try {
        const source = sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } });
        const plan = await detectActivities(options, config, source, info, files);
        if (options.planOnly) return { status: plan.status, planPath: files.plan, songsPath: files.songs };
        const runDirectory = path.join(files.directory, plan.signature.slice(0, 16));
        fs.mkdirSync(runDirectory, { recursive: true });
        scheduler = (options.scheduler || createClipResourceAdaptiveScheduler)({ ownConfig: root.ownStreamClips || {}, rootConfig: root });
        const metadata = [];
        for (const kind of ['songs', 'watch']) {
            if (!plan.parts[kind].length) continue;
            const metadataPath = path.join(runDirectory, `${kind}.json`);
            // An unchanged finished bundle is retained, including its review and publication state.
            if (fs.existsSync(metadataPath)) {
                let old = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                if (old.planSignature === plan.signature && old.output.parts.every(p => fs.existsSync(p.mediaPath)
                    && fs.statSync(p.mediaPath).size === p.bytes && fileDigest(p.mediaPath) === p.sha256)
                    && fs.existsSync(old.output.coverPath) && fileDigest(old.output.coverPath) === old.coverSha256) {
                    if (old.activityReview?.status !== 'approved') {
                        old = await refreshPresentation(old, plan, root, options);
                        const route = config[kind].collection || {};
                        Object.assign(old.upload, { collectionSectionId: route.sectionId || null, collectionSeasonId: route.seasonId || null,
                            tags: config[kind].tags, tid: config[kind].tid });
                        writeJsonAtomic(metadataPath, old);
                    }
                    metadata.push(old); continue;
                }
                if (old.activityReview?.status === 'approved') throw new Error('Reviewed activity artifacts changed; create a reviewed revision before rebuilding');
            }
            const parts = [];
            for (const [index, part] of plan.parts[kind].entries()) {
                const outputPath = path.join(runDirectory, `${kind}_P${String(index + 1).padStart(3, '0')}.mp4`);
                const lease = await scheduler.acquire();
                try { parts.push(await (options.renderPart || media.renderActivityPart)(options.mediaPath, part, outputPath, root, lease.profile)); }
                finally { lease.release(); }
            }
            const presentation = presentationTools.presentationFor(plan, kind, parts);
            const coverPath = presentationTools.coverPathFor(metadataPath, presentation);
            const lease = await scheduler.acquire();
            try { await (options.cover || media.activityCover)(parts[0], coverPath, root, presentation.cover); } finally { lease.release(); }
            const events = plan.events.filter(e => e.kind === (kind === 'songs' ? 'song' : 'watch'));
            const collection = config[kind].collection || {};
            const row = { version: 1, type: 'stream_activity_submission', kind, roomId: info.roomId,
                streamerName: info.streamerName, source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath || null },
                sourceSnapshot: source, transcript: plan.transcript, planSignature: plan.signature, planPath: files.plan, coverage: plan.coverage,
                window: { start: parts[0].start, end: parts.at(-1).end, duration: parts.reduce((n, p) => n + p.duration, 0) },
                activities: events, copy: presentation.copy,
                presentation: { version: presentation.version, style: presentation.profile.style, signature: presentation.signature },
                output: { mediaPath: parts[0].mediaPath, coverPath, metadataPath, parts: presentation.parts }, coverSha256: fileDigest(coverPath),
                activityReview: { version: 1, status: 'pending', checks: ['host_performance_or_actual_viewing', 'complete_boundaries', 'part_titles', 'public_copy'] },
                uploadReady: false, upload: { prefix: presentation.profile.prefix, tid: config[kind].tid, tags: config[kind].tags,
                    roomId: info.roomId, streamerName: info.streamerName, source: `${info.streamerName} 直播《${info.streamTitle}》${info.recordedAt}`,
                    collectionSectionId: collection.sectionId || null, collectionSeasonId: collection.seasonId || null } };
            writeJsonAtomic(metadataPath, row); metadata.push(row);
        }
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed while rendering');
        const manifestPath = path.join(runDirectory, 'UPLOAD_MANIFEST.json');
        writeJsonAtomic(manifestPath, { version: 1, type: 'bilibili_clip_upload_manifest', reviewPath: files.review,
            planPath: files.plan, roomId: info.roomId, clips: metadata.map((row, i) => ({ reviewIndex: i + 1, metadataPath: row.output.metadataPath })) });
        plan.status = 'rendered'; plan.uploadManifestPath = manifestPath; writeJsonAtomic(files.plan, plan);
        writeJsonAtomic(files.songs, planTools.songRecord(plan));
        fs.writeFileSync(files.review, reviewText(plan, metadata, files), 'utf8');
        if (metadata.length && options.registerUpload !== false) {
            const output = await (options.register || register)(manifestPath, options);
            const marker = typeof output === 'string' && output.match(/REGISTRY_RESULT:\s*(\{[^\n]+\})/u);
            if (marker) {
                const ids = JSON.parse(marker[1]).clipIdsByReviewIndex;
                const lines = metadata.map((row, i) => `${row.kind === 'songs' ? '歌切' : '同步视听'}上传短 ID: ${ids[String(i + 1)]}`);
                fs.appendFileSync(files.review, '\n' + lines.join('\n') + '\n', 'utf8');
                plan.uploadIds = ids; writeJsonAtomic(files.plan, plan);
            }
        }
        return { status: 'rendered', submissions: metadata.length, parts: metadata.reduce((n, row) => n + row.output.parts.length, 0),
            pendingReview: metadata.some(row => row.activityReview?.status !== 'approved'),
            manifestPath, planPath: files.plan, songsPath: files.songs, reviewPath: files.review };
    } finally { await scheduler?.stop?.(); release(); }
}
module.exports = { readAudience, recordingInfo, pathsFor, detectActivities, publicCopy, reviewText, register, generateStreamActivities,
    restyleStreamActivities };
