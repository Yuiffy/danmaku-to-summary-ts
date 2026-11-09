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
import { qqImageCharacters } from '../../services/qqbot/QQImageCatalog';
import { validateQQImageConfig } from '../../services/qqbot/QQImagePolicy';
import { QQImageInputs } from '../../services/qqbot/QQImageInputs';
import { createQQImageTools } from '../../services/qqbot/QQImageTools';
import { QQImageJobs } from '../../services/qqbot/QQImageJobs';
import { qqDiagnostic } from '../../services/qqbot/QQDiagnostics';
import { QQChatArchive } from '../../services/qqbot/QQChatArchive';
import { QQKnowledgeBase, qqKnowledgeFile } from '../../services/qqbot/QQKnowledgeBase';
import type { QQBot, SendMessageOptions } from '@tencent-connect/qqbot-nodejs';
import type { MediaFileType, MessageResponse } from '@tencent-connect/qqbot-nodejs';
import type { QQImageResult } from '../../services/qqbot/QQImagePolicy';
import type { QQRequest } from '../../services/qqbot/QQPolicy';

type QQMode = 'check' | 'live' | 'status' | 'resume';

/** Send a reply bound to, and visibly quoting, the exact inbound message. */
export async function sendQQReply(bot: Pick<QQBot, 'send' | 'uploadMedia'>, request: QQRequest,
  answer: string, image?: QQImageResult): Promise<MessageResponse> {
  const target = { scope: request.scope, targetId: request.targetId, msgId: request.msgId };
  const reference = { message_id: request.msgId };
  if (image) {
    const upload = await bot.uploadMedia({ target, fileType: 1 as MediaFileType, localPath: image.file, srvSendMsg: false });
    const options: SendMessageOptions = { target, msgType: 7, media: { file_info: upload.file_info }, content: answer,
      messageReference: reference };
    return bot.send(options);
  }
  return bot.send({ target, msgType: 0, content: answer, messageReference: reference });
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
  const characters = config.images?.enabled ? qqImageCharacters(root, config.images) : [];
  if (config.images?.enabled) validateQQImageConfig({ ...config.images, characters });
  if (options.mode === 'check') {
    console.info(JSON.stringify({ valid: true, appId, model: QQ_MODEL, keyName: provider.keyName, knowledge: !!knowledge,
      groupMode: config.groupMessageMode === 'mention' ? 'mention' : 'all', privateMode: 'fixed-guidance', imageModel: config.images?.enabled ? config.images.model : null, imageCharacters: characters.length }));
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
    const chatArchive = new QQChatArchive(root, appId);
    localKnowledge = new QQKnowledgeBase(qqKnowledgeFile(root));
    localKnowledge.seedDefaults();
    const imageInputs = new QQImageInputs(root, appId, undefined, (request, sourceRead) => report({
      event: 'qq_image_source_read', requestId: request.key, scope: request.scope, sourceRead }));
    const generate = config.images?.enabled ? createQQImageGenerator(root, appId, config.images, settings, undefined, imageInputs) : undefined;
    if (generate && config.images?.background) {
      imageJobs = new QQImageJobs(root, appId, config.images.timeoutMs, { generate, now: Date.now, report,
        fatal: async error => {
          state.paused = true;
          try { report({ event: 'qq_state_failure', failure: qqDiagnostic(error, 'state', 'state_failed') }); await store.save(state); }
          finally { stop(); }
        } });
      await imageJobs.open();
    }
    const workerConfig = config.images?.enabled ? { ...config, images: { ...config.images, characters } } : config;
    worker = new QQWorker(workerConfig, state, { now: Date.now, save: value => store.save(value), record: (request, update) => records.write(request, update),
      answer: async (request, signal, executeImage) => {
        let tokens = QQ_LIMITS.reservation as number;
        let imageToolMessage: string | undefined;
        const answer = createQQAnswerer(settings, knowledge, undefined, async (question, agent) => {
          tokens = Math.min(QQ_LIMITS.reservation, Math.max(1, agent.inputTokens + agent.outputTokens));
          report({ event: 'qq_agent_trace', requestId: question.key, scope: question.scope, agent });
          await records.write(question, { status: 'generating', agent });
        }, config.images?.enabled && executeImage ? createQQImageTools(request, { ...config.images, characters },
          () => imageInputs.load(request, signal), executeImage, count => report({ event: 'qq_image_sources_loaded',
            requestId: request.key, scope: request.scope, imageSourceCount: count }), result => {
              if (result.status === 'blocked' || result.status === 'failed') imageToolMessage = result.message;
            }) : undefined, chatArchive, localKnowledge);
        const generatedAnswer = await answer(request, signal);
        return { text: imageToolMessage || generatedAnswer, tokens };
      },
      image: generate,
      pendingImage: imageJobs ? request => imageJobs!.pending(request) : undefined,
      imageAdmission: imageJobs ? request => imageJobs!.admission(request) : undefined,
      enqueueImage: imageJobs ? (request, command) => imageJobs!.enqueue(request, command) : undefined,
      waitImage: imageJobs ? (request, signal, waitMs) => imageJobs!.wait(request, signal, waitMs) : undefined,
      send: async (request, answer, image) => {
        const result = await sendQQReply(bot!, request, answer, image);
        if (!result?.id) throw new Error('QQ send receipt missing');
        await imageJobs?.delivered(request);
        if (image) await imageInputs.remember(request, image, result);
      }, sleep: (ms, signal) => sleep(ms, undefined, { signal }), report });
    bot.on('ready', (data: any) => {
      if (typeof data?.user?.id === 'string') worker!.setBotId(data.user.id);
      report({ event: 'qq_ready', imageSourceDiagnosticsVersion: 1 });
    });
    bot.on('resumed', () => report({ event: 'qq_resumed' }));
    bot.on('disconnected', () => report({ event: 'qq_disconnected' }));
    bot.on('error', () => report({ event: 'qq_gateway_error' }));
    bot.on('message', (_ctx, message) => {
      void (async () => {
        const isGroup = message && typeof message === 'object' && (message as any).kind === 'group';
        const allMode = config.groupMessageMode !== 'mention';
        const captured = isGroup && allMode ? await chatArchive.capture(message as any) : undefined;
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
