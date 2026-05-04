module.exports = {
  apps: [
    {
      name: "inventory-app",
      script: "server.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      env: {
        NODE_ENV: "development",
        PORT: 3000
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000
      },
      // Menunggu file sistem siap sebelum restart jika terjadi crash
      watch: false,
      max_memory_restart: "1G",
      // Backup log ke file
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    }
  ]
};
