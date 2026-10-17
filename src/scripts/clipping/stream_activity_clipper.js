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
const stages = require('../workflow-runtime').loadWorkflow('clipping/activityStages');
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
    rejectedActivities: plan.rejectedActivities || [], ...(plan.calibratedKinds ? { calibratedKinds: plan.calibratedKinds, rawEvents: plan.rawEvents } : {}),
    ...(plan.verificationSignature ? { verificationSignature: plan.verificationSignature, verificationSettings: plan.verificationSettings,
        boundaryBudget: plan.boundaryBudget, verifierRevisions: plan.verifierRevisions } : {}),
    ...(plan.timingSignature ? { timingSignature: plan.timingSignature, timingRevisions: plan.timingRevisions } : {}) }); }

async function detectActivities(options, config, source, info, files) {
    if (config.detectionMode === 'summary' && !options.scan) {
        return require('./stream_activity_summary_plan').detectSummaryActivities(options, config, source, info, files, await readAudience(options.xmlPath));
    }
    const duration = await (options.probe || probeMediaDuration)(options.mediaPath, resolveFfprobePath(options.config.audio?.ffmpeg?.path || 'ffmpeg'));
    let transcript;
    try { transcript = await (options.prepareTranscript || prepareActivityTranscript)({ source, root: options.config, directory: files.directory, duration }); }
    catch (error) {
        const previous = fs.existsSync(files.plan) ? JSON.parse(fs.readFileSync(files.plan, 'utf8')) : null;
        if (previous && previous.contentSha256 !== planDigest(previous)) throw new Error('Activity plan changed outside the reviewed workflow');
        const failed = previous && sameSource(previous.source, source)
            ? { ...previous, calibratedKinds: stages.calibratedKinds(previous), status: 'failed', error: error.message }
            : { type: 'sui_stream_activity_plan', status: 'failed', ...info, source, duration, events: [],
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
            target: config.watch.targetPartSeconds, max: config.watch.maxPartSeconds,
            ...(config.watch.blackAlignment?.enabled ? { blackAlignment: config.watch.blackAlignment } : {}) } });
    let previous;
    const selected = stages.activityKinds(options.kind).filter(kind => config[kind].enabled);
    if (fs.existsSync(files.plan)) {
        const old = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
        if (old.uploadManifestPath && old.signature !== signature) throw new Error('Rendered activity plan parameters changed; use an explicit reviewed revision');
        if (old.signature === signature && sameSource(old.source, source)) {
            if (old.contentSha256 !== planDigest(old)) throw new Error('Activity plan changed outside the reviewed workflow');
            if (!stages.pendingKinds(old, selected).length) return old;
            if (old.rawEvents) previous = old;
        }
    }
    const coverage = previous?.coverage || { status: 'incomplete', duration, windows: [] };
    const diagnostics = previous?.diagnostics || { requests: [] };
    const plan = previous || { version: planTools.VERSION, type: 'sui_stream_activity_plan', status: 'detecting', signature,
        sessionId: planTools.sha(source), ...info, source, transcript, duration, events: [], rawEvents: [], calibratedKinds: [], coverage, diagnostics };
    const pending = stages.pendingKinds(plan, selected);
    const save = () => { plan.contentSha256 = planDigest(plan); writeJsonAtomic(files.plan, plan); writeJsonAtomic(files.songs, planTools.songRecord(plan)); };
    save();
    const events = plan.rawEvents || [];
    try {
        for (const window of windows) {
            if (coverage.windows.some(row => row.start === window.start && row.end === window.end && row.status === 'inspected')) continue;
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
            plan.rawEvents = events; save();
        }
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed during detection');
        plan.rawEvents = planTools.mergeEvents(events);
        plan.status = 'verifying'; plan.rejectedActivities ||= []; save();
        const verifiedEvents = [];
        const rejected = [];
        if (!options.verify && config.verification.evidenceMethod === 'independent_local_asr') {
            const checked = await require('./stream_activity_boundaries').calibrateBoundaries(stages.selectEvents(plan.rawEvents, pending),
                { config, root: options.config, source, info, directory: files.directory, rows, duration, diagnostics,
                    request: options.boundaryRequest, extract: options.extractBoundary, localDecode: options.localDecode });
            verifiedEvents.push(...checked.events); rejected.push(...checked.rejected);
        } else for (const event of stages.selectEvents(plan.rawEvents, pending)) {
            const verified = await (options.verify || verifyActivity)(event, { root: options.config, config, source, info,
                directory: files.directory, rows, duration, diagnostics });
            if (verified.decision === 'exclude') rejected.push({ ...event, verification: verified });
            else verifiedEvents.push(...verified.events.map(row => ({ ...row, id: event.id })));
        }
        plan.events = planTools.mergeEvents(stages.combineEvents(plan.events, verifiedEvents, pending), true);
        plan.rejectedActivities = stages.combineEvents(plan.rejectedActivities, rejected, pending);
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed during media verification');
        if (fileDigest(transcript.path) !== transcript.sha256) throw new Error('Activity transcript changed during verification');
        // Conflicting simultaneous activities must be reviewed, never silently dropped.
        for (let i = 1; i < plan.events.length; i++) {
            const a = plan.events[i - 1], b = plan.events[i];
            if (a.end > b.start) { a.reviewIssues.push('overlapping_activity'); b.reviewIssues.push('overlapping_activity'); }
        }
        const parts = planTools.buildParts(plan.events, duration, config);
        if (pending.includes('watch') && config.watch.blackAlignment?.enabled) parts.watch = await require('../workflow-runtime')
            .loadWorkflow('clipping/watchBlackRuntime').applyWatchBlack(parts.watch,
                { ...options, blackScanRun: options.blackScanRun || require('./media_runtime').runFfmpeg }, config, source, files.directory);
        plan.parts ||= { songs: [], watch: [] };
        for (const kind of pending) plan.parts[kind] = parts[kind];
        plan.calibratedKinds = stages.completeKinds(plan, pending); delete plan.error;
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
        `状态: ${activitySubmissionStatus(row, plan)}`,
        `元数据: ${row.output.metadataPath}`, `专用合集: season=${row.upload.collectionSeasonId || '未配置'} section=${row.upload.collectionSectionId || '未配置'}`,
        ...row.output.parts.map((part, i) => `- P${i + 1} ${part.title} (${part.duration.toFixed(2)} 秒): ${part.mediaPath}`),
        ...(row.activityReview?.issues || []).map(issue => `待核: ${issue}`),
        '', row.activities.length && row.activityReview?.status !== 'approved' ? `审核命令: npm run activity:clips -- approve --metadata "${row.output.metadataPath}" --note "已检查完整演唱/观看边界、演唱者及标题"`
            : row.activities.length ? '最终审核已通过，投稿状态以注册表为准。'
            : `已排除：${row.activityReview.reason}；上列视频仅为保留的旧版本，不可上传。`,
        '审核后可用上传短 ID 加入已有单实例投稿队列；本场每类只占一个投稿名额。');
    return lines.join('\n') + '\n';
}

function activitySubmissionStatus(row, plan) {
    const index = plan.manifestClips?.find(clip => clip.metadataPath === row.output.metadataPath)?.reviewIndex;
    const status = plan.uploadRegistry?.clipStatusByReviewIndex?.[String(index)];
    if (status === 'uploaded') return '已投稿';
    if (['queued', 'uploading'].includes(status)) return '已排队投稿';
    const receipt = plan.automaticPublication?.results?.find(result => result.kind === row.kind);
    if (receipt?.status === 'unknown') return `入队结果待确认：${receipt.reason}`;
    if (receipt?.status === 'blocked') return `待入队：${receipt.reason}`;
    return row.activityReview?.status === 'approved' ? '审核通过，待入队' : '待人工复核';
}

async function register(manifestPath, options = {}) {
    const result = await execFileAsync(options.pythonPath || 'python', [path.resolve(__dirname, '../clip_upload_registry.py'),
        'import-json', '--manifest', manifestPath, '--include-pending'], { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024,
            encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    console.log(result.stdout.trim());
    return result.stdout;
}
async function refreshPresentation(row, plan, root, options = {}) {
    let titleEvidence = options.titleEvidence || row.presentation?.titleEvidence || null;
    const titles = require('../workflow-runtime').loadWorkflow('clipping/activityTitles');
    if (titles.titleItems(titleEvidence).some(item => item.method === 'catalog_lyric_match')) {
        if (fileDigest(plan.transcript.path) !== plan.transcript.sha256) throw new Error('Song naming transcript changed');
        const rows = asr.parseSrt(plan.transcript.path).segments.map((item, index) => ({ index: index + 1, ...item }));
        titleEvidence = titles.bindTranscriptTitles(titles.titleItems(titleEvidence), row.activities, rows, plan.transcript);
    }
    for (const item of require('../workflow-runtime').loadWorkflow('clipping/activityTitles').titleItems(titleEvidence)) {
        if (item.method === 'source_frame_reading' && fileDigest(item.framePath) !== item.frameSha256
            || item.method === 'source_transcript_reading' && fileDigest(item.transcriptPath) !== item.transcriptSha256) throw new Error('Reviewed activity title evidence changed');
    }
    const scopedPlan = row.activitySelection ? { ...plan, events: plan.events.filter(event =>
        row.activities.some(selected => selected.id === event.id)) } : plan;
    const presentation = presentationTools.presentationFor(scopedPlan, row.kind, row.output.parts, titleEvidence);
    if (row.presentation?.version === presentation.version && row.presentation?.signature === presentation.signature) return row;
    if (row.activityReview?.status === 'approved') throw new Error('Approved activity presentation requires an explicit reviewed revision');
    const coverPath = presentationTools.coverPathFor(row.output.metadataPath, presentation);
    await (options.cover || media.activityCover)(presentation.parts[0], coverPath, root, presentation.cover);
    return { ...row, copy: presentation.copy, upload: { ...row.upload, prefix: presentation.profile.prefix,
        ...(row.kind === 'watch' ? { tags: presentation.tags,
            source: require('../workflow-runtime').loadWorkflow('clipping/watchPublicNames').watchPublicText(row.upload.source, row.activities) } : {}) },
        output: { ...row.output, parts: presentation.parts, coverPath }, coverSha256: fileDigest(coverPath),
        presentation: { version: presentation.version, style: presentation.profile.style, signature: presentation.signature,
            titleFormat: row.kind === 'songs' ? 'song_name_recording_date' : 'work_alias_recording_date', recordingDate: presentation.recordingDate,
            ...(presentation.publicNames ? { publicNames: presentation.publicNames } : {}),
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
        if (options.retainActivityIds && (selected.length !== 1 || !String(options.selectionNote || '').trim())) {
            throw new Error('Activity selection requires one metadata file and an explicit note');
        }
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
        if (options.titleEvidencePath) {
            if (options.contentName || selected.length !== 1 || fileDigest(plan.transcript.path) !== plan.transcript.sha256) throw new Error('Transcript title review requires one unchanged source submission');
            const requested = JSON.parse(fs.readFileSync(options.titleEvidencePath, 'utf8'));
            const transcriptRows = asr.parseSrt(plan.transcript.path).segments.map((row, index) => ({ index: index + 1, ...row }));
            options = { ...options, titleEvidence: require('../workflow-runtime').loadWorkflow('clipping/activityTitles')
                .bindTranscriptTitles(requested.items, selected[0].activities, transcriptRows, plan.transcript) };
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
        for (const row of selected) {
            const current = options.retainActivityIds
                ? stages.selectActivitySubmission(row, options.retainActivityIds, options.selectionNote) : row;
            changes.push({ original: row, updated: await refreshPresentation(current, plan, root, options) });
        }
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
    const selected = stages.activityKinds(options.kind);
    const root = options.config || loader.getConfig();
    const info = recordingInfo(options.mediaPath, options.context);
    if (!planTools.activityEnabled(root, info.roomId)) return { status: 'disabled' };
    options = { ...options, config: root };
    const config = planTools.getActivityConfig(root), files = pathsFor(options.mediaPath, root, config);
    if (options.watchBlackRegion) config.watch.blackAlignment = require('../workflow-runtime').loadWorkflow('clipping/watchBlackPolicy')
        .blackSettings({ ...config.watch.blackAlignment, enabled: true, region: options.watchBlackRegion });
    if (config.watch.blackAlignment?.enabled) config.watch.blackAlignment.cadence = require('../workflow-runtime')
        .loadWorkflow('clipping/watchMovieCadence').movieCadenceSettings(config.watch.blackAlignment.cadence);
    const publication = root.streamActivityClips?.automaticPublication?.mode === 'auto'
        ? require('../workflow-runtime').loadWorkflow('clipping/activityPublication') : null;
    const publicationActive = publication?.activityPublicationEnabled(root, info.roomId) && !options.scan
        && (!options.retryBoundaries || options.retryPublication) && config.detectionMode === 'summary';
    if (options.retryPublication && (!publicationActive || options.planOnly || options.scan
        || options.repairTiming || !String(options.revisionNote || '').trim())) {
        throw new Error('Publication retry requires enabled automatic publication and a substantive --revision-note; boundary rebuilding also requires --retry-boundaries');
    }
    if (options.titleEvidencePath && options.retryPublication && !options.retryBoundaries) throw new Error('Use restyle to bind revised titles before retrying an existing publication review');
    if (options.reviewBoundaryIds && (!options.retryBoundaries || !['songs', 'watch'].includes(options.kind)
        || !String(options.revisionNote || '').trim())) throw new Error('Final boundary feedback requires songs|watch --retry-boundaries and a revision note');
    if (options.repairTiming && (options.kind || options.scan || options.retryBoundaries || options.planOnly
        || !options.transcriptRecordPath || !String(options.revisionNote || '').trim() || config.detectionMode !== 'summary')) {
        throw new Error('Timing repair requires run for both kinds, --transcript-record and a substantive --revision-note');
    }
    if (options.transcriptRecordPath && !options.repairTiming && !fs.existsSync(files.plan)) throw new Error('A supplied timing repair requires an existing pending plan');
    if (options.retryBoundaries && (!options.kind || options.scan || options.planOnly || config.detectionMode !== 'summary')) {
        throw new Error('Boundary retry requires run --kind songs|watch in summary mode');
    }
    if (options.reviseVerifier && (!options.retryBoundaries || !String(options.revisionNote || '').trim())) {
        throw new Error('Verifier revision requires --retry-boundaries and a substantive --revision-note');
    }
    if (options.reviewPrelude && (!options.retryBoundaries || options.kind !== 'songs' || config.verification.evidenceMethod !== 'independent_local_asr')) {
        throw new Error('Prelude review requires a pending song boundary retry using independent local audio');
    }
    if (options.reviewAudio && (!options.reviewPrelude || !root.ai?.text?.gemini?.apiKey)) throw new Error('Explicit native listening requires song prelude review and configured Gemini audio access');
    const release = acquire(files.lock);
    let scheduler;
    try {
        return await require('../workflow-runtime').loadWorkflow('ai/usage').runClipUsage({
            kind: options.kind || 'activities', directory: files.directory, mediaPath: options.mediaPath, recording: info,
            webhookUrl: root.wechatWork?.webhookUrl, notifyEnabled: root.streamActivityClips?.notify?.enabled !== false,
            sendMarkdown: options.notifyUsage || require('../wechat_work_markdown').sendWeChatMarkdown,
            io: options.usageIO
        }, async () => {
        const source = sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } });
        if (options.retryPublication && !fs.existsSync(files.plan)) throw new Error('Publication retry requires an existing rendered plan');
        if (options.repairTiming && !fs.existsSync(files.plan)) throw new Error('Timing revision requires an existing pending plan');
        if (options.retryBoundaries && !fs.existsSync(files.plan)) throw new Error('Boundary retry requires an existing pending plan');
        if (fs.existsSync(files.plan)) {
            const previous = JSON.parse(fs.readFileSync(files.plan, 'utf8'));
            if (previous.contentSha256 !== planDigest(previous)) throw new Error('Activity plan changed outside the reviewed workflow');
            if (!options.reviseVerifier && !options.repairTiming && previous.verificationSettings && sameSource(previous.source, source)) {
                config.verification = previous.verificationSettings;
            }
            if (options.retryPublication && (!previous.uploadManifestPath
                || previous.status !== 'rendered' && !(options.retryBoundaries && previous.status === 'planned'))) throw new Error('Publication retry requires an existing rendered submission');
            if (options.retryBoundaries && !previous.uploadManifestPath) {
                if (previous.status !== 'planned' || !sameSource(previous.source, source) || options.reviseVerifier) {
                    throw new Error('Boundary retry requires a source-bound planned activity or existing pending submission');
                }
                const candidates = stages.retryBoundaryEvents(previous.rawEvents || [], previous.events, selected, previous.rejectedActivities || []);
                if ((previous.efficiency?.boundaryRequests || 0) >= config.verification.maxBatchRequests) throw new Error('Per-stream AI budget reached; boundary retry is refused');
                const id = crypto.randomUUID(), backupDirectory = path.join(files.directory, 'temp', 'boundary-revisions', id);
                fs.mkdirSync(backupDirectory, { recursive: true });
                for (const file of [files.plan, files.songs]) fs.copyFileSync(file, path.join(backupDirectory, path.basename(file)));
                options.boundaryRetry = { id, kind: options.kind, eventIds: candidates.map(event => event.id), backupDirectory, startedAt: new Date().toISOString() };
            }
            if (previous.uploadManifestPath) {
                if (!sameSource(previous.source, source)) throw new Error('Activity source changed after rendering; use an explicit reviewed revision');
                const manifest = JSON.parse(fs.readFileSync(previous.uploadManifestPath, 'utf8'));
                for (const clip of manifest.clips) {
                    const row = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
                    if (row.planSignature !== previous.signature || !sameSource(row.sourceSnapshot, source)) {
                        throw new Error('Existing activity submission differs from its plan or source');
                    }
                }
                if (options.retryPublication || options.reviewBoundaryIds) {
                    const registry = options.readRegistry ? options.readRegistry()
                        : JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../data/runtime/clip_upload_registry.json'), 'utf8'));
                    const rows = manifest.clips.map(clip => JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'))).filter(row => selected.includes(row.kind));
                    if (!rows.length && (!options.retryBoundaries || options.reviseVerifier
                        || !stages.retryBoundaryEvents(previous.rawEvents || [], previous.events, selected, previous.rejectedActivities || []).length)) {
                        throw new Error('Publication retry has no pending submission for the selected kind');
                    }
                    for (const row of rows) {
                        const registered = Object.values(registry.clips).find(clip => clip.metadataPath
                            && path.resolve(clip.metadataPath).toLowerCase() === path.resolve(row.output.metadataPath).toLowerCase());
                        if (options.reviewBoundaryIds) options.boundaryFeedback = stages.activityBoundaryFeedback(row,
                            JSON.parse(fs.readFileSync(row.activityReview.proofPath, 'utf8')), registered, options.reviewBoundaryIds);
                        else publication.assertActivityPublicationRetry(row, registered);
                    }
                    const id = crypto.randomUUID(), backupDirectory = path.join(files.directory, 'temp', 'publication-retries', id);
                    fs.mkdirSync(backupDirectory, { recursive: true });
                    for (const row of rows) fs.copyFileSync(row.output.metadataPath, path.join(backupDirectory, `${row.kind}.json`));
                    if (!options.retryBoundaries) options.publicationRetryPlan = { ...previous, publicationRetries: [...(previous.publicationRetries || []),
                        { id, note: options.revisionNote, kinds: selected, backupDirectory, startedAt: new Date().toISOString() }] };
                }
                if (options.retryBoundaries || options.repairTiming) {
                    const candidates = options.retryBoundaries ? stages.retryBoundaryEvents(previous.rawEvents || [], previous.events, selected, previous.rejectedActivities || [], options.boundaryFeedback) : [];
                    if (options.retryBoundaries && !options.reviseVerifier && (previous.efficiency?.boundaryRequests || 0) >= (previous.boundaryBudget?.limit || config.verification.maxBatchRequests)) throw new Error('Per-stream AI budget reached; boundary retry is refused');
                    const registryPath = path.resolve(__dirname, '../../../data/runtime/clip_upload_registry.json');
                    const registry = options.readRegistry ? options.readRegistry()
                        : fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { clips: {} };
                    const selectedRows = manifest.clips.map(clip => JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'))).filter(row => selected.includes(row.kind));
                    // A sibling song bundle may already be rendered while watch failed
                    // its interval check. Recover its original candidates before first render.
                    if (!selectedRows.length && (!options.retryBoundaries || !candidates.length || options.reviseVerifier)) {
                        throw new Error('Boundary retry has no pending submission for the selected kind');
                    }
                    for (const row of selectedRows) {
                        const registered = Object.values(registry.clips).find(clip => clip.metadataPath
                            && path.resolve(clip.metadataPath).toLowerCase() === path.resolve(row.output.metadataPath).toLowerCase());
                        stages.assertPendingBoundaryRetry(row, registered);
                        for (const part of row.output.parts) if (fs.statSync(part.mediaPath).size !== part.bytes || fileDigest(part.mediaPath) !== part.sha256) throw new Error('Activity video changed before boundary retry');
                        if (fileDigest(row.output.coverPath) !== row.coverSha256) throw new Error('Activity cover changed before boundary retry');
                    }
                    const id = crypto.randomUUID(), backupDirectory = path.join(files.directory, 'temp', 'boundary-revisions', id);
                    fs.mkdirSync(backupDirectory, { recursive: true });
                    for (const file of [files.plan, files.songs, files.review, previous.uploadManifestPath]) {
                        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDirectory, path.basename(file)));
                    }
                    fs.mkdirSync(path.join(backupDirectory, 'submissions'));
                    for (const row of selectedRows) fs.copyFileSync(row.output.metadataPath, path.join(backupDirectory, 'submissions', `${row.kind}.json`));
                    if (options.repairTiming) options.timingRevision = { id, note: options.revisionNote, backupDirectory, startedAt: new Date().toISOString() };
                    else options.boundaryRetry = { id, kind: options.kind, eventIds: candidates.map(event => event.id),
                        ...(options.boundaryFeedback ? { feedback: options.boundaryFeedback, note: options.revisionNote } : {}), backupDirectory, startedAt: new Date().toISOString() };
                }
            }
        }
        const plan = options.publicationRetryPlan || await detectActivities(options, config, source, info, files);
        if (options.planOnly) return { status: plan.status, planPath: files.plan, songsPath: files.songs };
        if (options.titleEvidencePath) {
            if (selected.length !== 1 || fileDigest(plan.transcript.path) !== plan.transcript.sha256) throw new Error('Transcript title review requires one unchanged source submission');
            const requested = JSON.parse(fs.readFileSync(options.titleEvidencePath, 'utf8'));
            options.titleEvidence = require('../workflow-runtime').loadWorkflow('clipping/activityTitles').bindTranscriptTitles(requested.items,
                stages.selectEvents(plan.events, selected), asr.parseSrt(plan.transcript.path).segments.map((row, index) => ({ index: index + 1, ...row })), plan.transcript);
        }
        const runDirectory = plan.timingSignature ? path.dirname(plan.uploadManifestPath) : path.join(files.directory, plan.signature.slice(0, 16));
        fs.mkdirSync(runDirectory, { recursive: true });
        const manifestPath = path.join(runDirectory, 'UPLOAD_MANIFEST.json');
        const previousClips = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).clips : [];
        scheduler = (options.scheduler || createClipResourceAdaptiveScheduler)({ ownConfig: root.ownStreamClips || {}, rootConfig: root });
        let metadata = [];
        for (const kind of selected) {
            const metadataPath = path.join(runDirectory, `${kind}.json`);
            if (!plan.parts[kind].length) {
                if ((plan.boundaryRetry?.kind === kind || plan.timingRevision) && fs.existsSync(metadataPath)) {
                    const old = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    stages.assertPendingBoundaryRetry(old);
                    const excluded = { ...old, activities: [], uploadReady: false,
                        activityReview: { version: 1, status: 'pending', reason: 'All activities excluded by boundary verification' } };
                    writeJsonAtomic(metadataPath, excluded); metadata.push(excluded);
                }
                continue;
            }
            const events = plan.events.filter(e => e.kind === (kind === 'songs' ? 'song' : 'watch'));
            stages.assertOrderedActivityParts(plan.parts[kind]);
            require('../workflow-runtime').loadWorkflow('clipping/activityWatchContext').assertWatchBoundaries(events);
            const previousMetadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
            const titleEvidence = options.titleEvidence || previousMetadata?.presentation?.titleEvidence || null;
            if (kind === 'watch' && publicationActive && require('../workflow-runtime').loadWorkflow('clipping/activityTitles')
                .namedEvents(events, titleEvidence).some(event => !event.name)) throw new Error('Viewing work names remain unresolved before rendering; provide --title-evidence');
            // An unchanged finished bundle is retained, including its review and publication state.
            if (fs.existsSync(metadataPath)) {
                let old = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                if (old.planSignature === plan.signature && stages.samePlannedParts(plan.parts[kind], old.output.parts)
                    && JSON.stringify(old.activities) === JSON.stringify(events) && old.output.parts.every(p => fs.existsSync(p.mediaPath)
                    && fs.statSync(p.mediaPath).size === p.bytes && fileDigest(p.mediaPath) === p.sha256)
                    && fs.existsSync(old.output.coverPath) && fileDigest(old.output.coverPath) === old.coverSha256) {
                    if (options.retryPublication && !options.retryBoundaries) { metadata.push(old); continue; }
                    if (old.activityReview?.status !== 'approved') {
                        old = await refreshPresentation(old, plan, root, options);
                        const route = config[kind].collection || {};
                        Object.assign(old.upload, { collectionSectionId: route.sectionId || null, collectionSeasonId: route.seasonId || null,
                            tags: config[kind].tags, tid: config[kind].tid });
                        writeJsonAtomic(metadataPath, old);
                    }
                    metadata.push(old); continue;
                }
                if (options.retryPublication && !options.retryBoundaries) throw new Error('Publication retry artifacts changed; an explicit reviewed revision is required');
                if (old.activityReview?.status === 'approved') throw new Error('Reviewed activity artifacts changed; create a reviewed revision before rebuilding');
            }
            // Preserve provisional videos and covers; only the pending metadata keeps its ID/path.
            const mediaDirectory = plan.timingRevision ? path.join(runDirectory, 'timing-revisions', plan.timingRevision.id) : plan.boundaryRetry?.kind === kind
                ? path.join(runDirectory, 'boundary-revisions', plan.boundaryRetry.id) : runDirectory;
            fs.mkdirSync(mediaDirectory, { recursive: true });
            const parts = [];
            for (const [index, part] of plan.parts[kind].entries()) {
                const outputPath = path.join(mediaDirectory, `${kind}_P${String(index + 1).padStart(3, '0')}.mp4`);
                const reused = require('../workflow-runtime').loadWorkflow('clipping/activityRecovery').reusableActivityPart(part, previousMetadata, source,
                    { size: file => fs.statSync(file).size, digest: fileDigest });
                if (reused) { parts.push(reused); continue; }
                const lease = await scheduler.acquire();
                try { parts.push(await (options.renderPart || media.renderActivityPart)(options.mediaPath, part, outputPath, root, lease.profile)); }
                finally { lease.release(); }
            }
            const presentation = presentationTools.presentationFor(plan, kind, parts, titleEvidence);
            const coverPath = presentationTools.coverPathFor(path.join(mediaDirectory, `${kind}.json`), presentation);
            const lease = await scheduler.acquire();
            try { await (options.cover || media.activityCover)(parts[0], coverPath, root, presentation.cover); } finally { lease.release(); }
            const collection = config[kind].collection || {};
            let row = { version: 1, type: 'stream_activity_submission', kind, roomId: info.roomId, generatedAt: new Date().toISOString(),
                ...(publicationActive ? { activityAutomaticPublicationRequired: true } : {}),
                streamerName: info.streamerName, source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath || null },
                sourceSnapshot: source, transcript: plan.transcript, planSignature: plan.signature, planPath: files.plan, coverage: plan.coverage,
                window: { start: parts[0].start, end: parts.at(-1).end, duration: parts.reduce((n, p) => n + p.duration, 0) },
                activities: events, copy: presentation.copy,
                presentation: { version: presentation.version, style: presentation.profile.style, signature: presentation.signature,
                    titleFormat: kind === 'songs' ? 'song_name_recording_date' : 'work_alias_recording_date', recordingDate: presentation.recordingDate,
                    ...(presentation.publicNames ? { publicNames: presentation.publicNames } : {}),
                    ...(titleEvidence ? { titleEvidence } : {}) },
                output: { mediaPath: parts[0].mediaPath, coverPath, metadataPath, parts: presentation.parts }, coverSha256: fileDigest(coverPath),
                activityReview: { version: 1, status: 'pending', checks: ['host_performance_or_actual_viewing', 'complete_boundaries', 'part_titles', 'public_copy'] },
                uploadReady: false, upload: { prefix: presentation.profile.prefix, tid: config[kind].tid, tags: presentation.tags || config[kind].tags,
                    roomId: info.roomId, streamerName: info.streamerName, source: kind === 'watch'
                        ? `${info.streamerName} 直播 ${info.recordedAt}` : `${info.streamerName} 直播《${info.streamTitle}》${info.recordedAt}`,
                    collectionSectionId: collection.sectionId || null, collectionSeasonId: collection.seasonId || null } };
            writeJsonAtomic(metadataPath, row);
            if (kind === 'songs' && !previousMetadata && config.songs.identifyNames === true) {
                row = await require('../workflow-runtime').loadWorkflow('clipping/songResearchRuntime').researchNewSongPresentation(row, {
                    identify: () => (options.identifySongs || identifyStreamSongs)({ metadataPath, config: root }),
                    apply: async evidencePath => {
                        const requested = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
                        const rows = asr.parseSrt(plan.transcript.path).segments.map((item, index) => ({ index: index + 1, ...item }));
                        const evidence = require('../workflow-runtime').loadWorkflow('clipping/activityTitles')
                            .bindTranscriptTitles(requested.items, events, rows, plan.transcript);
                        return refreshPresentation(row, plan, root, { ...options, titleEvidence: evidence });
                    }
                });
                writeJsonAtomic(metadataPath, row);
            }
            metadata.push(row);
        }
        if (!sameSource(sourceSnapshot({ source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath } }), source)) throw new Error('Activity source changed while rendering');
        const clips = stages.mergeManifestClips(previousClips, metadata.map(row => row.output.metadataPath));
        for (const clip of clips) if (!metadata.some(row => row.output.metadataPath === clip.metadataPath)) {
            metadata.push(JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8')));
        }
        let publicationAdapters;
        if (publicationActive) {
            const settings = root.ownStreamClips?.enhancements || {};
            publicationAdapters = options.publicationAdapters || publication.activityPublicationProcessAdapters(path.resolve(__dirname, '../../..'),
                (row, prompt, images) => require('./enhancement_runner').requestStage(
                    { ...settings.stageDefaults, ...settings.stages?.qa }, settings.budget,
                    { ...info, outputContract: { key: 'checks', type: 'object', allowDomainRejected: true } },
                    `activity-publication-${row.kind}`, prompt, images),
                (row, parts) => publication.inspectActivityPublication(row, parts,
                    resolveFfprobePath(root.audio?.ffmpeg?.path || 'ffmpeg'), async args => {
                        const lease = await scheduler.acquire();
                        try { return await require('./media_runtime').runFfmpeg(args, { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg',
                            threads: lease.profile.ffmpegThreads, timeoutMs: 1800000, stage: '活动成片发布审核' }); }
                        finally { lease.release(); }
                    }), { parse: file => asr.parseSrt(file).segments, audience: readAudience });
            metadata = await publication.reviewActivityPublications(metadata, root, publicationAdapters,
                { retryUnavailable: options.retryPublication === true, kinds: selected });
        }
        writeJsonAtomic(manifestPath, { version: 1, type: 'bilibili_clip_upload_manifest', reviewPath: files.review,
            planPath: files.plan, roomId: info.roomId, clips });
        plan.status = 'rendered'; plan.uploadManifestPath = manifestPath; plan.manifestClips = clips; writeJsonAtomic(files.plan, plan);
        writeJsonAtomic(files.songs, planTools.songRecord(plan));
        fs.writeFileSync(files.review, reviewText(plan, metadata, files), 'utf8');
        if (metadata.length && options.registerUpload !== false) {
            const importRegistry = async () => {
                const output = await (options.register || register)(manifestPath, options);
                const marker = typeof output === 'string' && output.match(/REGISTRY_RESULT:\s*(\{[^\n]+\})/u);
                return marker ? JSON.parse(marker[1]) : typeof output === 'object' ? output : null;
            };
            let registry = await importRegistry();
            if (registry && publicationActive) {
                plan.automaticPublication = await publication.enqueueActivityPublications(metadata, clips, registry, publicationAdapters, plan.automaticPublication);
                registry = await importRegistry() || registry;
            }
            if (registry) {
                plan.uploadRegistry = registry;
                const ids = registry.clipIdsByReviewIndex;
                const lines = metadata.map(row => `${row.kind === 'songs' ? '歌切' : '同步视听'}上传短 ID: ${ids[String(clips.find(clip => clip.metadataPath === row.output.metadataPath).reviewIndex)]}`);
                fs.writeFileSync(files.review, reviewText(plan, metadata, files), 'utf8');
                fs.appendFileSync(files.review, '\n' + lines.join('\n') + '\n', 'utf8');
                plan.uploadIds = ids; writeJsonAtomic(files.plan, plan);
            }
        }
        const selectedMetadata = metadata.filter(row => selected.includes(row.kind));
        return { status: 'rendered', submissions: selectedMetadata.length, parts: selectedMetadata.reduce((n, row) => n + row.output.parts.length, 0),
            pendingReview: metadata.some(row => row.activityReview?.status !== 'approved'),
            retainSource: metadata.some(row => row.activityReview?.authority === 'automatic'),
            ...(publicationActive ? { publicationResults: metadata.map(row => ({ kind: row.kind,
                id: plan.uploadIds?.[String(clips.find(clip => clip.metadataPath === row.output.metadataPath).reviewIndex)],
                title: row.upload.prefix+row.copy.title, status: activitySubmissionStatus(row, plan), issues: row.activityReview?.issues || [], reviewBrief: publication.activityReviewBrief(row) })) } : {}),
            manifestPath, planPath: files.plan, songsPath: files.songs, reviewPath: files.review };
        });
    } finally { await scheduler?.stop?.(); release(); }
}
async function identifyStreamSongs(options) {
    const root = options.config || loader.getConfig(), config = planTools.getActivityConfig(root);
    const metadata = JSON.parse(fs.readFileSync(options.metadataPath, 'utf8'));
    const info = recordingInfo(metadata.source.mediaPath, metadata);
    return require('../workflow-runtime').loadWorkflow('clipping/songResearchRuntime').identifyActivitySongs(options.metadataPath,
        { activityId: options.activityId, hint: options.hint }, {
            parse: file => asr.parseSrt(file).segments.map((row, index) => ({ index: index + 1, start: row.start, end: row.end, text: row.text })),
            audience: async file => (await readAudience(file)).map((row, index) => ({ index: index + 1, ...row })),
            catalog: options.catalog,
            propose: options.request || (async prompt => (await requestSelectionText(prompt,
                { primaryModel: config.ai.model, timeoutMs: config.ai.timeoutMs, maxTokens: 2500, strictEvaluation: true, structuredOutputKey: 'queries' },
                { ...config, ai: { ...config.ai, enabled: true } }, root, info, 'song-name-research', {}, value => {
                    try { return Array.isArray(JSON.parse(value.text || value).queries); } catch { return false; }
                })).text)
        });
}

async function reviewStreamActivity(options) {
    if (!String(options.note || '').trim()) throw new Error('Automatic operator review requires the saved feedback');
    const metadataPath = path.resolve(options.metadataPath), row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const release = acquire(path.join(path.dirname(row.planPath), '.worker.lock'));
    let scheduler;
    try {
        const root = options.config || loader.getConfig();
        const registry = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../data/runtime/clip_upload_registry.json'), 'utf8'));
        const registered = Object.values(registry.clips).find(clip => clip.metadataPath
            && path.resolve(clip.metadataPath).toLowerCase() === metadataPath.toLowerCase());
        stages.assertPendingBoundaryRetry(row, registered);
        if (!registered) throw new Error('Automatic operator review requires the existing registered ID');
        const backup = path.join(path.dirname(metadataPath), 'temp', 'operator-reviews', crypto.randomUUID());
        fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(metadataPath, path.join(backup, 'before.json'));
        const pending = { ...row, uploadReady: false, activityReview: { version: 1, status: 'pending' },
            activityOperatorReview: { version: 1, note: options.note, requestedAt: new Date().toISOString() } };
        writeJsonAtomic(metadataPath, pending);
        const publication = require('../workflow-runtime').loadWorkflow('clipping/activityPublication');
        const settings = root.ownStreamClips?.enhancements || {}, info = recordingInfo(row.source.mediaPath, row);
        scheduler = createClipResourceAdaptiveScheduler({ ownConfig: root.ownStreamClips || {}, rootConfig: root });
        const adapters = publication.activityPublicationProcessAdapters(path.resolve(__dirname, '../../..'),
            (_row, prompt, images) => require('./enhancement_runner').requestStage(
                { ...settings.stageDefaults, ...settings.stages?.qa }, settings.budget,
                { ...info, outputContract: { key: 'checks', type: 'object', allowDomainRejected: true } }, 'activity-operator-review', prompt, images),
            (current, parts) => publication.inspectActivityPublication(current, parts,
                resolveFfprobePath(root.audio?.ffmpeg?.path || 'ffmpeg'), async args => {
                    const lease = await scheduler.acquire();
                    try { return await require('./media_runtime').runFfmpeg(args, { ffmpegPath: root.audio?.ffmpeg?.path || 'ffmpeg',
                        threads: lease.profile.ffmpegThreads, timeoutMs: 1800000, stage: '活动反馈成片审核' }); }
                    finally { lease.release(); }
                }), { parse: file => asr.parseSrt(file).segments, audience: readAudience });
        const [reviewed] = await publication.reviewActivityPublications([pending], root, adapters, { operatorReview: true });
        await register(path.join(path.dirname(metadataPath), 'UPLOAD_MANIFEST.json'));
        if (reviewed.activityReview?.status !== 'approved') throw new Error(`Activity review needs attention: ${(reviewed.activityReview?.issues || []).join('; ')}`);
        return { status: 'approved', authority: 'automatic', id: registered.id };
    } finally { await scheduler?.stop?.(); release(); }
}
module.exports = { readAudience, recordingInfo, pathsFor, detectActivities, publicCopy, reviewText, register, generateStreamActivities,
    restyleStreamActivities, identifyStreamSongs, reviewStreamActivity };
