import { ConfigProvider } from '../../core/config/ConfigProvider';
import { getLogger } from '../../core/logging/LogManager';
import { RoomLiveStatus } from '../bilibili/interfaces/types';

export interface MikufansOfflineFallbackCandidate {
  roomId: string;
  roomName?: string;
  title?: string;
  segmentCount: number;
  streamStartedAt?: Date;
  latestSegmentActivityAt?: Date;
}

export interface MikufansOfflineFallbackStatusProvider {
  getRoomLiveStatus(roomId: string): Promise<RoomLiveStatus>;
}

export interface MikufansOfflineFallbackTrigger {
  candidate: MikufansOfflineFallbackCandidate;
  status: RoomLiveStatus;
  consecutiveConfirmations: number;
  offlineSince: Date;
  offlineGraceSeconds: number;
}

export interface MikufansOfflineFallbackConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  offlineConfirmations: number;
  offlineGraceSeconds: number;
  apiTimeoutMs: number;
}

interface OfflineObservation {
  streamKey: string;
  offlineSinceMs: number;
  consecutiveConfirmations: number;
  latestSegmentActivityMs?: number;
  triggered: boolean;
}

const DEFAULT_CONFIG: MikufansOfflineFallbackConfig = {
  enabled: true,
  pollIntervalSeconds: 60,
  offlineConfirmations: 3,
  offlineGraceSeconds: 180,
  apiTimeoutMs: 10 * 1000
};

/**
 * Reconciles an active recorder session with Bilibili's public room state.
 * It intentionally requires both repeated offline observations and an idle
 * recording segment window before sending the alert callback.
 */
export class MikufansOfflineFallbackMonitor {
  private logger = getLogger('MikufansOfflineFallbackMonitor');
  private provider?: MikufansOfflineFallbackStatusProvider;
  private timer: NodeJS.Timeout | null = null;
  private routesRegistered = false;
  private pollInFlight = false;
  private observations = new Map<string, OfflineObservation>();

  constructor(
    private readonly getCandidates: () => MikufansOfflineFallbackCandidate[],
    private readonly onConfirmedOffline: (details: MikufansOfflineFallbackTrigger) => Promise<void>
  ) {}

  setProvider(provider: MikufansOfflineFallbackStatusProvider | undefined): void {
    this.provider = provider;
    if (provider && this.routesRegistered) {
      this.start();
    }
  }

  start(): void {
    this.routesRegistered = true;
    if (this.timer || !this.provider) return;

    const config = this.getConfig();
    if (!config.enabled) {
      this.logger.info('Mikufans offline fallback is disabled');
      return;
    }

    const intervalMs = config.pollIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    this.timer.unref?.();

    this.logger.info('Mikufans offline fallback monitor started', {
      pollIntervalSeconds: config.pollIntervalSeconds,
      offlineConfirmations: config.offlineConfirmations,
      offlineGraceSeconds: config.offlineGraceSeconds,
      apiTimeoutMs: config.apiTimeoutMs
    });
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pollInFlight = false;
    this.observations.clear();
  }

  reset(roomId: string): void {
    this.observations.delete(String(roomId));
  }

  async pollOnce(): Promise<void> {
    if (!this.provider || this.pollInFlight) return;

    this.pollInFlight = true;
    try {
      let candidates: MikufansOfflineFallbackCandidate[];
      try {
        candidates = this.getCandidates();
      } catch (error) {
        this.logger.error('Failed to collect Mikufans offline fallback candidates', {
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      const candidateRooms = new Set(candidates.map(candidate => candidate.roomId));
      for (const roomId of this.observations.keys()) {
        if (!candidateRooms.has(roomId)) {
          this.observations.delete(roomId);
        }
      }

      for (const candidate of candidates) {
        await this.checkCandidate(candidate);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  getConfig(): MikufansOfflineFallbackConfig {
    try {
      const configured = (ConfigProvider.getConfig().webhook as any)?.mikufansOfflineFallback || {};
      return {
        enabled: configured.enabled !== false,
        pollIntervalSeconds: this.clampNumber(configured.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds, 10, 24 * 60 * 60),
        offlineConfirmations: Math.round(this.clampNumber(configured.offlineConfirmations, DEFAULT_CONFIG.offlineConfirmations, 1, 10)),
        offlineGraceSeconds: this.clampNumber(configured.offlineGraceSeconds, DEFAULT_CONFIG.offlineGraceSeconds, 0, 24 * 60 * 60),
        apiTimeoutMs: this.clampNumber(configured.apiTimeoutMs, DEFAULT_CONFIG.apiTimeoutMs, 1000, 120 * 1000)
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private async checkCandidate(candidate: MikufansOfflineFallbackCandidate): Promise<void> {
    const provider = this.provider;
    if (!provider) return;

    const config = this.getConfig();
    if (!config.enabled) return;

    let status: RoomLiveStatus;
    try {
      status = await this.getRoomLiveStatusWithTimeout(provider, candidate.roomId, config.apiTimeoutMs);
    } catch (error) {
      this.logger.warn('Bilibili room status check failed; offline confirmation was not counted', {
        roomId: candidate.roomId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (status.isLive) {
      this.observations.delete(candidate.roomId);
      return;
    }

    const nowMs = Date.now();
    const streamKey = this.getStreamKey(candidate);
    const latestSegmentActivityMs = candidate.latestSegmentActivityAt?.getTime();
    const previous = this.observations.get(candidate.roomId);
    const segmentChanged = previous?.latestSegmentActivityMs !== latestSegmentActivityMs;
    const observation = !previous || previous.streamKey !== streamKey || segmentChanged
      ? {
          streamKey,
          offlineSinceMs: nowMs,
          consecutiveConfirmations: 1,
          latestSegmentActivityMs,
          triggered: false
        }
      : {
          ...previous,
          consecutiveConfirmations: previous.consecutiveConfirmations + 1
        };

    this.observations.set(candidate.roomId, observation);

    const offlineForMs = nowMs - observation.offlineSinceMs;
    if (
      observation.triggered ||
      observation.consecutiveConfirmations < config.offlineConfirmations ||
      offlineForMs < config.offlineGraceSeconds * 1000
    ) {
      return;
    }

    observation.triggered = true;
    this.logger.warn('Bilibili is offline while Mikufans still has an active recording session', {
      roomId: candidate.roomId,
      consecutiveConfirmations: observation.consecutiveConfirmations,
      offlineForSeconds: Math.round(offlineForMs / 1000),
      segmentCount: candidate.segmentCount
    });

    try {
      await this.onConfirmedOffline({
        candidate,
        status,
        consecutiveConfirmations: observation.consecutiveConfirmations,
        offlineSince: new Date(observation.offlineSinceMs),
        offlineGraceSeconds: config.offlineGraceSeconds
      });
    } catch (error) {
      this.logger.error('Mikufans offline state alert callback failed', {
        roomId: candidate.roomId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getStreamKey(candidate: MikufansOfflineFallbackCandidate): string {
    if (candidate.streamStartedAt && !Number.isNaN(candidate.streamStartedAt.getTime())) {
      return `start:${candidate.streamStartedAt.getTime()}`;
    }
    if (candidate.latestSegmentActivityAt && !Number.isNaN(candidate.latestSegmentActivityAt.getTime())) {
      return `segment:${candidate.latestSegmentActivityAt.getTime()}`;
    }
    return `room:${candidate.roomId}`;
  }

  private async getRoomLiveStatusWithTimeout(
    provider: MikufansOfflineFallbackStatusProvider,
    roomId: string,
    timeoutMs: number
  ): Promise<RoomLiveStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        provider.getRoomLiveStatus(roomId),
        new Promise<RoomLiveStatus>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`room status request timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
