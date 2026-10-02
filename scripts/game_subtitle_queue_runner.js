'use strict';
const { spawn } = require('child_process');
const path = require('path');
const child = spawn('python', ['-u', path.join(__dirname, '../src/scripts/game_subtitle_upload.py'), '--loop'], {
  cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
});
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
