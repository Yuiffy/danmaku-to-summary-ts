/**
 * PM2生态系统配置文件
 * 用于管理弹幕转总结应用程序的进程
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'danmaku-webhook',
      script: 'dist/app/main.js',
      // 使用绝对路径确保正确
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 15121,
        HOST: '0.0.0.0',
        LOG_LEVEL: 'info'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 15122,
        HOST: 'localhost',
        LOG_LEVEL: 'debug'
      },
      env_test: {
        NODE_ENV: 'test',
        PORT: 15123,
        HOST: 'localhost',
        LOG_LEVEL: 'debug'
      },
      // 日志配置
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      log_file: path.join(__dirname, 'logs', 'pm2-combined.log'),
      time: true,
      // 合并日志输出
      merge_logs: true,
      // 进程管理
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      // 禁用PM2的日志合并，使用自定义日志格式
      output: path.join(__dirname, 'logs', 'pm2-out.log'),
      error: path.join(__dirname, 'logs', 'pm2-error.log'),
      // 等待就绪配置
      listen_timeout: 10000,
      kill_timeout: 5000,
      wait_ready: false,
      // 禁用自动重启计数（避免无限重启）
      exp_backoff_restart_delay: 100
    }
  ],

  // 部署配置
  deploy: {
    production: {
      user: 'node',
      host: 'localhost',
      ref: 'origin/main',
      repo: 'git@github.com:yourusername/danmaku-to-summary-ts.git',
      path: '/var/www/danmaku-to-summary-ts',
      'post-deploy': 'npm install && npm run build:all && pm2 reload ecosystem.config.js --env production'
    },
    development: {
      user: 'node',
      host: 'localhost',
      ref: 'origin/develop',
      repo: 'git@github.com:yourusername/danmaku-to-summary-ts.git',
      path: '/var/www/danmaku-to-summary-ts-dev',
      'post-deploy': 'npm install && npm run build:all && pm2 reload ecosystem.config.js --env development'
    }
  }
};