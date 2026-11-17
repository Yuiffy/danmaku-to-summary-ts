import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageResult } from './QQImagePolicy';
import { QQ_IMAGE_SOURCE_LIMIT, qqImageAttachmentUrl, qqImageReferenceId } from './QQImageInputPolicy';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { QQDiagnosticError, qqDiagnostic, qqFailure } from './QQDiagnostics';
import { qqImageBufferFormat, validQQImageFormat } from '../../core/qqImageFormat';
import { validateQQGif } from './QQImageAnimation';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DECODE_PIXELS = 50_000_000;
const MAX_NORMALIZED_PIXELS = 25_000_000;
const MAX_NORMALIZED_EDGE = 4096;
const FFMPEG_TIMEOUT_MS = 15000;
const FFMPEG_OUTPUT_LIMIT = MAX_BYTES * 2;
const MAX_GIF_REFERENCE_FRAMES = 6;
const GIF_REFERENCE_CELL = 768;
const GIF_REFERENCE_LABEL = 48;
const GIF_REFERENCE_GAP = 16;

export type QQImageNormalizer = (bytes: Buffer, signal: AbortSignal) => Promise<Buffer>;
type QQImageFallback = QQImageNormalizer;

function sharpPng(bytes: Buffer, edge?: number, limitInputPixels = MAX_DECODE_PIXELS): Promise<Buffer> {
  const gif = qqImageBufferFormat(bytes) === 'gif';
  let image = sharp(bytes, { ...(gif ? { animated: false, pages: 1, page: 0 } : {}),
    limitInputPixels, failOn: 'error', sequentialRead: true }).rotate();
  if (edge) image = image.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  return image.png().toBuffer();
}

/** Fixed FFmpeg fallback for valid but warning-prone or unusually encoded QQ images. */
function ffmpegPng(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `scale=w='min(${MAX_NORMALIZED_EDGE},iw)':h='min(${MAX_NORMALIZED_EDGE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'
    ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytesOut = 0, settled = false;
    const finish = (error?: unknown, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(output!);
    };
    const stop = (error: unknown) => {
      child.kill();
      finish(error);
    };
    const abort = () => stop(signal.reason || new Error('QQ source image decode aborted'));
    const timer = setTimeout(() => stop(new Error('QQ source image decode timed out')), FFMPEG_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesOut += buffer.length;
      if (bytesOut > FFMPEG_OUTPUT_LIMIT) {
        stop(qqFailure('image_prepare', 'image_size'));
        return;
      }
      chunks.push(buffer);
    });
    child.stderr.on('data', () => { /* Bounded process output is intentionally not retained. */ });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 || !bytesOut) finish(new Error('QQ source image decode failed'));
      else finish(undefined, Buffer.concat(chunks, bytesOut));
    });
    child.stdin.on('error', () => { /* Exit and abort are reported by the process events. */ });
    child.stdin.end(bytes);
  });
}

async function boundedPng(png: Buffer, signal: AbortSignal): Promise<Buffer> {
  let output = png;
  const metadata = await sharp(output, { limitInputPixels: MAX_DECODE_PIXELS }).metadata();
  const width = metadata.autoOrient?.width || metadata.width || 0;
  const height = metadata.autoOrient?.height || metadata.height || 0;
  if (width > MAX_NORMALIZED_EDGE || height > MAX_NORMALIZED_EDGE || width * height > MAX_NORMALIZED_PIXELS) {
    output = await sharpPng(output, MAX_NORMALIZED_EDGE, MAX_DECODE_PIXELS);
  }
  for (const edge of [2048, 1024]) {
    if (output.length <= MAX_BYTES) return output;
    output = await sharpPng(output, edge, MAX_DECODE_PIXELS);
  }
  signal.throwIfAborted();
  if (output.length > MAX_BYTES) throw qqFailure('image_prepare', 'image_size');
  return output;
}

/** Normalize ordinary images with Sharp and retry warning-prone inputs through a fixed local decoder. */
export function createQQImageNormalizer(fallback: QQImageFallback = ffmpegPng): QQImageNormalizer {
  return async (bytes, signal) => {
    signal.throwIfAborted();
    let png: Buffer;
    try {
      png = await sharpPng(bytes);
    } catch (error) {
      if (error instanceof QQDiagnosticError) throw error;
      signal.throwIfAborted();
      try { png = await fallback(bytes, signal); }
      catch (fallbackError) {
        if (fallbackError instanceof QQDiagnosticError) throw fallbackError;
        signal.throwIfAborted();
        throw qqFailure('image_prepare', 'image_bytes');
      }
    }
    try { return await boundedPng(png, signal); }
    catch (error) {
      if (error instanceof QQDiagnosticError) throw error;
      signal.throwIfAborted();
      throw qqFailure('image_prepare', 'image_bytes');
    }
  };
}

function gifReferenceLabel(width: number, text: string): Buffer {
  const escaped = text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${GIF_REFERENCE_LABEL}">` +
    `<rect width="100%" height="100%" fill="#202124"/><text x="16" y="32" fill="#ffffff" font-family="Arial, sans-serif" font-size="22">${escaped}</text></svg>`);
}

/** Turn an animated GIF into a bounded, ordered contact sheet for image editing models. */
async function gifReferenceSheet(bytes: Buffer, signal: AbortSignal): Promise<Buffer | undefined> {
  // Aggregate animation pixels are intentionally not used as the decode
  // budget: only the bounded representative frames below are materialized.
  const image = sharp(bytes, { animated: true, limitInputPixels: false, failOn: 'error' });
  const metadata = await image.metadata();
  const pages = metadata.pages || 1;
  const width = metadata.width || 0;
  const height = metadata.pageHeight || metadata.height || 0;
  if (pages < 2 || !width || !height) return;
  const count = Math.min(MAX_GIF_REFERENCE_FRAMES, pages);
  const indices = Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (pages - 1) / (count - 1)));
  const delays = Array.isArray(metadata.delay) ? metadata.delay : [];
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const columns = Math.min(3, count);
  const tileWidth = GIF_REFERENCE_CELL;
  const tileHeight = GIF_REFERENCE_CELL + GIF_REFERENCE_LABEL;
  for (const [position, page] of indices.entries()) {
    signal.throwIfAborted();
    const frame = await sharp(bytes, { page, pages: 1, limitInputPixels: MAX_DECODE_PIXELS, failOn: 'error' })
      .resize({ width: GIF_REFERENCE_CELL, height: GIF_REFERENCE_CELL, fit: 'contain', background: '#ffffff' }).png().toBuffer();
    const elapsed = delays.slice(0, page).reduce((sum, delay) => sum + (Number.isFinite(delay) ? delay : 0), 0) / 1000;
    const tile = await sharp(frame).extend({ top: GIF_REFERENCE_LABEL, bottom: 0, left: 0, right: 0, background: '#202124' })
      .composite([{ input: gifReferenceLabel(tileWidth, `FRAME ${position + 1}/${count}  ${elapsed.toFixed(1)}s`), left: 0, top: 0 }]).png().toBuffer();
    composites.push({ input: tile, left: (position % columns) * (tileWidth + GIF_REFERENCE_GAP),
      top: Math.floor(position / columns) * (tileHeight + GIF_REFERENCE_GAP) });
  }
  const rows = Math.ceil(count / columns);
  return sharp({ create: { width: columns * tileWidth + (columns - 1) * GIF_REFERENCE_GAP,
    height: rows * tileHeight + (rows - 1) * GIF_REFERENCE_GAP, channels: 4, background: '#202124' } })
    .composite(composites).png().toBuffer();
}

const normalizeQQImage = createQQImageNormalizer();

export interface QQImageSourceRead {
  version: 1;
  outcome: 'loaded' | 'failed';
  step: 'input' | 'receipt' | 'receipt_decode' | 'attachment' | 'download' | 'headers' | 'body' | 'decode' | 'complete';
  source: 'receipt' | 'attachment';
  hostname?: string;
  httpStatus?: number;
  contentType?: 'image' | 'octet_stream' | 'text' | 'missing' | 'other';
  bytes?: number;
  declaredTooLarge?: boolean;
  failure?: QQDiagnostic;
}

/** Group-scoped own-image receipts plus bounded QQ CDN reads; no group history or arbitrary paths. */
export class QQImageInputs {
  private readonly loads = new WeakMap<QQRequest, Promise<Buffer[]>>();
  private readonly gifs = new WeakMap<QQRequest, Map<number, Buffer>>();
  constructor(private readonly root: string, private readonly appId: string, private readonly transport = fetch,
    private readonly observe?: (request: QQRequest, read: QQImageSourceRead) => void,
    private readonly normalizeImage: QQImageNormalizer = normalizeQQImage) {}

  async remember(request: QQRequest, image: QQImageResult, receipt: { id: string; ext_info?: { ref_idx?: string } }): Promise<void> {
    if (request.scope !== 'group') throw new Error('QQ image reply requires a group');
    const references = [...new Set([receipt.id, receipt.ext_info?.ref_idx].filter(qqImageReferenceId))];
    if (!references.length) throw new Error('QQ image reply receipt missing');
    // A later pickup uses a different request key/day from the original job.
    const relative = path.relative(path.join(this.root, 'data/runtime/qqbot/records', this.appId), image.file).replace(/\\/gu, '/');
    const stored = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9]{64})\.(png|gif)$/u.exec(relative);
    if (!stored || stored[3] !== (image.format || 'png') || !validQQImageFormat(image.format)) throw new Error('Invalid QQ stored image');
    const entry = { version: 1, date: stored[1], key: stored[2], sha256: image.sha256,
      ...(image.format === 'gif' ? { format: image.format } : {}) };
    for (const reference of references) {
      const file = this.indexFile(request, reference);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(entry), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    }
  }

  async load(request: QQRequest, signal: AbortSignal): Promise<Buffer[]> {
    signal.throwIfAborted();
    let result = this.loads.get(request);
    if (!result) { result = this.loadOnce(request, signal); this.loads.set(request, result); }
    return result;
  }

  /** Previews remain normalized PNG; GIF edits receive the original animation bytes. */
  async loadForGeneration(request: QQRequest, signal: AbortSignal, animation: boolean): Promise<Buffer[]> {
    const images = await this.load(request, signal);
    if (!animation) return images;
    return Promise.all(images.map(async (png, index) => {
      const gif = this.gifs.get(request)?.get(index);
      if (!gif) return png;
      try {
        await validateQQGif(gif, 'image_prepare');
        return (await gifReferenceSheet(gif, signal)) || png;
      }
      catch (error) {
        if (error instanceof QQDiagnosticError) throw error;
        throw qqFailure('image_prepare', 'image_bytes');
      }
    }));
  }

  /** Bind one already-read, same-group candidate to this question and its background job. */
  async select(request: QQRequest, source: QQRequest, signal: AbortSignal): Promise<void> {
    if (request.scope !== 'group' || source.scope !== 'group' || request.targetId !== source.targetId ||
      request.imageInput || !source.imageInput) throw new Error('Invalid QQ contextual image selection');
    const images = await this.load(source, signal);
    signal.throwIfAborted();
    request.imageInput = source.imageInput;
    this.loads.set(request, Promise.resolve(images));
    const gifs = this.gifs.get(source);
    if (gifs) this.gifs.set(request, gifs);
  }

  private async loadOnce(request: QQRequest, signal: AbortSignal): Promise<Buffer[]> {
    const read: QQImageSourceRead = { version: 1, outcome: 'failed', step: 'input', source: 'attachment' };
    try {
      const images = await this.readSources(request, signal, read);
      read.outcome = 'loaded'; read.step = 'complete';
      return images;
    } catch (error) {
      read.failure = qqDiagnostic(error, read.step === 'download' || read.step === 'body' ? 'image_http' : 'image_prepare', 'unexpected', signal);
      throw error;
    } finally {
      // Observation must not change source admission, error propagation, caching or retries.
      try { this.observe?.(request, read); } catch { /* Keep the original read outcome. */ }
    }
  }

  private async readSources(request: QQRequest, signal: AbortSignal, read: QQImageSourceRead): Promise<Buffer[]> {
    const input = request.imageInput;
    if (request.scope !== 'group' || !input || input.urls.length > QQ_IMAGE_SOURCE_LIMIT) throw new Error('QQ source image unavailable');
    signal.throwIfAborted();
    if (input.reply) {
      read.step = 'receipt'; read.source = 'receipt';
      const local = await this.readReply(request, input.reply);
      if (local) { read.step = 'receipt_decode'; read.bytes = local.length; return [await this.normalizeSource(request, 0, local, signal)]; }
    }
    read.step = 'attachment'; read.source = 'attachment';
    // An exact, group-bound own-image receipt is authoritative even when QQ supplies an unusable URL.
    if (input.invalid || !input.urls.length) throw qqFailure('image_prepare', 'image_unavailable');
    const images: Buffer[] = [];
    let totalBytes = 0;
    for (const source of input.urls) {
      signal.throwIfAborted();
      const url = qqImageAttachmentUrl(source);
      if (!url) throw qqFailure('image_prepare', 'image_unavailable');
      read.hostname = new URL(url).hostname;
      read.step = 'download'; delete read.httpStatus; delete read.contentType; delete read.bytes; delete read.declaredTooLarge;
      const response = await this.transport(url, { method: 'GET', redirect: 'error', signal: signal as any,
        timeout: 15000, size: MAX_BYTES });
      read.step = 'headers'; read.httpStatus = response.status;
      const contentType = response.headers.get('content-type') || '';
      read.contentType = !contentType ? 'missing' : /^image\//iu.test(contentType) ? 'image' :
        /^application\/octet-stream(?:;|$)/iu.test(contentType) ? 'octet_stream' : /^text\//iu.test(contentType) ? 'text' : 'other';
      read.declaredTooLarge = Number(response.headers.get('content-length')) > MAX_BYTES;
      if (!response.ok || !/^image\//iu.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_BYTES) throw qqFailure('image_prepare', 'image_unavailable');
      read.step = 'body';
      const bytes = await response.buffer();
      read.bytes = bytes.length;
      if (bytes.length > MAX_BYTES) throw qqFailure('image_prepare', 'image_size');
      read.step = 'decode';
      const normalized = await this.normalizeSource(request, images.length, bytes, signal);
      totalBytes += Math.max(bytes.length, normalized.length);
      if (totalBytes > 64 * 1024 * 1024) throw qqFailure('image_prepare', 'image_size');
      images.push(normalized);
    }
    signal.throwIfAborted();
    return images;
  }

  private indexFile(request: QQRequest, reference: string): string {
    if (!qqImageReferenceId(reference)) throw new Error('Invalid QQ image reference');
    const key = qqDigest(JSON.stringify([request.scope, request.targetId, reference]));
    return path.join(this.root, 'data/runtime/qqbot/image-replies', this.appId, `${key}.json`);
  }

  private async readReply(request: QQRequest, reference: string): Promise<Buffer | undefined> {
    let entry: any;
    try { entry = JSON.parse(await fs.readFile(this.indexFile(request, reference), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!entry || entry.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.date) ||
      !validQQImageFormat(entry.format) ||
      ![entry.key, entry.sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) throw new Error('Invalid QQ image receipt');
    const directory = await fs.realpath(path.join(this.root, 'data/runtime/qqbot/records', this.appId));
    const file = await fs.realpath(path.join(directory, entry.date, `${entry.key}.${entry.format || 'png'}`));
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.stat(file)).size > MAX_BYTES) throw new Error('Invalid QQ source image');
    const bytes = await fs.readFile(file);
    if (qqDigest(bytes) !== entry.sha256) throw new Error('QQ source image changed');
    return bytes;
  }

  private async normalize(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
    const png = await this.normalizeImage(bytes, signal);
    if (png.length > MAX_BYTES) throw qqFailure('image_prepare', 'image_size');
    return png;
  }

  private async normalizeSource(request: QQRequest, index: number, bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
    const png = await this.normalize(bytes, signal);
    if (qqImageBufferFormat(bytes) === 'gif') {
      const gifs = this.gifs.get(request) || new Map<number, Buffer>();
      gifs.set(index, bytes); this.gifs.set(request, gifs);
    }
    return png;
  }
}
