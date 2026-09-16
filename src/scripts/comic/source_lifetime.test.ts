const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { once } = require('events');
const { retainComicSource, cleanupAbandonedSourceAliases } = require('./source_lifetime');

describe('comic source lifetime', () => {
  let directory;
  let original;
  let tempRoot;
  const log = jest.fn();
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-lifetime-'));
    original = path.join(directory, 'recording.flv');
    tempRoot = path.join(directory, 'temp');
    fs.writeFileSync(original, Buffer.alloc(64 * 1024, 42));
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); jest.restoreAllMocks(); });

  test('keeps the identical file readable after a second process deletes the original name', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    expect(snapshot).not.toBeNull();
    expect(fs.statSync(snapshot.path).ino).toBe(fs.statSync(original).ino);
    expect(fs.statSync(original).nlink).toBeGreaterThanOrEqual(2);
    await promisify(execFile)(process.execPath, ['-e', 'require("fs").unlinkSync(process.argv[1])', original], { windowsHide: true });
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(snapshot.path)).toEqual(Buffer.alloc(64 * 1024, 42));
    await snapshot.release();
    expect(fs.existsSync(snapshot.path)).toBe(false);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
    await snapshot.release();
  });

  test('releasing an alias never removes the original video', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    snapshot.readerStarting();
    await snapshot.release();
    expect(fs.readFileSync(original)).toEqual(Buffer.alloc(64 * 1024, 42));
    expect(fs.existsSync(snapshot.path)).toBe(false);
  });

  test('uses the live OS reader process to prevent deletion until its read finishes', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    snapshot.readerStarting();
    const reader = spawn(process.execPath, ['-e',
      'process.stdin.once("data",()=>{process.stdout.write(String(require("fs").readFileSync(process.argv[1]).length));process.exit(0);});',
      snapshot.path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    reader.stdout.on('data', data => { output += data.toString(); });
    const closed = once(reader, 'close');
    try {
      await once(reader, 'spawn');
      snapshot.registerReader(reader.pid);
      fs.unlinkSync(original);
      await snapshot.release();
      expect(fs.existsSync(snapshot.path)).toBe(true);
      reader.stdin.write('read');
      expect((await closed)[0]).toBe(0);
      expect(output).toBe(String(64 * 1024));
      const ownerPath = path.join(path.dirname(snapshot.path), 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, parentPid: reader.pid }));
      expect(await cleanupAbandonedSourceAliases(tempRoot, { log })).toBe(1);
      expect(fs.existsSync(snapshot.path)).toBe(false);
    } finally {
      if (reader.exitCode === null) reader.kill();
      await closed;
    }
  });

  test('does not copy media or allow overlap when hard links are unsupported', async () => {
    const link = jest.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('cross device'), { code: 'EXDEV' }));
    const copy = jest.spyOn(fs.promises, 'copyFile');
    expect(await retainComicSource(original, tempRoot, { log })).toBeNull();
    expect(link).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  test('falls back when the source changes while its alias is created', async () => {
    const originalLink = fs.promises.link.bind(fs.promises);
    jest.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      fs.appendFileSync(source, 'new recording bytes');
      return originalLink(source, destination);
    });
    expect(await retainComicSource(original, tempRoot, { log })).toBeNull();
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  test('retains files while the reader is alive and recovers only after both owners exit', async () => {
    const alive = jest.fn().mockReturnValue(true);
    const snapshot = await retainComicSource(original, tempRoot, { log, processIsAlive: alive });
    snapshot.readerStarting(); snapshot.registerReader(12345);
    await snapshot.release();
    expect(fs.existsSync(snapshot.path)).toBe(true);
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: alive })).toBe(0);
    alive.mockImplementation(pid => pid === 12345);
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: alive })).toBe(0);
    alive.mockReturnValue(false);
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: alive })).toBe(1);
    expect(fs.existsSync(snapshot.path)).toBe(false);
    expect(fs.existsSync(original)).toBe(true);
  });

  test('retains an unknown launch outcome instead of assuming no reader started', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    snapshot.readerStarting();
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: () => false })).toBe(0);
    expect(fs.existsSync(snapshot.path)).toBe(true);
    await snapshot.release();
  });

  test('does not abort a live reader when persisting its PID fails', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    snapshot.readerStarting();
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk write failed'); });
    expect(() => snapshot.registerReader(process.pid)).not.toThrow();
    write.mockRestore();
    await snapshot.release();
    expect(fs.existsSync(snapshot.path)).toBe(true);
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: () => false })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not persisted'));
  });

  test('will not delete a replacement file at a formerly owned alias path', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    fs.unlinkSync(snapshot.path);
    fs.writeFileSync(snapshot.path, 'unrelated replacement');
    await snapshot.release();
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe('unrelated replacement');
    expect(fs.existsSync(original)).toBe(true);
  });

  test('does not follow directory links or treat corrupt reader ownership as an exited process', async () => {
    const snapshot = await retainComicSource(original, tempRoot, { log });
    const ownerPath = path.join(path.dirname(snapshot.path), 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, host: `${os.hostname()}-another-host` }));
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: () => false })).toBe(0);
    expect(fs.existsSync(snapshot.path)).toBe(true);
    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, readerPid: 'unknown' }));
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: () => false })).toBe(0);
    expect(fs.existsSync(snapshot.path)).toBe(true);
    fs.writeFileSync(ownerPath, JSON.stringify(owner));
    const moved = path.join(tempRoot, 'unrelated-directory');
    const originalDirectory = path.dirname(snapshot.path);
    fs.renameSync(originalDirectory, moved);
    fs.symlinkSync(moved, originalDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await cleanupAbandonedSourceAliases(tempRoot, { log, processIsAlive: () => false })).toBe(0);
    await snapshot.release();
    expect(fs.existsSync(path.join(moved, 'source.flv'))).toBe(true);
  });
});
