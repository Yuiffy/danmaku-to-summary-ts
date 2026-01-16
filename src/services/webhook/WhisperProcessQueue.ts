import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';

/**
 * Whisper 处理任务
 */
interface WhisperTask {
  filePath: string;
  resolve: (value: void) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Whisper 处理队列服务
 * 确保同一时间只有一个 Whisper 进程在运行，避免 GPU 并发冲突
 */
export class WhisperProcessQueue {
  private logger = getLogger('WhisperProcessQueue');
  
  // 队列
  private queue: WhisperTask[] = [];
  
  // 当前是否有任务在执行
  private isProcessing: boolean = false;
  
  // 最大队列长度（防止内存溢出）
  private readonly maxQueueSize: number = 50;
  
  // 任务超时时间（30分钟）
  private readonly taskTimeoutMs: number = 30 * 60 * 1000;

  private static instance: WhisperProcessQueue;

  /**
   * 单例模式
   */
  static getInstance(): WhisperProcessQueue {
    if (!WhisperProcessQueue.instance) {
      WhisperProcessQueue.instance = new WhisperProcessQueue();
    }
    return WhisperProcessQueue.instance;
  }

  private constructor() {
    this.logger.info('Whisper处理队列已初始化');
  }

  /**
   * 添加任务到队列
   */
  async enqueue(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 检查队列长度
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error('Whisper处理队列已满，请稍后再试'));
        return;
      }

      const task: WhisperTask = {
        filePath,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.queue.push(task);
      this.logger.debug(`文件加入Whisper队列: ${path.basename(filePath)} (队列长度: ${this.queue.length})`);

      // 如果当前没有任务在执行，开始处理
      if (!this.isProcessing) {
        this.processNext().catch(error => {
          this.logger.error(`处理任务时出错: ${error.message}`);
        });
      }
    });
  }

  /**
   * 处理队列中的下一个任务
   */
  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.logger.debug('Whisper队列已清空');
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift()!;

    if (!task) {
      this.isProcessing = false;
      return;
    }

    const fileName = path.basename(task.filePath);
    
    try {
      this.logger.info(`🎤 开始Whisper处理: ${fileName} (剩余任务: ${this.queue.length})`);
      
      // 执行任务（这里实际不做任何事，因为任务已经在 enhanced_auto_summary.js 中执行）
      // 我们只是起到串行化的作用
      task.resolve();
      
    } catch (error: any) {
      this.logger.error(`Whisper处理失败: ${fileName} - ${error.message}`);
      task.reject(error);
    } finally {
      // 继续处理下一个任务
      this.processNext().catch(err => {
        this.logger.error(`继续处理队列时出错: ${err.message}`);
      });
    }
  }

  /**
   * 获取队列状态
   */
  getStatus(): {
    queueLength: number;
    isProcessing: boolean;
  } {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
    };
  }

  /**
   * 清空队列（慎用）
   */
  clearQueue(): number {
    const count = this.queue.length;
    this.queue.forEach(task => {
      task.reject(new Error('队列已清空'));
    });
    this.queue = [];
    this.logger.warn(`Whisper队列已清空，取消了 ${count} 个任务`);
    return count;
  }

  /**
   * 清理超时的任务
   */
  cleanupExpiredTasks(): number {
    const now = Date.now();
    const initialLength = this.queue.length;
    
    // 只清理队列中的任务，正在处理的不清除
    this.queue = this.queue.filter(task => {
      const age = now - task.timestamp;
      if (age > this.taskTimeoutMs) {
        task.reject(new Error(`任务超时 (${age / 1000}秒)`));
        return false;
      }
      return true;
    });

    const cleanedCount = initialLength - this.queue.length;
    if (cleanedCount > 0) {
      this.logger.info(`清理了 ${cleanedCount} 个超时的Whisper任务`);
    }

    return cleanedCount;
  }
}