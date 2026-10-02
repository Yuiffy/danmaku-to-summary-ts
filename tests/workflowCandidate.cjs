const fs = require('node:fs');
const path = require('node:path');

// Never fall back to the production workflow pointer when running tests.
if (!process.env.DANMAKU_WORKFLOW_RELEASE) {
  const candidate = path.join(__dirname, '../build/workflow-candidate.json');
  if (!fs.existsSync(candidate)) {
    throw new Error('Test workflows are missing. Run npm run build:workflows, or use npm test / npm run test:node.');
  }
  const { releaseDir } = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  if (typeof releaseDir !== 'string' || !path.isAbsolute(releaseDir) || !fs.existsSync(releaseDir)) {
    throw new Error('Invalid test workflow candidate. Run npm run build:workflows.');
  }
  process.env.DANMAKU_WORKFLOW_RELEASE = releaseDir;
}
