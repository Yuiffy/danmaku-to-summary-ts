import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import fetch from 'node-fetch';
import { loadConfigLayers } from '../../../core/config/ConfigLayers';
import { WeChatWorkNotifier } from '../../notification/WeChatWorkNotifier';
import { createReminderAdapters, readReminderRoomStatus, writeReminderState } from './ReminderRuntime';
import { initialReminderState, LiveReminderConfig } from './ReminderPolicy';

jest.mock('../../../core/config/ConfigLayers', () => ({ loadConfigLayers: jest.fn() }));
jest.mock('../../notification/WeChatWorkNotifier', () => ({ WeChatWorkNotifier: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());
const roomId = '25788785';

it('reads the actual stream start and activity metadata without adding a danmaku connection', async () => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { room_info: {
    room_id: 25788785, live_status: 1, live_start_time: 1791633600,
    title: '杂谈', area_name: '虚拟日常', parent_area_name: '虚拟主播'
  } } }) })) as unknown as typeof fetch;
  await expect(readReminderRoomStatus(roomId, transport)).resolves.toEqual({
    roomId, live: true, startedAt: 1791633600000, title: '杂谈', area: '虚拟日常', parentArea: '虚拟主播'
  });
  expect(transport).toHaveBeenCalledWith(expect.stringContaining(`room_id=${roomId}`), expect.objectContaining({ redirect: 'error', signal: expect.anything() }));
});

it.each([
  { code: -352 }, { code: 0, data: {} },
  { code: 0, data: { room_info: { room_id: 1, live_status: 1 } } }
])('refuses unavailable or mismatched metadata: %j', async body => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
  await expect(readReminderRoomStatus(roomId, transport)).rejects.toThrow();
});

it('persists atomically, isolates dry-run operator state, and records live results through the existing notifier', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-reminders-'));
  const log = jest.spyOn(console, 'log').mockImplementation();
  const notify = jest.fn(async () => true);
  (loadConfigLayers as jest.Mock).mockReturnValue({ wechatWork: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture' } });
  (WeChatWorkNotifier as jest.Mock).mockImplementation(() => ({ sendText: notify }));
  const config: LiveReminderConfig = { enabled: true, roomId, statePath: path.join(directory, 'state.json'), notificationConfigPath: path.join(directory, 'config.json') };
  try {
    const state = initialReminderState();
    writeReminderState(config.statePath, state);
    const dry = createReminderAdapters(config, false)!;
    const changed = dry.load(); changed.enabled = false; dry.save(changed);
    expect(JSON.parse(fs.readFileSync(config.statePath, 'utf8')).enabled).toBe(true);
    expect(fs.existsSync(`${config.statePath}.dry-run`)).toBe(true);
    const record = { roomId, day: '2026-10-10', id: 'medicine', name: '吃药', at: Date.now(), text: '反流的药按医嘱吃呀', status: 'sent' as const, notified: false };
    await dry.notify(record);
    expect(notify).not.toHaveBeenCalled();
    const live = createReminderAdapters(config, true)!;
    await live.notify(record);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('弹幕发送成功'));
    await live.notify({ ...record, status: 'attempted' });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('发送未确认，不自动重发'));
    expect(fs.readdirSync(directory).some(file => file.endsWith('.tmp'))).toBe(false);
    fs.writeFileSync(config.statePath, '{corrupt');
    expect(() => live.load()).toThrow();
  } finally { log.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it('requires explicit notification credentials only when enabled', () => {
  expect(createReminderAdapters(undefined, true)).toBeUndefined();
  expect(createReminderAdapters({ enabled: false, roomId, statePath: '', notificationConfigPath: '' }, true)).toBeUndefined();
  (loadConfigLayers as jest.Mock).mockReturnValue({});
  expect(() => createReminderAdapters({ enabled: true, roomId, statePath: path.resolve('ignored-state'), notificationConfigPath: path.resolve('ignored-config') }, true)).toThrow('wechatWork.webhookUrl');
});

it('reloads the existing bot cookie for metadata requests without sending danmaku or notifications', async () => {
  const notify = jest.fn(async () => true);
  (WeChatWorkNotifier as jest.Mock).mockImplementation(() => ({ sendText: notify }));
  (loadConfigLayers as jest.Mock).mockReturnValue({ wechatWork: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture' } });
  (fetch as unknown as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: {
    room_info: { room_id: 25788785, live_status: 0, live_start_time: 0 }
  } }) });
  let cookie = 'DedeUserID=99; SESSDATA=old';
  const adapters = createReminderAdapters({ enabled: true, roomId, statePath: path.resolve('ignored-state'),
    notificationConfigPath: path.resolve('ignored-config') }, true, () => cookie)!;
  await adapters.status(roomId);
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('getInfoByRoom'), expect.objectContaining({
    headers: expect.objectContaining({ Cookie: cookie, Origin: 'https://live.bilibili.com', 'User-Agent': expect.stringContaining('Chrome/') })
  }));
  cookie = 'DedeUserID=99; SESSDATA=rotated';
  await adapters.status(roomId);
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('getInfoByRoom'), expect.objectContaining({
    headers: expect.objectContaining({ Cookie: cookie })
  }));
  expect(notify).not.toHaveBeenCalled();
});
