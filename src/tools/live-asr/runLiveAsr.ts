import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { LiveAsrConfig, LiveAsrRunner, saveLiveAsrStatus, startLiveAsrWorker } from '../../services/live-asr/LiveAsrRunner';

export async function runLiveAsr(): Promise<void> {
  const project = getProjectRoot();
  const loaded = loadConfigLayers({ root: project }) as { asr?: { live?: LiveAsrConfig; paraformer?: Record<string, unknown> } };
  const config = loaded.asr?.live;
  if (!config?.enabled) { console.info('CPU live ASR disabled'); return; }
  const options = loaded.asr?.paraformer || {};
  const profile = options.model_profile;
  if (profile && profile !== 'default') throw new Error('CPU live ASR currently supports the default Paraformer profile only');
  const directory = path.join(project, 'data/runtime/live-asr');
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, 'runner.lock');
  try {
    const pid = Number(await fs.readFile(lock, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`Live ASR runner already active: ${pid}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await fs.unlink(lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
  const controller = new AbortController();
  const runner = new LiveAsrRunner(config, options,
    () => startLiveAsrWorker(project, config.python_executable || String(options.python_executable || 'python')),
    undefined, saveLiveAsrStatus(path.join(directory, 'status.json')));
  const stop = () => { controller.abort(); runner.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      let backlog = false, failed = false;
      try { backlog = await runner.tick(); }
      catch (error) { failed = true; console.error(error); await saveLiveAsrStatus(path.join(directory, 'status.json'))({ phase: 'error', error: String(error), at: Date.now() }); }
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) { resolve(); return; }
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, failed ? 30000 : backlog ? 250 : 5000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally { runner.close(); await fs.unlink(lock); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (require.main === module) runLiveAsr().catch(error => { console.error(error); process.exitCode = 1; });
