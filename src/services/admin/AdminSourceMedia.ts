import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { AdminError, atomicJson, digest, readJson } from './AdminFiles';

type Run = (executable: string, args: string[], timeoutMs: number) => Promise<string>;
const preparationTimeoutMs = 90_000;
const cacheContextSeconds = 300;
const timeoutError = () => new AdminError('原片预览准备超时（最多 90 秒），大录播读取较慢，请重试或生成粗剪', 503);
const runProcess: Run = (executable, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const stage = args.includes('-show_packets') ? '时间校验' : '转封装';
    console.warn('[admin/source-preview] process failed', { stage, tool: path.basename(executable), timeoutMs,
      code: error.code, signal: error.signal, killed: error.killed, stderr: stderr.trim().slice(-2000) });
    if (error.killed) reject(timeoutError());
    else if (error.code === 'ENOENT') reject(new AdminError('原片预览工具不可用，请检查 FFmpeg / FFprobe 配置', 503));
    else reject(new AdminError(`原片预览${stage}失败，请重试或生成粗剪；具体原因见管理服务日志`, 503));
  });
});
export interface SourcePlayback { file: string; origin: number; start: number; end: number; direct: boolean; format: string; sourceKey?: string; assetKey?: string }

/** A disposable browser container for registered source streams; never a review/upload artifact. */
export class AdminSourceMedia {
  private readonly pending = new Map<string, Promise<SourcePlayback>>();
  private readonly assets = new Map<string, string>();
  constructor(private readonly directory: string, private readonly ffmpeg: () => string, private readonly run: Run = runProcess) {}

  resolveAsset(key: string): string | undefined {
    const file = this.assets.get(key);
    if (!file || !fs.existsSync(file)) { this.assets.delete(key); return undefined; }
    return file;
  }

  async prepare(file: string, window: { start: number; end: number }, options: { forceRemux?: boolean } = {}): Promise<SourcePlayback> {
    const format = path.extname(file).toLowerCase();
    const sourceStat = fs.statSync(file);
    const sourceKey = digest(JSON.stringify({ file, size: sourceStat.size, mtime: sourceStat.mtimeMs, version: 1 }));
    // A large MP4 with its moov box at the tail can expose duration immediately but
    // still take tens of seconds to seek to a three-hour source position. Prepare a
    // short fast-start window for those files instead of making the browser scan it.
    const directMp4 = format === '.mp4' && isFastStartMp4(file);
    // FLV is deliberately remuxed into a short fast-start MP4 window. Browser
    // FLV/MSE playback can expose duration immediately but still scan from the
    // beginning when seeking deep into a long recording, leaving the target
    // position unbuffered for a very long time.
    if (!options.forceRemux && (format === '.webm' || directMp4)) {
      this.assets.set(sourceKey, file);
      return { file, ...window, origin: 0, direct: true, format, sourceKey, assetKey: sourceKey };
    }
    if (window.end - window.start > 3600) throw new AdminError('原片范围过长，请使用已生成的分 P 视频');
    const cached = this.findCached(file, sourceStat, sourceKey, window);
    if (cached) return cached;
    // Share one remux across nearby review candidates. A 25-second clip and the
    // next clip two minutes later should not each pay the deep-seek cost.
    const cacheWindow = { start: Math.max(0, window.start - cacheContextSeconds), end: window.end + cacheContextSeconds };
    const stat = sourceStat, identity = { file, size: stat.size, mtime: stat.mtimeMs, sourceKey,
      cacheStart: cacheWindow.start, cacheEnd: cacheWindow.end, version: 2 };
    const key = digest(JSON.stringify(identity)), output = path.join(this.directory, `${key}.mp4`), receipt = `${output}.json`;
    if (fs.existsSync(output) && fs.existsSync(receipt)) {
      const saved = readJson(receipt);
      if (Number.isFinite(saved.origin)) { this.assets.set(key, output); return { file: output, ...window, origin: saved.origin, direct: false, format: '.mp4', sourceKey, assetKey: key }; }
    }
    const current = this.pending.get(key);
    if (current) return current;
    if (this.pending.size) throw new AdminError('另一个原片正在加载，请稍后重试', 429);
    const task = this.remux(file, window, cacheWindow, output, receipt, identity, key);
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
  private findCached(file: string, stat: fs.Stats, sourceKey: string, window: { start: number; end: number }): SourcePlayback | undefined {
    if (!fs.existsSync(this.directory)) return undefined;
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.mp4\.json$/u.test(name)) continue;
      const receipt = path.join(this.directory, name);
      try {
        const saved = readJson(receipt, null), identity = saved?.identity;
        if (!identity || identity.file !== file || identity.size !== stat.size || identity.mtime !== stat.mtimeMs) continue;
        const cachedStart = Number(identity.cacheStart), cachedEnd = Number(identity.cacheEnd);
        if (identity.version !== 2 || !(cachedStart <= window.start && cachedEnd >= window.end) || !Number.isFinite(saved.origin)) continue;
        const output = receipt.slice(0, -'.json'.length), assetKey = name.slice(0, -'.mp4.json'.length);
        if (!fs.existsSync(output)) continue;
        this.assets.set(assetKey, output);
        return { file: output, ...window, origin: Number(saved.origin), direct: false, format: '.mp4', sourceKey, assetKey };
      } catch { /* A corrupt disposable receipt must not block a fresh preparation. */ }
    }
    return undefined;
  }
  private async packets(file: string, interval: string, run: (executable: string, args: string[]) => Promise<string>): Promise<any[]> {
    const probe = this.ffmpeg().replace(/ffmpeg(\.exe)?$/iu, 'ffprobe$1');
    const result = await run(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=pts_time,dts_time,flags,data_hash', '-show_data_hash', 'md5', '-of', 'json', '-read_intervals', interval, file]);
    return JSON.parse(result).packets || [];
  }
  private async remux(file: string, window: { start: number; end: number }, cacheWindow: { start: number; end: number },
    output: string, receipt: string, identity: any, assetKey: string): Promise<SourcePlayback> {
    // One budget for remux and every probe, below the HTTP adapter's 100-second deadline.
    const deadline = Date.now() + preparationTimeoutMs;
    const run = (executable: string, args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      return this.run(executable, args, remaining);
    };
    fs.mkdirSync(this.directory, { recursive: true });
    // Limit only this disposable cache; source recordings and review artifacts are untouched.
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.mp4(?:\.json)?$/u.test(name) && !/^[a-f0-9]{64}(?:\.source)?\.partial\.mp4$/u.test(name)) continue;
      const entry = path.join(this.directory, name);
      if (Date.now() - fs.statSync(entry).mtimeMs > 24 * 3600_000) fs.unlinkSync(entry);
    }
    const timestamped = output.replace(/\.mp4$/u, '.source.partial.mp4'), temporary = output.replace(/\.mp4$/u, '.partial.mp4');
    const start = Math.max(0, cacheWindow.start);
    try {
      // Preserve source timestamps in the first pass. ffprobe can then read the
      // actual keyframe time locally, avoiding a second deep scan of the source.
      await run(this.ffmpeg(), ['-nostdin', '-y', '-v', 'error', '-ss', String(start), '-copyts', '-i', file,
        '-to', String(cacheWindow.end + 2), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', timestamped]);
      const [first] = await this.packets(timestamped, '%+#1', run), origin = Number(first?.dts_time ?? first?.pts_time);
      if (!String(first?.flags).includes('K') || !Number.isFinite(origin)) throw new AdminError('原片时间定位失败', 503);
      await run(this.ffmpeg(), ['-nostdin', '-y', '-v', 'error', '-i', timestamped, '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', temporary]);
      const after = fs.statSync(file);
      if (origin > window.start || after.size !== identity.size || after.mtimeMs !== identity.mtime) {
        throw new AdminError('原片时间或素材已变化，请刷新后重试', 503);
      }
      fs.renameSync(temporary, output); atomicJson(receipt, { identity, origin });
      this.assets.set(assetKey, output);
      return { file: output, ...window, origin, direct: false, format: '.mp4', sourceKey: digest(JSON.stringify({ file: identity.file, size: identity.size, mtime: identity.mtime, version: 1 })), assetKey };
    } finally {
      for (const temporaryFile of [timestamped, temporary]) if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
  }
}

function isFastStartMp4(file: string): boolean {
  const stat = fs.statSync(file);
  if (stat.size < 16) return true;
  const sampleSize = Math.min(stat.size, 4 * 1024 * 1024);
  const handle = fs.openSync(file, 'r');
  try {
    const sample = Buffer.allocUnsafe(sampleSize);
    fs.readSync(handle, sample, 0, sampleSize, 0);
    // Unknown/non-MP4 fixtures should retain the historical direct path. For a
    // real ISO-BMFF file, moov must be visible near the beginning to be fast-start.
    if (sample.indexOf(Buffer.from('ftyp')) < 0) return true;
    const moov = sample.indexOf(Buffer.from('moov')), mdat = sample.indexOf(Buffer.from('mdat'));
    return moov >= 0 && (mdat < 0 || moov < mdat);
  } finally { fs.closeSync(handle); }
}
