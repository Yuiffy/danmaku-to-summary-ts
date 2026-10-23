import * as path from 'path';
import { loadConfigLayers } from '../../core/config/ConfigLayers';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { estimateSession, recallPlans, usageReport } from '../../workflows/itinerary/runtime';

/** Read-only CLI: no provider adapter, publication, workflow activation or queue mutations. */
export async function main(args = process.argv.slice(2)) {
  const root = getProjectRoot(), config = loadConfigLayers({ root });
  const [command, ...flags] = args, values: Record<string, string> = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--srt', '--xml', '--room', '--started-at', '--title'].includes(flags[i]) || !flags[i + 1]) throw new Error('Invalid itinerary argument');
    values[flags[i].slice(2)] = flags[i + 1];
  }
  if (command === 'usage') return usageReport({ root, config });
  if (!['estimate', 'show'].includes(command) || !values.room || !values['started-at']) {
    throw new Error('Usage: itinerary:memory usage | show --room ID --started-at ISO | estimate --srt PATH --room ID --started-at ISO [--xml PATH] [--title TEXT]');
  }
  const options = { root, config, session: { roomId: values.room, startedAt: values['started-at'],
    title: values.title, sessionId: path.resolve(values.srt || 'read-only-query') },
    srtPath: values.srt && path.resolve(values.srt), xmlPath: values.xml && path.resolve(values.xml) };
  if (command === 'show') return recallPlans(options);
  if (!options.srtPath) throw new Error('estimate requires --srt');
  return estimateSession(options);
}

if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
