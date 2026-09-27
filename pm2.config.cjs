// alemonx-pm2: {"name":"alemonx-server-4d7678ad","script":"./index.js","autorestart":true,"maxRestarts":10,"env":{"NODE_ENV":"production"}}
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: "alemonx-server-4d7678ad",
      namespace: "alemonx",
      cwd: __dirname,
      script: './index.js',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      env: {
        ALEMON_CBP_FILE_TRANSPORT: '1',
        ALEMON_CBP_FILE_DIR: path.join(__dirname, '.alemon', 'cbp'),
        NODE_ENV: 'production',
      }
    }
  ]
};
