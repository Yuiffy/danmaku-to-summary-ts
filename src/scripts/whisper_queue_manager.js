/**
 * Whisper 队列管理器
 * 负责持久化存储待处理的任务队列，支持重启后恢复
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const configLoader = require('./config-loader');

const QUEUE_FILE = path.join(__dirname, '.whisper_queue.json');
const LOCK_FILE = path.join(__dirname, '.whisper_lock');
const ACTIVE_TASK_HEARTBEAT_TIMEOUT = 2 * 60 * 1000;

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

/**
 * 队列任务结构
 * @typedef {Object} QueueTask
 * @property {string} id - 任务唯一ID
 * @property {string} mediaPath - 媒体文件路径
 * @property {string} roomId - 房间ID（可选）
 * @property {number} addedTime - 添加时间戳
 * @property {string} status - 任务状态: 'pending' | 'processing' | 'completed' | 'completed_with_cleanup_crash' | 'failed'
 * @property {string} [xmlPath] - 关联的 XML 路径
 * @property {string} [screenshotPath] - 关联的截图路径
 * @property {number} [startTime] - 开始处理时间戳
 * @property {number} [completedTime] - 完成时间戳
 * @property {string} [error] - 错误信息
 */

class WhisperQueueManager {
    constructor() {
        this.queue = [];
        this.loadQueue({ silent: false });
    }

    normalizeMediaPath(mediaPath) {
        if (typeof mediaPath !== 'string') {
            return mediaPath;
        }

        const trimmed = mediaPath.trim();
        if (!trimmed) {
            return trimmed;
        }

        if (/^[a-zA-Z]:[\\\/]*$/.test(trimmed) || /^[\\\/]{2}[^\\\/]+[\\\/]+[^\\\/]+[\\\/]*$/.test(trimmed)) {
            return trimmed.replace(/[\\\/]+$/, path.sep);
        }

        return trimmed.replace(/[\\\/]+$/, '');
    }

    cleanupInvalidPendingTasks(options = {}) {
        const { silent = true } = options;
        const completedStatuses = new Set(['completed', 'completed_with_cleanup_crash']);
        const completedPaths = new Set(
            this.queue
                .filter(task => completedStatuses.has(task.status))
                .map(task => this.normalizeMediaPath(task.mediaPath))
        );

        const removedTasks = [];

        this.queue = this.queue.filter(task => {
            task.mediaPath = this.normalizeMediaPath(task.mediaPath);
            const normalizedPath = task.mediaPath;
            const isActiveTask = task.status === 'pending' || task.status === 'processing';
            if (!isActiveTask) {
                return true;
            }

            if (!normalizedPath || !fs.existsSync(normalizedPath)) {
                removedTasks.push({ task, reason: 'media_missing' });
                return false;
            }

            if (completedPaths.has(normalizedPath)) {
                removedTasks.push({ task, reason: 'already_completed' });
                return false;
            }

            return true;
        });

        if (removedTasks.length > 0) {
            this.saveQueue();
            if (!silent) {
                console.log(`🧹 清理失效待处理任务: ${removedTasks.length} 个`);
                removedTasks.slice(0, 10).forEach(({ task, reason }) => {
                    const reasonLabel = reason === 'already_completed' ? '已存在完成记录' : '媒体文件不存在';
                    console.log(`   - ${path.basename(task.mediaPath)} (${reasonLabel})`);
                });
                if (removedTasks.length > 10) {
                    console.log(`   ... 还有 ${removedTasks.length - 10} 个`);
                }
            }
        }
    }

    cleanupStaleActiveTasks(options = {}) {
        const { silent = true } = options;
        const now = Date.now();
        const config = configLoader.getConfig();
        const configuredProcessTimeout = Number(config?.webhook?.timeouts?.processTimeout) || 30 * 60 * 1000;
        const legacyPendingTimeout = Math.max(configuredProcessTimeout + (5 * 60 * 1000), 45 * 60 * 1000);
        const removedTasks = [];

        for (const task of this.queue) {
            if (task.status !== 'processing') {
                continue;
            }

            let staleReason = null;

            if (Number.isInteger(task.ownerPid) && task.ownerPid > 0) {
                if (typeof task.ownerBootTime === 'number') {
                    const currentBootTime = getSystemBootTimestamp();
                    const bootTimeDiff = Math.abs(currentBootTime - task.ownerBootTime);
                    if (bootTimeDiff > 5 * 60 * 1000) {
                        staleReason = 'owner_process_rebooted';
                    }
                }

                if (!staleReason && !isProcessAlive(task.ownerPid)) {
                    staleReason = `owner_process_missing:${task.ownerPid}`;
                }
            }

            if (!staleReason && typeof task.lastHeartbeat === 'number') {
                const heartbeatAge = now - task.lastHeartbeat;
                if (heartbeatAge > ACTIVE_TASK_HEARTBEAT_TIMEOUT) {
                    staleReason = `heartbeat_timeout:${Math.floor(heartbeatAge / 1000)}s`;
                }
            }

            if (!staleReason && !task.ownerPid && !task.lastHeartbeat) {
                const activeSince = task.startTime || task.addedTime || 0;
                const activeAge = now - activeSince;
                if (activeAge > legacyPendingTimeout) {
                    staleReason = `legacy_timeout:${Math.floor(activeAge / 1000)}s`;
                }
            }

            if (!staleReason) {
                continue;
            }

            task.status = 'failed';
            task.completedTime = now;
            task.error = `stale_queue_task:${staleReason}`;
            removedTasks.push(task);
        }

        if (removedTasks.length > 0) {
            this.saveQueue();
            if (!silent) {
                console.log(`🧹 清理僵尸活动任务: ${removedTasks.length} 个`);
                removedTasks.slice(0, 10).forEach((task) => {
                    console.log(`   - ${path.basename(task.mediaPath)} (${task.error})`);
                });
                if (removedTasks.length > 10) {
                    console.log(`   ... 还有 ${removedTasks.length - 10} 个`);
                }
            }
        }
    }

    /**
     * 从文件加载队列
     */
    loadQueue(options = {}) {
        const { silent = true } = options;
        try {
            if (fs.existsSync(QUEUE_FILE)) {
                const content = fs.readFileSync(QUEUE_FILE, 'utf8');
                const data = JSON.parse(content);
                this.queue = (data.tasks || []).map(task => ({
                    ...task,
                    mediaPath: this.normalizeMediaPath(task.mediaPath)
                }));
                this.cleanupInvalidPendingTasks({ silent });
                this.cleanupStaleActiveTasks({ silent });
                if (!silent) {
                    console.log(`📋 加载队列: ${this.queue.length} 个任务`);
                }
                
                // 显示队列状态
                const pending = this.queue.filter(t => t.status === 'pending').length;
                const processing = this.queue.filter(t => t.status === 'processing').length;
                const completed = this.queue.filter(t => t.status === 'completed' || t.status === 'completed_with_cleanup_crash').length;
                const failed = this.queue.filter(t => t.status === 'failed').length;
                
                if (!silent && this.queue.length > 0) {
                    console.log(`   待处理: ${pending}, 处理中: ${processing}, 已完成: ${completed}, 失败: ${failed}`);
                }
            } else {
                this.queue = [];
            }
        } catch (error) {
            if (!silent) {
                console.warn(`⚠️  加载队列失败: ${error.message}，将创建新队列`);
            }
            this.queue = [];
        }
    }

    /**
     * 根据房间配置获取 Whisper 优先级
     * 规则：数值越大优先级越高；未配置默认 0
     * @param {string | number | null | undefined} roomId
     * @returns {number}
     */
    getTaskPriorityByRoomId(roomId) {
        if (roomId === null || roomId === undefined || roomId === '') {
            return 0;
        }

        const config = configLoader.getConfig();
        const roomKey = String(roomId);
        const roomConfig = config.ai?.roomSettings?.[roomKey]
            || config.roomSettings?.[roomKey];
        const priority = roomConfig?.whisperPriority;
        return Number.isFinite(priority) ? priority : 0;
    }

    /**
     * 获取任务优先级
     * @param {QueueTask} task
     * @returns {number}
     */
    getTaskPriority(task) {
        if (Number.isFinite(task?.priority)) {
            return task.priority;
        }
        return this.getTaskPriorityByRoomId(task?.roomId);
    }

    /**
     * 获取按优先级排序后的待处理任务
     * 排序规则：优先级高的在前，同优先级按入队时间早的在前
     * @returns {QueueTask[]}
     */
    getSortedPendingTasks() {
        return this.queue
            .filter(t => t.status === 'pending')
            .sort((a, b) => {
                const priorityDiff = this.getTaskPriority(b) - this.getTaskPriority(a);
                if (priorityDiff !== 0) {
                    return priorityDiff;
                }

                const addedTimeDiff = (a.addedTime || 0) - (b.addedTime || 0);
                if (addedTimeDiff !== 0) {
                    return addedTimeDiff;
                }

                return String(a.id).localeCompare(String(b.id));
            });
    }

    /**
     * 保存队列到文件
     */
    saveQueue() {
        try {
            const data = {
                lastUpdate: new Date().toISOString(),
                tasks: this.queue
            };
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error(`❌ 保存队列失败: ${error.message}`);
        }
    }

    /**
     * 生成任务ID
     */
    generateTaskId(mediaPath) {
        const timestamp = Date.now();
        const basename = path.basename(mediaPath);
        return `${timestamp}-${basename}`;
    }

    /**
     * 添加任务到队列
     * @param {string} mediaPath - 媒体文件路径
     * @param {string} [roomId] - 房间ID
     * @returns {QueueTask} 添加的任务
     */
    addTask(mediaPath, roomId = null, options = {}) {
        mediaPath = this.normalizeMediaPath(mediaPath);
        this.cleanupInvalidPendingTasks({ silent: true });
        const normalizedXmlPath = options.xmlPath ? this.normalizeMediaPath(options.xmlPath) : null;
        const normalizedScreenshotPath = options.screenshotPath ? this.normalizeMediaPath(options.screenshotPath) : null;
        const trackOwnershipWhilePending = options.trackOwnershipWhilePending === true;

        // 检查是否已存在相同文件的待处理任务
        const existing = this.queue.find(t => 
            t.mediaPath === mediaPath && 
            (t.status === 'pending' || t.status === 'processing')
        );
        
        if (existing) {
            let updated = false;
            if (roomId !== null && roomId !== undefined && roomId !== '' && String(existing.roomId || '') !== String(roomId)) {
                existing.roomId = roomId;
                existing.priority = this.getTaskPriorityByRoomId(roomId);
                updated = true;
            }
            if (normalizedXmlPath && existing.xmlPath !== normalizedXmlPath) {
                existing.xmlPath = normalizedXmlPath;
                updated = true;
            }
            if (normalizedScreenshotPath && existing.screenshotPath !== normalizedScreenshotPath) {
                existing.screenshotPath = normalizedScreenshotPath;
                updated = true;
            }
            if (trackOwnershipWhilePending) {
                existing.ownerPid = process.pid;
                existing.ownerBootTime = getSystemBootTimestamp();
                existing.lastHeartbeat = Date.now();
                updated = true;
            }
            if (updated) {
                this.saveQueue();
            }
            console.log(`ℹ️  任务已在队列中: ${path.basename(mediaPath)}`);
            return existing;
        }

        const task = {
            id: this.generateTaskId(mediaPath),
            mediaPath,
            roomId,
            priority: this.getTaskPriorityByRoomId(roomId),
            addedTime: Date.now(),
            status: 'pending'
        };

        if (normalizedXmlPath) {
            task.xmlPath = normalizedXmlPath;
        }

        if (normalizedScreenshotPath) {
            task.screenshotPath = normalizedScreenshotPath;
        }

        if (trackOwnershipWhilePending) {
            task.ownerPid = process.pid;
            task.ownerBootTime = getSystemBootTimestamp();
            task.lastHeartbeat = Date.now();
        }

        this.queue.push(task);
        this.saveQueue();
        
        console.log(`➕ 添加任务到队列: ${path.basename(mediaPath)}`);
        console.log(`   任务ID: ${task.id}`);
        console.log(`   优先级: ${task.priority}`);
        console.log(`   队列位置: ${this.getPendingPosition(task.id)}`);
        
        return task;
    }

    /**
     * 标记任务为处理中
     * @param {string} taskId - 任务ID
     */
    markProcessing(taskId) {
        const task = this.queue.find(t => t.id === taskId);
        if (task) {
            task.status = 'processing';
            task.startTime = Date.now();
            task.ownerPid = process.pid;
            task.ownerBootTime = getSystemBootTimestamp();
            task.lastHeartbeat = Date.now();
            this.saveQueue();
            console.log(`🔄 任务开始处理: ${path.basename(task.mediaPath)}`);
        }
    }

    touchTask(taskId) {
        const task = this.queue.find(t => t.id === taskId);
        if (!task) {
            return;
        }

        task.ownerPid = process.pid;
        task.ownerBootTime = getSystemBootTimestamp();
        task.lastHeartbeat = Date.now();
        this.saveQueue();
    }

    /**
     * 更新任务关联的媒体路径
     * 用于音频专用房间转码后切换到音频文件，避免原视频删除后任务被清理出队列。
     * @param {string} taskId - 任务ID
     * @param {string} mediaPath - 新的媒体路径
     */
    updateTaskMediaPath(taskId, mediaPath) {
        const task = this.queue.find(t => t.id === taskId);
        if (!task) {
            return;
        }

        const normalizedPath = this.normalizeMediaPath(mediaPath);
        if (!normalizedPath || task.mediaPath === normalizedPath) {
            return;
        }

        task.mediaPath = normalizedPath;
        this.saveQueue();
        console.log(`📝 更新任务媒体路径: ${task.id} -> ${path.basename(normalizedPath)}`);
    }

    /**
     * 标记任务为已完成
     * @param {string} taskId - 任务ID
     */
    markCompleted(taskId, options = {}) {
        const task = this.queue.find(t => t.id === taskId);
        if (task) {
            task.status = options.status || 'completed';
            task.completedTime = Date.now();
            task.lastHeartbeat = Date.now();
            if (options.warning) {
                task.warning = options.warning;
            }
            this.saveQueue();
            
            const duration = task.startTime ? ((task.completedTime - task.startTime) / 1000).toFixed(0) : 'N/A';
            const statusLabel = task.status === 'completed_with_cleanup_crash'
                ? '⚠️ 任务完成（清理异常）'
                : '✅ 任务完成';
            console.log(`${statusLabel}: ${path.basename(task.mediaPath)} (耗时: ${duration}秒)`);
            if (options.warning) {
                console.log(`   警告: ${options.warning}`);
            }
            
            // 清理旧的已完成任务（保留最近100个）
            this.cleanupOldTasks();
        }
    }

    /**
     * 标记任务为失败
     * @param {string} taskId - 任务ID
     * @param {string} error - 错误信息
     */
    markFailed(taskId, error) {
        const task = this.queue.find(t => t.id === taskId);
        if (task) {
            if (task.status === 'completed' || task.status === 'completed_with_cleanup_crash' || task.status === 'failed') {
                return;
            }
            task.status = 'failed';
            task.completedTime = Date.now();
            task.lastHeartbeat = Date.now();
            task.error = error;
            this.saveQueue();
            console.error(`❌ 任务失败: ${path.basename(task.mediaPath)}`);
            console.error(`   错误: ${error}`);
        }
    }

    /**
     * 获取待处理的任务列表
     * @returns {QueueTask[]}
     */
    getPendingTasks() {
        return this.getSortedPendingTasks();
    }

    getNextPendingTask(options = {}) {
        if (options.reload) {
            this.loadQueue({ silent: true });
        }

        return this.getSortedPendingTasks()[0] || null;
    }

    getTaskById(taskId, options = {}) {
        if (options.reload) {
            this.loadQueue({ silent: true });
        }

        return this.queue.find(t => t.id === taskId) || null;
    }

    /**
     * 获取指定任务当前的待处理队列位置（从 1 开始）
     * @param {string} taskId
     * @param {{ reload?: boolean }} [options]
     * @returns {number}
     */
    getPendingPosition(taskId, options = {}) {
        if (options.reload) {
            this.loadQueue({ silent: true });
        }

        const pendingTasks = this.getSortedPendingTasks();
        const index = pendingTasks.findIndex(task => task.id === taskId);
        return index >= 0 ? index + 1 : -1;
    }

    /**
     * 判断当前是否轮到指定任务执行
     * @param {string} taskId
     * @param {{ reload?: boolean }} [options]
     * @returns {boolean}
     */
    isTaskNext(taskId, options = {}) {
        if (options.reload) {
            this.loadQueue({ silent: true });
        }

        const nextTask = this.getSortedPendingTasks()[0];
        return nextTask?.id === taskId;
    }

    /**
     * 获取正在处理的任务
     * @returns {QueueTask|null}
     */
    getProcessingTask() {
        return this.queue.find(t => t.status === 'processing') || null;
    }

    /**
     * 检查是否有处理中的任务（从锁文件判断）
     * @returns {boolean}
     */
    hasActiveProcessing() {
        try {
            if (fs.existsSync(LOCK_FILE)) {
                const lockContent = fs.readFileSync(LOCK_FILE, 'utf8');
                const lock = JSON.parse(lockContent);
                const currentBootTime = getSystemBootTimestamp();
                const hasSameBootTime = typeof lock.bootTime !== 'number'
                    || Math.abs(currentBootTime - lock.bootTime) <= 5 * 60 * 1000;
                const hasLiveProcess = isProcessAlive(lock.pid);
                const age = typeof lock.timestamp === 'number'
                    ? Date.now() - lock.timestamp
                    : Number.POSITIVE_INFINITY;

                const LOCK_TIMEOUT = 24 * 60 * 60 * 1000; // 24??
                if (hasSameBootTime && hasLiveProcess && age < LOCK_TIMEOUT) {
                    return true;
                }
            }
        } catch (error) {
            // 忽略错误
        }
        return false;
    }

    /**
     * 恢复中断的任务
     * 将所有 'processing' 状态的任务重置为 'pending'
     */
    recoverInterruptedTasks() {
        const interrupted = this.queue.filter(t => t.status === 'processing');
        
        if (interrupted.length > 0) {
            console.log(`🔄 检测到 ${interrupted.length} 个中断的任务，重置为待处理状态`);
            
            interrupted.forEach(task => {
                task.status = 'pending';
                delete task.startTime;
                console.log(`   - ${path.basename(task.mediaPath)}`);
            });
            
            this.saveQueue();
        }
    }

    /**
     * 清理旧的已完成/失败任务
     * 保留最近100个已完成的任务
     */
    cleanupOldTasks() {
        const completedTasks = this.queue.filter(t => 
            t.status === 'completed' || t.status === 'completed_with_cleanup_crash' || t.status === 'failed'
        );
        
        if (completedTasks.length > 100) {
            // 按完成时间排序，保留最新的100个
            completedTasks.sort((a, b) => (b.completedTime || 0) - (a.completedTime || 0));
            const toRemove = completedTasks.slice(100);
            
            this.queue = this.queue.filter(t => !toRemove.includes(t));
            this.saveQueue();
            
            console.log(`🧹 清理了 ${toRemove.length} 个旧任务记录`);
        }
    }

    /**
     * 获取队列统计信息
     */
    getStats() {
        return {
            total: this.queue.length,
            pending: this.queue.filter(t => t.status === 'pending').length,
            processing: this.queue.filter(t => t.status === 'processing').length,
            completed: this.queue.filter(t => t.status === 'completed').length,
            failed: this.queue.filter(t => t.status === 'failed').length
        };
    }

    /**
     * 显示队列状态
     */
    printStatus() {
        const stats = this.getStats();
        console.log('\n📊 队列状态:');
        console.log(`   总任务数: ${stats.total}`);
        console.log(`   待处理: ${stats.pending}`);
        console.log(`   处理中: ${stats.processing}`);
        console.log(`   已完成: ${stats.completed}`);
        console.log(`   失败: ${stats.failed}`);
        
        const pending = this.getPendingTasks();
        if (pending.length > 0) {
            console.log('\n📋 待处理任务:');
            pending.slice(0, 5).forEach((task, index) => {
                const waitTime = ((Date.now() - task.addedTime) / 60000).toFixed(1);
                console.log(`   ${index + 1}. ${path.basename(task.mediaPath)} (等待 ${waitTime} 分钟)`);
            });
            if (pending.length > 5) {
                console.log(`   ... 还有 ${pending.length - 5} 个任务`);
            }
        }
    }
}

// 导出单例
module.exports = new WhisperQueueManager();
