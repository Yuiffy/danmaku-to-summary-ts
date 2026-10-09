import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { questionProviderSettings } from '../../services/live-vote/questions/DaiyuQuestionClient';
import { createRemoteEmbedder } from '../../services/live-vote/questions/EmbeddingClient';
import { createLocalEmbedder } from '../../services/live-vote/questions/LocalEmbedding';
import { nextIndexRun } from '../../services/live-vote/questions/IndexSchedule';
import { LiveQuestionConfig, validateQuestionConfig } from '../../services/live-vote/questions/QuestionPolicy';
import { acquireIndexLock, atomicJson, pruneSubtitleShards, updateSubtitleRoom } from '../../services/live-vote/questions/SubtitleIndex';

interface IndexStatus { lastSuccess?: number; lastFailure?: number; phase?: string; roomId?: string; files?: number; chunks?: number; nextRun?: string }

/** Operator CLI only. No publication adapters or live queue access. */
export async function runSubtitleIndexer(args: string[]): Promise<void> {
  const project = getProjectRoot();
  let configPath = path.join(project, 'data/runtime/live-vote.json'), loop = false, statusOnly = false, firstRoom = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = path.resolve(args[++i]);
    else if (args[i] === '--loop') loop = true;
    else if (args[i] === '--status') statusOnly = true;
    else if (args[i] === '--first-room' && /^[1-9]\d*$/u.test(args[i + 1] || '')) firstRoom = args[++i];
    else throw new Error('Usage: subtitleIndex [--config path] [--loop | --status] [--first-room id]');
  }
  const readConfig = async (): Promise<LiveQuestionConfig> => {
    const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/u, '')).questions as LiveQuestionConfig;
    validateQuestionConfig(config);
    if (!config.enabled || !config.semantic?.enabled) throw new Error('Subtitle indexing disabled');
    return config;
  };
  const initial = await readConfig();
  const statusFile = path.join(initial.semantic!.directory, 'status.json');
  let status: IndexStatus = {};
  try { status = JSON.parse(await fs.readFile(statusFile, 'utf8')); } catch { /* Initial run. */ }
  if (statusOnly) { console.info(JSON.stringify(status)); return; }
  const release = await acquireIndexLock(initial.semantic!.directory);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const save = async (patch: Partial<IndexStatus>) => {
    status = { ...status, ...patch };
    await atomicJson(statusFile, { ...status, pid: process.pid, at: new Date().toISOString() });
  };
  try {
    do {
      const due = loop ? nextIndexRun(Date.now(), status.lastSuccess, status.lastFailure) : Date.now();
      if (due > Date.now()) {
        await save({ phase: 'idle', nextRun: new Date(due).toISOString() });
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(due - Date.now(), 60000));
          controller.signal.addEventListener('abort', done, { once: true });
        });
        continue;
      }
      const config = await readConfig(), semantic = config.semantic!;
      if (semantic.directory !== initial.semantic!.directory) throw new Error('Index directory changed; restart worker');
      const embedder = semantic.backend === 'local' ? createLocalEmbedder(semantic, project) :
        createRemoteEmbedder(semantic, questionProviderSettings(loadConfigLayers({ configPath: config.providerConfigPath })));
      let incomplete = false;
      try {
        await save({ phase: 'running', nextRun: undefined });
        const rooms = Object.entries(config.recordingRoots).sort(([a], [b]) => Number(b === firstRoom) - Number(a === firstRoom));
        for (const [roomId, roots] of rooms) {
          let latest = 0;
          await save({ roomId, files: 0, chunks: 0 });
          const manifest = await updateSubtitleRoom(semantic, roomId, roots, embedder, controller.signal, async (files, chunks) => {
            status.files = files; status.chunks = chunks;
            if (Date.now() - latest > 10000) {
              latest = Date.now();
              await save({ roomId, files, chunks });
              console.info('[subtitle index]', JSON.stringify({ roomId, files, embeddedChunks: chunks }));
            }
          });
          incomplete ||= manifest.incomplete;
          console.info('[subtitle room]', JSON.stringify({ roomId, files: manifest.sources.length,
            chunks: manifest.sources.reduce((sum, source) => sum + source.chunks, 0), incomplete: manifest.incomplete }));
        }
        if (incomplete) throw new Error('Subtitle roots or sources incomplete');
        await pruneSubtitleShards(semantic.directory);
        await save({ phase: 'complete', lastSuccess: Date.now(), lastFailure: undefined });
      } catch {
        await save({ phase: controller.signal.aborted ? 'stopped' : 'retry', lastFailure: Date.now() });
        console.error('Subtitle index update incomplete; retaining readable checkpoints.');
        if (!loop && !controller.signal.aborted) throw new Error('Subtitle index update failed');
      } finally { await embedder.close?.(); }
    } while (loop && !controller.signal.aborted);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await release();
  }
}

if (require.main === module) runSubtitleIndexer(process.argv.slice(2)).catch(() => {
  console.error('Subtitle index worker failed; inspect index status and configured model availability.');
  process.exitCode = 1;
});
