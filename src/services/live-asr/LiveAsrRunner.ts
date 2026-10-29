import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { atomicLiveJson } from './LiveAsrStorage';

export interface LiveAsrConfig {
  enabled: boolean;
  /** Explicit opt-in; empty roots never mean all recorded rooms. */
  room_roots: Record<string, string[]>;
  room_ids: string[];
  python_executable?: string;
  idle_release_s?: number;
}
export interface LiveAsrReply {
  ok: boolean; error?: string; cursor?: number; duration?: number; waiting?: boolean;
  extend?: boolean; elapsed_s?: number; cuda_initialized?: boolean; segments?: number;
}
export interface LiveAsrWorker {
  request(value: unknown): Promise<LiveAsrReply>;
  close(): void;
}

export function validateLiveAsrConfig(config: LiveAsrConfig): void {
  if (!config || typeof config.enabled !== 'boolean') throw new Error('Invalid asr.live configuration');
  if (!config.enabled) return;
  if (!Array.isArray(config.room_ids) || config.room_ids.length !== 1 || !/^[1-9]\d*$/u.test(config.room_ids[0]) ||
      !config.room_roots || Object.keys(config.room_roots).some(id => !config.room_ids.includes(id)) ||
      !config.room_roots[config.room_ids[0]]?.length ||
      Object.values(config.room_roots).some(roots => !Array.isArray(roots) || roots.some(root => !path.isAbsolute(root)))) {
    throw new Error('Live ASR currently requires exactly one explicitly configured room');
  }
}

export function startLiveAsrWorker(project: string, executable: string): LiveAsrWorker {
  const child: ChildProcessWithoutNullStreams = spawn(executable,
    ['-u', path.join(project, 'src/scripts/python/live_asr_worker.py')], {
      cwd: project, shell: false, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' }
    });
  child.stderr.on('data', data => process.stderr.write(data));
  let pending: { resolve: (result: LiveAsrReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  let exited = false;
  const fail = (error: Error) => {
    exited = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!pending) return;
    const current = pending; pending = undefined; clearTimeout(current.timer);
    try { current.resolve(JSON.parse(line)); }
    catch { current.reject(new Error('Invalid CPU live ASR worker reply')); child.kill(); }
  });
  child.on('error', fail);
  child.on('close', code => fail(new Error(`CPU live ASR worker exited: ${code}`)));
  return {
    request(value) {
      if (pending || exited) return Promise.reject(new Error('CPU live ASR worker unavailable'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error('CPU live ASR worker timed out')); child.kill(); }, 180000);
        pending = { resolve, reject, timer };
        child.stdin.write(JSON.stringify(value) + '\n', error => { if (error) fail(error); });
      });
    },
    close() { fail(new Error('CPU live ASR worker stopped')); lines.close(); child.stdin.end(); child.kill(); }
  };
}

/** Only recent original recordings in room-owned roots; never recursively scan archives/bak. */
export async function findLiveAsrSources(config: LiveAsrConfig, now = Date.now()): Promise<Array<{ source: string; room_id: string }>> {
  const sources: Array<{ source: string; room_id: string; mtime: number }> = [];
  if (!config.enabled) return [];
  for (const room of config.room_ids) for (const root of config.room_roots[room]) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const folders = [root, ...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{4}_\d{2}_\d{2}$/u.test(entry.name))
      .map(entry => path.join(root, entry.name)).sort().reverse().slice(0, 2)];
    for (const folder of folders) {
      const files = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of files) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(`录制-${room}-`) ||
            /_merged\b/iu.test(entry.name) || !/\.(flv|ts|mkv|mp4)$/iu.test(entry.name)) continue;
        const source = path.join(folder, entry.name), stat = await fs.stat(source);
        if (stat.size >= 131072 && now - stat.mtimeMs < 90000 && now >= stat.mtimeMs - 5000) sources.push({ source, room_id: room, mtime: stat.mtimeMs });
      }
    }
  }
  return sources.sort((a, b) => b.mtime - a.mtime).slice(0, 1).map(({ source, room_id }) => ({ source, room_id }));
}

/** Single serial worker and bounded CPU threads; model is released while the room is idle. */
export class LiveAsrRunner {
  private worker?: LiveAsrWorker;
  private lastWork = 0;
  private extended = new Set<string>();
  constructor(private config: LiveAsrConfig, private readonly options: Record<string, unknown>,
    private readonly makeWorker: () => LiveAsrWorker,
    private readonly discover = findLiveAsrSources,
    private readonly status?: (value: unknown) => Promise<void>) { validateLiveAsrConfig(config); }

  async tick(now = Date.now()): Promise<boolean> {
    const sources = await this.discover(this.config, now);
    if (!sources.length) {
      if (this.worker && now - this.lastWork >= (this.config.idle_release_s ?? 120) * 1000) this.close();
      await this.status?.({ phase: 'idle', model_loaded: !!this.worker, at: now });
      return false;
    }
    this.worker ??= this.makeWorker();
    this.lastWork = now;
    try {
      const item = sources[0];
      const reply = await this.worker.request({ ...item, options: this.options, window_s: this.extended.has(item.source) ? 120 : 60 });
      if (!reply.ok) throw new Error(reply.error || 'CPU live ASR failed');
      if (reply.extend) this.extended.add(item.source); else this.extended.delete(item.source);
      await this.status?.({ phase: reply.waiting ? 'waiting_audio' : 'transcribed', ...item, ...reply, at: Date.now() });
      return !reply.waiting && (reply.duration ?? 0) - (reply.cursor ?? 0) > 65;
    } catch (error) { this.close(); throw error; }
  }
  close(): void { this.worker?.close(); this.worker = undefined; }
}

export const saveLiveAsrStatus = (file: string) => (value: unknown): Promise<void> => atomicLiveJson(file, value);
