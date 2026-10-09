import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { parseEvidenceQuery, queryRecordingEvidence, questionRooms, readQuestionRuntime } from '../../services/live-vote/questions/EvidenceQuery';

export async function recordingQuery(args: string[]): Promise<void> {
  let config = path.join(getProjectRoot(), 'data/runtime/live-vote.json'), inputFile = '', rooms = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) config = path.resolve(args[++i]);
    else if (args[i] === '--input' && args[i + 1]) inputFile = path.resolve(args[++i]);
    else if (args[i] === '--rooms') rooms = true;
    else throw new Error('Usage: recordingQuery [--config path] --rooms | --input question.json');
  }
  const runtime = await readQuestionRuntime(config);
  if (rooms) { console.log(JSON.stringify({ rooms: questionRooms(runtime) })); return; }
  if (!inputFile || (await fs.stat(inputFile)).size > 8192) throw new Error('Provide a bounded question JSON file');
  const input = parseEvidenceQuery(JSON.parse((await fs.readFile(inputFile, 'utf8')).replace(/^\uFEFF/u, '')), runtime.questions);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000);
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { console.log(JSON.stringify(await queryRecordingEvidence(runtime, input, controller.signal))); }
  finally { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (require.main === module) recordingQuery(process.argv.slice(2)).catch(() => {
  console.error(JSON.stringify({ error: 'Recording search failed. Check room, query options and local configuration.' }));
  process.exitCode = 1;
});
