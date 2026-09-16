const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'seedance_queue_runner.py');
const child = spawn('python', ['-u', script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.dirname(__dirname),
  shell: false,
  env: process.env,
  windowsHide: true,
});

child.on('exit', code => process.exit(code ?? 0));
