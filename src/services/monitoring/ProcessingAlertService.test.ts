import { ConfigProvider } from '../../core/config/ConfigProvider';
import { ProcessingAlertService } from './ProcessingAlertService';

describe('ProcessingAlertService recorder lifecycle alerts', () => {
  const cooldownMs = 30 * 60 * 1000;
  let sendMarkdown: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-11T17:30:00+08:00'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    sendMarkdown = jest.fn().mockResolvedValue(true);

    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      wechatWork: {
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'
      },
      monitoring: {
        processingAlerts: {
          enabled: true,
          cpuHighPercent: 85,
          mergeSlowSeconds: 480,
          screenshotSlowSeconds: 300,
          asrSlowSeconds: 900,
          streamStartNoFileOpeningSeconds: 300,
          streamEndNoSegmentGraceSeconds: 60,
          finalizationWatchdogGraceSeconds: 60,
          cooldownMs
        }
      }
    } as any);

    (ProcessingAlertService as any).notifier = { sendMarkdown };
    (ProcessingAlertService as any).sentIncidentsAt.clear();
    (ProcessingAlertService as any).lastSentAt.clear();
    (ProcessingAlertService as any).inFlightKeys.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    (ProcessingAlertService as any).notifier = undefined;
    (ProcessingAlertService as any).sentIncidentsAt.clear();
    (ProcessingAlertService as any).lastSentAt.clear();
    (ProcessingAlertService as any).inFlightKeys.clear();
  });

  test('returns lifecycle thresholds from configuration', () => {
    expect(ProcessingAlertService.getThresholds()).toEqual({
      cpuHighPercent: 85,
      mergeSlowSeconds: 480,
      screenshotSlowSeconds: 300,
      asrSlowSeconds: 900,
      streamStartNoFileOpeningSeconds: 300,
      streamEndNoSegmentGraceSeconds: 60,
      finalizationWatchdogGraceSeconds: 60
    });
  });

  test('deduplicates the same incident even after the room cooldown expires', async () => {
    const details = {
      roomId: '26966466',
      streamStartedAt: '2026-08-11T15:00:42.916+08:00'
    };

    await ProcessingAlertService.notifyStreamStartedWithoutFileOpening(details);
    jest.advanceTimersByTime(cooldownMs + 1);
    await ProcessingAlertService.notifyStreamStartedWithoutFileOrSession(details);

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
  });

  test('applies a per-kind room cooldown to different incidents', async () => {
    await ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment({
      roomId: '26966466',
      streamEndedAt: '2026-08-11T17:05:22.358+08:00'
    });
    const secondIncident = {
      roomId: '26966466',
      streamEndedAt: '2026-08-11T17:10:22.358+08:00'
    };

    await ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment(secondIncident);
    expect(sendMarkdown).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(cooldownMs + 1);
    await ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment(secondIncident);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  test('does not share cooldowns between different alert kinds', async () => {
    await ProcessingAlertService.notifyStreamStartedWithoutFileOpening({
      roomId: '25788785',
      streamStartedAt: '2026-08-11T15:00:00+08:00'
    });
    await ProcessingAlertService.notifyFinalizationStuck({
      roomId: '25788785',
      streamEndedAt: '2026-08-11T17:09:31+08:00'
    });

    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  test('retries one failed lifecycle send before entering cooldown', async () => {
    sendMarkdown.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const details = {
      roomId: '31368705',
      streamEndedAt: '2026-08-11T17:12:34.866+08:00'
    };

    const notification = ProcessingAlertService.notifyStreamEndedWithoutCurrentSegment(details);
    await jest.advanceTimersByTimeAsync(1000);
    await notification;

    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect((ProcessingAlertService as any).sentIncidentsAt.size).toBe(1);
    expect((ProcessingAlertService as any).lastSentAt.size).toBe(1);
  });

  test('bounds lifecycle notification retries and leaves failed incidents retryable', async () => {
    sendMarkdown.mockResolvedValue(false);
    const notification = ProcessingAlertService.notifyFinalizationStuck({
      roomId: '31368705',
      streamEndedAt: '2026-08-11T17:12:34.866+08:00'
    });

    await jest.advanceTimersByTimeAsync(1000);
    await notification;

    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect((ProcessingAlertService as any).sentIncidentsAt.size).toBe(0);
    expect((ProcessingAlertService as any).lastSentAt.size).toBe(0);
    expect((ProcessingAlertService as any).inFlightKeys.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('writes an audit log after WeChat Work confirms delivery', async () => {
    const info = jest.spyOn((ProcessingAlertService as any).logger, 'info').mockImplementation(() => undefined);
    await ProcessingAlertService.notifyFinalizationStuck({
      roomId: '26966466',
      streamEndedAt: '2026-08-11T17:05:25.855+08:00'
    });

    expect(info).toHaveBeenCalledWith('处理性能提醒已发送', {
      title: 'Mikufans 收尾流程疑似悬挂',
      incidentKey: 'mikufans-finalization-stuck:26966466:2026-08-11T17:05:25.855+08:00'
    });
  });

  test('coalesces concurrent sends for the same incident', async () => {
    let finishSend!: (sent: boolean) => void;
    sendMarkdown.mockReturnValue(new Promise<boolean>(resolve => {
      finishSend = resolve;
    }));
    const details = {
      roomId: '26966466',
      streamEndedAt: '2026-08-11T17:05:22.358+08:00'
    };

    const first = ProcessingAlertService.notifyFinalizationStuck(details);
    const second = ProcessingAlertService.notifyFinalizationStuck(details);
    finishSend(true);
    await Promise.all([first, second]);

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect((ProcessingAlertService as any).inFlightKeys.size).toBe(0);
  });

});
