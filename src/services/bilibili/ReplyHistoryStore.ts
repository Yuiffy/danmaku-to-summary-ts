/**
 * 回复历史存储实现
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/LogManager';
import { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
import { ReplyHistory } from './interfaces/types';

/**
 * 回复历史存储实现
 */
export class ReplyHistoryStore implements IReplyHistoryStore {
  private logger = getLogger('ReplyHistoryStore');
  private storagePath: string;
  private history: Map<string, ReplyHistory> = new Map();

  constructor() {
    // 设置存储路径
    const projectRoot = path.resolve(__dirname, '../../../..');
    this.storagePath = path.join(projectRoot, 'data', 'reply_history.json');
  }

  /**
   * 初始化存储
   */
  async initialize(): Promise<void> {
    try {
      // 确保目录存在
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.info(`创建存储目录: ${dir}`);
      }

      // 加载历史记录
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf8');
        const historyArray: ReplyHistory[] = JSON.parse(data);
        
        for (const item of historyArray) {
          this.history.set(item.dynamicId, item);
        }
        
        this.logger.info(`加载回复历史: ${this.history.size} 条记录`);
      } else {
        this.logger.info('回复历史文件不存在，将创建新文件');
        this.save();
      }
    } catch (error) {
      this.logger.error('初始化回复历史存储失败', { error });
      throw error;
    }
  }

  /**
   * 检查动态是否已回复
   */
  async hasReplied(dynamicId: string): Promise<boolean> {
    return this.history.has(dynamicId);
  }

  /**
   * 记录回复历史
   */
  async recordReply(history: ReplyHistory): Promise<void> {
    try {
      this.history.set(history.dynamicId, history);
      await this.save();
      // 确保 dynamicId 以字符串形式记录日志，避免大数精度丢失
      this.logger.info(`记录回复历史: ${history.dynamicId}`, {
        dynamicId: String(history.dynamicId),
        success: history.success
      });
    } catch (error) {
      // 避免 JSON.stringify 导致大数精度丢失，只记录关键字段
      this.logger.error('记录回复历史失败', {
        dynamicId: String(history.dynamicId),
        uid: history.uid,
        error
      });
      throw error;
    }
  }

  /**
   * 获取主播的回复历史
   */
  async getReplyHistory(uid: string, limit: number = 100): Promise<ReplyHistory[]> {
    const history = Array.from(this.history.values())
      .filter(item => item.uid === uid)
      .sort((a, b) => b.replyTime.getTime() - a.replyTime.getTime())
      .slice(0, limit);
    
    return history;
  }

  /**
   * 清理过期的回复历史
   */
  async cleanupOldHistory(days: number): Promise<void> {
    try {
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const [dynamicId, history] of this.history.entries()) {
        if (history.replyTime < cutoffDate) {
          this.history.delete(dynamicId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        await this.save();
        this.logger.info(`清理过期回复历史: ${cleanedCount} 条记录`, { days });
      } else {
        this.logger.debug('没有需要清理的过期记录', { days });
      }
    } catch (error) {
      this.logger.error('清理过期回复历史失败', { error, days });
      throw error;
    }
  }

  /**
   * 保存历史记录到文件
   */
  private async save(): Promise<void> {
    try {
      const historyArray = Array.from(this.history.values());
      const data = JSON.stringify(historyArray, null, 2);
      fs.writeFileSync(this.storagePath, data, 'utf8');
    } catch (error) {
      this.logger.error('保存回复历史失败', { error });
      throw error;
    }
  }
}
