const fs = require('fs');
const path = require('path');

const configLoader = require('./config-loader');
const ownStreamClipper = require('./own_stream_clipper');
const streamActivities = require('./clipping/stream_activity_clipper');
const streamGames = require('./clipping/stream_game_clipper');
const backgroundClipQueue = require('./background_clip_queue');

const BACKGROUND_CLIPS_ARG = '--payload';
const BACKGROUND_CLIP_QUEUE_WORKER_ARG = '--queue-worker';

const {
    generateOwnStreamClipsForMedia, generateTopicClipsForMedia, shouldRunAnyClipper,
    spawnBackgroundClipProcess, getBackgroundClipQueueConfig
} = require('./background_clip_support');

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
    const save = value => {
        const next = { ...value, pid: process.pid, updatedAt: new Date().toISOString() };
        if (next.status === 'completed') delete next.lastError;
        writeJsonAtomic(statePath, next);
    };
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
