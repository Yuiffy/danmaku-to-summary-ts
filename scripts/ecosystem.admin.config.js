/** Only the local administration workspace; never starts production workers. */
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'data', 'runtime', 'admin');
const common = {
  cwd: root,
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  windowsHide: true,
  restart_delay: 3000,
  kill_timeout: 10000,
  time: false,
};
const env = {
  NODE_ENV: 'production',
  DANMAKU_PROJECT_ROOT: root,
  ADMIN_PORT: '15127',
  ADMIN_BASE_URL: 'http://127.0.0.1:15127',
  ADMIN_TOKEN_FILE: path.join(runtime, 'access-token'),
  ADMIN_VOTE_CONFIG: path.join(root, 'data', 'runtime', 'live-vote.json'),
  WEBHOOK_BASE_URL: 'http://127.0.0.1:12523',
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'danmaku-admin-api',
      script: path.join(runtime, 'service', 'tools', 'admin', 'server.js'),
      env,
      error_file: path.join(root, 'logs', 'admin-api-error.log'),
      out_file: path.join(root, 'logs', 'admin-api-out.log'),
    },
    {
      ...common,
      name: 'danmaku-admin-web',
      script: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: ['start', '--hostname', '127.0.0.1', '--port', '3000'],
      env,
      error_file: path.join(root, 'logs', 'admin-web-error.log'),
      out_file: path.join(root, 'logs', 'admin-web-out.log'),
    },
  ],
};
