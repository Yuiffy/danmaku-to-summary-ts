import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import { QQRequest, qqDigest } from './QQPolicy';
import { qqImageAttachmentUrl } from './QQImageInputPolicy';
import { QQ_VIDEO_INPUT_LIMIT } from './QQVideoInputPolicy';
import { QQ_VIDEO_CUT_HELP, QQ_VIDEO_REFERENCE_DEFAULT_MS, QQ_VIDEO_REFERENCE_MAX_MS,
  QQVideoSelectionError, QQVideoSpan, qqVideoCutNegated, qqVideoCutRequested, qqVideoSelection, qqVideoSpans, qqVideoSpanDuration } from './QQVideoCutPolicy';
import { renderQQVideo } from './QQVideoRender';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_EDIT_BYTES = 100 * 1024 * 1024;
const MIN_REFERENCE_MS = 2000;
export interface QQVideoSource { file: string; durationMs: number; cut?: string }
export interface QQVideoSourceMetadata { durationMs: number; width: number; height: number; hasAudio?: boolean }
export class QQVideoInputError extends Error {}
type Probe = (file: string, signal: AbortSignal) => Promise<QQVideoSourceMetadata>;
type DownloadedVideo = QQVideoSourceMetadata & QQVideoSource;
const publicError = (error: unknown) => error instanceof QQVideoInputError || error instanceof QQVideoSelectionError
  ? error.message : '视频处理暂时失败，请重新附MP4视频。';

/** Fixed local probe; no model-selected executable or options and no arbitrary output in logs. */
const probeVideo: Probe = (file, signal) => new Promise((resolve, reject) => {
  const child = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-show_entries',
    'format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', file],
  { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
  let output = '', size = 0;
  const timer = setTimeout(() => child.kill(), 5000);
  child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 65536) child.kill(); else output += bytes.toString('utf8'); });
  child.stderr.on('data', () => { /* Never retain media metadata or raw subprocess errors. */ });
  child.on('error', () => { clearTimeout(timer); reject(new QQVideoInputError('视频暂时无法读取，请重新附视频。')); });
  child.on('close', code => {
    clearTimeout(timer);
    try {
      if (code !== 0 || size > 65536) throw new Error();
      const value = JSON.parse(output);
      const stream = value.streams?.find((item: { codec_type?: string; disposition?: { attached_pic?: number } }) =>
        item.codec_type === 'video' && !item.disposition?.attached_pic);
      if (!stream) throw new Error();
      const duration = Number(value.format?.duration) || Number(stream.duration);
      resolve({ durationMs: Math.round(duration * 1000), width: stream.width, height: stream.height,
        hasAudio: value.streams.some((item: { codec_type?: string }) => item.codec_type === 'audio') });
    } catch { reject(new QQVideoInputError('视频不是可读取的MP4，请重新附MP4视频。')); }
  });
});

/** Bounded QQ CDN download and local media validation, before any queue or provider submission. */
export class QQVideoInputs {
  constructor(private readonly root: string, private readonly app: string, private readonly transport = fetch,
    private readonly probe: Probe = probeVideo, private readonly render = renderQQVideo) {}

  async load(request: QQRequest, signal: AbortSignal): Promise<QQVideoSource[]> {
    try {
      const { selection } = qqVideoSelection(request.text);
      if (!selection && qqVideoCutRequested(request.text, !!request.videoInput)) throw new QQVideoInputError(QQ_VIDEO_CUT_HELP);
      if (selection && request.videoInput?.urls.length !== 1) throw new QQVideoInputError('指定截取区间时，请附上或引用一段原视频。');
      const sources = await this.download(request, signal);
      if (sources.length === 1) {
        const [source] = sources;
        if (source.durationMs > QQ_VIDEO_REFERENCE_MAX_MS && qqVideoCutNegated(request.text)) {
          throw new QQVideoInputError('参考视频最多15.4秒，请提供一段符合时长的原片。');
        }
        const spans = selection ? qqVideoSpans(selection, source.durationMs) :
          source.durationMs > QQ_VIDEO_REFERENCE_MAX_MS ? [{ startMs: 0, endMs: QQ_VIDEO_REFERENCE_DEFAULT_MS }] : undefined;
        if (spans) {
          const duration = qqVideoSpanDuration(spans);
          if (duration < MIN_REFERENCE_MS || duration > QQ_VIDEO_REFERENCE_MAX_MS) throw new QQVideoInputError('截取后的参考视频总时长需为2—15.4秒。');
          sources[0] = await this.cut(source, spans, MAX_BYTES, signal);
        }
      }
      if (sources.some(source => source.durationMs < MIN_REFERENCE_MS || source.durationMs > QQ_VIDEO_REFERENCE_MAX_MS ||
        ![source.width, source.height].every(edge => Number.isInteger(edge) && edge >= 200 && edge <= 2160))) {
        throw new QQVideoInputError('参考视频需为2—15.4秒、宽高200—2160像素的MP4。');
      }
      if (sources.reduce((sum, source) => sum + source.durationMs, 0) > QQ_VIDEO_REFERENCE_MAX_MS) {
        throw new QQVideoInputError('参考视频总时长最多15.4秒，请选一段视频并指定截取时间。');
      }
      signal.throwIfAborted();
      return sources.map(({ file, durationMs, cut }) => ({ file, durationMs, ...(cut ? { cut } : {}) }));
    } catch (error) {
      signal.throwIfAborted();
      throw new QQVideoInputError(`${publicError(error)}本次未提交生成。`);
    }
  }

  async edit(request: QQRequest, signal: AbortSignal): Promise<{ text: string; video?: QQVideoSource }> {
    try {
      const { selection } = qqVideoSelection(request.text);
      if (!selection || request.videoInput?.urls.length !== 1 || request.videoInput.invalid) return { text: QQ_VIDEO_CUT_HELP };
      const [source] = await this.download(request, signal);
      const spans = qqVideoSpans(selection, source.durationMs);
      const video = await this.cut(source, spans, MAX_EDIT_BYTES, signal);
      return { text: `剪辑完成，成片约${Number((video.durationMs / 1000).toFixed(2))}秒。`, video };
    } catch (error) {
      signal.throwIfAborted();
      return { text: publicError(error) };
    }
  }

  private async cut(source: DownloadedVideo, spans: QQVideoSpan[], maxBytes: number, signal: AbortSignal): Promise<DownloadedVideo & { cut: string }> {
    const durationMs = qqVideoSpanDuration(spans);
    if (durationMs > 180000 || spans.some(({ startMs, endMs }) => endMs - startMs < 100)) {
      throw new QQVideoInputError('每段剪辑须至少0.1秒，成片请控制在3分钟以内。');
    }
    const file = path.join(path.dirname(source.file), `cut-${qqDigest(JSON.stringify([source.file, spans]))}.mp4`);
    const staged = path.join(path.dirname(file), `cut-${randomUUID()}.partial.mp4`);
    try {
      await this.render(source.file, staged, spans, !!source.hasAudio, maxBytes, signal);
      const stat = await fs.stat(staged);
      if (stat.size > maxBytes) throw new QQVideoInputError('剪辑成片超过QQ可处理的文件大小，请缩短区间。');
      const metadata = await this.probe(staged, signal);
      if (!Number.isFinite(metadata.durationMs) || Math.abs(metadata.durationMs - durationMs) > 40 * spans.length ||
        (!!source.hasAudio && !metadata.hasAudio)) throw new Error();
      signal.throwIfAborted();
      await fs.rename(staged, file);
      return { ...metadata, file, cut: spans.map(({ startMs, endMs }) => `${startMs / 1000}–${endMs / 1000}秒`).join('、') };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof QQVideoInputError) throw error;
      throw new QQVideoInputError('剪辑没有完成，请缩短区间或重新附MP4视频。');
    } finally {
      await fs.unlink(staged).catch(() => {});
    }
  }

  private async download(request: QQRequest, signal: AbortSignal): Promise<DownloadedVideo[]> {
    signal.throwIfAborted();
    if (request.scope !== 'group' || !request.videoInput || request.videoInput.invalid ||
      !request.videoInput.urls.length || request.videoInput.urls.length > QQ_VIDEO_INPUT_LIMIT) {
      throw new QQVideoInputError('引用视频不可用或超过3段，请在新消息直接附视频与要求。');
    }
    const directory = path.join(this.root, 'data/runtime/qqbot/video-inputs', this.app, request.key);
    const results: DownloadedVideo[] = [];
    try {
      for (const value of request.videoInput.urls) {
        signal.throwIfAborted();
        const url = qqImageAttachmentUrl(value);
        if (!url) throw new Error();
        const response = await this.transport(url, { method: 'GET', redirect: 'error', signal: signal as any, timeout: 20000, size: MAX_BYTES });
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new QQVideoInputError('原视频每段最多50MB。');
        if (!response.ok || !/^(?:video\/|application\/octet-stream(?:;|$))/iu.test(response.headers.get('content-type') || '')) throw new Error();
        const bytes = await response.buffer();
        if (bytes.length > MAX_BYTES || bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error();
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `video-${qqDigest(bytes)}.mp4`);
        await fs.writeFile(file, bytes);
        const metadata = await this.probe(file, signal);
        if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) throw new Error();
        results.push({ file, ...metadata });
      }
      signal.throwIfAborted();
      return results;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof QQVideoInputError) throw error;
      throw new QQVideoInputError('没有读到可用视频，请在新消息直接附MP4视频与要求。');
    }
  }
}
