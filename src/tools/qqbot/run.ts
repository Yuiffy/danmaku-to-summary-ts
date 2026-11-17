import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { readJsonObject } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { questionProviderSettings } from '../../services/live-vote/questions/DaiyuQuestionClient';
import { readQuestionRuntime } from '../../services/live-vote/questions/EvidenceQuery';
import { QQConfig, QQ_MODEL, QQ_LIMITS, validateQQConfig } from '../../services/qqbot/QQPolicy';
import { QQState, QQStateStore, validateQQState } from '../../services/qqbot/QQState';
import { QQWorker } from '../../services/qqbot/QQWorker';
import { createQQAnswerer } from '../../services/qqbot/QQAgent';
import { createQQKnowledge } from '../../services/qqbot/QQKnowledge';
import { createPublicSearchFactory } from '../../services/live-vote/questions/PublicSearchRuntime';
import { loadQQSdk } from '../../services/qqbot/QQSdk';
import { QQRecords } from '../../services/qqbot/QQRecords';
import { readQQSecrets } from '../../services/qqbot/QQSecrets';
import { createQQImageGenerator } from '../../services/qqbot/QQImage';
import { QQImageQueueInputs } from '../../services/qqbot/QQImageQueueInputs';
import { qqImageCharacters } from '../../services/qqbot/QQImageCatalog';
import { validateQQImageConfig } from '../../services/qqbot/QQImagePolicy';
import { QQImageInputs } from '../../services/qqbot/QQImageInputs';
import { QQRecentImages } from '../../services/qqbot/QQRecentImages';
import { createQQImageTools } from '../../services/qqbot/QQImageTools';
import { withQQImageTaskTools } from '../../services/qqbot/QQImageTaskTools';
import { QQImageJobs } from '../../services/qqbot/QQImageJobs';
import { qqSendReceiptDiagnostic, qqSendFailureDiagnostic, qqSendRejection, QQSendReceiptDiagnostic, QQSendRejectedError } from '../../services/qqbot/QQSendReceipt';
import { createQQImageRejections } from '../../services/qqbot/QQImageRejectionRuntime';
import { qqDiagnostic } from '../../services/qqbot/QQDiagnostics';
import { QQChatArchive } from '../../services/qqbot/QQChatArchive';
import { QQKnowledgeBase, qqKnowledgeFile } from '../../services/qqbot/QQKnowledgeBase';
import type { QQBot, SendMessageOptions } from '@tencent-connect/qqbot-nodejs';
import type { MediaFileType, MessageResponse } from '@tencent-connect/qqbot-nodejs';
import type { QQImageResult } from '../../services/qqbot/QQImagePolicy';
import type { QQRequest } from '../../services/qqbot/QQPolicy';
import { QQVideoQueue, qqVideoProcess } from '../../services/qqbot/QQVideoQueue';
import { QQVideoInputs } from '../../services/qqbot/QQVideoInputs';
import { createQQVideoTools, mergeQQMediaTools } from '../../services/qqbot/QQVideoTools';
import type { QQVideoResult } from '../../services/qqbot/QQVideoPolicy';
import { qqReplyParts, sendQQProgress, waitQQReplySlot } from '../../services/qqbot/QQReplyDelivery';

type QQMode = 'check' | 'live' | 'status' | 'resume';

/** Bind the passive window separately from the server-owned native quote for supplemental images. */
export async function sendQQReply(bot: Pick<QQBot, 'send' | 'uploadMedia'>, request: QQRequest,
  answer: string, image?: QQImageResult, observe?: (diagnostic: QQSendReceiptDiagnostic) => void,
  imageRejected?: (error: QQSendRejectedError) => Promise<void>, video?: QQVideoResult,
  beforeNextPart?: () => Promise<void>): Promise<MessageResponse> {
  const target = { scope: request.scope, targetId: request.targetId, msgId: request.msgId };
  const reference = { message_id: request.replyMsgId || request.msgId };
  const notify = (diagnostic: QQSendReceiptDiagnostic) => { try { observe?.(diagnostic); } catch { /* Diagnostics cannot change sending. */ } };
  const send = async (options: SendMessageOptions) => {
    let result: MessageResponse;
    try { result = await bot.send(options); }
    catch (error) {
      notify(qqSendFailureDiagnostic(error, 'message'));
      const rejected = qqSendRejection(error);
      if (rejected && image && imageRejected) {
        try { await imageRejected(rejected); } catch { /* Keep the original platform rejection. */ }
      }
      throw rejected || error;
    }
    notify(qqSendReceiptDiagnostic(result)); return result;
  };
  if (image || video) {
    let upload: Awaited<ReturnType<QQBot['uploadMedia']>>;
    try { upload = await bot.uploadMedia({ target, fileType: (video ? 2 : 1) as MediaFileType, localPath: (video || image)!.file, srvSendMsg: false }); }
    catch (error) { notify(qqSendFailureDiagnostic(error, 'upload')); throw error; }
    const options: SendMessageOptions = { target, msgType: 7, media: { file_info: upload.file_info }, content: answer,
      messageReference: reference };
    return send(options);
  }
  const parts = qqReplyParts(answer);
  if (parts.length > 1 && !beforeNextPart) throw new Error('QQ multipart delivery requires durable pacing');
  let result: MessageResponse;
  for (const [index, content] of parts.entries()) {
    if (index) await beforeNextPart!();
    result = await send({ target, msgType: 0, content, messageReference: reference });
    if (parts.length > 1 && !result?.id) throw new Error('QQ partial reply receipt missing');
  }
  return result!;
}

/** An explicit image rejection permits one separately checkpointed text notice in the original passive window. */
export async function sendQQRejectionNotice(bot: Pick<QQBot, 'send' | 'uploadMedia'>, request: QQRequest, text: string,
  state: QQState, io: { now(): number; sleep(ms: number): Promise<unknown>; save(state: QQState): Promise<void>;
    stopping(): boolean; observe?(diagnostic: QQSendReceiptDiagnostic): void }): Promise<'sent' | 'expired'> {
  if (io.stopping() || state.paused) return 'expired';
  const delay = Math.max(0, state.lastSendAt + QQ_LIMITS.sendIntervalMs - io.now());
  if (delay) await io.sleep(delay);
  if (io.stopping() || state.paused || io.now() - request.createdAt >= QQ_LIMITS.maxAgeMs) return 'expired';
  const receipt = state.receipts[request.key];
  if (receipt && (receipt.replies || 0) >= 5) return 'expired';
  if (receipt) receipt.replies = (receipt.replies || 0) + 1;
  state.lastSendAt = io.now(); await io.save(state);
  const result = await sendQQReply(bot, request, text, undefined, io.observe);
  if (!result?.id) throw new Error('QQ rejection notice receipt missing');
  return 'sent'; // A notice cannot release the failed image job or register an image reference.
}

export function parseQQArgs(args: string[]): { config: string; mode: QQMode } {
  let config = path.join(getProjectRoot(), 'config/qqbot.example.json');
  let mode: QQMode = 'check', chosen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) config = path.resolve(args[++i]);
    else if (['--check', '--live', '--status', '--resume'].includes(args[i]) && !chosen) {
      mode = args[i].slice(2) as QQMode; chosen = true;
    } else throw new Error('Usage: qqbot [--config path] [--check|--live|--status|--resume]');
  }
  return { config, mode };
}

export async function runQQBot(args: string[]): Promise<void> {
  const root = getProjectRoot(), options = parseQQArgs(args);
  const config = readJsonObject(options.config) as unknown as QQConfig;
  validateQQConfig(config);
  const { credentials, provider } = readQQSecrets(root, config);
  if (typeof credentials.appId !== 'string' || !/^[1-9]\d{0,24}$/u.test(credentials.appId) ||
    typeof credentials.appSecret !== 'string' || !credentials.appSecret.trim() || credentials.appSecret.length > 512) throw new Error('Invalid QQ credentials');
  const appId = credentials.appId;
  const stateFile = path.join(root, 'data/runtime/qqbot', `${appId}.json`);
  if (options.mode === 'status') {
    const state = readJsonObject(stateFile) as unknown as QQState;
    validateQQState(state, appId);
    console.info(JSON.stringify({ appId, paused: state.paused, day: state.day, reservedTokens: state.tokens,
      receipts: Object.values(state.receipts).reduce<Record<string, number>>((counts, receipt) => {
        counts[receipt.status] = (counts[receipt.status] || 0) + 1; return counts;
      }, {}) }));
    return;
  }
  const store = new QQStateStore(stateFile, appId);
  if (options.mode === 'resume') {
    const state = await store.open();
    try { state.paused = false; await store.save(state); console.info('QQ bot resumed. Previous receipts will not be retried.'); }
    finally { await store.close(); }
    return;
  }
  // Only QQ's dedicated section/file: global secret/env layers must not replace this key.
  if (provider.keyName !== 'qq鹿饼用' || typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new Error('Dedicated QQ provider required');
  const settings = questionProviderSettings({ ai: { providers: { daiYu: { apiKey: provider.apiKey, baseUrl: provider.baseUrl } } } });
  const runtime = config.knowledge ? await readQuestionRuntime(path.resolve(root, config.knowledge.runtimeConfigPath)) : undefined;
  const knowledge = config.knowledge && runtime ? createQQKnowledge(runtime, config.knowledge,
    createPublicSearchFactory(runtime.questions.providerConfigPath, settings.proxy)) : undefined;
  const { QQBot } = await loadQQSdk();
  const characters = config.images && (config.images.enabled || config.videos?.enabled) ? qqImageCharacters(root, config.images) : [];
  if (config.images?.enabled) validateQQImageConfig({ ...config.images, characters });
  if (options.mode === 'check') {
    console.info(JSON.stringify({ valid: true, appId, model: QQ_MODEL, keyName: provider.keyName, knowledge: !!knowledge,
      groupMode: config.groupMessageMode === 'mention' ? 'mention' : 'all', privateMode: 'fixed-guidance', imageModel: config.images?.enabled ? config.images.model : null, imageCharacters: characters.length,
      videos: !!config.videos?.enabled }));
    return;
  }
  const state = await store.open();
  if (state.paused) { await store.close(); process.exitCode = 2; console.info('QQ replies paused; inspect --status before an explicit --resume.'); return; }
  let stopping = false;
  let bot: InstanceType<typeof QQBot> | undefined;
  let worker: QQWorker | undefined;
  let imageJobs: QQImageJobs | undefined;
  let localKnowledge: QQKnowledgeBase | undefined;
  const report = (event: import('../../services/qqbot/QQWorker').QQLogEvent) => {
    console.info(JSON.stringify({ ...event, appId, at: new Date().toISOString(), diagnosticsVersion: 1, pid: process.pid }));
    if (['qq_image_job_ready', 'qq_image_job_failed'].includes(event.event) && event.requestId) worker?.imageReady(event.requestId);
    if (state.paused) bot?.stop();
  };
  const stop = () => { stopping = true; worker?.stop(); imageJobs?.stop(); bot?.stop(); };
  const onMessage = (value: unknown) => { if (value === 'shutdown') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('message', onMessage);
  try {
    // Match the official QR plugin's production endpoint overrides. SDK logging stays disabled:
    // its default diagnostics can contain message bodies, openids and gateway URLs.
    bot = new QQBot({ appId, appSecret: credentials.appSecret, transport: 'websocket',
      baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://api.bot.qq.com',
      userAgent: 'shikamochi-qqbot/0.1', reconnect: { maxAttempts: 10 }, logger: { info: () => {}, error: () => {} } });
    const records = new QQRecords(root, appId);
    const imageRejections = createQQImageRejections(root, appId, config.notificationConfigPath, { report,
      sendNotice: (request, text) => sendQQRejectionNotice(bot!, request, text, state, { now: Date.now,
        sleep, save: value => store.save(value), stopping: () => stopping,
        observe: sendReceipt => report({ event: 'qq_send_receipt', requestId: request.key, scope: request.scope, sendReceipt }) }) });
    const chatArchive = new QQChatArchive(root, appId);
    localKnowledge = new QQKnowledgeBase(qqKnowledgeFile(root));
    localKnowledge.seedDefaults();
    const imageInputs = new QQImageInputs(root, appId, undefined, (request, sourceRead) => report({
      event: 'qq_image_source_read', requestId: request.key, scope: request.scope, sourceRead }));
    const recentImages = new QQRecentImages(root, appId, imageInputs);
    const videoConfig = config.videos ? { ...config.videos, queuePath: path.resolve(root, config.videos.queuePath) } : undefined;
    const videoInputs = new QQVideoInputs(root, appId);
    const videoQueue = videoConfig?.enabled ? new QQVideoQueue(root, appId, videoConfig, characters, {
      bridge: async (payload, signal) => await qqVideoProcess('python', [path.join(root, 'scripts/seedance_qq_bridge.py'), '--queue', videoConfig.queuePath], signal, payload) as any,
      account: signal => qqVideoProcess('dreamina-canvas', ['--format', 'json', '--non-interactive', 'auth', 'account'], signal),
      load: (request, signal) => imageInputs.load(request, signal),
      loadVideos: (request, signal) => videoInputs.load(request, signal)
    }, { mediaOperators: config.mediaOperators, dailyLimit: config.images?.dailyLimit, userDailyLimit: config.images?.userDailyLimit }) : undefined;
    const generate = config.images?.enabled ? createQQImageGenerator(root, appId, config.images, settings, undefined, imageInputs) : undefined;
    if (generate && config.images?.background) {
      const queueInputs = new QQImageQueueInputs(root, appId, imageInputs, { ...config.images, characters });
      imageJobs = new QQImageJobs(root, appId, config.images.timeoutMs, {
        prepare: (request, command, signal) => queueInputs.prepare(request, command, signal),
        generate: async (request, signal, command, input) => generate(request, signal, command, input ? await queueInputs.load(input) : undefined),
        now: Date.now, report,
        fatal: async error => {
          state.paused = true;
          try { report({ event: 'qq_state_failure', failure: qqDiagnostic(error, 'state', 'state_failed') }); await store.save(state); }
          finally { stop(); }
        } }, config);
      await imageJobs.open();
    }
    const workerConfig = config.images?.enabled ? { ...config, images: { ...config.images, characters } } : config;
    const replyIO = { now: Date.now, sleep: (ms: number) => sleep(ms), stopping: () => stopping,
      save: (value: QQState) => store.save(value), record: (request: QQRequest, update: import('../../services/qqbot/QQRecords').QQRecordUpdate) => records.write(request, update) };
    worker = new QQWorker(workerConfig, state, { now: Date.now, save: value => store.save(value), record: (request, update) => records.write(request, update),
      acknowledge: (request, text) => sendQQProgress(request, text, state, { ...replyIO,
        send: answer => sendQQReply(bot!, request, answer, undefined, sendReceipt => report({
          event: 'qq_send_receipt', requestId: request.key, scope: request.scope, sendReceipt })),
        report: event => report({ event, requestId: request.key, scope: request.scope }) }),
      answer: async (request, signal, executeImage, imageTasks) => {
        let tokens = QQ_LIMITS.reservation as number;
        let imageToolMessage: string | undefined;
        let videoMessage: string | undefined, video: QQVideoResult | undefined, videoReview = false;
        const imageTools = config.images && (config.images.enabled || videoConfig?.enabled) ? createQQImageTools(request, { ...config.images, characters },
          () => imageInputs.load(request, signal), executeImage || (async () => ({ status: 'blocked' as const, message: '图片功能未启用。' })),
          count => report({ event: 'qq_image_sources_loaded', requestId: request.key, scope: request.scope, imageSourceCount: count }), result => {
            imageToolMessage = result.status === 'blocked' || result.status === 'failed' ? result.message : undefined;
          }, recentImages.forRequest(request, signal)) : undefined;
        const videoTools = videoQueue && videoConfig ? createQQVideoTools(request, videoConfig, videoQueue, signal, delivery => {
          videoMessage = delivery.message; video = delivery.video; videoReview = delivery.status === 'draft';
        }) : undefined;
        const answer = createQQAnswerer(settings, knowledge, undefined, async (question, agent) => {
          tokens = Math.min(QQ_LIMITS.reservation, Math.max(1, agent.inputTokens + agent.outputTokens));
          report({ event: 'qq_agent_trace', requestId: question.key, scope: question.scope, agent });
          await records.write(question, { status: 'generating', agent });
        }, withQQImageTaskTools(mergeQQMediaTools(request, imageTools, videoTools), imageTasks), chatArchive, localKnowledge);
        let generatedAnswer: string;
        try { generatedAnswer = await answer(request, signal); }
        catch (error) {
          if (!videoMessage || qqDiagnostic(error, 'agent_run', 'unexpected', signal).code === 'record_failed') throw error;
          generatedAnswer = videoMessage;
        }
        return { text: videoMessage || imageToolMessage || generatedAnswer, tokens, ...(video ? { video } : {}), ...(videoReview ? { videoReview: true } : {}) };
      },
      image: generate,
      pendingImage: imageJobs ? request => imageJobs!.pending(request) : undefined,
      readImageTask: imageJobs ? request => imageJobs!.status(request) : undefined,
      collectImage: imageJobs ? request => imageJobs!.collect(request) : undefined,
      imageAdmission: imageJobs ? request => imageJobs!.admission(request) : undefined,
      enqueueImage: imageJobs ? (request, command) => imageJobs!.enqueue(request, command) : undefined,
      waitImage: imageJobs ? (request, signal, waitMs) => imageJobs!.wait(request, signal, waitMs) : undefined,
      hasReadyImage: imageJobs ? request => imageJobs!.hasReady(request) : undefined,
      imagePending: imageJobs ? key => imageJobs!.isPending(key) : undefined,
      readyImage: imageJobs ? (request, key) => imageJobs!.ready(request, key) : undefined,
      send: async (request, answer, image, video) => {
        const result = await sendQQReply(bot!, request, answer, image, sendReceipt => report({
          event: 'qq_send_receipt', requestId: request.key, scope: request.scope, sendReceipt }),
        image ? rejection => imageRejections.handle(request, image, rejection) : undefined, video, async () => {
          if (!await waitQQReplySlot(request, state, replyIO)) throw new Error('QQ partial reply window expired');
        });
        if (!result?.id) throw new Error('QQ send receipt missing');
        await imageJobs?.delivered(request);
        if (video) await videoQueue?.delivered(request, video, new AbortController().signal);
        if (image) {
          await imageInputs.remember(request, image, result);
          await recentImages.remember(request, answer, result.id);
        }
      }, sleep: (ms, signal) => sleep(ms, undefined, { signal }), report });
    bot.on('ready', (data: any) => {
      if (typeof data?.user?.id === 'string') worker!.setBotId(data.user.id);
      report({ event: 'qq_ready', imageSourceDiagnosticsVersion: 1, attachmentDiagnosticsVersion: 1, videoSourceErrorsVersion: 1,
        videoReferencesVersion: 1,
        mediaSourceAwarenessVersion: 1, imageCharacterAliasesVersion: 1, imageSourceModeVersion: 1,
        mediaLimitsVersion: 1,
        imageQueueVersion: 1, automaticImageRepliesVersion: 1, deferredImageNoticeVersion: 1,
        sendReceiptDiagnosticsVersion: 1, sendRejectionIsolationVersion: 1,
        imageRejectionNotificationsVersion: 1, recentImageContextVersion: 1, replyProgressVersion: 1, multipartReplyVersion: 1 });
    });
    bot.on('resumed', () => report({ event: 'qq_resumed' }));
    bot.on('disconnected', () => report({ event: 'qq_disconnected' }));
    bot.on('error', () => report({ event: 'qq_gateway_error' }));
    bot.on('message', (_ctx, message) => {
      void (async () => {
        const isGroup = message && typeof message === 'object' && (message as any).kind === 'group';
        const allMode = config.groupMessageMode !== 'mention';
        const captured = isGroup && allMode ? await chatArchive.capture(message as any) : undefined;
        if (isGroup && config.images?.enabled && (allMode || (message as any).rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||
          (message as any).mentions?.some((item: any) => item?.is_you === true))) await recentImages.capture(message as any);
        const event = captured ? { ...(message as any), chatContext: await chatArchive.recent(captured.conversation, captured.createdAt, 24) } : message;
        worker!.receive(event);
      })().catch(() => { /* malformed gateway events must not stop the websocket */ });
    });
    report({ event: 'qq_starting' });
    await bot.start();
    if (state.paused) process.exitCode = 2;
    else if (!stopping) throw new Error('QQ gateway stopped unexpectedly');
  } finally {
    stop(); await worker?.idle(); await imageJobs?.close(); localKnowledge?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('message', onMessage);
    await store.close();
  }
}

if (require.main === module) runQQBot(process.argv.slice(2)).catch(() => {
  console.error('QQ bot could not run. Inspect local configuration, credentials, dependency and owner lock.'); process.exitCode = 2;
});
