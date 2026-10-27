import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';
import FormData = require('form-data');
import sharp from 'sharp';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { questionProviderSettings } from '../live-vote/questions/DaiyuQuestionClient';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageConfig, QQImageResult, qqImagePlan } from './QQImagePolicy';
import { qqImageCharacters } from './QQImageCatalog';

/** Fixed API, trusted local character references, one paid attempt, PNG-only local output. */
export function createQQImageGenerator(root: string, appId: string, config: QQImageConfig,
  settings: ReturnType<typeof questionProviderSettings>, transport = fetch) {
  return async (request: QQRequest, signal: AbortSignal): Promise<QQImageResult> => {
    if (request.scope !== 'group' || !config.enabled) throw new Error('QQ images require a group mention');
    const { prompt, references } = qqImagePlan(request, { ...config, characters: qqImageCharacters(root, config) });
    const fields = { model: config.model, prompt, n: '1', size: '1024x1024', quality: config.quality, output_format: 'png' };
    let body: FormData | string, headers: Record<string, string>;
    if (references.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      const allowedRoot = await fs.realpath(path.join(root, 'public/reference_images'));
      for (const [index, reference] of references.entries()) {
        const file = await fs.realpath(path.resolve(root, reference));
        const relative = path.relative(allowedRoot, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid QQ character reference');
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Invalid QQ reference size');
        const data = await sharp(await fs.readFile(file), { limitInputPixels: 25_000_000 }).png().toBuffer();
        form.append('image[]', data, { filename: `character-${index + 1}.png`, contentType: 'image/png' });
      }
      body = form; headers = form.getHeaders();
    } else { body = JSON.stringify({ ...fields, n: 1 }); headers = { 'Content-Type': 'application/json' }; }
    signal.throwIfAborted();
    const endpoint = settings.url.replace(/\/chat\/completions$/u, references.length ? '/images/edits' : '/images/generations');
    const response = await transport(endpoint, { method: 'POST', redirect: 'error', body, signal: signal as any,
      timeout: config.timeoutMs, size: 24 * 1024 * 1024, headers: { ...headers, Authorization: `Bearer ${settings.apiKey}` },
      agent: settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined });
    if (!response.ok) throw new Error('QQ image provider unavailable');
    const result = await response.json() as any, encoded = result?.data?.[0]?.b64_json;
    // URL responses are intentionally not fetched: the provider is asked for local image bytes.
    if (typeof encoded !== 'string' || encoded.length > 22 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('QQ image bytes missing');
    const png = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: 25_000_000 }).png().toBuffer();
    if (png.length > 10 * 1024 * 1024) throw new Error('QQ output image too large');
    signal.throwIfAborted();
    const directory = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(request.createdAt));
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${request.key}.png`), temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(png); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    return { file, model: config.model, sha256: qqDigest(png), prompt };
  };
}
