import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';
import FormData = require('form-data');
import sharp from 'sharp';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { questionProviderSettings } from '../live-vote/questions/DaiyuQuestionClient';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageCommand, QQImageConfig, QQImageResult, qqImageCommandPlan, qqImageCommandReply, qqImageConfirmationReply, qqImagePlan } from './QQImagePolicy';
import { QQImageInputs } from './QQImageInputs';
import { qqImageCharacters } from './QQImageCatalog';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { QQDiagnosticError, qqDiagnostic, qqFailure, qqRequestId } from './QQDiagnostics';

/** Fixed API, trusted local character references, one paid attempt, PNG-only local output. */
export function createQQImageGenerator(root: string, appId: string, config: QQImageConfig,
  settings: ReturnType<typeof questionProviderSettings>, transport = fetch, inputs = new QQImageInputs(root, appId)) {
  return async (request: QQRequest, signal: AbortSignal, command?: QQImageCommand): Promise<QQImageResult> => {
    const started = Date.now();
    let stage: QQDiagnostic['stage'] = 'image_prepare';
    const detail: Partial<QQDiagnostic> = {};
    try {
      if (request.scope !== 'group' || !config.enabled) throw new Error('QQ images require a group mention');
      const options = { ...config, characters: qqImageCharacters(root, config) };
      if (command ? qqImageCommandReply(request, command, options) : qqImageConfirmationReply(request, options)) throw new Error('QQ image confirmation required');
      const sources = request.imageInput ? await inputs.load(request, signal) : [];
      const { prompt, references } = command ? qqImageCommandPlan(request, command, options, sources.length) : qqImagePlan(request, options, sources.length);
      const fields = { model: config.model, prompt, n: '1', size: '1024x1024', quality: config.quality, output_format: 'png' };
      let body: FormData | string, headers: Record<string, string>;
      if (references.length || sources.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        for (const [index, source] of sources.entries()) {
          form.append('image[]', source, { filename: `source-${index + 1}.png`, contentType: 'image/png' });
        }
        const allowedRoot = references.length ? await fs.realpath(path.join(root, 'public/reference_images')) : '';
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
      const endpoint = settings.url.replace(/\/chat\/completions$/u, references.length || sources.length ? '/images/edits' : '/images/generations');
      stage = 'image_http';
      const response = await transport(endpoint, { method: 'POST', redirect: 'error', body, signal: signal as any,
        timeout: config.timeoutMs, size: 24 * 1024 * 1024, headers: { ...headers, Authorization: `Bearer ${settings.apiKey}` },
        agent: settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined });
      if (Number.isInteger(response.status)) detail.httpStatus = response.status;
      detail.requestId = qqRequestId(response, settings.apiKey);
      if (!response.ok) throw qqFailure(stage, 'http_error');
      stage = 'image_decode';
      let result: any;
      try { result = await response.json(); }
      catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, stage, 'invalid_json', signal)); }
      const encoded = result?.data?.[0]?.b64_json;
      // URL responses are intentionally not fetched: the provider is asked for local image bytes.
      if (typeof encoded !== 'string' || encoded.length > 22 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw qqFailure(stage, 'image_bytes');
      const png = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: 25_000_000 }).png().toBuffer();
      if (png.length > 10 * 1024 * 1024) throw qqFailure(stage, 'image_size');
      signal.throwIfAborted();
      stage = 'image_store';
      const directory = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(request.createdAt));
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `${request.key}.png`), temporary = `${file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(png); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
      return { file, model: config.model, sha256: qqDigest(png), prompt };
    } catch (error) {
      throw new QQDiagnosticError(qqDiagnostic(error, stage, stage === 'image_decode' ? 'image_bytes' : 'unexpected', signal,
        { ...detail, elapsedMs: Math.max(0, Date.now() - started) }));
    }
  };
}
