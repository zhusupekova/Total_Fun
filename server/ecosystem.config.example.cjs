module.exports = {
  apps: [
    {
      name: 'total-fun-ws',
      script: 'server.js',
      cwd: '/opt/total_fun/server',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 7071,
        // Dev/testing default: allow connecting from a normal browser without Telegram initData.
        // For production mini-app: set DISABLE_TELEGRAM_AUTH='false' and REQUIRE_AUTH='true'.
        DISABLE_TELEGRAM_AUTH: process.env.DISABLE_TELEGRAM_AUTH || 'true',
        REQUIRE_AUTH: process.env.REQUIRE_AUTH || 'false',
        BOT_TOKEN: process.env.BOT_TOKEN || '',
        AUTH_GRACE_SEC: 86400,
        BALL_START_SPEED: process.env.BALL_START_SPEED || '15.0',
        BALL_MIN_SPEED: process.env.BALL_MIN_SPEED || '13.0',
        BALL_HIT_SPEED: process.env.BALL_HIT_SPEED || '18.0',
        BALL_MAX_SPEED: process.env.BALL_MAX_SPEED || '26.0',
        BALL_DAMPING: process.env.BALL_DAMPING || '1.0',
        BALL_HIT_BOOST: process.env.BALL_HIT_BOOST || '1.25',
        MAX_MSG_PER_SEC: 120,
        MAX_CONN_PER_IP: 8,
        CONN_WINDOW_MS: 10000,
        MAX_PAYLOAD: 4096,
        METRICS_INTERVAL_MS: 60000,
        ROOM_TIMEOUT_MS: 0,
        HIT_COOLDOWN_MS: 90,
        // PvP-only MVP: bots are disabled in server code.
        FILL_BOTS: 'false',
        BOT_AI: 'false',
      },
    },
  ],
};
