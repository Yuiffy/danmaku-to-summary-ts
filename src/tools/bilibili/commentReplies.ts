import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigObject, loadConfigLayers, readJsonObject } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { questionProviderSettings } from '../../services/live-vote/questions/DaiyuQuestionClient';
import { CommentApi } from '../../services/bilibili/comment-replies/CommentApi';
import { createCommentAnswerer } from '../../services/bilibili/comment-replies/CommentAgent';
import { pollCommentInbox } from '../../services/bilibili/comment-replies/CommentInbox';
import { CommentReplyConfig, validateCommentConfig } from '../../services/bilibili/comment-replies/CommentPolicy';
import { CommentState, CommentStateStore } from '../../services/bilibili/comment-replies/CommentState';
import { CommentWorker } from '../../services/bilibili/comment-replies/CommentWorker';
import { readQuestionRuntime } from '../../services/live-vote/questions/EvidenceQuery';
import { createCommentKnowledge } from '../../services/bilibili/comment-replies/CommentKnowledge';
import { CommentFeedError, CommentPoller } from '../../services/bilibili/comment-replies/CommentPolling';
import { createProjectReader } from '../../services/bilibili/comment-replies/CommentProjects';

export interface CommentCliOptions { config: string; mode: 'check' | 'dry-run' | 'live' | 'status' | 'resume' }
export function parseCommentArgs(args: string[]): CommentCliOptions {
  const options: CommentCliOptions = { config: path.join(getProjectRoot(), 'config/comment-replies.example.json'), mode: 'check' };
  let mode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) options.config = path.resolve(args[++i]);
    else if (['--check', '--dry-run', '--live', '--status', '--resume'].includes(args[i]) && !mode) {
      options.mode = args[i].slice(2) as CommentCliOptions['mode']; mode = true;
    } else throw new Error('Usage: commentReplies [--config path] [--check|--dry-run|--live|--status|--resume]');
  }
  return options;
}

function object(value: unknown): ConfigObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as ConfigObject : {}; }

export async function runCommentReplies(args: string[]): Promise<void> {
  const options = parseCommentArgs(args), root = getProjectRoot();
  const raw = readJsonObject(options.config);
  const config = { ...raw,
    credentialConfigPath: path.resolve(root, String(raw.credentialConfigPath || '')),
    providerConfigPath: path.resolve(root, String(raw.providerConfigPath || ''))
  } as unknown as CommentReplyConfig;
  validateCommentConfig(config);
  // Fixed account-specific location; notifications and model output never choose local paths.
  const file = path.join(root, 'data/runtime/comment-replies', `${config.botUid}${options.mode === 'dry-run' ? '.preview' : ''}.json`);
  if (options.mode === 'status') {
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as CommentState;
    console.info(JSON.stringify({ botUid: state.botUid, paused: state.paused,
      statuses: state.jobs.reduce<Record<string, number>>((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {}),
      budgets: Object.fromEntries(Object.entries(state.days).map(([day, usage]) => [day, usage.tokens])) }));
    return;
  }
  const store = new CommentStateStore(file, config.botUid);
  if (options.mode === 'resume') {
    const state = await store.open();
    try {
      state.paused = false;
      await store.save(state);
      console.info('Comment replies resumed. Unknown/failed jobs remain terminal and will not be retried.');
    } finally { await store.close(); }
    return;
  }
  const cookie = () => {
    const value = object(loadConfigLayers({ configPath: config.credentialConfigPath }).bilibili).cookie;
    if (typeof value !== 'string') throw new Error('Comment cookie is not configured');
    return value;
  };
  const api = new CommentApi(config.botUid, cookie);
  api.checkCredentials();
  const settings = questionProviderSettings(loadConfigLayers({ configPath: config.providerConfigPath }));
  const knowledge = config.knowledge && options.mode !== 'dry-run' ? createCommentKnowledge(
    await readQuestionRuntime(path.resolve(root, config.knowledge.runtimeConfigPath)), config.knowledge,
    { video: (aid, signal) => api.video(aid, signal), now: Date.now,
      ...(config.projectSources ? { projects: createProjectReader(root, config.projectSources) } : {}) }) : undefined;
  if (options.mode === 'check') {
    console.info('Comment reply configuration valid. No polling, model requests or publication performed.'); return;
  }
  const state = await store.open();
  const worker = new CommentWorker(config, state, {
    now: Date.now, save: value => store.save(value),
    answer: options.mode === 'live' ? createCommentAnswerer(settings, undefined, knowledge,
      { config, hotComments: (event, signal) => api.hotComments(event, signal),
        dynamic: (id, signal) => api.dynamic(id, signal) }) : async () => '鹿饼收到啦，这是一条本地预览回复。',
    audience: (uid, signal) => api.audience(uid, signal),
    like: options.mode === 'live' ? (event, signal) => api.like(event, signal) : undefined,
    send: options.mode === 'live' ? (event, answer, signal) => api.send(event, answer, signal) : async event => {
      console.info(JSON.stringify({ preview: true, key: event.key, uid: event.uid })); return '1';
    }
  });
  let stopping = false, timer: NodeJS.Timeout | undefined, wake: (() => void) | undefined;
  const poller = new CommentPoller(config.pollIntervalMs, {
    now: Date.now, report: event => console.info(JSON.stringify(event)),
    poll: () => pollCommentInbox(state, { feed: (kind, cursor) => api.feed(kind, cursor),
      admit: event => {
        if (stopping) throw new Error('Comment inbox stopped before admission');
        return worker.admit(event);
      }, save: value => store.save(value) })
  });
  let phase: 'poll' | 'work' = 'poll';
  const stop = () => { stopping = true; worker.stop(); if (timer) clearTimeout(timer); wake?.(); };
  const message = (value: unknown) => { if (value === 'shutdown') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('message', message);
  // Exactly one loop: provider calls, checkpoint writes and sends never overlap.
  console.info(`Comment replies ${options.mode}; transient notification reads retry automatically; saved checkpoints preserved.`);
  try {
    while (!stopping && !state.paused) {
      phase = 'poll';
      await poller.tick();
      phase = 'work';
      if (!stopping) await worker.tick();
      if (!stopping && !state.paused) await new Promise<void>(resolve => {
        wake = resolve; timer = setTimeout(resolve, 1000);
      });
      timer = undefined; wake = undefined;
    }
    if (state.paused) {
      process.exitCode = 2;
      console.info('Comment replies paused. Inspect --status and login/risk status before --resume.');
    }
  } catch (error) {
    // Permanent feed failures, auth/risk and snapshot failures still require operator inspection.
    worker.stop(); state.paused = true; process.exitCode = 2;
    try { await store.save(state); } catch { /* Leave the previous durable intent intact. */ }
    console.error(JSON.stringify({ event: 'comment_consumer_paused', phase,
      ...(error instanceof CommentFeedError ? error.diagnostic : { reason: 'internal' }) }));
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.removeListener('message', message);
    await store.close();
  }
}

if (require.main === module) runCommentReplies(process.argv.slice(2)).catch(() => {
  console.error('Comment replies could not start. Check local config, state and exclusive lock.'); process.exitCode = 2;
});
