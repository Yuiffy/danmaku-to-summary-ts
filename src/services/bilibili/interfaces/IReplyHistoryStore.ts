/**
 * 回复历史存储接口
 */
import { ReplyHistory } from './types';

export interface IReplyHistoryStore {
  /**
   * 检查动态是否已回复
   * @param dynamicId 动态ID
   * @returns 是否已回复
   */
  hasReplied(dynamicId: string): Promise<boolean>;

  /**
   * 记录回复历史
   * @param history 回复历史
   */
  recordReply(history: ReplyHistory): Promise<void>;

  /**
   * 获取主播的回复历史
   * @param uid 主播UID
   * @param limit 限制数量
   * @returns 回复历史列表
   */
  getReplyHistory(uid: string, limit?: number): Promise<ReplyHistory[]>;

  /**
   * 清理过期的回复历史
   * @param days 保留天数
   */
  cleanupOldHistory(days: number): Promise<void>;

  /**
   * 初始化存储
   */
  initialize(): Promise<void>;
}
