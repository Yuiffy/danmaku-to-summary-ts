import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { AdminError, atomicJson, digest, readJson } from './AdminFiles';

type Run = (executable: string, args: string[]) => Promise<string>;
const runProcess: Run = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, { windowsHide: true, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new AdminError('原片预览加载失败，请重试或生成粗剪', 503));
    else resolve(stdout);
  });
});
export interface SourcePlayback { file: string; origin: number; start: number; end: number; direct: boolean }

/** A disposable browser container for registered source streams; never a review/upload artifact. */
export class AdminSourceMedia {
  private readonly pending = new Map<string, Promise<SourcePlayback>>();
  constructor(private readonly directory: string, private readonly ffmpeg: () => string, private readonly run: Run = runProcess) {}

  async prepare(file: string, window: { start: number; end: number }): Promise<SourcePlayback> {
    if (['.mp4', '.webm'].includes(path.extname(file).toLowerCase())) return { file, ...window, origin: 0, direct: true };
    if (window.end - window.start > 3600) throw new AdminError('原片范围过长，请使用已生成的分 P 视频');
    const stat = fs.statSync(file), identity = { file, size: stat.size, mtime: stat.mtimeMs, ...window, version: 1 };
    const key = digest(JSON.stringify(identity)), output = path.join(this.directory, `${key}.mp4`), receipt = `${output}.json`;
    if (fs.existsSync(output) && fs.existsSync(receipt)) {
      const saved = readJson(receipt);
      if (Number.isFinite(saved.origin)) return { file: output, ...window, origin: saved.origin, direct: false };
    }
    const current = this.pending.get(key);
    if (current) return current;
    if (this.pending.size) throw new AdminError('另一个原片正在加载，请稍后重试', 429);
    const task = this.remux(file, window, output, receipt, identity);
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
  private async packets(file: string, interval: string): Promise<any[]> {
    const probe = this.ffmpeg().replace(/ffmpeg(\.exe)?$/iu, 'ffprobe$1');
    const result = await this.run(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=pts_time,dts_time,flags,data_hash', '-show_data_hash', 'md5', '-of', 'json', '-read_intervals', interval, file]);
    return JSON.parse(result).packets || [];
  }
  private async remux(file: string, window: { start: number; end: number }, output: string, receipt: string, identity: any): Promise<SourcePlayback> {
    fs.mkdirSync(this.directory, { recursive: true });
    // Limit only this disposable cache; source recordings and review artifacts are untouched.
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.mp4(?:\.json)?$/u.test(name)) continue;
      const entry = path.join(this.directory, name);
      if (Date.now() - fs.statSync(entry).mtimeMs > 24 * 3600_000) fs.unlinkSync(entry);
    }
    const temporary = output.replace(/\.mp4$/u, '.partial.mp4'), start = Math.max(0, window.start - 8);
    try {
      await this.run(this.ffmpeg(), ['-nostdin', '-y', '-v', 'error', '-ss', String(start), '-i', file,
        '-t', String(window.end + 2 - start), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
        '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', temporary]);
      // Stream copy starts at a keyframe. Match its actual packet to retain absolute source timing.
      const [first] = await this.packets(temporary, '%+#1');
      if (!first?.data_hash || !String(first.flags).includes('K')) throw new AdminError('原片时间定位失败', 503);
      let origin: number | undefined;
      for (const lookback of [30, 120]) {
        const from = Math.max(0, start - lookback);
        const packets = await this.packets(file, `${from}%+${start - from + 2}`);
        const times = packets.filter(packet => packet.data_hash === first.data_hash).map(packet => Number(packet.pts_time ?? packet.dts_time))
          .filter(time => Number.isFinite(time) && time >= 0 && time <= start + .5).sort((a, b) => b - a);
        if (times.length) { origin = times[0] - Number(first.pts_time); break; }
      }
      const after = fs.statSync(file);
      if (origin === undefined || !Number.isFinite(origin) || origin > window.start || after.size !== identity.size || after.mtimeMs !== identity.mtime) {
        throw new AdminError('原片时间或素材已变化，请刷新后重试', 503);
      }
      fs.renameSync(temporary, output); atomicJson(receipt, { identity, origin });
      return { file: output, ...window, origin, direct: false };
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
