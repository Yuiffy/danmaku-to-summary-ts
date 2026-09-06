/**
 * 回复历史存储实现
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { getLogger } from '../../core/logging/LogManager';
import { IReplyHistoryStore } from './interfaces/IReplyHistoryStore';
import { ReplyHistory } from './interfaces/types';

export interface ReplyHistoryStoreOptions {
  projectRoot?: string;
  legacyPaths?: string[];
}

/**
 * 回复历史存储实现
 */
export class ReplyHistoryStore implements IReplyHistoryStore {
  private logger = getLogger('ReplyHistoryStore');
  private storagePath: string;
  private history: Map<string, ReplyHistory> = new Map();
  private readonly legacyPaths: string[];
  private readonly backupDirectory: string;
  private initialized = false;

  constructor(options: ReplyHistoryStoreOptions = {}) {
    const projectRoot = options.projectRoot || getProjectRoot();
    this.storagePath = path.join(projectRoot, 'data', 'reply_history.json');
    this.legacyPaths = options.legacyPaths || [path.join(path.dirname(projectRoot), 'data', 'reply_history.json')];
    this.backupDirectory = path.join(projectRoot, 'data', 'runtime', 'reply-history-migration');
  }

  /**
   * 初始化存储
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      // 确保目录存在
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.info(`创建存储目录: ${dir}`);
      }

      const targetExists = fs.existsSync(this.storagePath);
      const merged = new Map<string, ReplyHistory>();
      if (targetExists) {
        for (const item of this.readHistoryFile(this.storagePath)) merged.set(item.dynamicId, item);
      }
      const markerPath = `${this.storagePath}.migration.json`;
      const marker: { schemaVersion: number; sources: Record<string, string> } = fs.existsSync(markerPath)
        ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : { schemaVersion: 1, sources: {} };
      if (marker.schemaVersion !== 1 || !marker.sources) throw new Error('Invalid reply history migration marker');
      let migrated = false;
      for (const legacyPath of this.legacyPaths) {
        if (path.resolve(legacyPath) === path.resolve(this.storagePath) || !fs.existsSync(legacyPath)) continue;
        const bytes = fs.readFileSync(legacyPath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (targetExists && marker.sources[legacyPath] === digest) continue;
        const records = this.readHistoryFile(legacyPath);
        fs.mkdirSync(this.backupDirectory, { recursive: true });
        const backup = path.join(this.backupDirectory, `${digest}.json`);
        if (!fs.existsSync(backup)) fs.copyFileSync(legacyPath, backup);
        for (const item of records) {
          const previous = merged.get(item.dynamicId);
          if (!previous || (item.success && !previous.success)
            || (item.success === previous.success && item.replyTime > previous.replyTime)) {
            merged.set(item.dynamicId, item);
          }
        }
        marker.sources[legacyPath] = digest;
        migrated = true;
      }
      this.history = merged;
      if (!targetExists || migrated) await this.save();
      if (migrated) this.writeAtomically(markerPath, JSON.stringify(marker, null, 2));
      this.initialized = true;
      this.logger.info(`加载回复历史: ${this.history.size} 条记录`, { migrated, storagePath: this.storagePath });
    } catch (error) {
      this.logger.error('初始化回复历史存储失败', undefined, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private readHistoryFile(file: string): ReplyHistory[] {
    const records = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(records)) throw new Error(`Reply history must be an array: ${file}`);
    return records.map(item => {
      if (!item || typeof item.dynamicId !== 'string' || !item.dynamicId
        || typeof item.uid !== 'string' || typeof item.success !== 'boolean') {
        throw new Error(`Invalid reply history record: ${file}`);
      }
      const replyTime = new Date(item.replyTime);
      if (!Number.isFinite(replyTime.getTime())) throw new Error(`Invalid reply history timestamp: ${file}`);
      return { ...item, replyTime };
    });
  }

  private writeAtomically(file: string, content: string): void {
    fs.writeFileSync(`${file}.tmp`, content, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
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
      this.writeAtomically(this.storagePath, data);
    } catch (error) {
      this.logger.error('保存回复历史失败', undefined, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
