# Release checklist

1) Sync main:
   ```bash
   git checkout main && git pull
   ```
2) Install deps (root + server):
   ```bash
   npm ci
   cd server && npm ci && cd ..
   ```
3) Quick quality gates:
   ```bash
   npm run lint
   npm run build
   npm run test:e2e
   npm run smoke:ws:local   # spins up ws on 7071 automatically
   ```
4) Production build for TMA:
   ```bash
   npm run build
   npm run export   # outputs to out/
   ```
5) Server start (local):
   ```bash
   npm run server:start
   # or cd server && node server.js
   ```
6) Environment (see .env.example): set BOT_TOKEN, REQUIRE_AUTH=true for prod, SCORE_TO_WIN/ROOM_TIMEOUT_MS if needed.
7) Deploy:
   - Host static `out/` via HTTPS and configure BotFather Web App URL.
   - Deploy WS server (systemd/docker) and open PORT.
8) Smoke in prod:
   - Hit `/health` on WS host (expects JSON ok).
   - Open WebApp in Telegram and verify connection + score banner + ping.
