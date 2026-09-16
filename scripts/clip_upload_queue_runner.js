const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, '..', 'src', 'scripts', 'clip_upload_registry.py');
const child = spawn('python', ['-u', script, 'worker', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.dirname(__dirname),
  shell: false,
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  },
  windowsHide: true,
});

child.on('exit', code => process.exit(code ?? 0));

// PM2 stops the Node wrapper, not Python directly.  Forward termination so a
// restart cannot leave an orphan worker holding the registry lock.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
