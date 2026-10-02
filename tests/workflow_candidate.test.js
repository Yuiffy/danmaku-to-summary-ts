const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('test bootstrap refuses a missing candidate even when an active workflow pointer exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-candidate-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'));
    fs.mkdirSync(path.join(root, 'data/runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/runtime/workflow-release.json'), JSON.stringify({ releaseDir: root }));
    const bootstrap = path.join(root, 'tests/workflowCandidate.cjs');
    fs.copyFileSync(path.join(__dirname, 'workflowCandidate.cjs'), bootstrap);
    const run = release => spawnSync(process.execPath, ['--require', bootstrap, '-e',
      'console.log(process.env.DANMAKU_WORKFLOW_RELEASE)'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', DANMAKU_WORKFLOW_RELEASE: release }
    });
    const missing = run('');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /npm run build:workflows/);
    fs.mkdirSync(path.join(root, 'build'));
    const descriptor = path.join(root, 'build/workflow-candidate.json');
    fs.writeFileSync(descriptor, JSON.stringify({ releaseDir: 'relative-release' }));
    assert.notEqual(run('').status, 0);
    fs.writeFileSync(descriptor, JSON.stringify({ releaseDir: path.join(root, 'missing') }));
    assert.notEqual(run('').status, 0);
    fs.writeFileSync(descriptor, JSON.stringify({ releaseDir: root }));
    const candidate = run('');
    assert.equal(candidate.status, 0, candidate.stderr);
    assert.equal(candidate.stdout.trim(), root);
    const explicit = run(path.join(root, 'build'));
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout.trim(), path.join(root, 'build'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
