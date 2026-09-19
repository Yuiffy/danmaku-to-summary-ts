import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecorderLogSource } from './RecorderLogSource';

describe('RecorderLogSource', () => {
  let root: string, filename: string, stateFile: string, now: number, started: number;
  let source: RecorderLogSource;
  const pid = 123;
  const identity = async (processId = pid) => fs.writeFile(stateFile, JSON.stringify({
    phase: 'healthy', heartbeatAt: now, lastSeen: { pid: processId, startedAt: new Date(started).toISOString(), observedAt: now, executablePath: path.join(root, 'recorder.exe') }
  }));
  const row = (message: string, fields: object = {}) => JSON.stringify({ '@t': new Date(now).toISOString(), '@mt': message, ProcessId: pid, ...fields }) + '\n';
  const roomRow = (liveStatus = 1) => row('拉取房间信息成功: {@room}', {
    RoomId: 25788785, room: { Room: { LiveStatus: liveStatus, Uid: 1954091502, Title: '岁己', RoomId: 25788785 } }
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-log-test-'));
    filename = path.join(root, 'bilirec20260919.txt');
    stateFile = path.join(root, 'state.json');
    now = Date.now(); started = now - 60000;
    await identity();
    await fs.writeFile(filename, '');
    source = new RecorderLogSource({ logDirectory: root, recorderStatePath: stateFile, now: () => now, isAlive: () => true });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('only the actual current process can contribute events, never the largest PID', async () => {
    await fs.writeFile(filename, row('弹幕认证成功: 房间 {RoomId}', { ProcessId: 99999, RoomId: 25788785 }) +
      row('Bilibili API -352 cooldown: {Endpoint}, RetryAt={RetryAt}', { Endpoint: 'getDanmuInfo' }) + roomRow());
    const result = await source.read();
    expect(result.events.map(e => e.kind)).toEqual(['risk', 'api-success']);
    expect(result.rooms.get('25788785')?.isLive).toBe(true);
    expect(result.identity.startsWith('123:')).toBe(true);
  });

  test('incremental reads retain incomplete UTF-8 lines and ignore malformed JSON', async () => {
    const encoded = Buffer.from(roomRow());
    const split = encoded.indexOf(Buffer.from('岁')) + 1;
    await fs.writeFile(filename, encoded.subarray(0, split));
    expect((await source.read()).rooms.size).toBe(0);
    await fs.appendFile(filename, Buffer.concat([encoded.subarray(split), Buffer.from('invalid-json\n')]));
    now += 1001;
    const result = await source.read();
    expect(result.rooms.get('25788785')?.title).toBe('岁己');
    const ids = result.events.map(e => e.id);
    now += 1001;
    expect((await source.read()).events.map(e => e.id)).toEqual(ids);
  });

  test('handles rotation and same-file truncation without losing new events', async () => {
    await fs.writeFile(filename, roomRow() + row('弹幕认证成功: 房间 {RoomId}', { RoomId: 25788785 }));
    await source.read();
    now += 1001;
    await fs.writeFile(path.join(root, 'bilirec20260920.txt'), roomRow(0));
    expect((await source.read()).rooms.get('25788785')?.isLive).toBe(false);
    now += 1001;
    await fs.writeFile(filename, row('弹幕认证成功: 房间 {RoomId}', { RoomId: 25788785 }));
    expect((await source.read()).events.filter(e => e.kind === 'connected')).toHaveLength(2);
  });

  test('copied rotation records have stable identities across source restarts', async () => {
    const risk = row('Bilibili API -352 cooldown: {Endpoint}, RetryAt={RetryAt}', { Endpoint: 'getDanmuInfo' });
    await fs.writeFile(filename, risk);
    const first = (await source.read()).events[0].id;
    await fs.rename(filename, path.join(root, 'bilirec20260919_001.txt'));
    source = new RecorderLogSource({ logDirectory: root, recorderStatePath: stateFile, now: () => now, isAlive: () => true });
    expect((await source.read()).events[0].id).toBe(first);
  });

  test('a recorder restart clears old room state and rejects reused-PID historical records', async () => {
    await fs.writeFile(filename, roomRow());
    await source.read();
    now += 5000; started = now;
    await identity();
    await fs.utimes(filename, new Date(now), new Date(now));
    expect((await source.read()).rooms.size).toBe(0);
    await expect(source.getRoomLiveStatus('25788785')).rejects.toThrow('新鲜');
  });

  test('stale process state, missing files, and stale room observations remain unknown', async () => {
    await fs.writeFile(filename, roomRow());
    await source.read();
    now += 121000;
    await expect(source.read()).rejects.toThrow('过期');
    now += 10 * 60000;
    await identity();
    await expect(source.getRoomLiveStatus('25788785')).rejects.toThrow('新鲜');
    await fs.unlink(filename);
    now += 1001;
    await expect(source.read()).rejects.toThrow('没有找到');
  });

  test('cannot use a dead process even when its log and watchdog heartbeat look fresh', async () => {
    source = new RecorderLogSource({ logDirectory: root, recorderStatePath: stateFile, now: () => now, isAlive: () => false });
    await fs.writeFile(filename, roomRow());
    await expect(source.read()).rejects.toThrow('进程身份');
  });

  test('API scopes and connection authentication are distinct and raw secrets are never retained', async () => {
    await fs.writeFile(filename, row('Bilibili API risk-control recovered: {Endpoint}', { Endpoint: 'getInfoByRoom' }) +
      row('连接弹幕服务器时出错，下次重试至少等待 {RetryDelaySeconds} 秒', { RoomId: 25788785, ExceptionDetail: { Type: 'Polly.CircuitBreaker.BrokenCircuitException', Message: 'secret-cookie' } }) +
      row('弹幕认证成功: 房间 {RoomId}', { RoomId: 25788785, Token: 'secret-token' }));
    const result = await source.read();
    expect(result.events.map(e => e.kind)).toEqual(['api-recovered', 'connected']);
    expect(JSON.stringify(result.events)).not.toContain('secret');
  });
});
