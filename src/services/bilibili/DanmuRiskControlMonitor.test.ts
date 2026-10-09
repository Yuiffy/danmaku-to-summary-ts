import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { DanmuRiskControlMonitor } from './DanmuRiskControlMonitor';
import { RecorderLogEvent, RecorderLogSnapshot } from '../monitoring/RecorderLogSource';
import { spawnPython } from '../../utils/pythonProcess';

jest.mock('../../utils/pythonProcess', () => ({ spawnPython: jest.fn() }));
jest.mock('../../core/logging/LogManager', () => ({ getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

describe('DanmuRiskControlMonitor from recorder logs', () => {
  let root: string, statePath: string, now: number, sequence: number;
  let snapshot: RecorderLogSnapshot, source: { read: jest.Mock }, sendMarkdown: jest.Mock;
  let monitor: DanmuRiskControlMonitor;
  const event = (kind: RecorderLogEvent['kind'], target = 'getDanmuInfo'): void => {
    snapshot.events.push({ id: String(++sequence), at: now, kind,
      ...(kind === 'connected' || kind === 'disconnected' ? { roomId: target } : { endpoint: target }) });
  };
  const poll = () => (monitor as any).check();
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-monitor-test-'));
    statePath = path.join(root, 'state.json'); now = Date.now(); sequence = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({ bilibili: { danmuRiskControl: {
      enabled: true, intervalMs: 1800000, notifyCooldownMs: 1800000, roomIds: ['25788785'], monitorStatePath: statePath
    } } } as any);
    snapshot = { identity: 'process-1', events: [], rooms: new Map() };
    source = { read: jest.fn(async () => snapshot) }; sendMarkdown = jest.fn().mockResolvedValue(true);
    monitor = new DanmuRiskControlMonitor({ sendMarkdown } as any, source);
    await monitor.start();
  });
  afterEach(async () => { monitor.stop(); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  test('pairs real API risk/recovery events, deduplicates repeated reads and never spawns a probe', async () => {
    now += 1000; event('risk'); await poll();
    now += 300000; event('api-recovered'); await poll(); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    expect(sendMarkdown.mock.calls[0][0]).toContain('接口: getDanmuInfo');
    expect(sendMarkdown.mock.calls[1][0]).toContain('5分0秒');
    expect(spawnPython).not.toHaveBeenCalled();
  });

  test('does not replay historical errors when installed for the first time', async () => {
    snapshot.events = [{ id: 'old-risk', at: now - 10000, kind: 'risk', endpoint: 'getDanmuInfo' }];
    await poll(); expect(sendMarkdown).not.toHaveBeenCalled();
  });

  test('restart resumes the cursor without duplicate alerts and preserves pending recovery', async () => {
    now += 1000; event('risk'); await poll();
    monitor.stop(); monitor = new DanmuRiskControlMonitor({ sendMarkdown } as any, source);
    await monitor.start(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
    now += 1000; event('api-recovered'); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  test('room info, cached tokens and connection authentication cannot clear a shared API cooldown', async () => {
    now += 1000; event('risk'); await poll();
    now += 1000; event('api-success', 'getInfoByRoom'); event('api-success'); event('connected', '25788785'); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    snapshot.identity = 'process-2'; now += 1000; event('api-success'); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  test('records a short outage without alerting and pairs a sustained outage with authenticated recovery', async () => {
    now += 1000; event('disconnected', '25788785'); await poll();
    now += 10000; event('connected', '25788785'); await poll();
    expect(sendMarkdown).not.toHaveBeenCalled();
    now += 1000; event('disconnected', '25788785'); await poll();
    now += 60000; await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
    now += 1000; event('api-recovered'); await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
    event('connected', '25788785'); await poll();
    expect(sendMarkdown.mock.calls[1][0]).toContain('弹幕连接恢复');
  });

  test('delivers start before recovery after a notification failure without new log lines', async () => {
    sendMarkdown.mockResolvedValueOnce(false);
    now += 1000; event('risk'); await poll();
    now += 1000; event('api-recovered'); await poll(); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(3);
    expect(sendMarkdown.mock.calls[0][0]).toEqual(sendMarkdown.mock.calls[1][0]);
    expect(sendMarkdown.mock.calls[2][0]).toContain('恢复');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).outbox).toEqual([]);
  });

  test('missing logs cannot announce recovery and unmonitored room failures are ignored', async () => {
    now += 1000; event('risk'); event('disconnected', '999'); await poll();
    source.read.mockRejectedValueOnce(new Error('missing log'));
    now += 1800000; await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
    await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
  });

  test('repeated risk events respect cooldown, but a real relapse starts a new incident', async () => {
    now += 1000; event('risk'); await poll();
    now += 1000; event('risk'); await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(1);
    now += 1800000; event('risk'); await poll(); expect(sendMarkdown).toHaveBeenCalledTimes(2);
    now += 1000; event('api-recovered'); event('risk'); await poll();
    expect(sendMarkdown).toHaveBeenCalledTimes(4);
  });
});
