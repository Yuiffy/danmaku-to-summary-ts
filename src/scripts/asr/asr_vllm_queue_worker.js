#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const QUEUE_DIR = path.join(process.cwd(), 'tmp', 'asr-vllm-queue');
const TASKS_FILE = path.join(QUEUE_DIR, 'tasks.json');
const STATE_FILE = path.join(QUEUE_DIR, 'state.json');
const PYTHON_WORKER = path.join(__dirname, '..', 'python', 'fun_asr_nano_vllm_worker.py');

function ensureQueueDir() {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    ensureQueueDir();
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

function loadTasks() {
    const data = readJson(TASKS_FILE, { tasks: [] });
    return Array.isArray(data.tasks) ? data.tasks : [];
}

function saveTasks(tasks) {
    writeJson(TASKS_FILE, {
        updatedAt: new Date().toISOString(),
        tasks
    });
}

function loadState() {
    return {
        paused: false,
        workerPid: null,
        backend: 'fun_asr_nano_vllm',
        currentTaskId: null,
        updatedAt: null,
        ...readJson(STATE_FILE, {})
    };
}

function saveState(patch) {
    const state = {
        ...loadState(),
        ...patch,
        updatedAt: new Date().toISOString()
    };
    writeJson(STATE_FILE, state);
    return state;
}

function parseArgs(argv) {
    const options = {
        command: 'run',
        enqueue: [],
        importWhisperQueue: false,
        roomId: null,
        once: false,
        limit: Infinity,
        dryRun: false,
        overwrite: false,
        backend: 'fun_asr_nano_vllm'
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--pause') {
            options.command = 'pause';
        } else if (arg === '--resume') {
            options.command = 'resume';
        } else if (arg === '--status') {
            options.command = 'status';
        } else if (arg === '--run') {
            options.command = 'run';
        } else if (arg === '--retry-failed' || arg === '--retry') {
            options.command = 'retry_failed';
        } else if (arg === '--enqueue') {
            options.command = 'enqueue';
            options.enqueue.push(argv[++i]);
        } else if (arg.startsWith('--enqueue=')) {
            options.command = 'enqueue';
            options.enqueue.push(arg.slice('--enqueue='.length));
        } else if (arg === '--import-whisper-queue') {
            options.command = 'enqueue';
            options.importWhisperQueue = true;
        } else if (arg === '--room-id') {
            options.roomId = argv[++i];
        } else if (arg.startsWith('--room-id=')) {
            options.roomId = arg.slice('--room-id='.length);
        } else if (arg === '--once') {
            options.once = true;
            options.limit = Math.min(options.limit, 1);
        } else if (arg === '--limit') {
            options.limit = Number(argv[++i]);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Number(arg.slice('--limit='.length));
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--overwrite') {
            options.overwrite = true;
        } else if (arg === '--backend') {
            options.backend = argv[++i];
        } else if (arg.startsWith('--backend=')) {
            options.backend = arg.slice('--backend='.length);
        } else if (!arg.startsWith('--')) {
            options.command = options.command === 'run' ? 'enqueue' : options.command;
            options.enqueue.push(arg);
        }
    }

    if (!Number.isFinite(options.limit) || options.limit <= 0) {
        options.limit = Infinity;
    }
    options.backend = String(options.backend || 'fun_asr_nano_vllm').trim();
    return options;
}

function makeTask(mediaPath, roomId = null, source = 'manual') {
    const resolved = path.resolve(mediaPath);
    return {
        id: `${Date.now()}-${path.basename(resolved)}`,
        mediaPath: resolved,
        roomId: roomId === undefined ? null : roomId,
        source,
        status: 'pending',
        addedTime: Date.now(),
        priority: String(roomId || '') === '25788785' ? 100 : 0
    };
}

function enqueueTasks(mediaPaths, roomId = null) {
    const tasks = loadTasks();
    let added = 0;
    for (const mediaPath of mediaPaths.map(item => String(item || '').trim()).filter(Boolean)) {
        const resolved = path.resolve(mediaPath);
        if (!fs.existsSync(resolved)) {
            console.warn(`[ASR queue] 跳过不存在文件: ${resolved}`);
            continue;
        }
        const existing = tasks.find(task => task.mediaPath === resolved && ['pending', 'processing'].includes(task.status));
        if (existing) {
            console.log(`[ASR queue] 已在队列中: ${path.basename(resolved)}`);
            continue;
        }
        tasks.push(makeTask(resolved, roomId, 'manual'));
        added += 1;
    }
    saveTasks(tasks);
    console.log(`[ASR queue] 添加任务: ${added}`);
}

function importWhisperQueue() {
    const queueManager = require('../whisper_queue_manager');
    const sourceTasks = queueManager.getPendingTasks();
    const tasks = loadTasks();
    let added = 0;
    for (const sourceTask of sourceTasks) {
        const mediaPath = path.resolve(sourceTask.mediaPath);
        if (!fs.existsSync(mediaPath)) {
            continue;
        }
        const existing = tasks.find(task => task.mediaPath === mediaPath && ['pending', 'processing'].includes(task.status));
        if (existing) {
            continue;
        }
        tasks.push({
            ...makeTask(mediaPath, sourceTask.roomId, 'whisper_queue'),
            importedTaskId: sourceTask.id,
            priority: Number(sourceTask.priority) || 0
        });
        added += 1;
    }
    saveTasks(tasks);
    console.log(`[ASR queue] 从现有队列导入 pending 任务: ${added}`);
}

function getSortedPendingTasks(tasks) {
    return tasks
        .filter(task => task.status === 'pending')
        .sort((a, b) => {
            const priorityDiff = (Number(b.priority) || 0) - (Number(a.priority) || 0);
            if (priorityDiff !== 0) {
                return priorityDiff;
            }
            return (Number(a.addedTime) || 0) - (Number(b.addedTime) || 0);
        });
}

function printStatus() {
    const tasks = loadTasks();
    const state = loadState();
    const counts = tasks.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] || 0) + 1;
        return acc;
    }, {});
    console.log(`[ASR queue] paused=${state.paused}, workerPid=${state.workerPid || 'none'}, current=${state.currentTaskId || 'none'}`);
    console.log(`[ASR queue] total=${tasks.length}, pending=${counts.pending || 0}, processing=${counts.processing || 0}, completed=${counts.completed || 0}, failed=${counts.failed || 0}`);
    getSortedPendingTasks(tasks).slice(0, 8).forEach((task, index) => {
        console.log(`  ${index + 1}. ${path.basename(task.mediaPath)} room=${task.roomId || '-'} source=${task.source || '-'}`);
    });
}

function updateTask(taskId, patch) {
    const tasks = loadTasks();
    const task = tasks.find(item => item.id === taskId);
    if (!task) {
        return null;
    }
    Object.assign(task, patch, { updatedAt: Date.now() });
    saveTasks(tasks);
    return task;
}

function retryFailedTasks() {
    const tasks = loadTasks();
    let retried = 0;
    const nextTasks = tasks.map((task) => {
        if (task.status !== 'failed') {
            return task;
        }
        retried += 1;
        const nextTask = {
            ...task,
            status: 'pending',
            workerPid: null,
            retryTime: Date.now(),
            retryCount: Number(task.retryCount || 0) + 1,
            warning: 'manual_retry_failed'
        };
        delete nextTask.error;
        delete nextTask.completedTime;
        delete nextTask.elapsedMs;
        return nextTask;
    });
    if (retried > 0) {
        saveTasks(nextTasks);
    }
    console.log(`[ASR queue] 重试 failed 任务: ${retried}`);
    return retried;
}

function isProcessRunning(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return false;
    }
    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

function recoverInterruptedTasks() {
    const state = loadState();
    if (state.workerPid && isProcessRunning(state.workerPid)) {
        return 0;
    }

    const tasks = loadTasks();
    let recovered = 0;
    const nextTasks = tasks.map((task) => {
        if (task.status !== 'processing') {
            return task;
        }
        recovered += 1;
        return {
            ...task,
            status: 'pending',
            workerPid: null,
            recoveredTime: Date.now(),
            warning: 'recovered_from_interrupted_worker'
        };
    });

    if (recovered > 0) {
        saveTasks(nextTasks);
        saveState({ workerPid: null, currentTaskId: null });
        console.log(`[ASR queue] 恢复中断任务: ${recovered}`);
    }
    return recovered;
}

function createPythonWorker(config) {
    const pythonCommand = asrBackends.resolvePythonCommand(config);
    const workerScript = asrBackends.translatePythonPath(PYTHON_WORKER, config);
    const child = spawn(pythonCommand.executable, [...pythonCommand.args, workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' }
    });
    let buffer = '';
    const pending = new Map();
    let nextId = 1;

    child.on('error', (error) => {
        for (const entry of pending.values()) {
            entry.reject(new Error(`vLLM worker start failed: ${error.message}`));
        }
        pending.clear();
    });

    child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            let message;
            try {
                message = JSON.parse(line);
            } catch (error) {
                console.warn(`[ASR worker] 非 JSON 输出: ${line}`);
                continue;
            }
            const entry = pending.get(message.id);
            if (!entry) {
                console.log(`[ASR worker] ${line}`);
                continue;
            }
            pending.delete(message.id);
            if (message.type === 'error' || message.type === 'fatal') {
                entry.reject(new Error(`${message.error}: ${message.detail || ''}`));
            } else {
                entry.resolve(message);
            }
        }
    });

    child.stderr.on('data', (data) => {
        process.stderr.write(data.toString());
    });

    child.on('exit', (code, signal) => {
        for (const entry of pending.values()) {
            entry.reject(new Error(`vLLM worker exited: code=${code}, signal=${signal || ''}`));
        }
        pending.clear();
    });

    function request(payload) {
        const id = `msg-${nextId++}`;
        const message = { ...payload, id };
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
        });
    }

    return {
        pid: child.pid,
        command: pythonCommand,
        init: () => request({
            type: 'init',
            config: asrBackends.translatePythonPayloadPaths(config, config)
        }),
        transcribe: (payload) => request({
            type: 'transcribe',
            ...asrBackends.translatePythonPayloadPaths(payload, config)
        }),
        shutdown: async () => {
            try {
                await request({ type: 'shutdown' });
            } catch {}
            child.stdin.end();
        },
        kill: () => child.kill('SIGTERM')
    };
}

function buildJobPayload(task, config, runtime) {
    const asrConfig = asrBackends.getAsrConfig(config);
    const backendConfig = asrConfig.fun_asr_nano_vllm;
    return {
        audio_path: task.mediaPath,
        hotwords: runtime.hotwordWords || [],
        language: backendConfig.language || '中文',
        use_itn: backendConfig.use_itn !== false,
        enable_speaker: Boolean(backendConfig.enable_speaker),
        preset_spk_num: backendConfig.preset_spk_num,
        max_new_tokens: backendConfig.max_new_tokens,
        batch_size_s: backendConfig.batch_size_s,
        asr_timeout_s: backendConfig.asr_timeout_s || backendConfig.process_timeout_s
    };
}

function outputSrtPath(mediaPath) {
    const parsed = path.parse(mediaPath);
    return path.join(parsed.dir, `${parsed.name}.srt`);
}

async function runQueue(options) {
    if (options.backend !== 'fun_asr_nano_vllm') {
        throw new Error(`ASR vLLM queue worker 目前只支持 backend=fun_asr_nano_vllm，收到: ${options.backend}`);
    }
    const state = loadState();
    if (state.paused) {
        console.log('[ASR queue] 当前已暂停，使用 --resume 后再运行。');
        return;
    }
    recoverInterruptedTasks();

    let tasks = getSortedPendingTasks(loadTasks());
    if (tasks.length === 0) {
        console.log('[ASR queue] 没有 pending 任务。');
        return;
    }
    if (options.dryRun) {
        console.log(`[ASR queue] dry-run，待处理 ${tasks.length} 个任务。`);
        tasks.slice(0, Number.isFinite(options.limit) ? options.limit : 8).forEach((task, index) => {
            console.log(`  ${index + 1}. ${task.mediaPath}`);
        });
        return;
    }

    let processed = 0;
    while (processed < options.limit) {
        tasks = getSortedPendingTasks(loadTasks());
        const task = tasks[0];
        if (!task) {
            console.log('[ASR queue] 没有需要启动 vLLM 的任务。');
            return;
        }
        const srtPath = outputSrtPath(task.mediaPath);
        if (fs.existsSync(srtPath) && !options.overwrite) {
            updateTask(task.id, {
                status: 'completed',
                completedTime: Date.now(),
                srtPath,
                warning: 'srt_exists_skipped'
            });
            console.log(`[ASR queue] 跳过已有字幕: ${path.basename(srtPath)}`);
            processed += 1;
            continue;
        }
        if (!fs.existsSync(task.mediaPath)) {
            updateTask(task.id, {
                status: 'failed',
                completedTime: Date.now(),
                error: `媒体文件不存在: ${task.mediaPath}`
            });
            console.warn(`[ASR queue] 跳过不存在文件: ${task.mediaPath}`);
            processed += 1;
            continue;
        }
        break;
    }
    if (processed >= options.limit) {
        return;
    }

    const config = configLoader.getConfig();
    const asrConfig = asrBackends.getAsrConfig(config);
    const worker = createPythonWorker(asrConfig.fun_asr_nano_vllm);
    saveState({ workerPid: worker.pid, backend: options.backend, currentTaskId: null });

    try {
        console.log(`[ASR queue] 启动 Fun-ASR-Nano vLLM worker pid=${worker.pid}, python=${worker.command.executable}`);
        await worker.init();
        while (processed < options.limit) {
            if (loadState().paused) {
                console.log('[ASR queue] 检测到暂停标记，停止领取新任务。');
                break;
            }
            const pending = getSortedPendingTasks(loadTasks());
            const task = pending[0];
            if (!task) {
                break;
            }
            const srtPath = outputSrtPath(task.mediaPath);
            if (fs.existsSync(srtPath) && !options.overwrite) {
                updateTask(task.id, {
                    status: 'completed',
                    completedTime: Date.now(),
                    srtPath,
                    warning: 'srt_exists_skipped'
                });
                processed += 1;
                continue;
            }
            if (!fs.existsSync(task.mediaPath)) {
                updateTask(task.id, {
                    status: 'failed',
                    completedTime: Date.now(),
                    error: `媒体文件不存在: ${task.mediaPath}`
                });
                processed += 1;
                continue;
            }

            const started = Date.now();
            updateTask(task.id, { status: 'processing', startTime: started, workerPid: process.pid });
            saveState({ currentTaskId: task.id });
            console.log(`[ASR queue] 开始: ${path.basename(task.mediaPath)}`);

            try {
                const context = { mediaPath: task.mediaPath, room_id: task.roomId };
                const runtime = asrBackends.resolveAsrHotwords(config, context);
                const response = await worker.transcribe(buildJobPayload(task, config, runtime));
                const normalized = asrBackends.normalizeAsrResult(response.result, asrBackends.getSubtitleConfig(config));
                asrBackends.writeSrt(normalized, srtPath, {
                    ...asrBackends.getSubtitleConfig(config),
                    corrections: runtime.corrections
                });
                asrBackends.writeSpeakerReviewSrt(normalized, srtPath, {
                    ...asrBackends.getSubtitleConfig(config),
                    corrections: runtime.corrections
                });
                asrBackends.writeAsrSpeakersSidecar(normalized, srtPath, config, context);
                updateTask(task.id, {
                    status: 'completed',
                    completedTime: Date.now(),
                    elapsedMs: Date.now() - started,
                    segmentCount: normalized.segments.length,
                    srtPath
                });
                console.log(`[ASR queue] 完成: ${path.basename(srtPath)}, segments=${normalized.segments.length}`);
            } catch (error) {
                updateTask(task.id, {
                    status: 'failed',
                    completedTime: Date.now(),
                    elapsedMs: Date.now() - started,
                    error: error.message
                });
                console.error(`[ASR queue] 失败: ${path.basename(task.mediaPath)}: ${error.message}`);
            } finally {
                saveState({ currentTaskId: null });
                processed += 1;
            }

            if (options.once) {
                break;
            }
        }
    } finally {
        saveState({ workerPid: null, currentTaskId: null });
        await worker.shutdown();
    }
}

async function main() {
    ensureQueueDir();
    const options = parseArgs(process.argv.slice(2));

    if (options.command === 'pause') {
        saveState({ paused: true });
        console.log('[ASR queue] 已暂停。');
        return;
    }
    if (options.command === 'resume') {
        saveState({ paused: false });
        console.log('[ASR queue] 已恢复。');
        return;
    }
    if (options.command === 'status') {
        printStatus();
        return;
    }
    if (options.command === 'retry_failed') {
        retryFailedTasks();
        printStatus();
        return;
    }
    if (options.command === 'enqueue') {
        if (options.importWhisperQueue) {
            importWhisperQueue();
        }
        if (options.enqueue.length > 0) {
            enqueueTasks(options.enqueue, options.roomId);
        }
        printStatus();
        return;
    }

    await runQueue(options);
    printStatus();
}

main().catch((error) => {
    console.error(`[ASR queue] fatal: ${error.stack || error.message}`);
    process.exit(1);
});
