module.exports = {
  apps: [
    {
      name: 'sui-bot-backend',
      script: 'dist/index.js',
      cwd: 'bot_v2',
      watch: false,
      autorestart: true,
      max_memory_restart: '2G',
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
      args: 'preview --host 127.0.0.1 --port 5174 --strictPort',
      cwd: 'frontend',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/frontend_error.log',
      out_file: 'logs/frontend_out.log',
      merge_logs: true,
      time: true
    }
  ]
};
