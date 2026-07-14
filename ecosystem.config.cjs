module.exports = {
  apps: [
    {
      name: "gridbot-server",
      script: "npx",
      args: "tsx server/index.ts",
      cwd: "/Users/tomomi/Sui-LPBot",
      env_file: ".env",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/server-error.log",
      out_file: "logs/server-out.log",
    },
  ],
};
