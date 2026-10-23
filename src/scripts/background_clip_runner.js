const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const configLoader = require('./config-loader');
const aiTextGenerator = require('./ai_text_generator');
const topicClipper = require('./topic_clipper');
const ownStreamClipper = require('./own_stream_clipper');
const streamActivities = require('./clipping/stream_activity_clipper');
const { activityEnabled } = require('./clipping/stream_activity_plan');
const streamGames = require('./clipping/stream_game_clipper');
const { gameEnabled } = require('./clipping/stream_game_plan');
const backgroundClipQueue = require('./background_clip_queue');
const {
    applyFfmpegProcessPriority,
    getFfmpegResourceConfig
} = require('./ffmpeg_resource');

const BACKGROUND_CLIPS_ARG = '--payload';
const BACKGROUND_CLIP_QUEUE_WORKER_ARG = '--queue-worker';

async function generateTopicClipsForMedia(originalMediaPath, processedMediaPath, srtPath, roomId = null, context = {}, xmlPath = null) {
    const config = configLoader.getConfig();
    const clipConfig = topicClipper.getClipTopicsConfig(config);
    if (!clipConfig.enabled) {
        return [];
    }

    console.log('\n🎞️  开始话题切片检测...');
    try {
        const ffmpegPath = config.audio?.ffmpeg?.path || 'ffmpeg';
        const results = await topicClipper.generateTopicClips({
            config,
            originalMediaPath,
            processedMediaPath,
            srtPath,
            xmlPath,
            ffmpegPath,
            context: {
                ...context,
                roomId: roomId ? String(roomId) : null
            },
            titleGenerator: aiTextGenerator.generateClipTitle,
            descriptionGenerator: aiTextGenerator.generateClipDescription
        });
        console.log(results.length > 0
            ? `✅ 话题切片完成: ${results.length} 个本地 review 包`
            : 'ℹ️  话题切片未生成候选');
        return results;
    } catch (error) {
        console.warn(`⚠️  话题切片阶段失败，继续后续流程: ${error.message}`);
        try {
            const mediaPath = processedMediaPath || originalMediaPath;
            const info = topicClipper.parseRecordingInfo(mediaPath, context || {});
            await topicClipper.notifyTopicClipFailure(error, {
                streamerName: topicClipper.resolveStreamerName(config, info.roomId || roomId, context || {}),
                streamTitle: info.streamTitle,
                roomId: info.roomId || (roomId ? String(roomId) : null),
                recordedAt: info.recordedAt,
                outputRoot: path.join(path.dirname(mediaPath), clipConfig.outputDirName),
                sourceFileName: info.fileName,
                stage: 'topic_clipper'
            }, config);
        } catch (notifyError) {
            console.warn(`⚠️  话题切片失败通知发送失败: ${notifyError.message}`);
        }
        return [];
    }
}

async function generateOwnStreamClipsForMedia(
    mediaPath,
    srtPath,
    xmlPath,
    roomId = null,
    context = {},
    fullLiveContextPath = null,
    liveContentSummaryPath = null,
    options = {}
) {
    const config = configLoader.getConfig();
    const info = ownStreamClipper.parseRecordingInfo(mediaPath, { ...context, roomId });
    const clipConfig = ownStreamClipper.getOwnStreamClipsConfig(config, roomId, info.recordedAt);
    if (!clipConfig.enabled) {
        return [];
    }

    const roomKey = roomId ? String(roomId) : null;
    const enabledRoomIds = Array.isArray(clipConfig.roomIds)
        ? clipConfig.roomIds.map(value => String(value)).filter(Boolean)
        : [];
    if (enabledRoomIds.length > 0 && (!roomKey || !enabledRoomIds.includes(roomKey))) {
        return [];
    }

    if (!xmlPath || !fs.existsSync(xmlPath)) {
        console.warn('⚠️  ownStreamClips 已启用，但未找到 XML 弹幕文件，跳过岁己直播有趣切片');
        return [];
    }

    const source = { mediaPath, srtPath, xmlPath, roomId, context, fullLiveContextPath, liveContentSummaryPath };
    const decision = await require('./workflow-runtime').loadWorkflow('clipping/ownCampaign').ensureCampaignContent(clipConfig, source, {
        prepare: async () => Object.assign(source, await require('./live_content_preparation').prepareCampaignContentSummary({ ...source, config, clipConfig }))
    });
    if (!decision.allowed) { console.log(`跳过活动有趣切片（${clipConfig.campaignContentGate?.id}）：${decision.reason}；保留原关键词流程。`); return []; }
    if (!context.earlyCampaign && config.ownStreamClips?.campaigns?.some(campaign => campaign.id === clipConfig.campaignContentGate?.id && campaign.earlyTrigger?.enabled)) {
        require('../core/media/RecordingCoverage.ts').reserveFinalCampaign(mediaPath, clipConfig.campaignContentGate.id);
    }
    require('../core/media/RecordingCoverage.ts').filterCampaignCoverage([], mediaPath);
    console.log('\n🎬  开始岁己直播有趣切片...');
    try {
        const results = await ownStreamClipper.generateOwnStreamClips({
            config,
            mediaPath,
            srtPath,
            xmlPath,
            ffmpegPath: config.audio?.ffmpeg?.path || 'ffmpeg',
            context: {
                ...context,
                roomId: roomKey
            },
            streamerName: context.streamerName || context.streamer_name || null,
            fullLiveContextPath: source.fullLiveContextPath,
            liveContentSummaryPath: source.liveContentSummaryPath
        });
        console.log(results.length > 0
            ? `✅ 岁己直播有趣切片完成: ${results.length} 段`
            : 'ℹ️  岁己直播有趣切片未生成候选');
        return results;
    } catch (error) {
        if (context.earlyCampaign || options.throwOnFailure) throw error;
        console.warn(`⚠️  岁己直播有趣切片阶段失败，继续后续流程: ${error.message}`);
        return [];
    }
}

function shouldRunAnyClipper(roomId = null, xmlPath = null) {
    const config = configLoader.getConfig();
    const topicConfig = topicClipper.getClipTopicsConfig(config);
    const ownConfig = ownStreamClipper.getOwnStreamClipsConfig(config, roomId);
    const roomKey = roomId ? String(roomId) : null;
    const ownRoomIds = Array.isArray(ownConfig.roomIds)
        ? ownConfig.roomIds.map(value => String(value)).filter(Boolean)
        : [];
    const ownEnabledForRoom = ownConfig.enabled
        && (ownRoomIds.length === 0 || (roomKey && ownRoomIds.includes(roomKey)))
        && !!xmlPath
        && fs.existsSync(xmlPath);

    return Boolean(topicConfig.enabled || ownEnabledForRoom || activityEnabled(config, roomKey) || gameEnabled(config, roomKey));
}

function installBackgroundClipLogger(logPath) {
    if (!logPath) {
        return () => {};
    }

    const append = (level, args) => {
        const line = args.map(arg => {
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
            if (typeof arg === 'string') {
                return arg;
            }
            try {
                return JSON.stringify(arg);
            } catch (error) {
                return String(arg);
            }
        }).join(' ');
        try {
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${line}\n`, 'utf8');
        } catch {
            // A logging failure must not abort an otherwise valid clip job.
        }
    };

    const originals = new Map();
    const wrappers = new Map();
    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level];
        const wrapper = (...args) => {
            append(level.toUpperCase(), args);
            original.apply(console, args);
        };
        originals.set(level, original);
        wrappers.set(level, wrapper);
        console[level] = wrapper;
    }

    return () => {
        for (const level of ['log', 'info', 'warn', 'error']) {
            if (console[level] === wrappers.get(level)) {
                console[level] = originals.get(level);
            }
        }
    }
}

function getBackgroundClipQueueConfig(config = configLoader.getConfig()) {
    return backgroundClipQueue.getQueueConfig(
        config?.clipTopics?.backgroundQueue || config?.backgroundClipQueue || {}
    );
}

function writeBackgroundClipPayload(payload) {
    const mediaPath = payload.processedMediaPath || payload.originalMediaPath || 'media';
    const baseDir = path.dirname(mediaPath);
    const baseName = path.basename(mediaPath, path.extname(mediaPath));
    const hash = crypto.createHash('sha1')
        .update(JSON.stringify({
            originalMediaPath: payload.originalMediaPath,
            processedMediaPath: payload.processedMediaPath,
            srtPath: payload.srtPath,
            roomId: payload.roomId,
            activityOptions: payload.activityOptions,
            earlyCampaign: payload.earlyCampaign,
            createdAt: payload.activityOptions || payload.earlyCampaign ? null : Date.now()
        }))
        .digest('hex')
        .slice(0, 10);
    const payloadPath = path.join(baseDir, `${baseName}_background_clips_${hash}.json`);
    const logPath = path.join(baseDir, `${baseName}_background_clips_${hash}.log`);
    if (!(payload.activityOptions || payload.earlyCampaign) || !fs.existsSync(payloadPath)) {
        require('./clipping/candidate_subtitles').writeJsonAtomic(payloadPath, { ...payload, logPath });
    }
    return { payloadPath, logPath };
}

function spawnDetachedBackgroundClipProcess(payloadPath, resourceConfig, extraEnv = {}) {
    const child = spawn(process.execPath, [__filename, BACKGROUND_CLIPS_ARG, payloadPath], {
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
        env: {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV || 'production',
            AUTOMATION: 'true',
            BACKGROUND_CLIPS: 'true',
            FFMPEG_THREADS: String(resourceConfig.threads),
            FFMPEG_PRIORITY: resourceConfig.priority,
            ...extraEnv
        }
    });
    applyFfmpegProcessPriority(child.pid, resourceConfig.priority);
    child.unref();
    return child;
}

function spawnBackgroundClipWorker(queueConfig, resourceConfig) {
    const child = spawn(process.execPath, [__filename, BACKGROUND_CLIP_QUEUE_WORKER_ARG], {
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
        env: {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV || 'production',
            AUTOMATION: 'true',
            BACKGROUND_CLIPS: 'true',
            FFMPEG_THREADS: String(resourceConfig.threads),
            FFMPEG_PRIORITY: resourceConfig.priority,
            DANMAKU_BACKGROUND_CLIP_QUEUE_DIR: queueConfig.directory,
            DANMAKU_BACKGROUND_CLIP_QUEUE_ENABLED: 'true'
        }
    });
    applyFfmpegProcessPriority(child.pid, resourceConfig.priority);
    child.unref();
    return child;
}

function spawnBackgroundClipProcess(payload) {
    const config = configLoader.getConfig();
    const resourceConfig = getFfmpegResourceConfig(config);
    const queueConfig = getBackgroundClipQueueConfig(config);
    const { payloadPath, logPath } = writeBackgroundClipPayload(payload);

    if (!queueConfig.enabled) {
        const child = spawnDetachedBackgroundClipProcess(payloadPath, resourceConfig);
        console.log(`🎬 自动切片已转入后台子进程: pid=${child.pid || 'unknown'}, log=${logPath}`);
        return { payloadPath, logPath, pid: child.pid, queued: false };
    }

    const queuedJob = backgroundClipQueue.enqueueJob({
        jobId: payload.activityOptions || payload.earlyCampaign ? path.basename(payloadPath, '.json') : undefined,
        payloadPath,
        logPath,
        roomId: payload.roomId
    }, queueConfig);
    const workerLaunch = backgroundClipQueue.claimWorkerLaunch(
        queueConfig.directory,
        queueConfig.staleLockMs
    );
    let worker = null;
    if (workerLaunch) {
        try {
            worker = spawnBackgroundClipWorker(queueConfig, resourceConfig);
            workerLaunch.commit();
        } catch (error) {
            workerLaunch.release();
            throw error;
        }
    }
    const pendingCount = backgroundClipQueue.countQueueEntries(queueConfig.directory);
    console.log(
        `🎬 自动切片已加入全局串行队列: job=${queuedJob.jobId}, roomId=${payload.roomId || 'unknown'}, `
        + `pending=${pendingCount}, workerPid=${worker?.pid || 'existing-or-starting'}, log=${logPath}`
    );
    return {
        ...queuedJob,
        payloadPath,
        logPath,
        pid: worker?.pid,
        workerStarted: Boolean(worker),
        queued: true
    };
}

async function deleteOriginalVideoAfterBackgroundClips(videoPathToDelete) {
    if (!videoPathToDelete) {
        return;
    }

    try {
        const { unlink: unlinkAsync } = require('fs/promises');
        if (fs.existsSync(videoPathToDelete)) {
            await unlinkAsync(videoPathToDelete);
            console.log(`🗑️  后台切片完成，已删除原始视频: ${path.basename(videoPathToDelete)}`);
        }
    } catch (deleteError) {
        console.error(`⚠️  后台切片完成后删除原始视频失败: ${deleteError.message}`);
    }
}

async function runBackgroundClipsFromPayload(payloadPath) {
    if (!payloadPath || !fs.existsSync(payloadPath)) {
        throw new Error(`background clip payload not found: ${payloadPath || ''}`);
    }

    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    // Snapshot operator settings for each new recording job; all its stages share this config.
    configLoader.clearCache();
    const runtimeConfig = configLoader.getConfig();
    const automatic = ownStreamClipper.getOwnStreamClipsConfig(runtimeConfig, payload.roomId).automaticPublication;
    const topicAutomatic = runtimeConfig.clipTopics?.automaticPublication?.mode === 'auto'
        && require('./workflow-runtime').loadWorkflow('clipping/publicationReview').publicationEnabled(
            require('./workflow-runtime').loadWorkflow('clipping/publicationReview').resolveTopicPublicationConfig(runtimeConfig), payload.roomId);
    if (topicAutomatic || automatic?.mode === 'auto' && automatic.roomIds?.map(String).includes(String(payload.roomId))) {
        // Asynchronous upload and pending human review both revalidate the original source.
        payload.videoPathToDelete = null;
    }
    const statePath = `${payloadPath}.progress.json`;
    const { writeJsonAtomic } = require('./clipping/candidate_subtitles');
    const recovery = require('./workflow-runtime').loadWorkflow('clipping/activityRecovery');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { version: 1, completed: {} };
    const save = value => writeJsonAtomic(statePath, { ...value, pid: process.pid, updatedAt: new Date().toISOString() });
    const stage = (name, run) => recovery.resumeStage(state, name, save, run);
    const restoreLogger = installBackgroundClipLogger(payload.logPath);
    try {
        if (state.status === 'completed') return;
        if (payload.earlyCampaign) {
            await stage('earlyCampaign', () => require('./campaign_early.ts').runEarlyCampaign(payload));
            state.status = 'completed'; save(state); return;
        }
        const recordingJobs = require('./recording_clip_job.ts');
        const projectRoot = path.resolve(__dirname, '../..');
        const recordingJob = recordingJobs.resolveRecordingClipJob(projectRoot, payload);
        if (recordingJob) {
            // This source-scoped job replaces ordinary keyword/own stages and always retains evidence.
            payload.videoPathToDelete = null;
            try {
                await stage('recordingJob', () => recordingJobs.executeRecordingClipJob(projectRoot, recordingJob, payloadPath));
            } finally { configLoader.clearCache(); }
            state.status = 'completed'; save(state); return;
        }
        console.log('🎬 后台自动切片 worker 开始处理任务');
        console.log(`   media=${payload.processedMediaPath || payload.originalMediaPath}`);
        console.log(`   srt=${payload.srtPath}`);
        console.log(`   roomId=${payload.roomId || 'unknown'}`);
        const context = payload.context || {};
        if (payload.activityOptions) {
            const config = payload.suppressActivityNotification ? { ...runtimeConfig,
                streamActivityClips: { ...runtimeConfig.streamActivityClips,
                    notify: { ...runtimeConfig.streamActivityClips?.notify, enabled: false } } } : runtimeConfig;
            const result = await stage('activity', () => streamActivities.generateStreamActivities({ ...payload.activityOptions, config }));
            console.log(`活动恢复: ${JSON.stringify(result)}`);
            state.status = 'completed'; save(state); return;
        }
        await stage('topics', () => generateTopicClipsForMedia(
            payload.originalMediaPath,
            payload.processedMediaPath,
            payload.srtPath,
            payload.roomId,
            context,
            payload.xmlPath
        ));
        const failures = new Map();
        try {
            await stage('own', () => generateOwnStreamClipsForMedia(
                payload.originalMediaPath,
                payload.srtPath,
                payload.xmlPath,
                payload.roomId,
                context,
                payload.fullLiveContextPath || null,
                payload.liveContentSummaryPath || null,
                { throwOnFailure: true }
            ));
        } catch (error) {
            // Keep this stage incomplete for the bounded queue retry, while archives continue.
            failures.set('own', error.message);
            payload.videoPathToDelete = null;
            console.warn(`岁己直播有趣切片失败，保留原始视频并继续后续流程: ${error.message}`);
        }
        // Complete ordinary highlights before the longer archive workflows.
        const archiveLabel = kind => ({ songs: '歌切', games: '游戏完整切片', watch: '同步视听' }[kind]);
        await require('./workflow-runtime').loadWorkflow('clipping/activityStages').runArchiveStages(async (kind, reuseSummaryOnly) => {
                const options = {
                    mediaPath: payload.originalMediaPath || payload.processedMediaPath,
                    srtPath: payload.srtPath, xmlPath: payload.xmlPath,
                    fullLiveContextPath: payload.fullLiveContextPath || null,
                    summaryPath: payload.liveContentSummaryPath || null,
                    context: { ...context, roomId: payload.roomId }
                };
                const result = await stage(kind, () => kind === 'games'
                    ? streamGames.generateStreamGames(options)
                    : streamActivities.generateStreamActivities({ ...options, kind, reuseSummaryOnly }));
                return result;
            }, (kind, result) => {
                failures.delete(kind);
                console.log(`${archiveLabel(kind)}: ${JSON.stringify(result)}`);
                // Review, upload and subtitle recovery still verify the original source.
                if (result.pendingReview || result.retainSource || (kind === 'games' && result.status === 'rendered')) {
                    payload.videoPathToDelete = null;
                }
            }, (kind, error) => {
                failures.set(kind, error.message);
                payload.videoPathToDelete = null;
                console.warn(`${archiveLabel(kind)}处理失败，保留原始视频供恢复: ${error.message}`);
            });
        if (failures.size) throw new Error(`${failures.has('own') ? 'Clip' : 'Archive'} stages incomplete: ${JSON.stringify([...failures])}`);
        state.status = 'completed'; save(state);
        await deleteOriginalVideoAfterBackgroundClips(payload.videoPathToDelete);
        console.log('✅ 后台自动切片子进程完成');
    } catch (error) {
        state.status = 'failed'; state.lastError = error.message; save(state);
        throw error;
    } finally {
        restoreLogger();
    }
}

async function runBackgroundClipQueueWorker() {
    const config = configLoader.getConfig();
    const queueConfig = getBackgroundClipQueueConfig(config);
    return backgroundClipQueue.runQueueWorker(
        queueConfig,
        async entry => runBackgroundClipsFromPayload(entry.payloadPath),
        { log: message => console.error(message), keepAlive: process.argv.includes('--loop') }
    );
}

module.exports = {
    generateOwnStreamClipsForMedia,
    generateTopicClipsForMedia,
    shouldRunAnyClipper,
    spawnBackgroundClipProcess,
    runBackgroundClipsFromPayload,
    runBackgroundClipQueueWorker,
    getBackgroundClipQueueConfig
};

if (require.main === module) {
    (async () => {
        try {
            if (process.argv.includes(BACKGROUND_CLIP_QUEUE_WORKER_ARG)) {
                await runBackgroundClipQueueWorker();
                return;
            }
            const payloadIndex = process.argv.indexOf(BACKGROUND_CLIPS_ARG);
            const payloadPath = payloadIndex >= 0 ? process.argv[payloadIndex + 1] : process.argv[2];
            await runBackgroundClipsFromPayload(payloadPath);
        } catch (error) {
            console.error(`❌ background_clip_runner failed: ${error.message}`);
            if (error?.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    })();
}
