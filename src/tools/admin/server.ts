import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { AdminConfigStore } from '../../services/admin/AdminConfigStore';
import { AdminClipStore } from '../../services/admin/AdminClipStore';
import { AdminJobs, createCommandRunner } from '../../services/admin/AdminJobs';
import { createAdminServer } from '../../services/admin/AdminServer';
import { readJson } from '../../services/admin/AdminFiles';
import { AdminQueries } from '../../services/live-vote/question-lab/AdminQueries';
import { AdminSourceMedia } from '../../services/admin/AdminSourceMedia';
import { AdminFeedback } from '../../services/admin/AdminFeedback';
import { AdminCoverPreview } from '../../services/admin/AdminCoverPreview';
import { AdminTitles } from '../../services/admin/AdminTitles';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { AITextGenerator } from '../../services/ai/AITextGenerator';
import { createFeedbackAgent } from '../../services/admin/AdminFeedbackAgent';
import { createFeedbackCompletion } from '../../services/admin/AdminFeedbackClient';

export function startAdminService(): void {
  const root = getProjectRoot(), tokenFile = path.join(root, 'data/runtime/admin/access-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { encoding: 'utf8', flag: 'wx' });
  const configs = new AdminConfigStore(root, process.env.ADMIN_VOTE_CONFIG);
  const roots = () => {
    const production = readJson(path.join(root, 'config/production.json'), {}), vote = configs.rawVote();
    return [...new Set<string>([production.webhook?.endpoints?.mikufans?.basePath, production.audio?.storage?.archiveTargetBasePath,
      ...Object.values(vote.questions?.recordingRoots || {}).flat()].filter(value => typeof value === 'string'))];
  };
  const runner = createCommandRunner(root, process.env.ADMIN_PYTHON);
  const jobs = new AdminJobs(path.join(root, 'data/runtime/admin/jobs'), runner);
  const queries = AdminQueries.fromFile(configs.path('live-vote'));
  const sourceMedia = new AdminSourceMedia(path.join(root, 'data/runtime/admin/source-previews'),
    () => readJson(path.join(root, 'config/production.json'), {}).audio?.ffmpeg?.path || 'ffmpeg');
  const clips = new AdminClipStore(root, roots);
  const feedback = new AdminFeedback(clips, jobs, runner, async prompt => {
    await ConfigProvider.initialize({ configPath: path.join(root, 'config/production.json') });
    return new AITextGenerator().generateText(prompt, { temperature: 0.1, maxTokens: 6000, timeout: 120000 });
  }, createFeedbackAgent(async (messages, tools) => {
    await ConfigProvider.initialize({ configPath: path.join(root, 'config/production.json') });
    return createFeedbackCompletion(ConfigProvider.getConfig() as any)(messages, tools);
  }));
  const covers = new AdminCoverPreview(root, process.env.ADMIN_PYTHON);
  const titles = new AdminTitles(path.join(root, 'data/runtime/admin/title-choices'), clips, jobs, async prompt => {
    await ConfigProvider.initialize({ configPath: path.join(root, 'config/production.json') });
    return new AITextGenerator().generateText(prompt, { temperature: 0.6, maxTokens: 1800, timeout: 120000 });
  });
  const app = createAdminServer({ configs, clips, jobs, queries, sourceMedia, feedback, covers, titles }, fs.readFileSync(tokenFile, 'utf8').trim());
  const port = Number(process.env.ADMIN_PORT || 15127);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ADMIN_PORT 无效');
  const server = app.listen(port, '127.0.0.1', () => console.log(`管理 API: http://127.0.0.1:${port}`));
  const stop = () => { queries.stop(); server.close(); void jobs.flush().then(() => process.exit()); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) startAdminService();
