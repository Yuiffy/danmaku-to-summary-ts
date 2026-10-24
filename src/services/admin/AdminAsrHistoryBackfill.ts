import * as fs from 'fs';
import * as path from 'path';
import { AdminAsrHistoryIndex } from './AdminAsrHistoryIndex';
import { asrHistoryMetrics } from './AdminAsrHistory';
import { digest, readText } from './AdminFiles';

/** One bounded background discovery per service start; never follows directory symlinks. */
export async function backfillAsrHistory(roots: string[], index: AdminAsrHistoryIndex, stopped: () => boolean): Promise<number> {
  let visited = 0, imported = 0;
  const pending = [...new Set(roots)], seen = new Set<string>();
  while (pending.length && visited < 250000 && !stopped()) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const canonical = fs.realpathSync(directory).toLowerCase();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (stopped() || ++visited > 250000) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.asr_meta.json')) {
        try {
          const meta = JSON.parse(readText(file, 4 * 1024 * 1024));
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
          const name = entry.name.slice(0, -'.asr_meta.json'.length);
          const streamer = file.split(/[\\/]/u).find(part => /^\d+_.+/u.test(part));
          index.upsert(file, { id: `metadata-${digest(file.toLowerCase())}`, streamerName: streamer?.replace(/^\d+_/u, '') || '未知主播',
            title: name.replace(/^录制-\d+-\d{8}-\d{6}-\d+-/u, '').replace(/_merged$/u, ''), status: 'asr_completed',
            metadata: 'available', ...asrHistoryMetrics(meta) });
          imported++;
        } catch { /* Missing, oversized or corrupt source is not valid historical evidence. */ }
      }
      if (visited % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  return imported;
}
