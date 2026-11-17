import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { QQRequest, qqDigest } from './QQPolicy';
import { qqImageAttachmentUrl } from './QQImageInputPolicy';
import { QQ_VIDEO_INPUT_LIMIT } from './QQVideoInputPolicy';

const MAX_BYTES = 50 * 1024 * 1024;
export interface QQVideoSource { file: string; durationMs: number }
export interface QQVideoSourceMetadata { durationMs: number; width: number; height: number }
export class QQVideoInputError extends Error {}
type Probe = (file: string, signal: AbortSignal) => Promise<QQVideoSourceMetadata>;

/** Fixed local probe; no model-selected executable or options and no arbitrary output in logs. */
const probeVideo: Probe = (file, signal) => new Promise((resolve, reject) => {
  const child = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries',
    'format=duration,format_name:stream=codec_type,width,height,duration', '-of', 'json', file],
  { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
  let output = '', size = 0;
  const timer = setTimeout(() => child.kill(), 5000);
  child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 65536) child.kill(); else output += bytes.toString('utf8'); });
  child.stderr.on('data', () => { /* Never retain media metadata or raw subprocess errors. */ });
  child.on('error', () => { clearTimeout(timer); reject(new QQVideoInputError('参考视频暂时无法读取，本次未提交生成，请重新附视频。')); });
  child.on('close', code => {
    clearTimeout(timer);
    try {
      if (code !== 0 || size > 65536) throw new Error();
      const value = JSON.parse(output);
      const stream = value.streams?.find((item: { codec_type?: string }) => item.codec_type === 'video');
      if (!stream || !String(value.format?.format_name).split(',').includes('mp4')) throw new Error();
      resolve({ durationMs: Math.round(Number(value.format.duration) * 1000), width: stream.width, height: stream.height });
    } catch { reject(new QQVideoInputError('参考视频不是可读取的MP4，本次未提交生成，请重新附MP4视频。')); }
  });
});

/** Bounded QQ CDN download and local media validation, before any queue or provider submission. */
export class QQVideoInputs {
  constructor(private readonly root: string, private readonly app: string, private readonly transport = fetch,
    private readonly probe: Probe = probeVideo) {}

  async load(request: QQRequest, signal: AbortSignal): Promise<QQVideoSource[]> {
    signal.throwIfAborted();
    if (request.scope !== 'group' || !request.videoInput || request.videoInput.invalid ||
      !request.videoInput.urls.length || request.videoInput.urls.length > QQ_VIDEO_INPUT_LIMIT) {
      throw new QQVideoInputError('引用视频不可用或超过3段，本次未提交生成，请在新消息直接附视频与要求。');
    }
    const directory = path.join(this.root, 'data/runtime/qqbot/video-inputs', this.app, request.key);
    const results: QQVideoSource[] = [];
    try {
      for (const value of request.videoInput.urls) {
        signal.throwIfAborted();
        const url = qqImageAttachmentUrl(value);
        if (!url) throw new Error();
        const response = await this.transport(url, { method: 'GET', redirect: 'error', signal: signal as any, timeout: 20000, size: MAX_BYTES });
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new QQVideoInputError('参考视频每段最多50MB，本次未提交生成。');
        if (!response.ok || !/^(?:video\/|application\/octet-stream(?:;|$))/iu.test(response.headers.get('content-type') || '')) throw new Error();
        const bytes = await response.buffer();
        if (bytes.length > MAX_BYTES || bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error();
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `video-${qqDigest(bytes)}.mp4`);
        await fs.writeFile(file, bytes);
        const metadata = await this.probe(file, signal);
        if (!Number.isFinite(metadata.durationMs) || metadata.durationMs < 2000 || metadata.durationMs > 15400 ||
          ![metadata.width, metadata.height].every(edge => Number.isInteger(edge) && edge >= 200 && edge <= 2160)) {
          throw new QQVideoInputError('参考视频需为2—15.4秒、宽高200—2160像素的MP4，本次未提交生成。');
        }
        results.push({ file, durationMs: metadata.durationMs });
      }
      if (results.reduce((sum, item) => sum + item.durationMs, 0) > 15400) throw new QQVideoInputError('参考视频总时长最多15.4秒，本次未提交生成，请先裁剪后重发。');
      signal.throwIfAborted();
      return results;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof QQVideoInputError) throw error;
      throw new QQVideoInputError('没有读到可用参考视频，本次未提交生成，请在新消息直接附MP4视频与要求。');
    }
  }
}
