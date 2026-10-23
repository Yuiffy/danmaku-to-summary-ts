import * as fs from 'fs/promises';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { LiveQuestionConfig, validateQuestionConfig } from '../../services/live-vote/questions/QuestionPolicy';
import { acquireIndexLock, atomicJson } from '../../services/live-vote/questions/SubtitleIndex';
import { FtsUpdate, updateRecordingFts } from '../../services/live-vote/questions/RecordingFtsMaintenance';

/** Separate cheap text index maintenance; never waits for an embedding provider or publishes replies. */
export async function runRecordingIndexer(args: string[]): Promise<void> {
  let configPath = path.join(getProjectRoot(), 'data/runtime/live-vote.json'), loop = false, statusOnly = false, firstRoom = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = path.resolve(args[++i]);
    else if (args[i] === '--loop') loop = true;
    else if (args[i] === '--status') statusOnly = true;
    else if (args[i] === '--first-room' && /^[1-9]\d*$/u.test(args[i + 1] || '')) firstRoom = args[++i];
    else throw new Error('Usage: recordingIndex [--config path] [--loop | --status] [--first-room id]');
  }
  const read = async () => {
    const runtime = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/u, '')) as { questions: LiveQuestionConfig; botUid?: string };
    validateQuestionConfig(runtime.questions);
    if (!runtime.questions.enabled || !runtime.questions.lexical?.enabled) throw new Error('Recording FTS indexing disabled');
    return runtime;
  };
  const initial = await read(), directory = initial.questions.lexical!.directory, statusFile = path.join(directory, 'status.json');
  if (statusOnly) { console.info(await fs.readFile(statusFile, 'utf8').catch(() => '{}')); return; }
  const release = await acquireIndexLock(directory), controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const save = (value: unknown) => atomicJson(statusFile, value);
  try {
    do {
      const runtime = await read(), config = runtime.questions.lexical!;
      if (config.directory !== directory) throw new Error('FTS directory changed; restart worker');
      const rooms: Record<string, FtsUpdate> = {}, startedAt = new Date().toISOString();
      try {
        const configuredRooms = Object.entries(runtime.questions.recordingRoots).sort(([a], [b]) => Number(b === firstRoom) - Number(a === firstRoom));
        for (const [roomId, roots] of configuredRooms) {
          await save({ phase: 'running', pid: process.pid, startedAt, roomId, rooms });
          rooms[roomId] = await updateRecordingFts(config, roomId, roots, controller.signal, runtime.botUid,
            async progress => { await save({ phase: 'running', pid: process.pid, startedAt, roomId, rooms, progress }); });
          console.info('[recording FTS]', JSON.stringify({ roomId, ...rooms[roomId] }));
        }
        await save({ phase: Object.values(rooms).every(room => room.complete) ? 'complete' : 'partial',
          pid: process.pid, startedAt, updatedAt: new Date().toISOString(), rooms });
      } catch (error) {
        await save({ phase: controller.signal.aborted ? 'stopped' : 'retry', pid: process.pid, startedAt, rooms });
        if (!loop && !controller.signal.aborted) throw error;
        if (!controller.signal.aborted) console.error('Recording FTS update incomplete; next poll will retry.');
      }
      if (loop && !controller.signal.aborted) await delay(config.pollIntervalMs || 120000, undefined, { signal: controller.signal }).catch(() => {});
    } while (loop && !controller.signal.aborted);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }
}
if (require.main === module) runRecordingIndexer(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : 'Recording FTS index worker failed'); process.exitCode = 1;
});
