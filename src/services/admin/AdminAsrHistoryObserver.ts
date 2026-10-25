import * as fs from 'fs';
import * as path from 'path';
import { loadAsrHistoryTasks, readAsrHistoryItem, trustedAsrHistoryRoots } from './AdminAsrHistory';
import { AdminAsrHistoryIndex } from './AdminAsrHistoryIndex';
import { backfillAsrHistory } from './AdminAsrHistoryBackfill';
import { readText } from './AdminFiles';

interface ObserverOptions {
  queueFile: string;
  historyFile: string;
  roots(): string[];
  readSidecar?: typeof readText;
  loadTasks?: typeof loadAsrHistoryTasks;
  backfill?: typeof backfillAsrHistory;
  diagnostic?(stage: string, error: { name: string; code?: string }): void;
}

/** Rebuildable observer, independent of ASR admission; each pass takes one queue snapshot. */
export class AdminAsrHistoryObserver {
  private index?: AdminAsrHistoryIndex;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private fingerprints = new Map<string, string>();
  constructor(private readonly options: ObserverOptions) {}

  private report(stage: string, error: unknown): void {
    const value = ((error as { cause?: unknown })?.cause || error) as NodeJS.ErrnoException;
    this.options.diagnostic?.(stage, { name: value?.name || 'Error', code: value?.code });
  }

  start(): void {
    if (this.index) return;
    const index = this.index = new AdminAsrHistoryIndex(this.options.historyFile);
    void this.sync().then(async () => {
      if (this.index !== index) return;
      try {
        await (this.options.backfill || backfillAsrHistory)(this.options.roots(), index, () => this.index !== index);
        // Wait out a timer pass before restoring queue statuses changed by backfill.
        await this.active;
        // Backfill may have temporarily replaced a queue-derived status for the same source.
        if (this.index !== index) return;
        this.fingerprints.clear();
        if (this.index === index) await this.sync();
      } catch (error) { this.report('backfill', error); }
    });
    this.timer = setInterval(() => { void this.sync(); }, 30000);
    this.timer.unref();
  }

  sync(): Promise<void> {
    if (this.active) return this.active;
    const index = this.index;
    if (!index) return Promise.resolve();
    const active = this.scan(index).catch(error => this.report('sync', error)).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active;
  }

  private async scan(index: AdminAsrHistoryIndex): Promise<void> {
    const tasks = (this.options.loadTasks || loadAsrHistoryTasks)(this.options.queueFile).slice(0, 1000);
    const trusted = trustedAsrHistoryRoots(this.options.roots());
    const observed = new Map<string, string>();
    for (let offset = 0; offset < tasks.length; offset += 50) {
      if (this.index !== index) return;
      const changed = [];
      for (const task of tasks.slice(offset, offset + 50)) {
        if (typeof task.mediaPath !== 'string' || !path.isAbsolute(task.mediaPath)) continue;
        const parsed = path.parse(task.mediaPath), source = path.join(parsed.dir, `${parsed.name}.asr_meta.json`);
        let identity: unknown;
        try {
          const canonical = fs.realpathSync(source), stat = fs.statSync(canonical);
          identity = [canonical, stat.mtimeMs, stat.ctimeMs, stat.size];
        } catch (error) { identity = (error as NodeJS.ErrnoException).code || 'unavailable'; }
        const fingerprint = JSON.stringify([task, trusted, identity]);
        observed.set(source, fingerprint);
        if (this.fingerprints.get(source) === fingerprint) continue;
        const row = readAsrHistoryItem(task, trusted, this.options.readSidecar || readText);
        // Retry transient read/permission failures even if file timestamps did not change.
        if (row.metadata === 'unavailable') observed.delete(source);
        changed.push({ source, row });
      }
      index.upsertMany(changed);
      if (offset + 50 < tasks.length) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (this.index === index) this.fingerprints = observed;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const index = this.index;
    this.index = undefined;
    this.active = undefined;
    this.fingerprints.clear();
    index?.close();
  }
}
