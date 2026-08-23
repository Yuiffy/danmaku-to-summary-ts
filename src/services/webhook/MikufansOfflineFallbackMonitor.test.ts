import { ConfigProvider } from '../../core/config/ConfigProvider';
import {
  MikufansOfflineFallbackCandidate,
  MikufansOfflineFallbackMonitor
} from './MikufansOfflineFallbackMonitor';
import { RoomLiveStatus } from '../bilibili/interfaces/types';

function candidate(latestSegmentActivityAt = new Date('2026-08-23T12:00:00.000Z')): MikufansOfflineFallbackCandidate {
  return {
    roomId: '25788785',
    roomName: 'SUI',
    title: 'live',
    segmentCount: 1,
    streamStartedAt: new Date('2026-08-23T10:00:00.000Z'),
    latestSegmentActivityAt
  };
}

function offlineStatus(): RoomLiveStatus {
  return {
    roomId: '25788785',
    liveStatus: 0,
    isLive: false
  };
}

describe('MikufansOfflineFallbackMonitor', () => {
  let getConfig: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    getConfig = jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      webhook: {
        mikufansOfflineFallback: {
          enabled: true,
          pollIntervalSeconds: 60,
          offlineConfirmations: 3,
          offlineGraceSeconds: 180,
          apiTimeoutMs: 1000
        }
      }
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('requires repeated offline checks and an idle segment grace period', async () => {
    const provider = { getRoomLiveStatus: jest.fn().mockResolvedValue(offlineStatus()) };
    const trigger = jest.fn().mockResolvedValue(undefined);
    const monitor = new MikufansOfflineFallbackMonitor(() => [candidate()], trigger);
    monitor.setProvider(provider);

    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 1000);
    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();

    jest.advanceTimersByTime(120 * 1000);
    await monitor.pollOnce();

    expect(provider.getRoomLiveStatus).toHaveBeenCalledTimes(3);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toMatchObject({
      consecutiveConfirmations: 3,
      offlineGraceSeconds: 180
    });
  });

  test('resets the offline streak when the room comes back online', async () => {
    const provider = { getRoomLiveStatus: jest.fn() };
    provider.getRoomLiveStatus
      .mockResolvedValueOnce(offlineStatus())
      .mockResolvedValueOnce({ ...offlineStatus(), liveStatus: 1, isLive: true })
      .mockResolvedValue(offlineStatus());
    const trigger = jest.fn().mockResolvedValue(undefined);
    const monitor = new MikufansOfflineFallbackMonitor(() => [candidate()], trigger);
    getConfig.mockReturnValue({
      webhook: {
        mikufansOfflineFallback: {
          enabled: true,
          offlineConfirmations: 2,
          offlineGraceSeconds: 0,
          pollIntervalSeconds: 60,
          apiTimeoutMs: 1000
        }
      }
    } as any);
    monitor.setProvider(provider);

    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();

    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();
    await monitor.pollOnce();
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  test('restarts the grace period when a new segment is observed', async () => {
    let latestActivity = new Date('2026-08-23T12:00:00.000Z');
    const provider = { getRoomLiveStatus: jest.fn().mockResolvedValue(offlineStatus()) };
    const trigger = jest.fn().mockResolvedValue(undefined);
    const monitor = new MikufansOfflineFallbackMonitor(() => [candidate(latestActivity)], trigger);
    getConfig.mockReturnValue({
      webhook: {
        mikufansOfflineFallback: {
          enabled: true,
          offlineConfirmations: 2,
          offlineGraceSeconds: 120,
          pollIntervalSeconds: 60,
          apiTimeoutMs: 1000
        }
      }
    } as any);
    monitor.setProvider(provider);

    await monitor.pollOnce();
    jest.advanceTimersByTime(60 * 1000);
    latestActivity = new Date('2026-08-23T12:01:00.000Z');
    await monitor.pollOnce();
    jest.advanceTimersByTime(60 * 1000);
    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 1000);
    await monitor.pollOnce();
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  test('does not count a failed status request as offline confirmation', async () => {
    const provider = { getRoomLiveStatus: jest.fn() };
    provider.getRoomLiveStatus
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue(offlineStatus());
    const trigger = jest.fn().mockResolvedValue(undefined);
    const monitor = new MikufansOfflineFallbackMonitor(() => [candidate()], trigger);
    getConfig.mockReturnValue({
      webhook: {
        mikufansOfflineFallback: {
          enabled: true,
          offlineConfirmations: 2,
          offlineGraceSeconds: 0,
          pollIntervalSeconds: 60,
          apiTimeoutMs: 1000
        }
      }
    } as any);
    monitor.setProvider(provider);

    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();
    await monitor.pollOnce();
    expect(trigger).not.toHaveBeenCalled();
    await monitor.pollOnce();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
