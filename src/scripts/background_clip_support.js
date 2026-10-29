const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const configLoader = require('./config-loader');
const aiTextGenerator = require('./ai_text_generator');
const topicClipper = require('./topic_clipper');
const ownStreamClipper = require('./own_stream_clipper');
const { activityEnabled } = require('./clipping/stream_activity_plan');
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
        await require('./recording_map_recovery.ts').ensureRecordingMap(mediaPath);
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
    const child = spawn(process.execPath, [path.join(__dirname, 'background_clip_runner.js'), BACKGROUND_CLIPS_ARG, payloadPath], {
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
    const child = spawn(process.execPath, [path.join(__dirname, 'background_clip_runner.js'), BACKGROUND_CLIP_QUEUE_WORKER_ARG], {
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

module.exports = {
    generateOwnStreamClipsForMedia, generateTopicClipsForMedia, shouldRunAnyClipper,
    spawnBackgroundClipProcess, getBackgroundClipQueueConfig
};
