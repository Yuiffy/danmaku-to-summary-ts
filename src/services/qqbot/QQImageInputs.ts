import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageResult } from './QQImagePolicy';
import { QQ_IMAGE_INPUT_LIMIT, qqImageAttachmentUrl, qqImageReferenceId } from './QQImageInputPolicy';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';

const MAX_BYTES = 10 * 1024 * 1024;

/** Group-scoped own-image receipts plus bounded QQ CDN reads; no group history or arbitrary paths. */
export class QQImageInputs {
  private readonly loads = new WeakMap<QQRequest, Promise<Buffer[]>>();
  constructor(private readonly root: string, private readonly appId: string, private readonly transport = fetch) {}

  async remember(request: QQRequest, image: QQImageResult, receipt: { id: string; ext_info?: { ref_idx?: string } }): Promise<void> {
    if (request.scope !== 'group') throw new Error('QQ image reply requires a group');
    const references = [...new Set([receipt.id, receipt.ext_info?.ref_idx].filter(qqImageReferenceId))];
    if (!references.length) throw new Error('QQ image reply receipt missing');
    const entry = { version: 1, date: shanghaiDay(request.createdAt), key: request.key, sha256: image.sha256 };
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

  private async loadOnce(request: QQRequest, signal: AbortSignal): Promise<Buffer[]> {
    const input = request.imageInput;
    if (request.scope !== 'group' || !input || input.urls.length > QQ_IMAGE_INPUT_LIMIT) throw new Error('QQ source image unavailable');
    signal.throwIfAborted();
    if (input.reply) {
      const local = await this.readReply(request, input.reply);
      if (local) return [await this.normalize(local)];
    }
    // An exact, group-bound own-image receipt is authoritative even when QQ supplies an unusable URL.
    if (input.invalid || !input.urls.length) throw new Error('QQ source image unavailable');
    const images: Buffer[] = [];
    for (const source of input.urls) {
      signal.throwIfAborted();
      const url = qqImageAttachmentUrl(source);
      if (!url) throw new Error('Invalid QQ image attachment');
      const response = await this.transport(url, { method: 'GET', redirect: 'error', signal: signal as any,
        timeout: 15000, size: MAX_BYTES });
      if (!response.ok || !/^image\//iu.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('QQ image download failed');
      const bytes = await response.buffer();
      if (bytes.length > MAX_BYTES) throw new Error('QQ source image too large');
      images.push(await this.normalize(bytes));
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
      ![entry.key, entry.sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) throw new Error('Invalid QQ image receipt');
    const directory = await fs.realpath(path.join(this.root, 'data/runtime/qqbot/records', this.appId));
    const file = await fs.realpath(path.join(directory, entry.date, `${entry.key}.png`));
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.stat(file)).size > MAX_BYTES) throw new Error('Invalid QQ source image');
    const bytes = await fs.readFile(file);
    if (qqDigest(bytes) !== entry.sha256) throw new Error('QQ source image changed');
    return bytes;
  }

  private async normalize(bytes: Buffer): Promise<Buffer> {
    const png = await sharp(bytes, { limitInputPixels: 25_000_000 }).png().toBuffer();
    if (png.length > MAX_BYTES) throw new Error('QQ source image too large');
    return png;
  }
}
