/**
 * Whisper 队列管理器
 * 负责持久化存储待处理的任务队列，支持重启后恢复
 */

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '.whisper_queue.json');
const LOCK_FILE = path.join(__dirname, '.whisper_lock');

/**
 * 队列任务结构
 * @typedef {Object} QueueTask
 * @property {string} id - 任务唯一ID
 * @property {string} mediaPath - 媒体文件路径
 * @property {string} roomId - 房间ID（可选）
 * @property {number} addedTime - 添加时间戳
 * @property {string} status - 任务状态: 'pending' | 'processing' | 'completed' | 'failed'
 * @property {number} [startTime] - 开始处理时间戳
 * @property {number} [completedTime] - 完成时间戳
 * @property {string} [error] - 错误信息
 */

class WhisperQueueManager {
    constructor() {
        this.queue = [];
        this.loadQueue();
    }

    /**
     * 从文件加载队列
     */
    loadQueue() {
        try {
            if (fs.existsSync(QUEUE_FILE)) {
                const content = fs.readFileSync(QUEUE_FILE, 'utf8');
                const data = JSON.parse(content);
                this.queue = data.tasks || [];
                console.log(`📋 加载队列: ${this.queue.length} 个任务`);
                
                // 显示队列状态
                const pending = this.queue.filter(t => t.status === 'pending').length;
                const processing = this.queue.filter(t => t.status === 'processing').length;
                const completed = this.queue.filter(t => t.status === 'completed').length;
                const failed = this.queue.filter(t => t.status === 'failed').length;
                
                if (this.queue.length > 0) {
                    console.log(`   待处理: ${pending}, 处理中: ${processing}, 已完成: ${completed}, 失败: ${failed}`);
                }
            }
        } catch (error) {
            console.warn(`⚠️  加载队列失败: ${error.message}，将创建新队列`);
            this.queue = [];
        }
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
    addTask(mediaPath, roomId = null) {
        // 检查是否已存在相同文件的待处理任务
        const existing = this.queue.find(t => 
            t.mediaPath === mediaPath && 
            (t.status === 'pending' || t.status === 'processing')
        );
        
        if (existing) {
            console.log(`ℹ️  任务已在队列中: ${path.basename(mediaPath)}`);
            return existing;
        }

        const task = {
            id: this.generateTaskId(mediaPath),
            mediaPath,
            roomId,
            addedTime: Date.now(),
            status: 'pending'
        };

        this.queue.push(task);
        this.saveQueue();
        
        console.log(`➕ 添加任务到队列: ${path.basename(mediaPath)}`);
        console.log(`   任务ID: ${task.id}`);
        console.log(`   队列位置: ${this.getPendingTasks().length}`);
        
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
            this.saveQueue();
            console.log(`🔄 任务开始处理: ${path.basename(task.mediaPath)}`);
        }
    }

    /**
     * 标记任务为已完成
     * @param {string} taskId - 任务ID
     */
    markCompleted(taskId) {
        const task = this.queue.find(t => t.id === taskId);
        if (task) {
            task.status = 'completed';
            task.completedTime = Date.now();
            this.saveQueue();
            
            const duration = task.startTime ? ((task.completedTime - task.startTime) / 1000).toFixed(0) : 'N/A';
            console.log(`✅ 任务完成: ${path.basename(task.mediaPath)} (耗时: ${duration}秒)`);
            
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
            task.status = 'failed';
            task.completedTime = Date.now();
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
        return this.queue.filter(t => t.status === 'pending');
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
                const age = Date.now() - lock.timestamp;
                
                // 锁文件未过期，说明有任务在处理
                const LOCK_TIMEOUT = 60 * 60 * 1000; // 1小时
                if (age < LOCK_TIMEOUT) {
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
            t.status === 'completed' || t.status === 'failed'
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
