const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const configLoader = require('./config-loader');
const aiTextGenerator = require('./ai_text_generator');
const topicClipper = require('./topic_clipper');
const ownStreamClipper = require('./own_stream_clipper');
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
    fullLiveContextPath = null
) {
    const config = configLoader.getConfig();
    const clipConfig = ownStreamClipper.getOwnStreamClipsConfig(config);
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
            fullLiveContextPath
        });
        console.log(results.length > 0
            ? `✅ 岁己直播有趣切片完成: ${results.length} 段`
            : 'ℹ️  岁己直播有趣切片未生成候选');
        return results;
    } catch (error) {
        console.warn(`⚠️  岁己直播有趣切片阶段失败，继续后续流程: ${error.message}`);
        return [];
    }
}

function shouldRunAnyClipper(roomId = null, xmlPath = null) {
    const config = configLoader.getConfig();
    const topicConfig = topicClipper.getClipTopicsConfig(config);
    const ownConfig = ownStreamClipper.getOwnStreamClipsConfig(config);
    const roomKey = roomId ? String(roomId) : null;
    const ownRoomIds = Array.isArray(ownConfig.roomIds)
        ? ownConfig.roomIds.map(value => String(value)).filter(Boolean)
        : [];
    const ownEnabledForRoom = ownConfig.enabled
        && (ownRoomIds.length === 0 || (roomKey && ownRoomIds.includes(roomKey)))
        && !!xmlPath
        && fs.existsSync(xmlPath);

    return Boolean(topicConfig.enabled || ownEnabledForRoom);
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
            createdAt: Date.now()
        }))
        .digest('hex')
        .slice(0, 10);
    const payloadPath = path.join(baseDir, `${baseName}_background_clips_${hash}.json`);
    const logPath = path.join(baseDir, `${baseName}_background_clips_${hash}.log`);
    fs.writeFileSync(payloadPath, JSON.stringify({ ...payload, logPath }, null, 2), 'utf8');
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
    const restoreLogger = installBackgroundClipLogger(payload.logPath);

    try {
        console.log('🎬 后台自动切片 worker 开始处理任务');
        console.log(`   media=${payload.processedMediaPath || payload.originalMediaPath}`);
        console.log(`   srt=${payload.srtPath}`);
        console.log(`   roomId=${payload.roomId || 'unknown'}`);
        const context = payload.context || {};
        await generateTopicClipsForMedia(
            payload.originalMediaPath,
            payload.processedMediaPath,
            payload.srtPath,
            payload.roomId,
            context,
            payload.xmlPath
        );
        await generateOwnStreamClipsForMedia(
            payload.originalMediaPath,
            payload.srtPath,
            payload.xmlPath,
            payload.roomId,
            context,
            payload.fullLiveContextPath || null
        );
        console.log('✅ 后台自动切片子进程完成');
    } finally {
        await deleteOriginalVideoAfterBackgroundClips(payload.videoPathToDelete);
        try {
            fs.unlinkSync(payloadPath);
        } catch (error) {
            console.warn(`⚠️  删除后台切片 payload 失败: ${error.message}`);
        }
        restoreLogger();
    }
}

async function runBackgroundClipQueueWorker() {
    const config = configLoader.getConfig();
    const queueConfig = getBackgroundClipQueueConfig(config);
    return backgroundClipQueue.runQueueWorker(
        queueConfig,
        async entry => runBackgroundClipsFromPayload(entry.payloadPath),
        { log: message => console.error(message) }
    );
}

module.exports = {
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
