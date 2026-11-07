'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const command = process.argv[2];
const args = process.argv.slice(3);
const defaults = {
  dev: '.next-dev',
  build: 'build/web-admin-candidate',
  start: '.next',
  'build-production': '.next',
  'start-candidate': 'build/web-admin-candidate',
};

if (!command || !defaults[command]) {
  console.error('Usage: node tools/run-next.cjs <dev|build|start|build-production|start-candidate> [next args...]');
  process.exit(2);
}

const projectRoot = path.resolve(__dirname, '..');
const distDir = process.env.DANMAKU_NEXT_BUILD_DIR || defaults[command];
const env = { ...process.env, DANMAKU_NEXT_BUILD_DIR: distDir };
const nextBin = require.resolve('next/dist/bin/next');
const isBuild = command === 'build' || command === 'build-production';
const lockPath = path.resolve(projectRoot, `${distDir.replace(/[\\/]/g, '-')}.lock`);
let lockFd;

function releaseLock() {
  if (lockFd === undefined) return;
  try { fs.closeSync(lockFd); } catch { /* best effort during process shutdown */ }
  try { fs.unlinkSync(lockPath); } catch { /* best effort during process shutdown */ }
  lockFd = undefined;
}

function acquireBuildLock() {
  if (!isBuild) return;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeSync(lockFd, `${process.pid}\n`);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      let owner = '';
      try { owner = fs.readFileSync(lockPath, 'utf8').trim(); } catch { /* stale lock details are optional */ }
      const ownerPid = Number(owner);
      let ownerAlive = false;
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch { /* the lock is stale */ }
      }
      if (!ownerAlive) {
        try { fs.unlinkSync(lockPath); } catch { /* another builder may have replaced it */ }
        return acquireBuildLock();
      }
      console.error(`Next build already running${owner ? ` (pid ${owner})` : ''}: ${distDir}`);
      process.exit(1);
    }
    throw error;
  }
  process.once('exit', releaseLock);
  process.once('SIGINT', () => { releaseLock(); process.exit(130); });
  process.once('SIGTERM', () => { releaseLock(); process.exit(143); });
}

acquireBuildLock();
const child = spawn(process.execPath, [nextBin, command === 'build-production' ? 'build' : command === 'start-candidate' ? 'start' : command, ...args], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.once('error', error => {
  console.error(error instanceof Error ? error.message : error);
  releaseLock();
  process.exit(1);
});
child.once('exit', (code, signal) => {
  releaseLock();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
