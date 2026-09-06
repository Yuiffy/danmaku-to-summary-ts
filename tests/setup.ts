import * as fs from 'fs';
import * as path from 'path';

// Source compatibility tests use the candidate without changing the live pointer.
const workflowCandidate = path.join(__dirname, '../build/workflow-candidate.json');
if (!process.env.DANMAKU_WORKFLOW_RELEASE && fs.existsSync(workflowCandidate)) {
  process.env.DANMAKU_WORKFLOW_RELEASE = JSON.parse(fs.readFileSync(workflowCandidate, 'utf8')).releaseDir;
}
