import * as fs from 'fs/promises';
import * as path from 'path';
import { QQRequest, qqDigest } from './QQPolicy';
import { QQImageResult } from './QQImagePolicy';
import { QQSendRejectedError } from './QQSendReceipt';

type Outcome = 'pending' | 'sending' | 'sent' | 'unknown' | 'expired';
type Step = 'qqNotice' | 'wecomText' | 'wecomImage';
interface Receipt {
  version: 1; appId: string; requestId: string; imageSha256: string; platformCode: number;
  qqNotice: Outcome; wecomText: Outcome; wecomImage: Outcome;
}
export interface QQImageRejectionEvent {
  event: 'qq_image_rejection_notice'; requestId: string; scope: 'group';
  rejectionNotice: { version: 1; step: Step | 'journal'; outcome: Outcome; platformCode: number };
}
export interface QQImageRejectionIO {
  sendNotice(request: QQRequest, text: string): Promise<'sent' | 'expired'>;
  sendText(text: string): Promise<boolean>;
  sendImage(file: string): Promise<boolean>;
  report(event: QQImageRejectionEvent): void;
}
const outcomes: Outcome[] = ['pending', 'sending', 'sent', 'unknown', 'expired'];
const steps: Step[] = ['qqNotice', 'wecomText', 'wecomImage'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** A numeric rejection code alone does not establish its cause or a moderation category. */
export function qqImageRejectionNotice(code: number): string {
  return `图片已经生成，但QQ拒绝发送这张图（错误码${code}）。目前未确认具体原因。`;
}

/** Each side effect has a durable intent. An uncertain notice is never automatically replayed. */
export class QQImageRejections {
  private active = new Map<string, Promise<void>>();
  constructor(private readonly root: string, private readonly appId: string, private readonly io: QQImageRejectionIO) {
    if (!/^[1-9]\d{0,24}$/u.test(appId)) throw new Error('Invalid QQ alert owner');
  }
  handle(request: QQRequest, image: QQImageResult, rejection: QQSendRejectedError): Promise<void> {
    const running = this.active.get(request.key);
    if (running) return running;
    const run = this.deliver(request, image, rejection).catch(() => {
      this.report(request, rejection, 'journal', 'unknown');
    }).finally(() => this.active.delete(request.key));
    this.active.set(request.key, run); return run;
  }
  private report(request: QQRequest, rejection: QQSendRejectedError, step: Step | 'journal', outcome: Outcome): void {
    try { this.io.report({ event: 'qq_image_rejection_notice', requestId: request.key, scope: 'group',
      rejectionNotice: { version: 1, step, outcome, platformCode: rejection.platformCode } }); }
    catch { /* Reporting cannot change whether a side effect is sent. */ }
  }
  private async deliver(request: QQRequest, image: QQImageResult, rejection: QQSendRejectedError): Promise<void> {
    if (request.scope !== 'group' || !hash(request.key) || !hash(image.sha256) ||
      !Number.isSafeInteger(rejection.platformCode) || rejection.platformCode <= 0) throw new Error('Invalid QQ rejection');
    const file = path.join(this.root, 'data/runtime/qqbot/send-alerts', this.appId, `${request.key}.json`);
    const receipt: Receipt = { version: 1, appId: this.appId, requestId: request.key, imageSha256: image.sha256,
      platformCode: rejection.platformCode, qqNotice: 'pending', wecomText: 'pending', wecomImage: 'pending' };
    try {
      if ((await fs.stat(file)).size > 4096) throw new Error('Invalid QQ alert receipt');
      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as Receipt;
      if (saved.version !== 1 || saved.appId !== receipt.appId || saved.requestId !== receipt.requestId ||
        saved.imageSha256 !== receipt.imageSha256 || saved.platformCode !== receipt.platformCode ||
        steps.some(step => !outcomes.includes(saved[step]))) throw new Error('Invalid QQ alert receipt');
      Object.assign(receipt, saved);
      for (const step of steps) if (receipt[step] === 'sending') receipt[step] = 'unknown';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const save = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(receipt), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    };
    const send = async (step: Step, action: () => Promise<Outcome>) => {
      if (receipt[step] !== 'pending') return;
      receipt[step] = 'sending'; await save();
      try { receipt[step] = await action(); } catch { receipt[step] = 'unknown'; }
      await save(); this.report(request, rejection, step, receipt[step]);
    };
    // The passive QQ reply window is shorter than the operator alert's lifetime.
    await send('qqNotice', () => this.io.sendNotice(request, qqImageRejectionNotice(rejection.platformCode)));
    const description = qqImageRejectionNotice(rejection.platformCode);
    const text = `QQ鹿饼发图被拒绝\n${description}\nHTTP ${rejection.httpStatus}\n` +
      `提问时间：${new Date(request.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n` +
      `用户要求：${request.text.slice(0, 600)}\nQQ文字提示：${receipt.qqNotice === 'sent' ? '已发送' : receipt.qqNotice === 'expired' ? '原消息已过回复时限' : '未确认送达'}\n` +
      `任务：${request.key.slice(0, 12)}\n以下附上对应的生成结果供查看。`;
    await send('wecomText', async () => await this.io.sendText(text) ? 'sent' : 'unknown');
    await send('wecomImage', async () => {
      const directory = await fs.realpath(path.join(this.root, 'data/runtime/qqbot/records', this.appId));
      const source = await fs.realpath(image.file), relative = path.relative(directory, source);
      if (relative.startsWith('..') || path.isAbsolute(relative) || (await fs.stat(source)).size > 10 * 1024 * 1024 ||
        qqDigest(await fs.readFile(source)) !== image.sha256) throw new Error('QQ alert image changed');
      return await this.io.sendImage(source) ? 'sent' : 'unknown';
    });
  }
}
