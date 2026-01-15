/**
 * PM2生态系统配置文件
 * 用于管理弹幕转总结应用程序的进程
 */

module.exports = {
  apps: [
    {
      name: 'danmaku-webhook',
      script: 'dist/app/main.js',
      cwd: __dirname,
      instances: 1,
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
        PORT: 15121,
        HOST: 'localhost',
        LOG_LEVEL: 'debug'
      },
      env_test: {
        NODE_ENV: 'test',
        PORT: 15121,
        HOST: 'localhost',
        LOG_LEVEL: 'debug'
      },
      // 日志配置
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      // 进程管理
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      // 健康检查
      health_check: {
        url: 'http://localhost:15121/health',
        interval: 30000,
        timeout: 5000,
        retries: 3
      }
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