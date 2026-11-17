import * as fs from 'fs/promises';
import * as path from 'path';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageCommand, QQImageConfig, qqImageCommandPlan, qqImageOutputFormat } from './QQImagePolicy';
import { QQImageInputs } from './QQImageInputs';
import { QQ_IMAGE_INPUT_LIMIT, QQ_IMAGE_SOURCE_LIMIT } from './QQImageInputPolicy';

export interface QQImageQueuedInput { request: QQRequest; command: QQImageCommand; sources: string[]; referenceCount?: number }
const HASH = /^[a-f0-9]{64}$/u;

/** No platform IDs, signed CDN URLs, chat context or nicknames enter the durable payload. */
export function qqImageQueuedInput(request: QQRequest, command: QQImageCommand, sources: string[] = []): QQImageQueuedInput {
  return { request: { key: request.key, user: request.user, scope: 'group', targetId: '', msgId: '', text: request.text,
    createdAt: request.createdAt, ...(request.imageInput ? { imageInput: { urls: [], reply: 'queued-source' } } : {}) }, command, sources };
}
export function validQQImageQueuedInput(input: QQImageQueuedInput, key: string, user: string): boolean {
  const r = input?.request, c = input?.command;
  return !!r && r.key === key && r.user === user && r.scope === 'group' && r.targetId === '' && r.msgId === '' &&
    typeof r.text === 'string' && r.text.length <= 24000 && Number.isSafeInteger(r.createdAt) &&
    !!c && ['create', 'edit'].includes(c.mode) && typeof c.instruction === 'string' && c.instruction.length <= 1500 &&
    Array.isArray(c.characters) && c.characters.length <= 8 && c.characters.every(name => typeof name === 'string' && name.length <= 80) &&
    Array.isArray(input.sources) && input.sources.length <= QQ_IMAGE_SOURCE_LIMIT && input.sources.every(hash => HASH.test(hash)) &&
    (input.referenceCount === undefined || Number.isInteger(input.referenceCount) && input.referenceCount >= 0 && input.referenceCount <= QQ_IMAGE_INPUT_LIMIT);
}

/** Freeze normalized references before acceptance so a long wait/restart cannot expire QQ attachments. */
export class QQImageQueueInputs {
  private readonly directory: string;
  constructor(root: string, appId: string, private readonly inputs: QQImageInputs, private readonly config?: QQImageConfig) {
    this.directory = path.join(root, 'data/runtime/qqbot/image-queue-inputs', appId);
  }
  async prepare(request: QQRequest, command: QQImageCommand, signal: AbortSignal): Promise<QQImageQueuedInput> {
    const buffers = request.imageInput ? await this.inputs.loadForGeneration(request, signal, qqImageOutputFormat(request.text) === 'gif') : [];
    const plan = this.config ? qqImageCommandPlan(request, command, this.config, buffers.length) : undefined;
    const sources: string[] = [];
    for (const bytes of buffers) {
      signal.throwIfAborted();
      const hash = qqDigest(bytes), file = path.join(this.directory, hash + '.png');
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file); sources.push(hash);
    }
    return { ...qqImageQueuedInput(request, command, sources), ...(plan ? { referenceCount: plan.references.length } : {}) };
  }
  async load(input: QQImageQueuedInput): Promise<Buffer[]> {
    if (!validQQImageQueuedInput(input, input.request.key, input.request.user)) throw new Error('Invalid queued image input');
    return Promise.all(input.sources.map(async hash => {
      const directory = await fs.realpath(this.directory), file = await fs.realpath(path.join(directory, hash + '.png'));
      if (path.dirname(file) !== directory || (await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('Invalid queued image source');
      const bytes = await fs.readFile(file);
      if (qqDigest(bytes) !== hash) throw new Error('Queued image source changed');
      return bytes;
    }));
  }
}
