module.exports = {
  apps: [
    {
      name: "sui-bot-backend",
      script: "dist/index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "800M",
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/backend_error.log",
      out_file: "logs/backend_out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};
