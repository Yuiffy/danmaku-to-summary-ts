import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { qqDigest, QQRequest } from './QQPolicy';
import type { QQImageCharacter } from './QQImagePolicy';
import { QQVideoConfig, QQVideoCommand, QQVideoResult, qqVideoPlan, qqVideoDirectRequested, qqVideoEditRequested, qqVideoConfirmRequested, QQ_VIDEO_AUTH_REPLY, QQ_VIDEO_CREDIT_REPLY } from './QQVideoPolicy';
import { unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { QQVideoInputError, QQVideoSource } from './QQVideoInputs';
import { QQMediaAccess, qqMediaOperator, QQ_MEDIA_OPERATOR_LIMITS } from './QQMediaAccess';
import { QQ_VIDEO_CUT_HELP, QQ_VIDEO_REFERENCE_MAX_MS, qqVideoCutRequested } from './QQVideoCutPolicy';

export interface QQVideoDraft { prompt: string; creativeText: string; materials: string[]; sourceCount: number; videoSourceCount?: number; command: QQVideoCommand }
export interface QQVideoQueueReply { status: string; taskId?: string; failureCode?: string; file?: string; requiredCredits?: number; draft?: QQVideoDraft; images?: string[]; videos?: QQVideoSource[]; limitReason?: string; retryAt?: number }
export interface QQVideoQueueIO {
  bridge(payload: unknown, signal: AbortSignal): Promise<QQVideoQueueReply>;
  account(signal: AbortSignal): Promise<unknown>;
  load(request: QQRequest, signal: AbortSignal): Promise<Buffer[]>;
  loadVideos?(request: QQRequest, signal: AbortSignal): Promise<QQVideoSource[]>;
}
export interface QQVideoDelivery { status: 'draft' | 'pending' | 'blocked' | 'failed' | 'generated'; message: string; video?: QQVideoResult }

/** Fixed executable/argv, bounded output and no shell. Never expose raw subprocess diagnostics to QQ. */
export function qqVideoProcess(executable: string, args: string[], signal: AbortSignal, input?: unknown): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => child.kill(), 25000);
    child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 1024 * 1024) child.kill(); else chunks.push(bytes); });
    child.stderr.on('data', () => { /* Account data and provider bodies are private. */ });
    child.stdin.on('error', () => { /* close/error settles the attempt */ });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Video adapter unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > 1024 * 1024) return reject(new Error('Video adapter unavailable'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid video adapter response')); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export function qqCanvasAccount(value: unknown): boolean {
  const account = value as { ok?: unknown; data?: { userId?: unknown } } | null;
  return account?.ok === true && /^[1-9]\d*$/u.test(String(account.data?.userId));
}

/** Queue ownership is hashed and server bound. The model selects catalogue names, never paths or IDs. */
export class QQVideoQueue {
  constructor(private readonly root: string, private readonly app: string, private readonly config: QQVideoConfig,
    private readonly characters: QQImageCharacter[], private readonly io: QQVideoQueueIO,
    private readonly access: QQMediaAccess & { dailyLimit?: number; userDailyLimit?: number } = {}) {}
  private admission(request: QQRequest) {
    const operator = qqMediaOperator(this.access, request.user);
    return { dailyLimit: this.access.dailyLimit ?? 300,
      userDailyLimit: operator ? QQ_MEDIA_OPERATOR_LIMITS.userDailyLimit : this.access.userDailyLimit ?? 30,
      userWindowLimit: operator ? QQ_MEDIA_OPERATOR_LIMITS.userWindowImages : 10,
      intervalSeconds: operator ? QQ_MEDIA_OPERATOR_LIMITS.intervalMs / 1000 : 60,
      maxActive: operator ? QQ_MEDIA_OPERATOR_LIMITS.maxConcurrent : 1, independentInterval: operator };
  }
  private owner(request: QQRequest) {
    return { app: this.app, user: request.user, conversation: qqDigest(JSON.stringify([request.scope, request.targetId])), request: request.key };
  }
  async enqueue(request: QQRequest, command: QQVideoCommand, signal: AbortSignal): Promise<QQVideoDelivery> {
    if (!this.config.enabled || request.scope !== 'group') return { status: 'blocked', message: '视频功能未启用。' };
    const owner = this.owner(request);
    const existing = await this.io.bridge({ action: 'lookup', owner }, signal);
    if (existing.status !== 'missing') return this.delivery(existing);
    const previous = qqVideoEditRequested(request.text) ? await this.io.bridge({ action: 'draft', owner }, signal) : undefined;
    if (previous && !previous.draft) return { status: 'blocked', message: '你在本群没有待确认的视频草稿，请先说明要生成的视频。' };
    if (previous?.draft) command = { ...previous.draft.command, ...command,
      characters: command.characters.length ? command.characters : previous.draft.command.characters,
      voices: command.voices.length ? command.voices : previous.draft.command.voices,
      model: command.model ?? previous.draft.command.model, ratio: command.ratio ?? previous.draft.command.ratio,
      duration: command.duration ?? previous.draft.command.duration };
    const removeVoice = qqVideoEditRequested(request.text) && /(?:不要|不用|取消|去掉|移除)(?:人物)?(?:的)?(?:声线|音色|声音参考|配音参考)/u.test(request.text);
    if (removeVoice) command = { ...command, voices: [] };
    let plan: ReturnType<typeof qqVideoPlan>;
    try { plan = qqVideoPlan(request.text, command, this.characters, !!request.videoInput); }
    catch (error) { return { status: 'blocked', message: (error as Error).message }; }
    if (unsafeComment(command.instruction)) return { status: 'blocked', message: '视频说明未通过检查，请按原始创作要求调整。' };
    const voices = [...new Set(command.voices)].map(name => this.config.voices.find(voice => voice.name === name));
    if (voices.some(voice => !voice)) return { status: 'blocked', message: '没有收录这个人的声线，请先查询可用声线。' };
    // A named voice cannot silently degrade to text-only imitation if the model omits the audio selection.
    const voiceText = previous?.draft ? previous.draft.creativeText + '\n' + request.text : request.text;
    const voiceRequested = !removeVoice && /声线|音色|声音.{0,5}(?:说|配音)|用.{1,20}配音/u.test(voiceText);
    if (!voiceRequested && voices.length) return { status: 'blocked', message: '本条没有要求人物声线，不会擅自加入声线素材。' };
    const namedVoices = this.config.voices.filter(voice => voice.aliases.some(alias =>
      new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:的)?(?:声线|音色|声音|配音)`, 'iu').test(voiceText)));
    if (voiceRequested && !voices.length) voices.push(...namedVoices);
    if (voices.some(voice => !namedVoices.includes(voice!))) return { status: 'blocked', message: '所选声线与本次指定的人物不一致，或该声线尚未收录，请重新选择。' };
    if (voiceRequested && !voices.length) return { status: 'blocked', message: '请先选择已收录的声线；没有对应声音素材时无法使用该声线。' };
    if (!request.videoInput && qqVideoCutRequested(request.text)) return { status: 'blocked', message: QQ_VIDEO_CUT_HELP };
    const direct = qqVideoDirectRequested(request.text);
    if (direct && !qqCanvasAccount(await this.io.account(signal))) return { status: 'blocked', message: QQ_VIDEO_AUTH_REPLY };
    let videos: QQVideoSource[] = previous?.videos || [];
    if (request.videoInput) {
      try {
        if (!this.io.loadVideos) throw new Error();
        videos = await this.io.loadVideos(request, signal);
        if (!videos.length) throw new Error();
      } catch (error) {
        signal.throwIfAborted();
        return { status: 'blocked', message: error instanceof QQVideoInputError ? error.message : '没有读到可用参考视频，本次未提交生成，请直接附视频与要求重发。' };
      }
    }
    let source: Buffer[] = [];
    if (request.imageInput) {
      const unavailable: QQVideoDelivery = { status: 'blocked',
        message: '没有读到可用原图，本次视频未提交生成。请把原图直接附在新消息里，并同时发送视频要求。' };
      try { source = await this.io.load(request, signal); }
      catch { signal.throwIfAborted(); return unavailable; }
      if (!source.length) return unavailable;
    }
    const inherited = !request.imageInput ? previous?.images || [] : [];
    if (source.length + inherited.length + plan.references.length > 9) return { status: 'blocked', message: '视频最多使用9张参考图，请减少附图或角色素材。' };
    if (videos.length > 3 || videos.reduce((sum, item) => sum + item.durationMs, 0) > QQ_VIDEO_REFERENCE_MAX_MS) return { status: 'blocked', message: '参考视频最多3段，总时长最多15.4秒，本次未提交生成。' };
    if (source.length + inherited.length + plan.references.length + videos.length + voices.length > 12) return { status: 'blocked', message: '图片、视频和声音参考合计最多12份，请减少素材。' };
    if (voices.length && !source.length && !inherited.length && !plan.references.length && !videos.length) return { status: 'blocked', message: '使用声线参考时还需附图、附视频或指定角色素材。' };
    const trustedRoot = await fs.realpath(path.join(this.root, 'public/reference_images'));
    const images: string[] = [...inherited];
    const directory = path.join(this.root, 'data/runtime/qqbot/video-inputs', this.app, request.key);
    if (source.length) await fs.mkdir(directory, { recursive: true });
    for (const [index, bytes] of source.entries()) {
      const file = path.join(directory, `source-${index + 1}-${qqDigest(bytes)}.png`);
      await fs.writeFile(file, bytes); images.push(file);
    }
    for (const character of plan.references) {
      const file = await fs.realpath(path.resolve(this.root, character.referenceImage));
      const relative = path.relative(trustedRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid video reference');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Invalid video reference');
      images.push(file);
    }
    const sourceCount = source.length + inherited.length;
    const creativeText = previous?.draft ? `${previous.draft.creativeText}\n本次修改优先：${request.text}` : request.text;
    const prompt = [creativeText, command.instruction,
      ...plan.references.map((character, index) => `@Image ${sourceCount + index + 1} 是${character.name}的外观参考：${character.description}`),
      ...videos.map((video, index) => `@Video ${index + 1} 是用户提供的参考视频，按照本次要求使用其画面、动作和镜头信息；指定人物外观以角色参考为准。` +
        (video.cut ? '原片截取已完成，请按此参考片段的完整内容创作。' : '')),
      ...voices.map((voice, index) => `@Audio ${index + 1} 仅参考${voice!.name}的声线，不复制样本台词，台词以本次用户要求为准。`)].join('\n');
    if (prompt.length > 3000) return { status: 'blocked', message: '完整视频prompt过长，请精简要求后再提交。' };
    const draft: QQVideoDraft = { prompt, creativeText, sourceCount, videoSourceCount: videos.length,
      materials: [...Array.from({ length: sourceCount }, (_, index) => `图片${index + 1}：用户附图${index + 1}`),
        ...plan.references.map((character, index) => `图片${sourceCount + index + 1}：${character.name}`),
        ...videos.map((video, index) => (!request.videoInput && previous?.draft?.materials.find(material => material.startsWith(`视频${index + 1}：`))) ||
          `视频${index + 1}：用户参考视频（${video.durationMs / 1000}秒${video.cut ? `，取原片${video.cut}` : ''}）`),
        ...voices.map((voice, index) => `音频${index + 1}：${voice!.name}声线`)],
      command: { ...command, characters: plan.references.map(character => character.name), voices: voices.map(voice => voice!.name),
        model: plan.model, ratio: plan.ratio, duration: plan.duration } };
    signal.throwIfAborted();
    return this.delivery(await this.io.bridge({ action: 'enqueue', owner, senderName: request.senderName, prompt, images,
      videos: videos.map(video => video.file), videoDurationsMs: videos.map(video => video.durationMs),
      audio: voices.map(voice => path.resolve(this.root, voice!.audio)), model: plan.model,
      ratio: plan.ratio, duration: plan.duration, resolution: '720p', direct, draft, admission: this.admission(request) }, signal));
  }
  async readDraft(request: QQRequest, signal: AbortSignal) {
    if (request.scope !== 'group' || !this.config.enabled) return { status: 'missing' };
    const result = await this.io.bridge({ action: 'draft', owner: this.owner(request) }, signal);
    return result.draft ? { status: 'draft', prompt: result.draft.prompt, materials: result.draft.materials, command: result.draft.command } : { status: 'missing' };
  }
  async approve(request: QQRequest, signal: AbortSignal): Promise<QQVideoDelivery> {
    if (request.scope !== 'group' || !this.config.enabled || !qqVideoConfirmRequested(request.text)) return { status: 'blocked', message: '请先检查视频草稿，再明确回复“确认生成视频”。' };
    if (!qqCanvasAccount(await this.io.account(signal))) return { status: 'blocked', message: QQ_VIDEO_AUTH_REPLY };
    return this.delivery(await this.io.bridge({ action: 'approve', owner: this.owner(request), admission: this.admission(request) }, signal));
  }
  async collect(request: QQRequest, signal: AbortSignal): Promise<QQVideoDelivery> {
    if (request.scope !== 'group' || !this.config.enabled) return { status: 'blocked', message: '请在群里领取视频。' };
    const result = await this.io.bridge({ action: 'status', owner: this.owner(request) }, signal);
    if (result.status !== 'completed' || !result.file) return this.delivery(result);
    if (!new RegExp(`^qq_${this.app}_[a-f0-9]{64}$`, 'u').test(result.taskId || '')) throw new Error('Invalid video task');
    const resultRoot = await fs.realpath(path.join(path.dirname(this.config.queuePath), 'qq-results'));
    const directory = await fs.realpath(path.join(resultRoot, result.taskId!));
    if (path.relative(resultRoot, directory).startsWith('..')) throw new Error('Invalid video directory');
    const file = await fs.realpath(result.file);
    const relative = path.relative(directory, file);
    const stat = await fs.stat(file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.mp4$/iu.test(file) || !stat.isFile() || stat.size < 12 || stat.size > 100 * 1024 * 1024) throw new Error('Invalid video output');
    const handle = await fs.open(file, 'r');
    try { const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0); if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4'); }
    finally { await handle.close(); }
    return { status: 'generated', message: '视频生成完成。', video: { file, taskId: result.taskId } };
  }
  async delivered(request: QQRequest, video: QQVideoResult, signal: AbortSignal): Promise<void> {
    if (video.taskId) await this.io.bridge({ action: 'delivered', owner: this.owner(request), taskId: video.taskId }, signal);
  }
  async confirm(request: QQRequest, signal: AbortSignal): Promise<QQVideoDelivery> {
    const amount = /^确认视频(?:使用|消耗)?\s*(\d+)\s*积分[。！!]?$/u.exec(request.text.trim());
    if (request.scope !== 'group' || !this.config.enabled || !amount) return { status: 'blocked', message: '请按报价明确回复“确认视频90积分”（数字替换为你同意的积分上限）。' };
    return this.delivery(await this.io.bridge({ action: 'confirm', owner: this.owner(request), credits: Number(amount[1]) }, signal));
  }
  private delivery(result: QQVideoQueueReply): QQVideoDelivery {
    if (result.status === 'limited' && Number.isSafeInteger(result.retryAt)) {
      const when = new Date(result.retryAt!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const reason = result.limitReason === 'interval' ? '全局视频启动间隔为1分钟' : result.limitReason === 'user_interval' ? '你的视频启动间隔至少10秒' :
        result.limitReason === 'user_window' ? '你近5小时的视频次数已用完' : result.limitReason === 'user_daily' ? '你今天的视频次数已用完' : '今天大家的视频次数已用完';
      return { status: 'blocked', message: `${reason}，请在${when}后再试；本次未提交生成。` };
    }
    if (result.status === 'draft' && result.draft) {
      const { draft } = result, { command } = draft;
      return { status: 'draft', message: `视频草稿（尚未入队）\n素材：${draft.materials.join('；') || '无，纯文本生成'}\n设置：${command.model}、720P、${command.ratio}、${command.duration}秒\nprompt：\n${draft.prompt}\n检查后回复“确认生成视频”；修改请说“修改视频……”并附要求，也可说“直接生成视频”。` };
    }
    if (result.failureCode === 'insufficient_credits') return { status: 'failed', message: QQ_VIDEO_CREDIT_REPLY };
    if (result.failureCode === 'account_unavailable') return { status: 'failed', message: QQ_VIDEO_AUTH_REPLY };
    if (result.failureCode === 'invalid_request') return { status: 'failed', message: '视频任务参数未通过校验，已暂停，请管理员检查配置；不会重复生成。' };
    if (result.failureCode === 'provider_unavailable') return { status: 'failed', message: '视频生成服务暂时不可用，任务已暂停，请管理员检查；不会重复生成。' };
    if (['confirmation_required', 'billing_unavailable'].includes(result.failureCode || '')) return { status: 'blocked',
      message: '视频积分自动处理暂未完成，请管理员检查；无需回复积分确认。' };
    if (result.status === 'missing') return { status: 'blocked', message: '你在本群还没有可领取的视频，请先发起视频生成。' };
    if (result.status === 'busy') return { status: 'blocked', message: '视频队列繁忙，或你的未完成视频数已达上限；请稍后再试或先查询视频进度。' };
    if (result.status === 'needs_review') return { status: 'blocked', message: '视频提交结果还需管理员核对，暂时不会再次生成，请稍后查询视频进度。' };
    if (result.status === 'completed') return { status: 'pending', message: '视频已经生成，请在本群艾特我说“领取视频”收片。' };
    if (['pending', 'submitted'].includes(result.status)) return { status: 'pending', message: `${result.status === 'submitted' ? '视频已提交，正在生成中。' : '视频已按确认的设置进入生成队列。'}稍后在本群艾特我说“领取视频”查看进度或收片。` };
    return { status: 'failed', message: '视频任务暂时无法完成，请管理员检查队列；不会重复提交生成。' };
  }
}
