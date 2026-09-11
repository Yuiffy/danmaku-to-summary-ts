#!/usr/bin/env node
const workflowRuntime = require('./workflow-runtime');
if (require.main === module && process.argv[2] === '--check-runtime') {
    console.log(JSON.stringify(workflowRuntime.checkRuntime()));
    process.exit(0);
}
const {
    runCommand,
    getVideoDuration,
    logAsrTimings,
    getGpuUsage,
    execFileAsync,
    getRelevantProcessSnapshot,
    getGpuProcessSnapshot,
    logWhisperResourceSnapshot,
} = workflowRuntime.loadWorkflow('summary/diagnostics');


const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// 导入新模块
const configLoader = require('./config-loader');
const audioProcessor = require('./audio_processor');
const aiTextGenerator = require('./ai_text_generator');
const aiComicGenerator = require('./ai_comic_generator');
const { runComicWithConcurrentClips, resolveComicSourceVideo, automaticComicOptions } = require('./comic/pipeline');
const queueManager = require('./whisper_queue_manager');
const asrBackends = require('./asr/asr_backends');
const topicClipper = require('./topic_clipper');
const ownStreamClipper = require('./own_stream_clipper');
const backgroundClipRunner = require('./background_clip_runner');
const speakerReferenceCatalog = require('./asr/speaker_reference_catalog');
const liveGenerationContext = require('./live_generation_context');
const fullLiveContext = require('./full_live_context');
const liveContentSummary = require('./live_content_summary');

// 获取音频格式配置
function getAudioFormats() {
    const config = configLoader.getConfig();
    const defaultAudioFormats = ['.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac'];
    return config.audio?.formats || config.audioRecording?.audioFormats || defaultAudioFormats;
}

// 获取支持的媒体文件扩展名
function getMediaExtensions() {
    const audioFormats = getAudioFormats();
    const videoExtensions = ['.mp4', '.flv', '.mkv', '.ts', '.mov'];
    return [...videoExtensions, ...audioFormats];
}

const MEDIA_EXTS = getMediaExtensions();

function isMediaFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_EXTS.includes(ext);
}

function isAudioFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const audioFormats = getAudioFormats();
    return audioFormats.includes(ext);
}


// 获取视频时长（秒）

// ASR 文件锁 - 防止并发调用导致 GPU 冲突
const WHISPER_LOCK_FILE = path.join(__dirname, '.whisper_lock');
const WHISPER_LOCK_TIMEOUT = 24 * 60 * 60 * 1000; // 24小时超时(锁文件过期时间)
const WHISPER_LOCK_RETRY_INTERVAL = 10000; // 10秒重试间隔
const WHISPER_MAX_RETRIES = 24 * 60 * 6; // 最多重试 8640 次（24小时）
const WHISPER_PROGRESS_LOG_INTERVAL = 30000; // 每30秒输出一次详细进度
const WHISPER_QUEUE_TURN_RETRY_INTERVAL = 5000; // 5秒检查一次是否轮到当前任务
const ASR_PHASE_DONE_SENTINEL = '[[ASR_PHASE_DONE]]';
const DELAYED_REPLY_READY_SENTINEL = '[[DELAYED_REPLY_READY]]';
const SUI_ROOM_ID = '25788785';

function writeAsrMetaSidecar(srtPath, data) {
    try {
        if (!srtPath || !data) return null;
        const parsed = path.parse(srtPath);
        const metaPath = path.join(parsed.dir, `${parsed.name}.asr_meta.json`);
        fs.writeFileSync(metaPath, JSON.stringify(data, null, 2), 'utf8');
        return metaPath;
    } catch (error) {
        console.warn(`⚠️  写入 ASR meta sidecar 失败: ${error.message}`);
        return null;
    }
}

function parseSpeakerRequestFromEnv() {
    const encoded = String(process.env.ASR_SPEAKER_REQUEST_JSON || '').trim();
    if (!encoded) {
        return null;
    }
    try {
        const raw = Buffer.from(encoded, 'base64').toString('utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn(`⚠️  解析 ASR_SPEAKER_REQUEST_JSON 失败: ${error.message}`);
        return null;
    }
}

function enrichAsrContextWithSpeakerRequest(context = {}, request = null, config = configLoader.getConfig()) {
    if (!request || typeof request !== 'object') {
        return context;
    }
    const participants = Array.isArray(request.participants) ? request.participants : [];
    const referencePreparation = request.referencePreparation && typeof request.referencePreparation === 'object'
        ? request.referencePreparation
        : null;
    const resolvedParticipants = participants.map((participant) => ({
        streamerId: participant.streamerId ? String(participant.streamerId) : null,
        displayName: participant.displayName ? String(participant.displayName) : null,
        role: participant.role ? String(participant.role) : 'participant',
        planned: participant.planned !== false,
        roomIds: Array.isArray(participant.roomIds) ? participant.roomIds.map(value => String(value)).filter(Boolean) : [],
        speakerLabels: Array.isArray(participant.speakerLabels) ? participant.speakerLabels.map(value => String(value)).filter(Boolean) : [],
        aliases: Array.isArray(participant.aliases) ? participant.aliases.map(value => String(value)).filter(Boolean) : [],
        mentionLabels: Array.isArray(participant.mentionLabels) ? participant.mentionLabels.map(value => String(value)).filter(Boolean) : []
    })).filter((participant) => participant.streamerId);
    const constrainedSpeakerReferences = speakerReferenceCatalog.buildSpeakerReferencesForParticipants(
        resolvedParticipants.map((participant) => ({
            id: participant.streamerId,
            displayName: participant.displayName,
            speakerLabels: participant.speakerLabels,
            aliases: participant.aliases
        })),
        config
    );

    return {
        ...context,
        speakerRequest: {
            ...request,
            hostStreamerId: request.hostStreamerId ? String(request.hostStreamerId) : null,
            plannedParticipantIds: Array.isArray(request.plannedParticipantIds)
                ? request.plannedParticipantIds.map(value => String(value)).filter(Boolean)
                : [],
            rosterStreamerIds: Array.isArray(request.rosterStreamerIds)
                ? request.rosterStreamerIds.map(value => String(value)).filter(Boolean)
                : [],
            participants: resolvedParticipants,
            constrainToRoster: request.constrainToRoster !== false,
            referencePreparation,
            constrainedSpeakerReferences
        }
    };
}

let hasLoggedGpuDetectionConfig = false;
let activeWhisperProcess = null;
let whisperCleanupInProgress = null;
let activeWhisperCleanupContext = null;
let whisperSignalHooksInstalled = false;
let activeQueueTaskContext = null;

function getSystemBootTimestamp() {
    return Math.floor(Date.now() - (os.uptime() * 1000));
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function setActiveQueueTask(taskId, mediaPath) {
    if (!taskId) {
        activeQueueTaskContext = null;
        return;
    }

    activeQueueTaskContext = { taskId, mediaPath };
    queueManager.touchTask(taskId);
}

function clearActiveQueueTask(taskId = null) {
    if (!taskId || activeQueueTaskContext?.taskId === taskId) {
        activeQueueTaskContext = null;
    }
}

function getInvalidLockReason(lock) {
    if (!lock || typeof lock !== 'object') {
        return 'invalid lock content';
    }

    if (typeof lock.bootTime === 'number') {
        const currentBootTime = getSystemBootTimestamp();
        const bootTimeDiff = Math.abs(currentBootTime - lock.bootTime);
        if (bootTimeDiff > 5 * 60 * 1000) {
            return 'system reboot detected';
        }
    }

    if (!isProcessAlive(lock.pid)) {
        return `lock holder process not found (PID: ${lock.pid ?? 'unknown'})`;
    }

    if (typeof lock.timestamp !== 'number') {
        return 'lock timestamp missing';
    }

    const age = Date.now() - lock.timestamp;
    if (age > WHISPER_LOCK_TIMEOUT) {
        return `lock expired (${(age / 60000).toFixed(1)} minutes old, PID: ${lock.pid})`;
    }

    return null;
}

/**
 * 通过 nvidia-smi 查询 GPU 占用情况
 * @returns {{ gpuUtil: number, vramUsed: number, vramTotal: number } | null} 返回 null 表示不可用
 */





function waitForChildExit(child, timeoutMs) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.killed) {
            resolve(true);
            return;
        }

        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        const onExit = () => {
            cleanup();
            resolve(true);
        };

        const cleanup = () => {
            clearTimeout(timer);
            child.removeListener('close', onExit);
            child.removeListener('exit', onExit);
        };

        child.once('close', onExit);
        child.once('exit', onExit);
    });
}

async function terminateChildProcessTree(child, label = 'Whisper子进程', gracePeriodMs = 5000) {
    const pid = child?.pid;
    if (!pid) {
        console.warn(`⚠️ ${label} 没有有效 PID，跳过进程树清理`);
        return;
    }

    try {
        console.warn(`🧹 ${label} 开始温和终止，PID=${pid}`);
        child.kill('SIGTERM');
    } catch (error) {
        console.warn(`⚠️ ${label} 发送 SIGTERM 失败，PID=${pid}: ${error.message}`);
    }

    const exitedGracefully = await waitForChildExit(child, gracePeriodMs);
    if (exitedGracefully) {
        console.log(`🧹 ${label} 已在宽限期内退出，PID=${pid}`);
        return;
    }

    try {
        console.warn(`🧹 ${label} 宽限期后仍存活，执行 taskkill /T /F，PID=${pid}`);
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch (error) {
        console.warn(`⚠️ ${label} taskkill 失败，PID=${pid}: ${error.message}`);
    }

    const exitedAfterForce = await waitForChildExit(child, 3000);
    if (exitedAfterForce) {
        console.log(`🧹 ${label} 已强制结束，PID=${pid}`);
    } else {
        console.warn(`⚠️ ${label} 强制结束后仍未确认退出，PID=${pid}`);
    }
}

async function waitForGpuResidueCheck() {
    const attempts = 3;
    for (let i = 1; i <= attempts; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const gpuProcesses = await getGpuProcessSnapshot();
        if (gpuProcesses.length === 0) {
            console.log(`✅ GPU 残留检查通过 (${i}/${attempts})，未检测到计算进程残留`);
            return;
        }
        if (i === attempts) {
            console.warn(`⚠️ gpu_residue_detected: ${gpuProcesses.join(' | ')}`);
        }
    }
}

async function cleanupWhisperProcess(reason = 'unknown') {
    if (whisperCleanupInProgress) {
        return whisperCleanupInProgress;
    }

    whisperCleanupInProgress = (async () => {
        const child = activeWhisperProcess;
        const context = activeWhisperCleanupContext;
        console.log(`🧹 Whisper cleanup begin: reason=${reason}, pid=${child?.pid ?? 'none'}, media=${context?.mediaPath ? path.basename(context.mediaPath) : 'unknown'}`);
        await logWhisperResourceSnapshot(`cleanup-before:${reason}`);

        if (child) {
            await terminateChildProcessTree(child, 'Whisper子进程');
        }

        activeWhisperProcess = null;
        activeWhisperCleanupContext = null;
        await logWhisperResourceSnapshot(`cleanup-after:${reason}`);
        await waitForGpuResidueCheck();
        console.log(`🧹 Whisper cleanup end: reason=${reason}`);
    })();

    try {
        await whisperCleanupInProgress;
    } finally {
        whisperCleanupInProgress = null;
    }
}

function installWhisperSignalHooks() {
    if (whisperSignalHooksInstalled) {
        return;
    }
    whisperSignalHooksInstalled = true;

    const wrapCleanup = (signal, exitCode) => async () => {
        try {
            if (activeQueueTaskContext?.taskId) {
                const interruptedFile = activeQueueTaskContext.mediaPath
                    ? path.basename(activeQueueTaskContext.mediaPath)
                    : activeQueueTaskContext.taskId;
                queueManager.markFailed(activeQueueTaskContext.taskId, `任务被 ${signal} 中止: ${interruptedFile}`);
            }
            await cleanupWhisperProcess(`parent-${signal}`);
        } finally {
            process.exit(exitCode);
        }
    };

    process.on('SIGINT', wrapCleanup('SIGINT', 130));
    process.on('SIGTERM', wrapCleanup('SIGTERM', 143));
    process.on('uncaughtException', async (error) => {
        console.error(`❌ uncaughtException: ${error.stack || error.message}`);
        try {
            await cleanupWhisperProcess('uncaughtException');
        } finally {
            process.exit(1);
        }
    });
    process.on('unhandledRejection', async (reason) => {
        console.error(`❌ unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
        try {
            await cleanupWhisperProcess('unhandledRejection');
        } finally {
            process.exit(1);
        }
    });
}

function logGpuDetectionConfig(config) {
    if (hasLoggedGpuDetectionConfig) {
        return;
    }

    hasLoggedGpuDetectionConfig = true;
    const gpuConfig = config.whisper?.gpuDetection;
    const configPath = configLoader.findConfigPath();

    if (!gpuConfig) {
        console.warn(`⚠️ GPU 检测配置缺失: ${configPath} 中未找到 whisper.gpuDetection，Whisper 将直接启动`);
        return;
    }

    console.log(
        `🧩 GPU 检测配置: file=${configPath}, enabled=${gpuConfig.enabled === true}, ` +
        `gpuUtilThreshold=${gpuConfig.gpuUtilizationThreshold ?? 60}%, ` +
        `vramThreshold=${gpuConfig.vramUsageThreshold ?? 70}%, ` +
        `checkInterval=${gpuConfig.checkIntervalSeconds ?? 30}s`
    );

    if (!gpuConfig.enabled) {
        console.warn('⚠️ GPU 检测已禁用，Whisper 不会因为 GPU 占用而等待');
    }
}

/**
 * 根据配置判断 GPU 是否繁忙
 * @returns {Promise<{ busy: boolean, reason: string }>}
 */
async function isGpuBusy() {
    const config = configLoader.getConfig();
    const gpuConfig = config.whisper?.gpuDetection;
    logGpuDetectionConfig(config);

    if (!gpuConfig?.enabled) {
        return { busy: false, reason: '' };
    }

    const usage = await getGpuUsage();
    if (!usage) {
        console.warn('⚠️ 无法获取 GPU 占用数据（nvidia-smi 不可用或执行失败），跳过 GPU 检测');
        return { busy: false, reason: '' }; // nvidia-smi 不可用，跳过检测
    }

    const { gpuUtil, vramUsed, vramTotal } = usage;
    const vramPct = vramTotal > 0 ? (vramUsed / vramTotal * 100) : 0;
    const utilThreshold = gpuConfig.gpuUtilizationThreshold ?? 60;
    const vramThreshold = gpuConfig.vramUsageThreshold ?? 70;

    const utilBusy = gpuUtil >= utilThreshold;
    const vramBusy = vramPct >= vramThreshold;

    if (utilBusy || vramBusy) {
        const reason = `运算: ${gpuUtil.toFixed(0)}%${utilBusy ? '⚠️' : ''}, 显存: ${vramUsed.toFixed(0)}/${vramTotal.toFixed(0)} MB (${vramPct.toFixed(1)}%)${vramBusy ? '⚠️' : ''}`;
        return { busy: true, reason };
    }

    const info = `运算: ${gpuUtil.toFixed(0)}%, 显存: ${vramUsed.toFixed(0)}/${vramTotal.toFixed(0)} MB (${vramPct.toFixed(1)}%)`;
    return { busy: false, reason: info };
}

async function acquireWhisperLock(taskId = null, options = {}) {
    const { bypassQueueTurn = false } = options;
    const startTime = Date.now();
    let lastProgressLog = 0;
    
    for (let i = 0; i < WHISPER_MAX_RETRIES; i++) {
        if (taskId) {
            queueManager.touchTask(taskId);
        }

        if (!bypassQueueTurn && taskId && !queueManager.isTaskNext(taskId, { reload: true })) {
            const position = queueManager.getPendingPosition(taskId, { reload: true });
            const elapsed = Date.now() - startTime;

            if (elapsed - lastProgressLog >= WHISPER_PROGRESS_LOG_INTERVAL) {
                lastProgressLog = elapsed;
                console.log(`📋 当前任务尚未轮到执行: taskId=${taskId}, queuePosition=${position > 0 ? position : 'unknown'}`);
            }

            await new Promise(r => setTimeout(r, WHISPER_QUEUE_TURN_RETRY_INTERVAL));
            continue;
        }

        try {
            // 尝试创建锁文件
            const fd = fs.openSync(WHISPER_LOCK_FILE, 'wx');
            const lockData = {
                pid: process.pid,
                startTime: new Date().toISOString(),
                bootTime: getSystemBootTimestamp(),
                timestamp: Date.now(),
                videoFile: process.argv[2] ? path.basename(process.argv[2]) : 'unknown'
            };
            fs.writeSync(fd, JSON.stringify(lockData, null, 2));
            fs.closeSync(fd);
            
            const waitTime = ((Date.now() - startTime) / 1000).toFixed(0);
            if (i > 0) {
                console.log(`🔒 获取 ASR 锁成功 (等待了 ${waitTime}秒)`);
            } else {
                console.log('🔒 获取 ASR 锁成功');
            }

            // ── GPU 负载检测：获取到锁后，检查 GPU 是否繁忙 ──
            const config = configLoader.getConfig();
            const gpuCheckIntervalSec = config.whisper?.gpuDetection?.checkIntervalSeconds ?? 30;
            const gpuCheckIntervalMs = gpuCheckIntervalSec * 1000;
            let shouldRetryLock = false;

            // eslint-disable-next-line no-constant-condition
            while (true) {
                console.log('🔍 检测 GPU 负载...');
                const { busy, reason } = await isGpuBusy();
                if (!busy) {
                    if (reason) {
                        console.log(`✅ GPU 空闲 (${reason})，继续启动 ASR`);
                    }
                    break; // GPU 空闲，跳出循环，继续执行
                }
                // GPU 繁忙：释放锁，等待后重试
                releaseWhisperLock();
                console.log(`🎮 GPU 繁忙 (${reason})，ASR 等待 ${gpuCheckIntervalSec} 秒...`);
                await new Promise(r => setTimeout(r, gpuCheckIntervalMs));
                shouldRetryLock = true;
                break;
            }

            if (shouldRetryLock) {
                continue;
            }

            return;
        } catch (error) {
            if (error.code === 'EEXIST') {
                // 检查锁是否过期
                try {
                    const lockContent = fs.readFileSync(WHISPER_LOCK_FILE, 'utf8');
                    const lock = JSON.parse(lockContent);
                    const invalidReason = getInvalidLockReason(lock);

                    if (invalidReason) {
                        console.warn(`??  Invalid lock detected (${invalidReason}), removing...`);
                        fs.unlinkSync(WHISPER_LOCK_FILE);
                        continue; // retry
                    }
                    
                    const elapsed = Date.now() - startTime;
                    const elapsedMinutes = (elapsed / 60000).toFixed(1);
                    const elapsedSeconds = (elapsed / 1000).toFixed(0);
                    
                    // 每10秒输出简短日志
                    console.log(`⏳ 等待 ASR 锁释放... (${elapsedSeconds}s)`);
                    
                    // 每30秒输出详细进度
                    if (elapsed - lastProgressLog >= WHISPER_PROGRESS_LOG_INTERVAL) {
                        lastProgressLog = elapsed;
                        const lockAge = ((Date.now() - lock.timestamp) / 60000).toFixed(1);
                        console.log(`📊 [ASR队列状态]`);
                        console.log(`   当前等待时间: ${elapsedMinutes} 分钟 (${elapsedSeconds}秒)`);
                        console.log(`   当前持锁进程: PID ${lock.pid} (已持有 ${lockAge} 分钟)`);
                        console.log(`   当前处理文件: ${lock.videoFile || '未知'}`);
                        console.log(`   剩余最大等待: ${((WHISPER_MAX_RETRIES - i) * WHISPER_LOCK_RETRY_INTERVAL / 60000).toFixed(1)} 分钟`);
                        console.log(`   💡 提示: 如果您正在玩游戏或使用显存，ASR 会等待显存释放`);
                    }
                } catch (readError) {
                    // 锁文件损坏，删除重试
                    console.warn('⚠️  锁文件损坏，尝试删除...');
                    try {
                        fs.unlinkSync(WHISPER_LOCK_FILE);
                    } catch (e) {
                        // 忽略删除失败
                    }
                }
                
                // 等待后重试
                await new Promise(r => setTimeout(r, WHISPER_LOCK_RETRY_INTERVAL));
            } else {
                throw error;
            }
        }
    }
    
    const totalWaitMinutes = (WHISPER_MAX_RETRIES * WHISPER_LOCK_RETRY_INTERVAL / 60000).toFixed(1);
    throw new Error(`获取 ASR 锁超时 (超过 ${totalWaitMinutes} 分钟)`);
}

function releaseWhisperLock() {
    try {
        if (fs.existsSync(WHISPER_LOCK_FILE)) {
            fs.unlinkSync(WHISPER_LOCK_FILE);
            console.log('🔓 释放 ASR 锁');
        }
    } catch (error) {
        console.warn(`⚠️  释放 ASR 锁时出错: ${error.message}`);
    }
}

// 带重试的命令执行函数
async function runCommandWithRetry(command, args, options = {}, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`尝试执行 (第 ${attempt}/${maxRetries} 次): ${command} ${args.join(' ')}`);
            await runCommand(command, args, options);
            return; // 成功则返回
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                console.warn(`⚠️  第 ${attempt} 次尝试失败: ${error.message}`);
                console.log(`⏳ 等待5秒后进行第 ${attempt + 1} 次尝试...`);
                await new Promise(r => setTimeout(r, 5000)); // 等待5秒后重试
            }
        }
    }
    throw lastError; // 所有重试都失败则抛出错误
}

async function runWhisperWithLifecycle(pythonScript, mediaPath) {
    installWhisperSignalHooks();
    await logWhisperResourceSnapshot('before-spawn');

    return new Promise((resolve, reject) => {
        const child = spawn('python', [pythonScript, mediaPath], {
            env: { ...process.env, PYTHONUTF8: '1' },
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        activeWhisperProcess = child;
        activeWhisperCleanupContext = { mediaPath, pythonScript, startedAt: Date.now() };
        console.log(`🚀 Whisper 子进程已启动: PID=${child.pid}, target=${path.basename(mediaPath)}`);

        child.stdout?.on('data', (data) => {
            process.stdout.write(data);
        });

        child.stderr?.on('data', (data) => {
            process.stderr.write(data);
        });

        child.on('error', async (error) => {
            try {
                await cleanupWhisperProcess(`spawn-error:${error.message}`);
            } catch (cleanupError) {
                console.warn(`⚠️ spawn-error cleanup 失败: ${cleanupError.message}`);
            }
            reject(error);
        });

        child.on('close', async (code, signal) => {
            const abnormal = code !== 0;
            try {
                await cleanupWhisperProcess(abnormal ? `exit-${code ?? 'null'}${signal ? `-${signal}` : ''}` : 'normal-exit');
            } catch (cleanupError) {
                reject(cleanupError);
                return;
            }

            if (abnormal) {
                const error = new Error(`Command failed with exit code ${code}${signal ? ` (signal: ${signal})` : ''}`);
                error.exitCode = code;
                error.signal = signal;
                reject(error);
                return;
            }

            resolve();
        });
    });
}

async function processMedia(mediaPath, taskId = null, options = {}) {
    const dir = path.dirname(mediaPath);
    const nameNoExt = path.basename(mediaPath, path.extname(mediaPath));
    const srtPath = path.join(dir, `${nameNoExt}.srt`);

    const pythonScript = path.join(__dirname, 'python', 'batch_whisper.py');

    if (!fs.existsSync(srtPath)) {
        let mediaDurationSeconds = 0;

        // 检查媒体文件时长，小于30秒则跳过Whisper处理
        try {
            console.log(`🔍 分析媒体文件时长...`);
            const duration = await getVideoDuration(mediaPath);
            mediaDurationSeconds = duration;
            const minDurationSeconds = 30; // 最小媒体文件时长：30秒
            
            if (duration < minDurationSeconds) {
                const fileType = isAudioFile(mediaPath) ? '音频' : '视频';
                console.log(`⏭️  ${fileType}时长过短 (${duration.toFixed(1)}秒 < ${minDurationSeconds}秒)，跳过Whisper处理`);
                return {
                    srtPath: null,
                    completionOptions: {
                        warning: `${fileType}时长过短，跳过Whisper: ${duration.toFixed(1)}秒`
                    }
                };
            }
            
            const minutes = Math.floor(duration / 60);
            const seconds = Math.floor(duration % 60);
            const ms = Math.floor((duration % 1) * 1000);
            console.log(`-> ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`);
        } catch (error) {
            console.warn(`⚠️  获取媒体文件时长失败: ${error.message}，继续处理`);
        }

        const config = configLoader.getConfig();
        const enableSpeakerOnce = String(process.env.ASR_ENABLE_SPEAKER_ONCE || '').toLowerCase() === 'true';
        const speakerRequest = parseSpeakerRequestFromEnv();
        if (enableSpeakerOnce) {
            config.asr = config.asr || {};
            config.asr.paraformer = {
                ...(config.asr.paraformer || {}),
                enable_speaker: true,
                spk_model: config.asr.paraformer?.spk_model || 'cam++',
                speaker_detection_mode: 'always'
            };
            console.log('🎙️  本任务已启用一次性说话人识别（Paraformer + CAM++）');
        }
        const subtitleConfig = asrBackends.getSubtitleConfig(config);
        const context = enrichAsrContextWithSpeakerRequest(options.asrContext || {}, speakerRequest, config);
        const selected = enableSpeakerOnce
            ? { backend: 'paraformer', reason: '一次性说话人识别开关' }
            : options.forceBackend
            ? { backend: options.forceBackend, reason: options.forceReason || `实验模式指定 ${options.forceBackend}` }
            : asrBackends.resolveAsrBackend(config, context, options.asrBackend);
        const proofreading = await require('./asr/subtitle_proofreading').loadProofreadingContext(config, context, mediaPath);
        const asrRuntime = {
            ...asrBackends.resolveAsrHotwords(config, context),
            // 让具体 ASR backend 复用这里已经完成灰度/房间路由的结果，
            // 避免 transcribeParaformer 再次按“直接指定 backend”解析并丢失微调模型覆盖。
            routingContext: context,
            resolvedBackend: selected
        };
        const fileType = isAudioFile(mediaPath) ? 'Audio' : 'Video';
        console.log(`\n-> [ASR] Generating Subtitles (${selected.backend})...`);
        console.log(`   Target: ${path.basename(mediaPath)} (${fileType})`);
        console.log(`   ASR backend: ${selected.backend} (${selected.reason})`);
        if ((asrRuntime.hotwordTokens || []).length > 0) {
            const hotwordLog = asrRuntime.hotwordTokens
                .map(item => item.weight !== undefined ? `${item.word}(${item.weight})` : item.word)
                .join(', ');
            console.log(`   ASR hotwords: ${hotwordLog}`);
        } else if (asrRuntime.hotwords.length > 0) {
            const hotwordLog = asrRuntime.hotwords
                .map(item => item.weight !== undefined ? `${item.word}(${item.weight})` : item.word)
                .join(', ');
            console.log(`   ASR hotwords: ${hotwordLog}`);
        } else {
            console.log('   ASR hotwords: none');
        }
        setActiveQueueTask(taskId, mediaPath);

        try {
            // 获取 ASR 锁，防止 GPU 后端并发调用导致资源冲突。
            await acquireWhisperLock(taskId, options);
            const asrStartTime = Date.now();

            let completedWithCleanupCrash = false;
            let completionWarning = null;
            let asrResult = null;
            let normalized = null;

            try {
                if (selected.backend === 'whisper') {
                    if (!fs.existsSync(pythonScript)) {
                        throw new Error(`Python script not found at: ${pythonScript}`);
                    }
                    await runWhisperWithLifecycle(pythonScript, mediaPath);
                    if (!fs.existsSync(srtPath)) {
                        throw new Error(`Whisper 完成后未找到字幕文件: ${srtPath}`);
                    }
                    asrResult = asrBackends.parseSrt(srtPath, 'whisper');
                } else if (selected.backend === 'sensevoice') {
                    asrResult = await asrBackends.transcribeSenseVoice(mediaPath, config, asrRuntime);
                } else if (selected.backend === 'fun_asr_nano') {
                    asrResult = await asrBackends.transcribeFunAsrNano(mediaPath, config, asrRuntime);
                } else if (selected.backend === 'fun_asr_nano_vllm') {
                    asrResult = await asrBackends.transcribeFunAsrNanoVllm(mediaPath, config, asrRuntime);
                } else if (selected.backend === 'paraformer') {
                    asrResult = await asrBackends.transcribeParaformer(mediaPath, config, asrRuntime);
                } else {
                    throw new Error(`未实现的 ASR backend: ${selected.backend}`);
                }

                const speakerProcessing = asrResult?.speaker_processing || asrResult?.speakerProcessing || null;
                if (speakerProcessing?.timings && asrResult?.timings) {
                    speakerProcessing.timings = {
                        ...speakerProcessing.timings,
                        reference_embedding_s: Number(asrResult.timings.reference_embedding_s || 0)
                    };
                }
                const asrTimingSummary = logAsrTimings(
                    asrResult?.timings,
                    mediaDurationSeconds,
                    speakerProcessing
                );
                normalized = asrBackends.normalizeAsrResult(asrResult, subtitleConfig);
                asrBackends.writeSrt(normalized, srtPath, {
                    ...subtitleConfig,
                    write_evidence: true,
                    proofreading,
                    corrections: asrRuntime.corrections
                });
                asrBackends.writeSpeakerReviewSrt(normalized, srtPath, {
                    ...subtitleConfig,
                    proofreading,
                    corrections: asrRuntime.corrections
                }, config, { ...context, mediaPath });
                asrBackends.writeAsrSpeakersSidecar(normalized, srtPath, config, {
                    ...context,
                    mediaPath
                });
                const asrElapsedSeconds = (Date.now() - asrStartTime) / 1000;
                const selectedBackendOptions = selected.backendOptionsOverride?.[selected.backend] || {};
                const selectedModelProfile = String(selectedBackendOptions.model_profile || config.asr?.paraformer?.model_profile || 'default');
                const selectedFinetunedModel = String(selectedBackendOptions.finetuned_model || config.asr?.gray_rollout?.finetuned_model || config.asr?.paraformer?.finetuned_model || '');
                const selectedModel = selectedModelProfile === 'finetuned'
                    ? (selectedFinetunedModel || config.asr?.paraformer?.model || 'paraformer-zh')
                    : String(config.asr?.paraformer?.base_model || config.asr?.paraformer?.model || 'paraformer-zh');
                const realtimeFactor = mediaDurationSeconds > 0 ? (asrElapsedSeconds / mediaDurationSeconds) : null;
                writeAsrMetaSidecar(srtPath, {
                    backend: normalized.backend,
                    routingReason: selected.reason,
                    modelProfile: selectedModelProfile,
                    model: selectedModel,
                    finetunedModel: selectedFinetunedModel || null,
                    elapsedSeconds: Number(asrElapsedSeconds.toFixed(3)),
                    mediaDurationSeconds: mediaDurationSeconds > 0 ? Number(mediaDurationSeconds.toFixed(3)) : null,
                    realtimeFactor: realtimeFactor === null ? null : Number(realtimeFactor.toFixed(4)),
                    stageTimings: asrResult?.timings || null,
                    timingSummary: asrTimingSummary || null,
                    speakerProcessing,
                    emotionAnalysis: normalized.emotion_analysis || asrResult?.emotion_analysis || asrResult?.emotionAnalysis || null,
                    segments: normalized.segments.length,
                    generatedAt: new Date().toISOString()
                });
                console.log(`✅ ASR完成: backend=${normalized.backend}, segments=${normalized.segments.length}, output=${path.basename(srtPath)}`);
            } catch (error) {
                // 特殊处理：如果进程报错（比如 code 3221226505/0xC0000409），但文件确实生成了，视为可兼容完成
                if (selected.backend === 'whisper' && fs.existsSync(srtPath) && fs.statSync(srtPath).size > 100) {
                    completedWithCleanupCrash = true;
                    completionWarning = `Whisper 进程异常退出但产物有效: ${error.message}`;
                    console.log(`⚠️  Whisper 进程异常退出 (可能在资源释放阶段崩溃)，但检测到有效输出文件，继续后续流程。`);
                    console.log(`⚠️  已标记任务状态: completed_with_cleanup_crash`);
                } else {
                    throw error;
                }
            }
            
            const completionOptions = completedWithCleanupCrash
                ? { status: 'completed_with_cleanup_crash', warning: completionWarning }
                : null;

            return {
                srtPath: fs.existsSync(srtPath) ? srtPath : null,
                speakerReviewSrtPath: fs.existsSync(srtPath) ? path.join(path.dirname(srtPath), `${path.parse(srtPath).name}.speaker.srt`) : null,
                asrResult,
                normalized,
                completionOptions
            };
        } catch (error) {
            throw error;
        } finally {
            await cleanupWhisperProcess('processMedia-finally');
            // 释放锁
            releaseWhisperLock();
            clearActiveQueueTask(taskId);
        }
    } else {
        console.log(`-> [Skip] Subtitle exists: ${path.basename(srtPath)}`);
        clearActiveQueueTask(taskId);
        return {
            srtPath,
            speakerReviewSrtPath: path.join(path.dirname(srtPath), `${path.parse(srtPath).name}.speaker.srt`),
            asrResult: null,
            normalized: null,
            completionOptions: {
                warning: `字幕已存在，跳过Whisper: ${path.basename(srtPath)}`
            }
        };
    }

    return {
        srtPath: fs.existsSync(srtPath) ? srtPath : null,
        speakerReviewSrtPath: fs.existsSync(srtPath) ? path.join(path.dirname(srtPath), `${path.parse(srtPath).name}.speaker.srt`) : null,
        asrResult: null,
        normalized: null,
        completionOptions: null
    };
}

// 音频处理
async function processAudioIfNeeded(mediaPath, roomId = null) {
    console.log('\n🔊 检查音频处理需求...');
    
    try {
        const result = await audioProcessor.processVideoForAudio(mediaPath, roomId);
        if (result) {
            // 新格式: { audioPath, videoPathToDelete }
            const audioPath = result.audioPath || result;
            const videoPathToDelete = result.videoPathToDelete || null;
            console.log(`✅ 音频处理完成，使用音频文件: ${path.basename(audioPath)}`);
            if (videoPathToDelete) {
                console.log(`📋 将在切片完成后删除视频: ${path.basename(videoPathToDelete)}`);
            }
            return { audioPath, videoPathToDelete };
        }
    } catch (error) {
        console.error(`⚠️  音频处理失败: ${error.message}`);
    }
    
    return { audioPath: mediaPath, videoPathToDelete: null };
}

// AI文本生成
async function generateAiText(highlightPath, roomId = null, options = {}) {
    console.log('\n🤖 开始AI文本生成...');
    const combinedReply = await require('./full_reply_workflow').tryGenerateCombinedReply(highlightPath, roomId, options);
    if (combinedReply.handled) return combinedReply.goodnightTextPath;
    
    try {
        const result = await aiTextGenerator.generateGoodnightReply(highlightPath, roomId, options);
        if (result) {
            console.log(`✅ AI文本生成完成: ${path.basename(result)}`);
            return result;
        }
    } catch (error) {
        console.error(`⚠️  AI文本生成失败: ${error.message}`);
    }
    
    return null;
}

async function prepareFullLiveContextForExperiment(options = {}) {
    const {
        highlightPath,
        roomId,
        srtPath,
        xmlPath,
        mediaPath,
        context = {},
        pendingPayload = null
    } = options;
    const config = options.config || configLoader.getConfig();
    const experiment = liveContentSummary.getFullLiveContextExperiment(config, roomId);
    if (!experiment) {
        return null;
    }

    const enabledTasks = Array.isArray(experiment.tasks)
        ? experiment.tasks.map(value => String(value))
        : [];
    if (enabledTasks.length === 0) {
        return null;
    }
    if (!srtPath || !fs.existsSync(srtPath)) {
        throw new Error('全量输入实验缺少 SRT 文件');
    }
    if (!xmlPath || !fs.existsSync(xmlPath)) {
        throw new Error('全量输入实验缺少弹幕 XML 文件');
    }

    const parsed = asrBackends.parseSrt(srtPath, 'full_live_context');
    const danmaku = await ownStreamClipper.parseDanmakuXml(xmlPath);
    const clipConfig = { ...ownStreamClipper.getOwnStreamClipsConfig(config),
        ...((experiment.compactEvidence === true || experiment.replySummary?.enabled === true)
            ? { compactEvidence: true } : {}) };
    const emotionAnalysis = ownStreamClipper.loadEmotionAnalysisForSrt(srtPath);
    const info = ownStreamClipper.parseRecordingInfo(mediaPath || srtPath, {
        ...context,
        roomId: roomId ? String(roomId) : null
    });
    const totalDuration = Number(parsed.segments?.at(-1)?.end || 0);
    const sharedContext = fullLiveContext.buildFullLiveSharedContext({
        parsed,
        danmaku,
        config: clipConfig,
        emotionAnalysis,
        info,
        totalDuration
    });
    const saved = fullLiveContext.saveFullLiveContextSidecar(highlightPath, sharedContext);
    if (pendingPayload) {
        pendingPayload.fullLiveContextPath = saved.outputPath;
    }

    console.log(`🧱 全量直播共享输入已保存: ${path.basename(saved.outputPath)}`);
    console.log(
        `   字幕=${saved.payload.counts.subtitleLines}, `
        + `弹幕=${saved.payload.counts.rawDanmaku}->${saved.payload.counts.mergedDanmaku}, `
        + `prefixChars=${Array.from(saved.payload.sharedPrefix).length}`
    );
    console.log(`   sourceSha256=${saved.payload.sourceSha256}, sharedPrefixSha256=${saved.payload.sharedPrefixSha256}`);
    return {
        experiment,
        enabledTasks,
        outputPath: saved.outputPath,
        payload: saved.payload
    };
}

async function waitForPromiseWithin(promise, timeoutMs) {
    let timeoutHandle;
    const timeout = new Promise(resolve => {
        timeoutHandle = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 1));
    });
    try {
        return await Promise.race([
            Promise.resolve(promise).then(() => true),
            timeout
        ]);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function generateTopicClipsForMedia(originalMediaPath, processedMediaPath, srtPath, roomId = null, context = {}, xmlPath = null) {
    const config = configLoader.getConfig();
    const clipConfig = topicClipper.getClipTopicsConfig(config);
    if (!clipConfig.enabled) {
        return [];
    }

    console.log('\n✂️  开始话题切片检测...');
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
        if (results.length > 0) {
            console.log(`✅ 话题切片完成: ${results.length} 个本地 review 包`);
        } else {
            console.log('ℹ️  话题切片未生成候选');
        }
        return results;
    } catch (error) {
        console.warn(`⚠️  话题切片阶段失败，继续后续流程: ${error.message}`);
        return [];
    }
}

function findXmlForMedia(mediaPath, xmlFiles = []) {
    if (!mediaPath || !Array.isArray(xmlFiles) || xmlFiles.length === 0) {
        return null;
    }
    const mediaDir = path.dirname(mediaPath);
    const mediaBase = path.basename(mediaPath, path.extname(mediaPath));
    const exact = xmlFiles.find(file => (
        path.dirname(file) === mediaDir &&
        path.basename(file, path.extname(file)) === mediaBase
    ));
    if (exact) {
        return exact;
    }
    return xmlFiles.find(file => path.dirname(file) === mediaDir) || null;
}

async function generateOwnStreamClipsForMedia(mediaPath, srtPath, xmlPath, roomId = null, context = {}) {
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

    console.log('\n🎞️  开始岁己直播有趣切片...');
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
            streamerName: context.streamerName || context.streamer_name || null
        });
        if (results.length > 0) {
            console.log(`✅ 岁己直播有趣切片完成: ${results.length} 段`);
        } else {
            console.log('ℹ️  岁己直播有趣切片未生成候选');
        }
        return results;
    } catch (error) {
        console.warn(`⚠️  岁己直播有趣切片阶段失败，继续后续流程: ${error.message}`);
        return [];
    }
}

async function deleteVideoAfterSkippedBackgroundClips(videoPathToDelete) {
    if (!videoPathToDelete) {
        return;
    }

    try {
        const { unlink: unlinkAsync } = require('fs/promises');
        if (fs.existsSync(videoPathToDelete)) {
            await unlinkAsync(videoPathToDelete);
            console.log(`Deleted original video after skipped background clips: ${path.basename(videoPathToDelete)}`);
        }
    } catch (deleteError) {
        console.error(`Failed to delete original video after skipped background clips: ${deleteError.message}`);
    }
}

async function startPendingBackgroundClips(pendingPayloads, reason = 'goodnight-text-ready') {
    if (!Array.isArray(pendingPayloads) || pendingPayloads.length === 0) {
        return;
    }

    console.log(`\nStarting deferred background clips (${pendingPayloads.length}) after ${reason}...`);
    for (const payload of pendingPayloads) {
        try {
            backgroundClipRunner.spawnBackgroundClipProcess(payload);
        } catch (clipSpawnError) {
            console.warn(`Failed to start deferred background clips, skipping clips and continuing: ${clipSpawnError.message}`);
            await deleteVideoAfterSkippedBackgroundClips(payload.videoPathToDelete);
        }
    }
}

// AI漫画生成
async function generateAiComic(highlightPath, roomId = null, options = {}) {
    console.log('\n🎨 开始AI漫画生成...');
    
    try {
        const result = await aiComicGenerator.generateComicFromHighlight(highlightPath, roomId, options);
        if (result) {
            console.log(`✅ AI漫画生成完成: ${path.basename(result)}`);
            return result;
        }
    } catch (error) {
        console.error(`⚠️  AI漫画生成失败: ${error.message}`);
    }
    
    return null;
}

// 触发延迟回复任务（已废弃，现在由 MikufansWebhookHandler 直接调用）
async function triggerDelayedReply(roomId, goodnightTextPath, comicImagePath) {
    console.log(`ℹ️  延迟回复触发已移至父进程，此函数已废弃`);
    console.log(`   房间ID: ${roomId}`);
    console.log(`   晚安回复: ${goodnightTextPath}`);
    console.log(`   漫画: ${comicImagePath}`);
}

// 检查房间是否启用AI功能
function shouldGenerateAiForRoom(roomId) {
    const config = configLoader.getConfig();
    const roomStr = String(roomId);

    // 获取全局默认图片生成配置
    const comicDefaults = config.ai?.comic?.defaults || {};
    const defaultMinDuration = comicDefaults.minDurationMinutes ?? 0;       // 晚安文本生成时默认也生成配图
    const defaultProbability = comicDefaults.generationProbability ?? 1.0;  // 默认 100%

    let roomConfig = null;
    if (config.ai?.roomSettings && config.ai.roomSettings[roomStr]) {
        roomConfig = config.ai.roomSettings[roomStr];
    } else if (config.roomSettings && config.roomSettings[roomStr]) {
        // 兼容旧格式
        roomConfig = config.roomSettings[roomStr];
    }

    if (roomConfig) {
        return {
            text: roomConfig.enableTextGeneration !== false,
            comic: roomConfig.enableComicGeneration !== false,
            minComicDurationMinutes: roomConfig.minComicDurationMinutes ?? defaultMinDuration,
            comicGenerationProbability: roomConfig.comicGenerationProbability ?? defaultProbability,
        };
    }

    // 默认启用所有AI功能、使用全局默认时长和概率
    return {
        text: true,
        comic: true,
        minComicDurationMinutes: defaultMinDuration,
        comicGenerationProbability: defaultProbability,
    };
}

function shouldPreferSpeakerReviewSrtForRoom(roomId, asrResult = null) {
    const config = configLoader.getConfig();
    const roomStr = String(roomId);
    const roomConfig = (config.ai?.roomSettings && config.ai.roomSettings[roomStr])
        || (config.roomSettings && config.roomSettings[roomStr])
        || null;

    if (!roomConfig || roomConfig.preferSpeakerReviewSrtWhenMultipleSpeakers !== true) {
        return false;
    }

    // Anonymous acoustic clusters are still distinct speakers. Keeping their
    // labels lets the summary model distinguish a guest self-introduction from
    // the room owner without forcing an unreliable real-name match.
    return asrBackends.hasMultipleSpeakerLabels(asrResult);
}

// 从文件名提取房间ID
function extractRoomIdFromFilename(filename) {
    // 尝试匹配 "录制-23197314-..." 或 "23197314-..." 格式
    const match = filename.match(/(?:录制-)?(\d+)-/);
    return match ? parseInt(match[1]) : null;
}

function resolveRoomIdForFile(filePath, fallbackRoomId = null) {
    if (fallbackRoomId) {
        return fallbackRoomId;
    }

    const extractedRoomId = extractRoomIdFromFilename(path.basename(filePath));
    if (extractedRoomId) {
        console.log(`🔍 从文件名提取房间ID: ${extractedRoomId}`);
        return extractedRoomId;
    }

    console.warn(`⚠️  无法从文件名提取房间ID: ${path.basename(filePath)}`);
    return null;
}

function buildAsrRoutingContext(filePath, roomId = null) {
    const config = configLoader.getConfig();
    const roomKey = roomId ? String(roomId) : null;
    const roomConfig = roomKey
        ? (config.ai?.roomSettings?.[roomKey] || config.roomSettings?.[roomKey] || null)
        : null;
    const anchor = roomKey
        ? Object.values(config.bilibili?.anchors || {}).find(item => String(item.roomId || item.uid || '') === roomKey)
        : null;

    return {
        room_id: roomKey,
        channel_id: roomKey,
        uid: anchor?.uid || null,
        streamer_name: roomConfig?.anchorName || anchor?.name || null,
        filename: path.basename(filePath)
    };
}

function shouldBypassQueueTurn(inputPaths) {
    if (String(process.env.BYPASS_WHISPER_QUEUE || '').toLowerCase() === 'true') {
        return true;
    }

    if (process.env.ROOM_ID) {
        return false;
    }

    return inputPaths.length === 1;
}

async function runAsrCompare(mediaPath, taskId, options) {
    const backends = options.asrCompare;
    if (!backends || backends.length === 0) {
        return null;
    }

    const dir = path.dirname(mediaPath);
    const nameNoExt = path.basename(mediaPath, path.extname(mediaPath));
    const originalSrtPath = path.join(dir, `${nameNoExt}.srt`);
    const results = [];

    console.log(`🧪 ASR compare mode: ${backends.join(', ')}`);
    for (const backend of backends) {
        const backendSrtPath = path.join(dir, `${nameNoExt}.${backend}.srt`);
        if (fs.existsSync(originalSrtPath)) {
            fs.renameSync(originalSrtPath, `${originalSrtPath}.compare-bak-${Date.now()}`);
        }

        const mediaResult = await processMedia(mediaPath, taskId, {
            ...options,
            forceBackend: backend,
            forceReason: `compare 模式 backend=${backend}`
        });

        if (!mediaResult?.srtPath || !fs.existsSync(mediaResult.srtPath)) {
            throw new Error(`compare 模式未生成字幕: backend=${backend}`);
        }
        if (fs.existsSync(backendSrtPath)) {
            fs.unlinkSync(backendSrtPath);
        }
        fs.renameSync(mediaResult.srtPath, backendSrtPath);
        const parsed = asrBackends.parseSrt(backendSrtPath, backend);
        results.push({
            backend,
            srt_path: backendSrtPath,
            segment_count: parsed.segments.length
        });
    }

    const comparePath = path.join(dir, `${nameNoExt}.compare.json`);
    fs.writeFileSync(comparePath, JSON.stringify({
        input: mediaPath,
        results
    }, null, 2), 'utf8');

    console.log(`🧪 compare 输出: ${path.basename(comparePath)}`);
    return {
        srtPath: results[0]?.srt_path || null,
        completionOptions: {
            warning: `ASR compare 模式已输出: ${path.basename(comparePath)}`
        }
    };
}

const main = async () => {
    const parsedArgs = asrBackends.parseCliArgs(process.argv.slice(2));
    const inputPaths = parsedArgs.inputPaths;
    const cliOptions = parsedArgs.options;

    if (inputPaths.length === 0) {
        console.error('X Error: No files detected! Please drag files onto the icon.');
        process.exit(1);
    }

    const envRoomId = process.env.ROOM_ID ? parseInt(process.env.ROOM_ID) : null;
    const bypassQueueTurn = shouldBypassQueueTurn(inputPaths);

    console.log('===========================================');
    console.log('      Live Summary 增强版自动化工厂       ');
    console.log('      (支持音频处理 + AI生成)             ');
    console.log('===========================================');
    if (bypassQueueTurn) {
        console.log('⚡ 当前为手动单文件执行，跳过队列轮转检查，仅保留 ASR 互斥锁');
    }
    if (cliOptions.asrBackend) {
        console.log(`🎚️  ASR backend CLI override: ${cliOptions.asrBackend}`);
    }
    if (cliOptions.asrCompare) {
        console.log(`🧪 ASR compare enabled: ${cliOptions.asrCompare.join(', ')}`);
    }

    // 恢复中断的任务
    queueManager.recoverInterruptedTasks();
    
    // 显示队列状态
    queueManager.printStatus();

    const mediaFiles = [];
    const xmlFiles = [];
    const filesToProcess = [];
    const fileSnapshots = new Map();  // 用于记录文件快照

    console.log('-> Analyzing input files...');

    inputPaths.forEach(filePath => {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const fileName = path.basename(filePath);

            if (isMediaFile(filePath)) {
                const fileType = isAudioFile(filePath) ? 'Audio' : 'Video';
                console.log(`   [${fileType}] Found: ${fileName}`);
                mediaFiles.push(filePath);
            } else if (ext === '.xml') {
                console.log(`   [XML]   Found: ${fileName}`);
                xmlFiles.push(filePath);
                filesToProcess.push(filePath);
            } else if (ext === '.srt') {
                console.log(`   [SRT]   Found: ${fileName}`);
                filesToProcess.push(filePath);
            }
        }
    });

    // 处理媒体文件（音频处理 + ASR）
    const processedMediaFiles = [];
    const queueTaskRecords = [];
    const completionOptionsByTaskId = new Map();
    const pendingBackgroundClipPayloads = [];
    let backgroundClipsStarted = false;
    const startBackgroundClipsOnce = async (reason) => {
        if (backgroundClipsStarted) {
            return;
        }
        backgroundClipsStarted = true;
        await startPendingBackgroundClips(pendingBackgroundClipPayloads, reason);
    };
    for (const mediaFile of mediaFiles) {
        console.log(`\n--- 处理媒体文件: ${path.basename(mediaFile)} ---`);
        const mediaRoomId = resolveRoomIdForFile(mediaFile, envRoomId);
        
        // 添加任务到队列
        const task = queueManager.addTask(mediaFile, mediaRoomId, {
            trackOwnershipWhilePending: !bypassQueueTurn
        });

        if (task?.id) {
            queueManager.markProcessing(task.id);
            setActiveQueueTask(task.id, mediaFile);
            queueTaskRecords.push({ id: task.id, mediaPath: mediaFile });
        }
        
        // 1. 音频处理（如果需要）— 只转换不删除，切片后再删
        let processedResult;
        try {
            processedResult = await processAudioIfNeeded(mediaFile, mediaRoomId);
        } catch (error) {
            if (task?.id) {
                queueManager.markFailed(task.id, error.message);
            }
            throw error;
        }
        const processedFile = processedResult.audioPath;
        let videoToDeleteAfterClips = processedResult.videoPathToDelete;
        queueManager.updateTaskMediaPath(task.id, processedFile);
        if (task?.id) {
            setActiveQueueTask(task.id, processedFile);
        }
        
        // 2. ASR生成字幕（传递 taskId）
        let mediaResult;
        let asrContext = null;
        let asrOptions = null;
        try {
            asrContext = { ...buildAsrRoutingContext(processedFile, mediaRoomId), xmlPath: findXmlForMedia(mediaFile, xmlFiles) };
            asrOptions = {
                bypassQueueTurn,
                asrBackend: cliOptions.asrBackend,
                asrCompare: cliOptions.asrCompare,
                asrContext
            };
            mediaResult = cliOptions.asrCompare
                ? await runAsrCompare(processedFile, task.id, asrOptions)
                : await processMedia(processedFile, task.id, asrOptions);
            console.log(`${ASR_PHASE_DONE_SENTINEL} taskId=${task.id} media=${path.basename(processedFile)}`);
        } catch (error) {
            if (task?.id) {
                queueManager.markFailed(task.id, error.message);
                clearActiveQueueTask(task.id);
            }
            throw error;
        }

        if (mediaResult?.completionOptions && task?.id) {
            completionOptionsByTaskId.set(task.id, mediaResult.completionOptions);
        }

        const srtPath = mediaResult?.srtPath || null;
        const speakerReviewSrtPath = mediaResult?.speakerReviewSrtPath || null;
        const preferredSrtPath = shouldPreferSpeakerReviewSrtForRoom(mediaRoomId, mediaResult?.asrResult)
            ? (speakerReviewSrtPath || srtPath)
            : srtPath;
        
        if (preferredSrtPath) {
            const clipContext = {
                ...(asrOptions.asrContext || {}),
                streamerName: asrOptions.asrContext?.streamer_name || null
            };
            const xmlPathForMedia = findXmlForMedia(mediaFile, xmlFiles);
            if (backgroundClipRunner.shouldRunAnyClipper(mediaRoomId, xmlPathForMedia)) {
                pendingBackgroundClipPayloads.push({
                    originalMediaPath: mediaFile,
                    processedMediaPath: processedFile,
                    srtPath: preferredSrtPath,
                    xmlPath: xmlPathForMedia,
                    roomId: mediaRoomId ? String(mediaRoomId) : null,
                    context: clipContext,
                    videoPathToDelete: videoToDeleteAfterClips
                });
                videoToDeleteAfterClips = null;
                console.log(`Deferred background clips until goodnight text is ready: ${path.basename(preferredSrtPath)}`);
            }
            processedMediaFiles.push(processedFile); // 记录处理后的文件
            filesToProcess.push(preferredSrtPath);
        }

        // 切片完成后删除原始视频（音频专用房间 & keepOriginalVideo=false）
        if (videoToDeleteAfterClips) {
            try {
                const { unlink: unlinkAsync } = require('fs/promises');
                await unlinkAsync(videoToDeleteAfterClips);
                console.log(`🗑️  切片完成，已删除原始视频: ${path.basename(videoToDeleteAfterClips)}`);
            } catch (deleteError) {
                console.error(`⚠️  删除原始视频失败: ${deleteError.message}`);
            }
        }
    }

    console.log('\n--------------------------------------------');

    // 在处理开始前记录文件列表快照，用于后续过滤本次生成的文件
    if (filesToProcess.length > 0) {
        const outputDir = path.dirname(filesToProcess[0]);
        try {
            const existingFiles = fs.readdirSync(outputDir);
            existingFiles.forEach(file => {
                const filePath = path.join(outputDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    fileSnapshots.set(file, stats.mtimeMs);
                } catch (e) {
                    fileSnapshots.set(file, 0);
                }
            });
        } catch (e) {
            // 忽略错误
        }
    }

    // Node.js Fusion（弹幕融合）
    let generatedHighlightFile = null;
    let outputDir = null;
    
    if (filesToProcess.length === 0) {
        console.log('X Warning: No valid SRT or XML files to process.');
    } else {
        console.log('-> [Fusion] Merging Subtitles and Danmaku...');

        const nodeScript = path.join(__dirname, 'do_fusion_summary.js');

        // 获取输出目录
        outputDir = path.dirname(filesToProcess[0]);

        if (!fs.existsSync(nodeScript)) {
            console.error(`X Error: Node.js script not found at: ${nodeScript}`);
        } else {
            // 获取输出目录和基础名称
            const baseName = path.basename(filesToProcess[0])
                .replace(/\.speaker$/i, '')
                .replace(/\.(srt|xml|mp4|flv|mkv)$/i, '')
                .replace(/_fix$/, '');
            generatedHighlightFile = path.join(outputDir, `${baseName}_AI_HIGHLIGHT.txt`);
            
            try {
                await runCommandWithRetry('node', [nodeScript, ...filesToProcess], {}, 2);
            } catch (error) {
                console.error(`❌ Fusion处理失败（经过重试）: ${error.message}`);
                // 继续处理而不中断，因为可能已经部分生成了数据
            }
        }
    }

    // AI生成阶段
    console.log('\n--------------------------------------------');
    console.log('-> [AI Generation] Starting AI content generation...');
    
    try {
        // 使用 do_fusion_summary 生成的文件
        if (generatedHighlightFile && fs.existsSync(generatedHighlightFile)) {
            const highlightPath = generatedHighlightFile;
            const highlightFile = path.basename(highlightPath);
            // 优先使用环境变量中的 roomId，如果没有再从文件名提取
            const finalRoomId = envRoomId || extractRoomIdFromFilename(highlightFile);
            
            console.log(`📌 处理 do_fusion_summary 生成的文件: ${highlightFile}`);
            console.log(`\n--- 处理: ${highlightFile} ---`);
            
            // 检查AI_HIGHLIGHT文件大小，小于0.5KB则跳过AI生成
            const highlightStats = fs.statSync(highlightPath);
            const highlightSizeKB = highlightStats.size / 1024;
            const minHighlightSizeKB = 0.5; // 最小AI_HIGHLIGHT文件大小：0.5KB
            
            console.log(`📊 AI_HIGHLIGHT文件大小: ${highlightSizeKB.toFixed(2)}KB`);
            
            if (highlightSizeKB < minHighlightSizeKB) {
                const fullInputExperiment = liveContentSummary.getFullLiveContextExperiment(
                    configLoader.getConfig(),
                    finalRoomId
                );
                if (!fullInputExperiment) {
                    console.log(`⏭️  AI_HIGHLIGHT文件过小 (${highlightSizeKB.toFixed(2)}KB < ${minHighlightSizeKB}KB)，跳过AI生成`);
                    await startBackgroundClipsOnce('highlight-too-small');
                    return;
                }
                console.log(
                    `🧪 AI_HIGHLIGHT虽小 (${highlightSizeKB.toFixed(2)}KB)，`
                    + '但本房间启用了全量输入实验，继续从完整 SRT + 弹幕构建任务'
                );
            }
            
            // 检查视频时长（从SRT文件获取）
            // In single-file (webhook) path, mediaResult may not be defined;
            // fall back to checking room config directly.
            const preferSpeakerSrt = (typeof mediaResult !== 'undefined' && mediaResult?.asrResult)
                ? shouldPreferSpeakerReviewSrtForRoom(finalRoomId, mediaResult.asrResult)
                : shouldPreferSpeakerReviewSrtForRoom(finalRoomId, null);
            const srtFile = preferSpeakerSrt
                ? (filesToProcess.find(f => f.endsWith('.speaker.srt')) || filesToProcess.find(f => f.endsWith('.srt')))
                : filesToProcess.find(f => f.endsWith('.srt'));
            if (srtFile && fs.existsSync(srtFile)) {
                const srtContent = fs.readFileSync(srtFile, 'utf8');
                const timeMatches = srtContent.match(/\d{2}:\d{2}:\d{2},\d{3}/g);
                if (timeMatches && timeMatches.length > 0) {
                    const lastTimeStr = timeMatches[timeMatches.length - 1];
                    const [h, m, sWithMs] = lastTimeStr.split(':');
                    const s = sWithMs.split(',')[0]; // 取秒数部分，去掉毫秒
                    const totalSeconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
                    const minDurationSeconds = 30; // 最小视频时长：30秒
                    
                    console.log(`⏱️  视频时长: ${totalSeconds}秒`);
                    
                    if (totalSeconds < minDurationSeconds) {
                        console.log(`⏭️  视频时长过短 (${totalSeconds}秒 < ${minDurationSeconds}秒)，跳过AI生成`);
                        await startBackgroundClipsOnce('media-too-short');
                        return;
                    }
                }
            }
            
            // 检查房间AI设置
            const aiSettings = finalRoomId ? shouldGenerateAiForRoom(finalRoomId) : {
                text: true, comic: true,
                minComicDurationMinutes: 60,
                comicGenerationProbability: 1.0
            };
            
            console.log(`🏠 房间ID: ${finalRoomId}`);
            console.log(`   AI文本生成: ${aiSettings.text ? '启用' : '禁用'}`);
            console.log(`   AI漫画生成: ${aiSettings.comic ? '启用' : '禁用'}`);
            const generationMode = configLoader.getConfig().ai?.roomSettings?.[String(finalRoomId)]?.generationMode;
            if (generationMode) console.log(`[GENERATION_MODE] ${JSON.stringify({roomId:finalRoomId,mode:generationMode})}`);
            console.log(`   图片最短时长: ${aiSettings.minComicDurationMinutes} 分钟`);
            console.log(`   图片生成概率: ${(aiSettings.comicGenerationProbability * 100).toFixed(0)}%`);

            const normalizedSrtPath = srtFile ? path.normalize(srtFile) : null;
            const fullInputPayload = pendingBackgroundClipPayloads.find(payload => (
                String(payload.roomId || '') === String(finalRoomId || '')
                && normalizedSrtPath
                && path.normalize(payload.srtPath || '') === normalizedSrtPath
            )) || pendingBackgroundClipPayloads.find(payload => (
                String(payload.roomId || '') === String(finalRoomId || '')
            )) || null;
            const fullInputMediaPath = fullInputPayload?.originalMediaPath
                || mediaFiles[mediaFiles.length - 1]
                || processedMediaFiles[processedMediaFiles.length - 1]
                || srtFile;
            const fullInputXmlPath = fullInputPayload?.xmlPath
                || (fullInputMediaPath ? findXmlForMedia(fullInputMediaPath, xmlFiles) : null)
                || xmlFiles.find(file => !srtFile || path.dirname(file) === path.dirname(srtFile))
                || null;
            let preparedFullLiveContext = null;
            try {
                preparedFullLiveContext = await prepareFullLiveContextForExperiment({
                    highlightPath,
                    roomId: finalRoomId,
                    srtPath: srtFile,
                    xmlPath: fullInputXmlPath,
                    mediaPath: fullInputMediaPath,
                    context: fullInputPayload?.context || {},
                    pendingPayload: fullInputPayload,
                    config: configLoader.getConfig()
                });
            } catch (error) {
                console.warn(`⚠️  准备全量直播共享输入失败，实验任务降级且不影响原流程: ${error.message}`);
            }

            try {
                const preparedContext = await liveGenerationContext.prepareLiveGenerationContext(
                    highlightPath,
                    finalRoomId,
                    configLoader.getConfig(), { srtPath: srtFile }
                );
                const liveContext = preparedContext.context;
                console.log(`🧭 本场事实上下文已保存: ${path.basename(preparedContext.outputPath)}`);
                console.log(`   直播标题: ${liveContext.liveTitle || '未取得'}`);
                console.log(`   开播前近期动态: ${liveContext.recentDynamics.length} 条 (${liveContext.sources.recentDynamics})`);
                console.log(`   下播动态上下文: ${liveContext.replyDynamic?.id || '未采用'} (${liveContext.sources.replyDynamic})`);
                if (liveContext.recentDynamicsError) {
                    console.warn(`   ⚠️ 近期动态获取失败，已降级为标题上下文: ${liveContext.recentDynamicsError}`);
                }
            } catch (error) {
                console.warn(`⚠️  准备本场事实上下文失败，将由生成器从文件名降级解析: ${error.message}`);
            }
            
            // AI文本生成
            let goodnightTextPath = null;
            if (aiSettings.text) {
                console.log(`📝 开始AI文本生成...`);
                const useFullInputForGoodnight = liveContentSummary.isExperimentTaskEnabled(
                    preparedFullLiveContext?.experiment,
                    'goodnight'
                );
                goodnightTextPath = await generateAiText(highlightPath, finalRoomId, useFullInputForGoodnight
                    ? {
                        fullLiveContextPath: preparedFullLiveContext.outputPath,
                        promptCacheRolloutPercent: preparedFullLiveContext.experiment.promptCacheRolloutPercent
                    }
                    : {});
                console.log(`📝 AI文本生成结果: ${goodnightTextPath || 'null'}`);
            } else {
                console.log('ℹ️  跳过AI文本生成（房间设置禁用）');
            }

            const liveContentSummaryEnabled = liveContentSummary.isExperimentTaskEnabled(
                preparedFullLiveContext?.experiment,
                'summary'
            );
            const liveContentSummaryPath = liveContentSummaryEnabled
                ? liveContentSummary.getLiveContentSummaryPath(highlightPath)
                : null;
            const liveContentSummaryDeliveryMode = liveContentSummaryEnabled
                ? liveContentSummary.getSummaryDeliveryMode(preparedFullLiveContext.experiment)
                : null;
            const cachePropagationWaitMs = liveContentSummary.getCachePropagationWaitMs(
                preparedFullLiveContext?.experiment
            );
            if (goodnightTextPath && cachePropagationWaitMs > 0) {
                console.log(
                    `⏳ 等待 ${cachePropagationWaitMs}ms 让晚安请求建立的共享前缀缓存传播，`
                    + '再启动直播梗概与后续生成任务'
                );
                await new Promise(resolve => setTimeout(resolve, cachePropagationWaitMs));
            }
            let delayedReplyReadyEmitted = false;

            const emitDelayedReplyReady = (comicImagePathForReply = null) => {
                if (!goodnightTextPath) {
                    return;
                }

                const payload = {
                    roomId: finalRoomId,
                    goodnightTextPath,
                    mediaPath: processedMediaFiles.length > 0 ? processedMediaFiles[processedMediaFiles.length - 1] : undefined
                };
                if (comicImagePathForReply) {
                    payload.comicImagePath = comicImagePathForReply;
                }
                if (liveContentSummaryPath) {
                    payload.liveContentSummaryPath = liveContentSummaryPath;
                    payload.liveContentSummaryDeliveryMode = liveContentSummaryDeliveryMode;
                }

                delayedReplyReadyEmitted = true;
                console.log(`${DELAYED_REPLY_READY_SENTINEL} ${JSON.stringify(payload)}`);
            };

            const liveContentSummaryPromise = liveContentSummaryEnabled
                ? liveContentSummary.generateLiveContentSummary({
                    highlightPath,
                    fullLiveContextPath: preparedFullLiveContext.outputPath,
                    roomId: finalRoomId,
                    experiment: preparedFullLiveContext.experiment,
                    config: configLoader.getConfig()
                }).catch(error => {
                    console.warn(`⚠️  直播梗概实验失败，不影响晚安、漫画或切片: ${error.message}`);
                    return null;
                })
                : null;
            let liveContentSummaryWarmupAttempted = false;
            const waitForLiveContentCacheWarmup = async () => {
                if (
                    !liveContentSummaryPromise
                    || liveContentSummaryDeliveryMode !== 'separate'
                    || liveContentSummaryWarmupAttempted
                ) {
                    return;
                }
                liveContentSummaryWarmupAttempted = true;
                const warmupWaitMs = Number(preparedFullLiveContext.experiment.cacheWarmupWaitMs) || 45000;
                const completed = await waitForPromiseWithin(liveContentSummaryPromise, warmupWaitMs);
                if (!completed) {
                    console.warn(
                        `⚠️  直播梗概在 ${Math.round(warmupWaitMs / 1000)} 秒缓存预热窗口内未完成，`
                        + '继续漫画与自动切片；梗概完成后仍会由延迟回复任务发布'
                    );
                }
            };

            // AI漫画生成
            let comicImagePath = null;
            const highlightDir = path.dirname(highlightPath);
            const highlightBase = path.basename(highlightPath).replace('_AI_HIGHLIGHT.txt', '');
            const expectedComicImagePath = path.join(highlightDir, `${highlightBase}_COMIC_FACTORY.png`);
            if (aiSettings.comic) {
                // --- 检查图片生成条件 ---

                // 1. 检查直播时长是否达到阈值
                let durationMinutes = null;
                if (srtFile && fs.existsSync(srtFile)) {
                    try {
                        const srtContent = fs.readFileSync(srtFile, 'utf8');
                        const timeMatches = srtContent.match(/\d{2}:\d{2}:\d{2},\d{3}/g);
                        if (timeMatches && timeMatches.length > 0) {
                            const lastTimeStr = timeMatches[timeMatches.length - 1];
                            const [h, m, sWithMs] = lastTimeStr.split(':');
                            const sv = parseInt(sWithMs.split(',')[0]); // 取秒数部分，去掉毫秒
                            durationMinutes = (parseInt(h) * 3600 + parseInt(m) * 60 + sv) / 60;
                        }
                    } catch (e) {
                        console.warn(`⚠️  读取SRT时长失败: ${e.message}`);
                    }
                }

                const minDur = aiSettings.minComicDurationMinutes;
                if (durationMinutes !== null && durationMinutes < minDur) {
                    console.log(`⏭️  直播时长过短 (${durationMinutes.toFixed(1)}分钟 < 阈值 ${minDur}分钟)，跳过图片生成`);
                } else {
                    // 2. 概率抽样
                    const prob = aiSettings.comicGenerationProbability;
                    const roll = Math.random();
                    if (roll > prob) {
                        console.log(`🎲 概率抓取未命中 (${roll.toFixed(3)} > ${prob})，跳过图片生成`);
                    } else {
                        emitDelayedReplyReady(expectedComicImagePath);
                        console.log(`🎲 概率抓取命中 (${roll.toFixed(3)} ≤ ${prob})，开始生成图片`);
                        console.log(`🎨 开始AI漫画生成...`);
                        const imageOptions = automaticComicOptions(finalRoomId);
                        const sourceVideoPath = resolveComicSourceVideo(mediaFiles, highlightPath, isAudioFile);
                        comicImagePath = await runComicWithConcurrentClips({
                            sourceVideoPath,
                            tempRoot: path.resolve(__dirname, '../../tmp/comic-source-reads'),
                            overlapEnabled: pendingBackgroundClipPayloads.length > 0
                                && configLoader.getConfig().ai?.comic?.overlapClips === true,
                            startClips: startBackgroundClipsOnce,
                            onSchedule: timing => console.log(`[COMIC_CLIP_SCHEDULE] ${JSON.stringify({ roomId: finalRoomId, recording: highlightFile, ...timing })}`),
                            prepareComic: async () => {
                                await waitForLiveContentCacheWarmup();
                                if (liveContentSummaryPromise && liveContentSummaryEnabled) {
                                    console.log('⏳ 等待同场直播梗概完成，再启动漫画生成，确保游戏名和活动类型进入漫画事实约束');
                                    await liveContentSummaryPromise;
                                }
                            },
                            generateComic: sourceOptions => generateAiComic(highlightPath, finalRoomId, {
                                ...imageOptions, ...sourceOptions,
                                ...(liveContentSummary.isExperimentTaskEnabled(preparedFullLiveContext?.experiment, 'comic')
                                    ? { fullLiveContextPath: preparedFullLiveContext.outputPath } : {})
                            })
                        });
                        console.log(`🎨 AI漫画生成结果: ${comicImagePath || 'null'}`);
                    }
                }
            } else {
                console.log('ℹ️  跳过AI漫画生成（房间设置禁用）');
            }

            if (goodnightTextPath && !delayedReplyReadyEmitted) {
                emitDelayedReplyReady();
            }

            await waitForLiveContentCacheWarmup();
            await startBackgroundClipsOnce(aiSettings.comic ? 'comic-generation-finished' : 'comic-disabled');

            if (liveContentSummaryPromise) {
                await liveContentSummaryPromise;
            }

            // 触发延迟回复任务（现在由父进程 MikufansWebhookHandler 处理）
            console.log(`🔍 延迟回复将由父进程处理: roomId=${finalRoomId}, goodnightTextPath=${goodnightTextPath}, comicImagePath=${comicImagePath}`);
        } else {
            console.log('⚠️  未找到 do_fusion_summary 生成的 AI_HIGHLIGHT 文件');
            console.log(`   generatedHighlightFile: ${generatedHighlightFile}`);
            console.log(`   exists: ${generatedHighlightFile ? fs.existsSync(generatedHighlightFile) : 'N/A'}`);
        }
    } catch (error) {
        console.error(`⚠️  AI生成阶段出错: ${error.message}`);
        console.error(error.stack);
    }

    await startBackgroundClipsOnce('ai-generation-finished');

    console.log('');
    console.log('===========================================');
    console.log('       所有任务完成！                      ');
    console.log('===========================================');
    
    if (filesToProcess.length > 0) {
        console.log(`输出目录: ${outputDir}`);
        
        // 列出生成的文件（只显示本次新生成的文件）
        try {
            const files = fs.readdirSync(outputDir);
            const now = Date.now();
            // 过滤出本次会话新生成的文件（包括本次创建的AI_HIGHLIGHT文件）
            const generatedFiles = files.filter(f => {
                const filePath = path.join(outputDir, f);
                try {
                    const stats = fs.statSync(filePath);
                    // 如果文件在快照中不存在，或者修改时间在快照之后，则是新生成的文件
                    const originalMtime = fileSnapshots.get(f) || 0;
                    // 5分钟内的文件视为本次生成的（容忍时间差）
                    const isNew = stats.mtimeMs > originalMtime || (now - stats.mtimeMs < 300000);
                    // 只显示AI相关的文件
                    const isAiFile = f.includes('_晚安回复.md') ||
                                   f.includes('_COMIC_FACTORY.') ||
                                   f.includes('_AI_HIGHLIGHT.txt') ||
                                   f.includes('_FULL_LIVE_CONTEXT.json') ||
                                   f.includes('_LIVE_CONTENT.json');
                    return isAiFile && isNew;
                } catch (e) {
                    return false;
                }
            });
            
            if (generatedFiles.length > 0) {
                console.log('\n📁 本次生成的文件:');
                generatedFiles.forEach(file => {
                    const filePath = path.join(outputDir, file);
                    const stats = fs.statSync(filePath);
                    const size = (stats.size / 1024).toFixed(1);
                    const mtime = new Date(stats.mtimeMs).toLocaleTimeString();
                    console.log(`   ${file} (${size}KB) [${mtime}]`);
                });
            }
        } catch (error) {
            // 忽略文件列表错误
        }
    }

    // 检查是否在自动化模式（支持 NODE_ENV、CI 和 AUTOMATION 环境变量）
    if (process.env.NODE_ENV === 'automation' || process.env.CI || process.env.AUTOMATION === 'true') {
        for (const taskRecord of queueTaskRecords) {
            const completionOptions = completionOptionsByTaskId.get(taskRecord.id) || {};
            queueManager.markCompleted(taskRecord.id, completionOptions);
            clearActiveQueueTask(taskRecord.id);
        }
        process.exit(0);
    } else {
        for (const taskRecord of queueTaskRecords) {
            const completionOptions = completionOptionsByTaskId.get(taskRecord.id) || {};
            queueManager.markCompleted(taskRecord.id, completionOptions);
            clearActiveQueueTask(taskRecord.id);
        }
        // 交互模式，等待用户
        console.log('\n按Enter键关闭...');
        process.stdin.resume();
        process.stdin.on('data', () => {
            process.exit(0);
        });
    }
}

(async () => {
    await main();
})();
