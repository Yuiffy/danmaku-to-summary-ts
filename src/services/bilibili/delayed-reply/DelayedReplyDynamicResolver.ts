import { getLogger } from '../../../core/logging/LogManager';
import { IBilibiliAPIService } from '../interfaces/IBilibiliAPIService';
import { BilibiliDynamic, DelayedReplyTask } from '../interfaces/types';
import { DelayedReplyPolicy } from './DelayedReplyPolicy';

/** Resolves reply targets without relying on pinned or otherwise unsorted feed order. */
export class DelayedReplyDynamicResolver {
  private readonly logger = getLogger('DelayedReplyDynamicResolver');

  constructor(
    private readonly api: Pick<IBilibiliAPIService, 'getDynamics'>,
    private readonly policy: DelayedReplyPolicy
  ) {}

  async findTarget(task: DelayedReplyTask): Promise<BilibiliDynamic | null> {
    try {
      if (!task.liveEndTime) return await this.getLatest(task.uid!);

      const endTime = Date.now();
      const liveEnd = task.liveEndTime.getTime();
      const validLiveEnd = Number.isFinite(liveEnd) && liveEnd <= endTime;
      let startTime = (validLiveEnd ? liveEnd : endTime) - 30 * 60_000;
      if (!validLiveEnd) {
        this.logger.warn('Ignoring invalid or future live end time for dynamic lookup', { taskId: task.taskId });
      }
      const liveStart = task.liveStartTime?.getTime();
      if (liveStart !== undefined && liveStart <= endTime) startTime = Math.max(startTime, liveStart);

      const dynamics = await this.api.getDynamics(task.uid!);
      const target = this.latestInWindow(dynamics, startTime, endTime);
      this.logger.info('Resolved dynamic in live end window', {
        taskId: task.taskId, dynamicId: target?.id,
        startTime: new Date(startTime).toISOString(), endTime: new Date(endTime).toISOString(),
        publishTime: target?.publishTime.toISOString()
      });
      return target;
    } catch (error) {
      if (this.policy.isCredentialError(error)) throw error;
      this.logger.error('Target dynamic lookup failed', { taskId: task.taskId, error });
      return null;
    }
  }

  async getLatest(uid: string): Promise<BilibiliDynamic | null> {
    try {
      const dynamics = await this.api.getDynamics(uid);
      const target = this.latestInWindow(dynamics, Number.NEGATIVE_INFINITY, Date.now());
      this.logger.info('Resolved latest fallback dynamic', {
        uid, dynamicId: target?.id, publishTime: target?.publishTime.toISOString()
      });
      return target;
    } catch (error) {
      if (this.policy.isCredentialError(error)) throw error;
      this.logger.error('Latest dynamic lookup failed', { uid, error });
      return null;
    }
  }

  private latestInWindow(dynamics: BilibiliDynamic[], startTime: number, endTime: number): BilibiliDynamic | null {
    return dynamics
      .filter(dynamic => {
        const time = dynamic?.publishTime?.getTime();
        return time !== undefined && Number.isFinite(time) && time >= startTime && time <= endTime;
      })
      .sort((a, b) => b.publishTime.getTime() - a.publishTime.getTime())[0] || null;
  }
}
