// pm2 process definition, used by scripts/deploy.sh:  pm2 startOrReload ecosystem.config.cjs
// The file ends in .cjs because package.json says "type": "module", and pm2 loads this file with require().
module.exports = {
  apps: [
    {
      name: 'mco2-ddb',
      script: 'src/server.js',
      cwd: __dirname, // so dotenv finds the .env next to the code (/opt/mco2/.env)
      exec_mode: 'fork',
      instances: 1, // exactly one process per VM: the health checker and (later) the recovery worker must not run twice
      autorestart: true,
      max_memory_restart: '300M',
      time: true, // timestamp every line in `pm2 logs`
      kill_timeout: 5000, // give the app time to close its database connections on reload
    },
  ],
};
