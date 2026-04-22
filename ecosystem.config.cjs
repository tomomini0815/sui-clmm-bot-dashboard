module.exports = {
  apps: [
    {
      name: 'sui-bot-backend',
      script: 'bot_v2/dist/index.js',
      cwd: 'bot_v2',
      watch: false,
      autorestart: true,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 3002
      },
      error_file: 'logs/backend_error.log',
      out_file: 'logs/backend_out.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'sui-bot-frontend',
      script: 'node_modules/vite/bin/vite.js',
      args: '--port 5174',
      cwd: 'frontend',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'development'
      },
      error_file: 'logs/frontend_error.log',
      out_file: 'logs/frontend_out.log',
      merge_logs: true,
      time: true
    }
  ]
};
