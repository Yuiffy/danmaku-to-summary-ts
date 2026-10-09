import * as path from 'path';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { readQuestionRuntime } from '../../services/live-vote/questions/EvidenceQuery';
import { createLiveQuestionAnswerer } from '../../services/live-vote/questions/DaiyuQuestionClient';
import { createQuestionLab } from '../../services/live-vote/question-lab/QuestionLabServer';

export async function runQuestionLab(args: string[]): Promise<void> {
  let config = path.join(getProjectRoot(), 'data/runtime/live-vote.json'), port = 15126;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) config = path.resolve(args[++i]);
    else if (args[i] === '--port' && /^\d+$/u.test(args[i + 1] || '')) port = Number(args[++i]);
    else throw new Error('Usage: questionLab [--config path] [--port number]');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid lab port');
  const runtime = await readQuestionRuntime(config), origin = `http://127.0.0.1:${port}`;
  const answer = createLiveQuestionAnswerer(runtime.questions, runtime.botUid)!;
  const lab = createQuestionLab({ runtime, answer }, origin);
  const server = lab.app.listen(port, '127.0.0.1', () => console.info(`Recording question lab: ${origin}`));
  server.on('error', () => { console.error('Question lab could not listen on the configured local port.'); process.exitCode = 1; });
  const stop = () => { lab.stop(); server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) runQuestionLab(process.argv.slice(2)).catch(() => {
  console.error('Question lab could not start. Check local runtime/provider configuration.'); process.exitCode = 1;
});
