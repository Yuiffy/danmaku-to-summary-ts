'use strict';

/**
 * Small, explicit queue for manually selected clips.
 *
 * A task only needs a recording, an optional SRT, a time range and copy.
 * Cutting never implies uploading unless autoUpload=true was requested.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const topicClipper = require('./topic_clipper');
const configLoader = require('./config-loader');
const { createClipResourceAdaptiveScheduler } = require('./clipping/resource_scheduler');

const projectRoot = path.resolve(__dirname, '../..');
const defaultQueuePath = path.join(projectRoot, 'data/runtime/manual_clip_queue.json');
const QUEUE_PROFILES = {
    mizuki: {
        name: 'mizuki',
        titlePrefix: '【弥月】',
        tags: ['弥月Mizuki', '弥月', '虚拟主播', '直播切片', 'AI切片'],
        label: '弥月手工队列'
    },
    small_sui: {
        name: 'small_sui',
        titlePrefix: '【小岁】',
        tags: ['小岁', '岁AI切片', '虚拟主播', '直播切片', 'AI切片'],
        label: '手工候选队列'
    },
    old_sui: {
        name: 'old_sui',
        titlePrefix: '【老岁片】',
        tags: ['老岁片', '岁己SUI', '虚拟主播', '直播切片', 'AI切片'],
        label: '老岁片手工队列'
    },
    shiori: {
        name: 'shiori',
        titlePrefix: '【小栞】',
        tags: ['AI切片', '小岁', '虚拟主播', '直播切片'],
        label: '栞栞手工队列'
    },
    izayoi: {
        name: 'izayoi',
        titlePrefix: '【十六萤】',
        tags: ['十六萤', '十六萤Izayoi', '虚拟主播', '直播切片', 'AI切片'],
        label: '十六萤手工队列'
    }
};
function resolveQueueProfile(value) {
    const normalized = String(value || 'small_sui').trim().toLowerCase();
    if (['mizuki', '弥月', '弥月mizuki'].includes(normalized)) return QUEUE_PROFILES.mizuki;
    if (['old', 'legacy', 'old-sui', 'old_sui', '老岁片'].includes(normalized)) {
        return QUEUE_PROFILES.old_sui;
    }
    if (['shiori', '小栞', '栞栞'].includes(normalized)) {
        return QUEUE_PROFILES.shiori;
    }
    if (['izayoi', '十六萤', '十六萤izayoi'].includes(normalized)) {
        return QUEUE_PROFILES.izayoi;
    }
    return QUEUE_PROFILES.small_sui;
}

function formatRecordedDate(value) {
    const match = String(value || '').match(/(?:^|[^\d])(\d{4})[-_/年](\d{1,2})[-_/月](\d{1,2})(?:日)?(?:[^\d]|$)/);
    if (!match) return '';
    return `${match[1]}年${String(match[2]).padStart(2, '0')}月${String(match[3]).padStart(2, '0')}日`;
}

function resolveRecordedDate(recordedAt, mediaPath = '') {
    return formatRecordedDate(recordedAt) || formatRecordedDate(mediaPath);
}

function formatRecordedAt(recordedAt, mediaPath = '') {
    const values = [recordedAt, mediaPath].map(value => String(value || '').trim()).filter(Boolean);
    for (const value of values) {
        let match = value.match(/(\d{4})[-_/年](\d{1,2})[-_/月](\d{1,2})(?:日)?[T\s]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/);
        if (match) {
            return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')} ${String(match[4]).padStart(2, '0')}:${match[5]}:${match[6] || '00'}`;
        }

        match = value.match(/(?:^|[^\d])((?:19|20)\d{2})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})(?!\d)/);
        if (match) {
            return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
        }

        match = value.match(/(\d{4})[-_/年](\d{1,2})[-_/月](\d{1,2})(?:日)?/);
        if (match) {
            return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
        }
    }
    return '';
}

function normalizeStreamTitle(streamTitle) {
    return String(streamTitle || '')
        .trim()
        .replace(/[\s_-]*(?:merged|best_effort)$/i, '')
        .replace(/^《|》$/g, '')
        .trim();
}

function buildUploadSource({
    streamerName = '岁己SUI',
    streamTitle = '',
    recordedAt = '',
    mediaPath = ''
} = {}) {
    const name = String(streamerName || '岁己SUI').trim() || '岁己SUI';
    const title = normalizeStreamTitle(streamTitle);
    const timestamp = formatRecordedAt(recordedAt, mediaPath);
    const titlePart = title ? ` 直播《${title}》` : ' 直播';
    return `${name}${titlePart}${timestamp ? `${title ? '' : ' '}${timestamp}` : ''}`.trim();
}

function normalizeOldSuiTitle(title, { recordedAt = '', mediaPath = '' } = {}) {
    const normalized = String(title || '').trim();
    const date = resolveRecordedDate(recordedAt, mediaPath);
    if (!date || normalized.endsWith(date)) return normalized;
    return `${normalized} ${date}`.trim();
}

function buildProfileDescription(profile, description, { recordedAt = '', mediaPath = '', streamTitle = '' } = {}) {
    const normalized = String(description || '').trim();
    if (profile?.name !== 'old_sui') return normalized;

    const date = resolveRecordedDate(recordedAt, mediaPath);
    const title = String(streamTitle || '').trim();
    const headers = [];
    if (date && !normalized.includes('直播日期：')) headers.push(`直播日期：${date}`);
    if (title && !normalized.includes('直播标题：')) headers.push(`直播标题：${title}`);
    return [...headers, normalized].filter(Boolean).join('\n\n');
}

function nowIso() {
    return new Date().toISOString();
}

function readQueue(queuePath) {
    if (!fs.existsSync(queuePath)) return { version: 1, nextId: 1, tasks: [] };
    return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
}

function writeQueue(queuePath, queue) {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    const tmp = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, queuePath);
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--auto-upload') options.autoUpload = true;
        else if (arg === '--no-notify') options.notify = false;
        else if (arg === '--once') options.once = true;
        else if (arg === '--loop') options.loop = true;
        else if (arg === '--force') options.force = true;
        else if (arg.startsWith('--')) {
            const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            options[key] = argv[++index];
        } else if (!options.command) options.command = arg;
        else if (!options.id) options.id = arg;
    }
    return options;
}

function requireOption(options, name) {
    const value = String(options[name] ?? '').trim();
    if (!value) throw new Error(`missing --${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
    return value;
}

function asNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
    return number;
}

function deriveSrt(mediaPath) {
    const base = path.join(path.dirname(mediaPath), path.basename(mediaPath, path.extname(mediaPath)));
    const candidate = `${base}.srt`;
    return fs.existsSync(candidate) ? candidate : '';
}

function deriveOutputDir(mediaPath, explicit) {
    if (explicit) return path.resolve(explicit);
    return path.join(path.dirname(mediaPath), 'manual_requested_clips');
}

function deriveReviewPath(mediaPath, outputDir, explicit) {
    if (explicit) return path.resolve(explicit);
    const stem = path.basename(mediaPath, path.extname(mediaPath));
    return path.join(outputDir, `${stem}_MANUAL_REVIEW.md`);
}

function buildQueueMediaConfig(rootConfig = {}, resourceProfile = null) {
    const own = rootConfig.ownStreamClips || {};
    return {
        ...(rootConfig.clipTopics || {}),
        subtitleVideoEncoder: own.subtitleVideoEncoder || 'h264_nvenc',
        subtitleVideoPreset: own.subtitleVideoPreset || 'p4',
        subtitleVideoCrf: own.subtitleVideoCrf ?? 23,
        subtitleVideoCq: own.subtitleVideoCq ?? 23,
        subtitleHwaccel: own.subtitleHwaccel ?? 'cuda',
        clipFfmpegThreads: resourceProfile?.ffmpegThreads ?? own.clipFfmpegThreads ?? 2,
        burnSubtitles: true,
        twoStageSubtitleBurn: true,
        twoStageMode: 'copy',
        preserveCoverSource: true,
        ffmpegTimeoutMs: 1200000
    };
}

function formatClock(seconds) {
    return topicClipper.formatClock(seconds);
}

function appendReview(reviewPath, task, result) {
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    let review = fs.existsSync(reviewPath)
        ? fs.readFileSync(reviewPath, 'utf8')
        : [
            '# 手工候选切片 review',
            '',
            `录制: ${task.mediaPath}`,
            '来源统计: 手工队列 0',
            '',
            '## 切片列表',
            ''
        ].join('\n');
    if (review.includes(result.output.mediaPath)) return review;
    const indices = Array.from(review.matchAll(/^(\d+)\.\s/mg), match => Number(match[1]));
    const index = (indices.length ? Math.max(...indices) : 0) + 1;
    review = review.replace(
        /^来源统计:\s*手工队列\s+(\d+)$/m,
        (_, count) => `来源统计: 手工队列 ${Number(count) + 1}`
    ).trimEnd();
    const entry = [
        '',
        `${index}. ${task.title} | ${formatClock(task.start)} | ${formatClock(task.end - task.start)} | ${result.output.mediaPath}`,
        '   来源: 手工队列',
        result.output.coverPath ? `   封面: ${result.output.coverPath}` : null,
    ].filter(Boolean).join('\n');
    review += `\n${entry}`;
    fs.writeFileSync(reviewPath, review, 'utf8');
    return review;
}

function importJson(metadataPath, reviewPath, task) {
    const profile = resolveQueueProfile(task.profile);
    const source = buildUploadSource(task);
    const args = [
        path.join(projectRoot, 'src/scripts/clip_upload_registry.py'),
        'import-json',
        '--manifest', metadataPath,
        '--review', reviewPath,
        '--source', source,
        '--prefix', profile.titlePrefix,
        '--tags', profile.tags.join(','),
        '--tid', String(task.tid || 21),
        '--label', profile.label
    ];
    const result = spawnSync('python', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        // Keep the registry helper completely detached from the user's desktop.
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) throw new Error(`upload registry import failed: ${output || result.status}`);
    const match = output.match(/IDs:\s*([\d,]+)/);
    return {
        output,
        clipIds: match ? match[1].split(',').map(value => Number(value)).filter(Number.isFinite) : []
    };
}

function enqueueIds(ids) {
    if (!ids.length) return '';
    const args = [
        path.join(projectRoot, 'src/scripts/clip_upload_registry.py'),
        'enqueue', '--ids', ids.join(',')
    ];
    const result = spawnSync('python', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status !== 0) throw new Error(`upload queue enqueue failed: ${output || result.status}`);
    return output;
}

function buildNotifyResult(task, result) {
    return {
        uploadId: task.uploadIds?.[0] || null,
        window: { start: task.start, end: task.end, duration: task.end - task.start },
        copy: { title: task.title },
        output: { mediaPath: result.output.mediaPath }
    };
}

async function notifyTask(task, result, rootConfig) {
    if (task.notify === false) return false;
    const config = {
        ...rootConfig,
        clipTopics: {
            ...(rootConfig.clipTopics || {}),
            notify: { ...(rootConfig.clipTopics?.notify || {}), enabled: true }
        }
    };
    return topicClipper.notifyTopicClipResults(
        [buildNotifyResult(task, result)],
        {
            streamerName: task.streamerName || '岁己SUI',
            streamTitle: task.streamTitle || path.basename(task.mediaPath),
            recordedAt: task.recordedAt || '未知',
            roomId: task.roomId || '25788785',
            outputRoot: task.outputDir,
            reviewPath: task.reviewPath,
            uploadRegistry: task.uploadIds?.length ? { clipIds: task.uploadIds } : null
        },
        config
    );
}

async function cutTask(task, rootConfig, resourceSchedulerOverride = null) {
    if (!fs.existsSync(task.mediaPath)) throw new Error(`media not found: ${task.mediaPath}`);
    if (!fs.existsSync(task.srtPath)) throw new Error(`SRT not found: ${task.srtPath}`);
    if (!(task.end > task.start)) throw new Error('end must be greater than start');
    fs.mkdirSync(task.outputDir, { recursive: true });
    const sourceSrt = topicClipper.parseTopicSrt(task.srtPath);
    const outputVideo = path.join(task.outputDir, `${task.outputStem}.mp4`);
    const outputSrt = path.join(task.outputDir, `${task.outputStem}.srt`);
    const metadataPath = path.join(task.outputDir, `${task.outputStem}.json`);
    const copyPath = path.join(task.outputDir, `${task.outputStem}_投稿文案.md`);
    const window = { start: task.start, end: task.end, duration: task.end - task.start };
    const subtitleConfig = rootConfig.subtitle || {};
    const clipTopicsConfig = rootConfig.clipTopics || {};
    const srtResult = topicClipper.writeClipSrt(sourceSrt.segments, window, outputSrt, {
        maxCharsPerLine: clipTopicsConfig.subtitleMaxCharsPerLine
            ?? subtitleConfig.max_chars_per_line
            ?? 18,
        stripPunctuation: subtitleConfig.strip_punctuation ?? true
    });
    const resourceScheduler = resourceSchedulerOverride || createClipResourceAdaptiveScheduler({
        ownConfig: rootConfig.ownStreamClips || {},
        rootConfig
    });
    const resourceLease = resourceScheduler.enabled
        ? await resourceScheduler.acquire()
        : null;
    const resourceProfile = resourceLease?.profile || resourceScheduler.getProfile();
    const cutConfig = buildQueueMediaConfig(rootConfig, resourceProfile);
    let mediaResult;
    try {
        mediaResult = await topicClipper.cutClipMedia(
            { kind: 'video', mediaPath: task.mediaPath },
            window,
            outputSrt,
            outputVideo,
            cutConfig
        );
    } finally {
        resourceLease?.release();
    }
    let coverPath = null;
    try {
        coverPath = await topicClipper.generateClipCover(
            outputVideo,
            task.coverText || task.title,
            task.outputDir,
            {
                streamerName: task.streamerName || '岁己SUI',
                coverSourcePath: mediaResult.coverSourcePath || task.mediaPath,
                clipStart: mediaResult.coverClipStart ?? task.start,
                clipDuration: window.duration,
                preferredTime: Math.max(0, task.start + window.duration * 0.35 - (mediaResult.coverTimeOrigin || 0)),
                timeoutMs: 1200000
            }
        );
    } finally {
        topicClipper.cleanupTemporaryCoverSource(mediaResult);
    }
    const profile = resolveQueueProfile(task.profile);
    const metadata = {
        version: 1,
        generatedAt: nowIso(),
        mode: 'manual_clip_queue',
        profile: profile.name,
        status: 'success',
        source: { mediaPath: task.mediaPath, srtPath: task.srtPath, sourceKind: 'video' },
        roomId: task.roomId || '25788785',
        streamerName: task.streamerName || '岁己SUI',
        recordedAt: task.recordedAt || null,
        streamTitle: task.streamTitle || null,
        uploadSource: buildUploadSource(task),
        window,
        copy: { title: task.title, coverText: task.coverText, description: task.description, tags: profile.tags },
        upload: {
            source: buildUploadSource(task),
            prefix: profile.titlePrefix,
            tags: profile.tags,
            tid: Number(task.tid || 21),
            roomId: task.roomId || '25788785',
            streamerName: task.streamerName || '岁己SUI'
        },
        uploadReady: true,
        output: {
            mediaPath: outputVideo,
            srtPath: outputSrt,
            metadataPath,
            copyPath,
            coverPath,
            burnedSubtitles: Boolean(mediaResult.burnedSubtitles),
            twoStageMode: mediaResult.twoStageMode || 'copy',
            subtitleSegmentCount: srtResult.segmentCount,
            resourceMode: resourceProfile.mode,
            ffmpegThreads: cutConfig.clipFfmpegThreads,
            subtitleVideoEncoder: mediaResult.subtitleVideoEncoder || cutConfig.subtitleVideoEncoder,
            subtitleHwaccel: cutConfig.subtitleHwaccel || null
        }
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const uploadSource = buildUploadSource(task);
    const recordedAt = formatRecordedAt(task.recordedAt, task.mediaPath);
    fs.writeFileSync(copyPath, [
        `# ${task.title}`,
        '',
        '## 简介', task.description || '',
        '',
        '## 来源', `来源：${uploadSource}`,
        recordedAt ? `直播开始时间：${recordedAt}` : null,
        '',
        '## Tags', profile.tags.join(', '),
        '',
        '## 本地文件', `视频: ${outputVideo}`, `字幕: ${outputSrt}`, `封面: ${coverPath}`,
        ''
    ].join('\n'), 'utf8');
    const result = { output: metadata.output, copy: metadata.copy, window };
    appendReview(task.reviewPath, task, result);
    return result;
}

async function processTask(task, queue, rootConfig, queuePath = defaultQueuePath, resourceScheduler = null) {
    const result = await cutTask(task, rootConfig, resourceScheduler);
    task.outputVideo = result.output.mediaPath;
    task.outputSrt = result.output.srtPath;
    task.coverPath = result.output.coverPath;
    const registry = importJson(result.output.metadataPath, task.reviewPath, task);
    task.uploadIds = registry.clipIds;
    task.cutAt = nowIso();
    task.status = task.autoUpload ? 'pending_upload' : 'pending_review';
    if (task.autoUpload) {
        enqueueIds(task.uploadIds);
        task.status = 'upload_queued';
        task.uploadQueuedAt = nowIso();
    }
    task.updatedAt = nowIso();
    await notifyTask(task, result, rootConfig);
    writeQueue(queuePath, queue);
    return task;
}

async function approveTask(task, queue, rootConfig, queuePath = defaultQueuePath) {
    if (!['pending_review', 'pending_upload'].includes(task.status)) {
        throw new Error(`task ${task.id} is ${task.status}, not awaiting approval`);
    }
    if (!task.uploadIds?.length) throw new Error(`task ${task.id} has no upload IDs`);
    enqueueIds(task.uploadIds);
    task.status = 'upload_queued';
    task.uploadQueuedAt = nowIso();
    task.updatedAt = nowIso();
    writeQueue(queuePath, queue);
    await notifyTask(task, { output: { mediaPath: task.outputVideo } }, rootConfig);
    return task;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const queuePath = path.resolve(options.queue || defaultQueuePath);
    const queue = readQueue(queuePath);
    const rootConfig = configLoader.getConfig();
    if (options.command === 'add') {
        const mediaPath = path.resolve(requireOption(options, 'media'));
        const start = asNumber(requireOption(options, 'start'), 'start');
        const end = asNumber(requireOption(options, 'end'), 'end');
        const outputDir = deriveOutputDir(mediaPath, options.outputDir);
        const outputStem = String(options.outputStem || `manual_${String(queue.nextId).padStart(5, '0')}`);
        const profile = resolveQueueProfile(options.profile);
        const recordedAt = String(options.recordedAt || '').trim();
        const streamTitle = String(options.streamTitle || '').trim();
        const rawTitle = requireOption(options, 'title');
        const title = profile.name === 'old_sui'
            ? normalizeOldSuiTitle(rawTitle, { recordedAt, mediaPath })
            : rawTitle;
        const description = buildProfileDescription(
            profile,
            String(options.description || '').trim(),
            { recordedAt, mediaPath, streamTitle }
        );
        const task = {
            id: `mcq-${String(queue.nextId++).padStart(5, '0')}`,
            createdAt: nowIso(), updatedAt: nowIso(), status: 'pending_cut',
            mediaPath, srtPath: path.resolve(options.srt || deriveSrt(mediaPath)),
            start, end,
            title,
            profile: profile.name,
            description,
            coverText: String(options.coverText || options.title || '').trim(),
            outputDir, outputStem,
            // Keep each task's registry import isolated by default. A shared
            // review is still possible with an explicit --review path.
            reviewPath: path.resolve(options.review || path.join(outputDir, `${outputStem}_REVIEW.md`)),
            roomId: String(options.roomId || '25788785'),
            streamerName: String(options.streamerName || '岁己SUI'),
            streamTitle,
            recordedAt,
            tid: Number(options.tid || 21),
            autoUpload: Boolean(options.autoUpload),
            notify: options.notify !== false
        };
        queue.tasks.push(task);
        writeQueue(queuePath, queue);
        console.log(JSON.stringify(task, null, 2));
        return;
    }
    if (options.command === 'list') {
        for (const task of queue.tasks) console.log(`${task.id}\t${task.status}\t${task.title}`);
        return;
    }
    if (options.command === 'approve') {
        const task = queue.tasks.find(item => item.id === options.id);
        if (!task) throw new Error(`task not found: ${options.id}`);
        await approveTask(task, queue, rootConfig, queuePath);
        console.log(`approved ${task.id}: ${task.status} (${task.uploadIds.join(',')})`);
        return;
    }
    if (options.command === 'worker') {
        const resourceScheduler = createClipResourceAdaptiveScheduler({
            ownConfig: rootConfig.ownStreamClips || {},
            rootConfig
        });
        do {
            const tasks = queue.tasks.filter(task => task.status === 'pending_cut');
            if (!tasks.length) {
                if (!options.loop) {
                    console.log('no pending_cut tasks');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 30000));
                Object.assign(queue, readQueue(queuePath));
                continue;
            }
            const task = tasks[0];
            console.log(`cutting ${task.id}: ${task.title}`);
            await processTask(task, queue, rootConfig, queuePath, resourceScheduler);
            console.log(`done ${task.id}: ${task.status} (${(task.uploadIds || []).join(',')})`);
        } while (options.loop);
        return;
    }
    throw new Error('usage: manual_clip_queue.js add|list|worker|approve <id>');
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    QUEUE_PROFILES,
    resolveQueueProfile,
    formatRecordedDate,
    resolveRecordedDate,
    formatRecordedAt,
    normalizeStreamTitle,
    buildUploadSource,
    normalizeOldSuiTitle,
    buildProfileDescription,
    parseArgs,
    readQueue,
    writeQueue,
    appendReview,
    deriveSrt,
    deriveOutputDir,
    deriveReviewPath,
    buildQueueMediaConfig,
    cutTask,
    processTask
};
