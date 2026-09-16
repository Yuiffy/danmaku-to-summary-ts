import { ConfigProvider } from '../../core/config/ConfigProvider';
import { WeChatWorkNotifier } from '../notification/WeChatWorkNotifier';
import { DanmuRiskControlMonitor } from './DanmuRiskControlMonitor';

jest.mock('../../core/logging/LogManager', () => ({
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

describe('DanmuRiskControlMonitor notifications', () => {
  const intervalMs = 300000;
  const notifyCooldownMs = 1800000;
  let monitor: DanmuRiskControlMonitor;
  let sendMarkdown: jest.Mock;
  let checkRoom: jest.SpyInstance;
  let getConfig: jest.SpyInstance;

  function result(code: number, roomId = '25788785') {
    return {
      roomId, code, message: code === 0 ? 'OK' : String(code),
      isRiskControl: code === -352, timestamp: new Date()
    };
  }

  async function poll(code: number) {
    checkRoom.mockResolvedValue(result(code));
    await (monitor as any).check();
  }

  function nextPoll() {
    jest.setSystemTime(Date.now() + intervalMs);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-13T11:12:39.000Z'));
    getConfig = jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      bilibili: { danmuRiskControl: {
        enabled: true, intervalMs, notifyCooldownMs, roomIds: ['25788785']
      } }
    } as any);
    sendMarkdown = jest.fn().mockResolvedValue(true);
    monitor = new DanmuRiskControlMonitor({ sendMarkdown } as unknown as WeChatWorkNotifier);
    checkRoom = jest.spyOn(monitor as any, 'checkRoom');
  });

  afterEach(() => {
    monitor.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('pairs a risk alert with one recovery notification inside the cooldown', async () => {
    await poll(-352);
    nextPoll();
    await poll(0);
    nextPoll();
    await poll(0);

    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect(sendMarkdown.mock.calls[0][0]).toContain('⚠️ B站弹幕API风控告警');
    const recovery = sendMarkdown.mock.calls[1][0];
    expect(recovery).toContain('✅ B站弹幕API风控恢复');
    expect(recovery).toContain('房间ID: 25788785');
    expect(recovery).toContain('返回码: 0');
    expect(recovery).toContain('19:12:39');
    expect(recovery).toContain('19:17:39');
    expect(recovery).toContain('5分0秒');
  });

  test('does not send recovery for a room that has always been healthy', async () => {
    await poll(0);
    nextPoll();
    await poll(0);
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  test('alerts immediately for a new incident after recovery', async () => {
    await poll(-352);
    nextPoll();
    await poll(0);
    nextPoll();
    await poll(-352);
    nextPoll();
    await poll(0);

    expect(sendMarkdown).toHaveBeenCalledTimes(4);
    expect(sendMarkdown.mock.calls[2][0]).toContain('⚠️ B站弹幕API风控告警');
    expect(sendMarkdown.mock.calls[3][0]).toContain('19:22:39');
    expect(sendMarkdown.mock.calls[3][0]).toContain('5分0秒');
  });

  test('retains the reminder cooldown within one uninterrupted incident', async () => {
    await poll(-352);
    nextPoll();
    await poll(-352);
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + notifyCooldownMs);
    await poll(-352);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    nextPoll();
    await poll(0);
    expect(sendMarkdown.mock.calls[2][0]).toContain('19:12:39');
    expect(sendMarkdown.mock.calls[2][0]).toContain('40分0秒');
  });

  test('does not treat other API failures or thrown checks as recovery', async () => {
    await poll(-352);
    nextPoll();
    await poll(-1);
    checkRoom.mockRejectedValueOnce(new Error('network timeout'));
    await (monitor as any).check();
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    nextPoll();
    await poll(0);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect(sendMarkdown.mock.calls[1][0]).toContain('10分0秒');
  });

  test.each([false, new Error('delivery failed')])('retries an undelivered start alert: %s', async failure => {
    if (failure instanceof Error) sendMarkdown.mockRejectedValueOnce(failure);
    else sendMarkdown.mockResolvedValueOnce(failure);
    await poll(-352);
    nextPoll();
    await poll(-352);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect(sendMarkdown.mock.calls[1][0]).toContain('⚠️ B站弹幕API风控告警');
  });

  test.each([false, new Error('delivery failed')])('retries recovery and preserves the first successful check time: %s', async failure => {
    await poll(-352);
    if (failure instanceof Error) sendMarkdown.mockRejectedValueOnce(failure);
    else sendMarkdown.mockResolvedValueOnce(failure);
    nextPoll();
    await poll(0);
    nextPoll();
    await poll(0);
    nextPoll();
    await poll(0);
    expect(sendMarkdown).toHaveBeenCalledTimes(3);
    expect(sendMarkdown.mock.calls[1][0]).toEqual(sendMarkdown.mock.calls[2][0]);
    expect(sendMarkdown.mock.calls[2][0]).toContain('19:17:39');
  });

  test('a relapse after an undelivered recovery starts a fresh alert immediately', async () => {
    await poll(-352);
    sendMarkdown.mockResolvedValueOnce(false);
    nextPoll();
    await poll(0);
    nextPoll();
    await poll(-352);
    expect(sendMarkdown).toHaveBeenCalledTimes(3);
    expect(sendMarkdown.mock.calls[2][0]).toContain('⚠️ B站弹幕API风控告警');
  });

  test('does not send an orphan recovery when the start alert was never delivered', async () => {
    sendMarkdown.mockResolvedValueOnce(false);
    await poll(-352);
    nextPoll();
    await poll(0);
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    nextPoll();
    await poll(-352);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  test('tracks incident and recovery independently for each room', async () => {
    getConfig.mockReturnValue({ bilibili: { danmuRiskControl: {
      enabled: true, intervalMs, notifyCooldownMs, roomIds: ['25788785', '123']
    } } } as any);
    checkRoom.mockImplementation(async roomId => result(-352, roomId));
    await (monitor as any).check();
    nextPoll();
    checkRoom.mockImplementation(async roomId => result(roomId === '25788785' ? 0 : -352, roomId));
    await (monitor as any).check();
    expect(sendMarkdown).toHaveBeenCalledTimes(3);
    expect(sendMarkdown.mock.calls[2][0]).toContain('房间ID: 25788785');
    nextPoll();
    checkRoom.mockImplementation(async roomId => result(0, roomId));
    await (monitor as any).check();
    expect(sendMarkdown).toHaveBeenCalledTimes(4);
    expect(sendMarkdown.mock.calls[3][0]).toContain('房间ID: 123');
  });
});
