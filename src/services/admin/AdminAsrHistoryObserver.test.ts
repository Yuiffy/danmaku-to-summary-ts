import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminAsrHistoryObserver } from './AdminAsrHistoryObserver';
import { queryAsrHistory } from './AdminAsrHistoryIndex';
import { atomicJson, readText } from './AdminFiles';

let root: string, observer: AdminAsrHistoryObserver | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-observer-')); });
afterEach(() => { observer?.close(); fs.rmSync(root, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('takes one queue snapshot per pass, reuses unchanged sidecars, refreshes a changed file', async () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), mediaPath: path.join(root, `${i}.flv`), status: 'completed' }));
  tasks.forEach(task => atomicJson(task.mediaPath.replace('.flv', '.asr_meta.json'), { elapsedSeconds: 10 }));
  const loadTasks = jest.fn(() => tasks), readSidecar = jest.fn(readText), backfill = jest.fn(async () => 0);
  const historyFile = path.join(root, 'history.sqlite');
  observer = new AdminAsrHistoryObserver({ queueFile: 'injected', historyFile, roots: () => [root], loadTasks, readSidecar, backfill });
  observer.start(); await observer.sync(); await tick(); await observer.sync();
  loadTasks.mockClear(); readSidecar.mockClear();
  const first = observer.sync(); expect(observer.sync()).toBe(first); await first;
  expect(loadTasks).toHaveBeenCalledTimes(1); expect(readSidecar).not.toHaveBeenCalled();
  atomicJson(path.join(root, '0.asr_meta.json'), { elapsedSeconds: 234 });
  await observer.sync(); expect(readSidecar).toHaveBeenCalledTimes(1);
  expect(queryAsrHistory(historyFile).total).toBe(1000);
  const found = Array.from({ length: 20 }, (_, i) => queryAsrHistory(historyFile, i + 1, 50).items).flat().find(item => item.id === '0');
  expect(found?.elapsedSeconds).toBe(234);
});

test('retries temporary read failures and keeps prior history when a queue read fails', async () => {
  const source = path.join(root, 'a.asr_meta.json'); atomicJson(source, { elapsedSeconds: 10 });
  const task = { id: 'a', mediaPath: path.join(root, 'a.flv'), status: 'completed' };
  const loadTasks = jest.fn(() => [task]), diagnostic = jest.fn();
  const readSidecar = jest.fn(readText).mockImplementationOnce(() => { throw new Error('transient'); });
  const historyFile = path.join(root, 'history.sqlite');
  observer = new AdminAsrHistoryObserver({ queueFile: 'injected', historyFile, roots: () => [root], loadTasks, readSidecar,
    backfill: async () => 0, diagnostic });
  observer.start(); await observer.sync(); await tick(); await observer.sync();
  expect(queryAsrHistory(historyFile).items[0].metadata).toBe('available');
  loadTasks.mockImplementationOnce(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); });
  await observer.sync();
  expect(diagnostic).toHaveBeenCalledWith('sync', { name: 'Error', code: 'EACCES' });
  expect(queryAsrHistory(historyFile).total).toBe(1);
});

test('closing during a yielded pass stops writes and a restarted observer can synchronize', async () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: String(i), mediaPath: path.join(root, `${i}.flv`), status: 'failed' }));
  const diagnostic = jest.fn(), backfill = jest.fn(async () => 0);
  observer = new AdminAsrHistoryObserver({ queueFile: 'injected', historyFile: path.join(root, 'history.sqlite'), roots: () => [root],
    loadTasks: () => tasks, backfill, diagnostic });
  observer.start(); const old = observer.sync(); observer.close(); observer.start();
  await old; await observer.sync(); await tick(); await observer.sync();
  expect(diagnostic).not.toHaveBeenCalled();
  expect(queryAsrHistory(path.join(root, 'history.sqlite')).total).toBe(100);
});
