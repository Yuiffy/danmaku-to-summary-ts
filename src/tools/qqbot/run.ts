import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { readJsonObject } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { questionProviderSettings } from '../../services/live-vote/questions/DaiyuQuestionClient';
import { readQuestionRuntime } from '../../services/live-vote/questions/EvidenceQuery';
import { QQConfig, QQ_MODEL, validateQQConfig } from '../../services/qqbot/QQPolicy';
import { QQState, QQStateStore, validateQQState } from '../../services/qqbot/QQState';
import { QQWorker } from '../../services/qqbot/QQWorker';
import { createQQAnswerer } from '../../services/qqbot/QQAgent';
import { createQQKnowledge } from '../../services/qqbot/QQKnowledge';
import { loadQQSdk } from '../../services/qqbot/QQSdk';
import { QQRecords } from '../../services/qqbot/QQRecords';
import { readQQSecrets } from '../../services/qqbot/QQSecrets';
import { createQQImageGenerator } from '../../services/qqbot/QQImage';
import { qqImageCharacters } from '../../services/qqbot/QQImageCatalog';
import { validateQQImageConfig } from '../../services/qqbot/QQImagePolicy';

type QQMode = 'check' | 'live' | 'status' | 'resume';
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
  const knowledge = config.knowledge ? createQQKnowledge(
    await readQuestionRuntime(path.resolve(root, config.knowledge.runtimeConfigPath)), config.knowledge) : undefined;
  const { QQBot } = await loadQQSdk();
  const characters = config.images?.enabled ? qqImageCharacters(root, config.images) : [];
  if (config.images?.enabled) validateQQImageConfig({ ...config.images, characters });
  if (options.mode === 'check') {
    console.info(JSON.stringify({ valid: true, appId, model: QQ_MODEL, keyName: provider.keyName, knowledge: !!knowledge,
      groupMode: 'mention-only', privateMode: 'fixed-guidance', imageModel: config.images?.enabled ? config.images.model : null, imageCharacters: characters.length }));
    return;
  }
  const state = await store.open();
  if (state.paused) { await store.close(); process.exitCode = 2; console.info('QQ replies paused; inspect --status before an explicit --resume.'); return; }
  let stopping = false;
  let bot: InstanceType<typeof QQBot> | undefined;
  let worker: QQWorker | undefined;
  const report = (event: { event: string; scope?: string }) => {
    console.info(JSON.stringify({ ...event, appId, at: new Date().toISOString() }));
    if (state.paused) bot?.stop();
  };
  const stop = () => { stopping = true; worker?.stop(); bot?.stop(); };
  const onMessage = (value: unknown) => { if (value === 'shutdown') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('message', onMessage);
  try {
    // Match the official QR plugin's production endpoint overrides. SDK logging stays disabled:
    // its default diagnostics can contain message bodies, openids and gateway URLs.
    bot = new QQBot({ appId, appSecret: credentials.appSecret, transport: 'websocket',
      baseUrl: 'https://api.bot.qq.com', tokenBaseUrl: 'https://api.bot.qq.com',
      userAgent: 'shikamochi-qqbot/0.1', reconnect: { maxAttempts: 10 }, logger: { info: () => {}, error: () => {} } });
    const records = new QQRecords(root, appId);
    worker = new QQWorker(config, state, { now: Date.now, save: value => store.save(value), record: (request, update) => records.write(request, update),
      answer: createQQAnswerer(settings, knowledge, undefined, (request, agent) => records.write(request, { status: 'generating', agent })),
      image: config.images?.enabled ? createQQImageGenerator(root, appId, config.images, settings) : undefined,
      send: async (request, answer, image) => {
        const target = { scope: request.scope, targetId: request.targetId, msgId: request.msgId };
        const result = image ? (await bot!.sendImage(target, { localPath: image.file }, { content: answer })).message : await bot!.sendText(target, answer);
        if (!result?.id) throw new Error('QQ send receipt missing');
      }, sleep: (ms, signal) => sleep(ms, undefined, { signal }), report });
    bot.on('ready', (data: any) => {
      if (typeof data?.user?.id === 'string') worker!.setBotId(data.user.id);
      report({ event: 'qq_ready' });
    });
    bot.on('resumed', () => report({ event: 'qq_resumed' }));
    bot.on('disconnected', () => report({ event: 'qq_disconnected' }));
    bot.on('error', () => report({ event: 'qq_gateway_error' }));
    bot.on('message', (_ctx, message) => {
      if (worker!.receive(message)) report({ event: 'qq_request_accepted', scope: message.kind });
    });
    report({ event: 'qq_starting' });
    await bot.start();
    if (state.paused) process.exitCode = 2;
    else if (!stopping) throw new Error('QQ gateway stopped unexpectedly');
  } finally {
    stop(); await worker?.idle();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('message', onMessage);
    await store.close();
  }
}

if (require.main === module) runQQBot(process.argv.slice(2)).catch(() => {
  console.error('QQ bot could not run. Inspect local configuration, credentials, dependency and owner lock.'); process.exitCode = 2;
});
