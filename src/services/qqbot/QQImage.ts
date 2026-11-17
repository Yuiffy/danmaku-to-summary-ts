import * as fs from 'fs/promises';
import * as path from 'path';
import fetch, { Response } from 'node-fetch';
import FormData = require('form-data');
import sharp from 'sharp';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { questionProviderSettings } from '../live-vote/questions/DaiyuQuestionClient';
import { shanghaiDay } from '../bilibili/comment-replies/CommentPolicy';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageCommand, QQImageConfig, QQImageResult, qqImageCommandForRequest, qqImageCommandPlan, qqImageCommandReply, qqImageConfirmationReply, qqImagePlan } from './QQImagePolicy';
import { QQImageInputs } from './QQImageInputs';
import { qqImageCharacters } from './QQImageCatalog';
import { QQDiagnostic } from '../../core/admin/qqDiagnostics';
import { QQDiagnosticError, qqDiagnostic, qqFailure, qqRequestId } from './QQDiagnostics';
import { qqImageLongComicRequested, qqImageModel, qqImageOutputFormat } from './QQImagePolicy';
import { qqImageBufferFormat } from '../../core/qqImageFormat';
import { validateQQGif } from './QQImageAnimation';
import { qqImagePackedBuffers, qqImagePackingNotice } from './QQImagePacking';

type SafeUpstreamMessage = NonNullable<QQDiagnostic['upstreamMessage']>;
type ImageHttpFailure = { code: QQDiagnostic['code']; upstreamMessage?: SafeUpstreamMessage };

function isGifOutputUnavailable(value: unknown): boolean {
  return typeof value === 'string' && /GIF output is not enabled for this request/iu.test(value);
}

/** Inspect only a bounded error envelope; arbitrary provider text never leaves this adapter. */
async function imageHttpFailure(response: Response): Promise<ImageHttpFailure> {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    const body = response.body;
    if (Buffer.isBuffer(body)) {
      if (body.length > 16384) return { code: 'http_error' };
      chunks.push(body);
    } else {
      for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 16384) return { code: 'http_error' };
        chunks.push(bytes);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const error = parsed?.error;
    if (isGifOutputUnavailable(parsed?.detail) || isGifOutputUnavailable(error?.message) || isGifOutputUnavailable(text)) {
      return { code: 'image_gif_unavailable' };
    }
    const message = error?.message === 'Upstream request failed' || error?.message === 'Our servers are currently overloaded. Please try again later.'
      ? error.message as SafeUpstreamMessage
      : text === 'Upstream request failed' || text === 'Our servers are currently overloaded. Please try again later.'
        ? text as SafeUpstreamMessage : undefined;
    if (response.status === 400 && error?.code === 'moderation_blocked') {
      return { code: typeof error.message === 'string' && /safety_violations=\[[^\]\r\n]*\bsexual\b[^\]\r\n]*\]/u.test(error.message)
        ? 'image_sexual' : 'image_moderation', ...(message ? { upstreamMessage: message } : {}) };
    }
    return { code: 'http_error', ...(message ? { upstreamMessage: message } : {}) };
  } catch { /* Unreadable or non-JSON error bodies retain their original HTTP failure. */ }
  return { code: 'http_error' };
}

/** Fixed API, trusted local references, validated PNG or multi-frame GIF output. */
export function createQQImageGenerator(root: string, appId: string, config: QQImageConfig,
  settings: ReturnType<typeof questionProviderSettings>, transport = fetch, inputs = new QQImageInputs(root, appId)) {
  return async (request: QQRequest, signal: AbortSignal, command?: QQImageCommand, preparedSources?: Buffer[]): Promise<QQImageResult> => {
    const started = Date.now();
    let stage: QQDiagnostic['stage'] = 'image_prepare';
    const detail: Partial<QQDiagnostic> = {};
    try {
      if (request.scope !== 'group' || !config.enabled) throw new Error('QQ images require a group mention');
      const options = { ...config, characters: qqImageCharacters(root, config) };
      command = command ? qqImageCommandForRequest(request, command) : command;
      if (command ? qqImageCommandReply(request, command, options) : qqImageConfirmationReply(request, options)) throw new Error('QQ image confirmation required');
      const format = qqImageOutputFormat(request.text), model = qqImageModel(request, config);
      const sources = preparedSources ?? (request.imageInput ? await inputs.loadForGeneration(request, signal, format === 'gif') : []);
      const { prompt, references, packing } = command ? qqImageCommandPlan(request, command, options, sources.length) : qqImagePlan(request, options, sources.length);
      const fields = { model, prompt, n: '1', size: format === 'gif' ? '512x512' : qqImageLongComicRequested(request.text) ? '1024x1536' : '1024x1024', quality: config.quality, output_format: format };
      let body: FormData | string, headers: Record<string, string>;
      if (references.length || sources.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        const packedSources = await qqImagePackedBuffers(sources, packing.sources, 'SOURCE', signal);
        for (const [index, source] of packedSources.entries()) {
          const sourceFormat = packing.sources[index].length > 1 ? 'jpeg' : qqImageBufferFormat(source) === 'gif' ? 'gif' : 'png';
          form.append('image[]', source, { filename: `source-${index + 1}.${sourceFormat}`, contentType: `image/${sourceFormat}` });
        }
        const allowedRoot = references.length ? await fs.realpath(path.join(root, 'public/reference_images')) : '';
        const referenceBuffers: Buffer[] = [];
        for (const reference of references) {
          const file = await fs.realpath(path.resolve(root, reference));
          const relative = path.relative(allowedRoot, file);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid QQ character reference');
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Invalid QQ reference size');
          const data = await sharp(await fs.readFile(file), { limitInputPixels: 25_000_000 }).png().toBuffer();
          referenceBuffers.push(data);
        }
        const packedReferences = await qqImagePackedBuffers(referenceBuffers, packing.references, 'CHARACTER', signal);
        for (const [index, data] of packedReferences.entries()) {
          const referenceFormat = packing.references[index].length > 1 ? 'jpeg' : 'png';
          form.append('image[]', data, { filename: `character-${index + 1}.${referenceFormat}`, contentType: `image/${referenceFormat}` });
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
      if (!response.ok) {
        const failure = await imageHttpFailure(response);
        throw qqFailure(stage, failure.code, failure.upstreamMessage ? { upstreamMessage: failure.upstreamMessage } : {});
      }
      stage = 'image_decode';
      let result: any;
      try { result = await response.json(); }
      catch (error) { throw new QQDiagnosticError(qqDiagnostic(error, stage, 'invalid_json', signal)); }
      const encoded = result?.data?.[0]?.b64_json;
      // URL responses are intentionally not fetched: the provider is asked for local image bytes.
      if (typeof encoded !== 'string' || encoded.length > 22 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw qqFailure(stage, 'image_bytes');
      const bytes = Buffer.from(encoded, 'base64');
      const output = format === 'gif' ? await validateQQGif(bytes, stage, true) :
        await sharp(bytes, { limitInputPixels: 25_000_000 }).png().toBuffer();
      if (output.length > 10 * 1024 * 1024) throw qqFailure(stage, 'image_size');
      signal.throwIfAborted();
      stage = 'image_store';
      const directory = path.join(root, 'data/runtime/qqbot/records', appId, shanghaiDay(request.createdAt));
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `${request.key}.${format}`), temporary = `${file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
      const collageNotice = qqImagePackingNotice(sources.length, references.length);
      return { file, model, sha256: qqDigest(output), prompt, ...(format === 'gif' ? { format } : {}), ...(collageNotice ? { collageNotice } : {}) };
    } catch (error) {
      throw new QQDiagnosticError(qqDiagnostic(error, stage, stage === 'image_decode' ? 'image_bytes' : 'unexpected', signal,
        { ...detail, elapsedMs: Math.max(0, Date.now() - started) }));
    }
  };
}
