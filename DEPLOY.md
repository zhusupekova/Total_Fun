# Deployment guide

## WebSocket сервер
### PM2 (production, Mini App auth)
1. На сервере создайте `server/.env` (не коммитить):
```
PORT=7071
BOT_TOKEN=PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE
DISABLE_TELEGRAM_AUTH=false
REQUIRE_AUTH=true
AUTH_GRACE_SEC=86400
BALL_START_SPEED=15.0
BALL_MIN_SPEED=13.0
BALL_HIT_SPEED=18.0
BALL_MAX_SPEED=26.0
BALL_DAMPING=1.0
BALL_HIT_BOOST=1.25
MAX_MSG_PER_SEC=120
MAX_CONN_PER_IP=8
CONN_WINDOW_MS=10000
MAX_PAYLOAD=4096
METRICS_INTERVAL_MS=60000
ROOM_TIMEOUT_MS=0
HIT_COOLDOWN_MS=90
FILL_BOTS=false
BOT_AI=false
BOT_DEADZONE=0.25
```
2. Запуск:
```
cd /opt/total_fun/server
export $(grep -v '^#' .env | xargs)
pm2 start ecosystem.config.example.cjs --env production --update-env
pm2 save
pm2 startup
```
3. Проверка:
```
pm2 status
curl http://127.0.0.1:7071/health
```

### Быстро отключить Telegram auth (для тестов в браузере)
В `.env`:
```
DISABLE_TELEGRAM_AUTH=true
REQUIRE_AUTH=false
```
И перезапуск:
```
set -a && source .env && set +a
pm2 restart total-fun-ws --update-env
pm2 save
```

### Systemd (single room, Node.js)
1. Создайте юнит `/etc/systemd/system/total_fun.service`:
```
[Unit]
Description=Total_Fun WS server
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/total_fun/server
Environment=PORT=7071
Environment=BOT_TOKEN=xxx
Environment=REQUIRE_AUTH=true
Environment=MAGNETS=on
Environment=MAX_MSG_PER_SEC=120
Environment=MAX_CONN_PER_IP=8
Environment=CONN_WINDOW_MS=10000
Environment=MAX_PAYLOAD=4096
Environment=METRICS_INTERVAL_MS=60000
Environment=ALLOW_DEBUG=false
Environment=COLLECTIBLE_COUNT=10
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```
2. `systemctl daemon-reload && systemctl enable --now total_fun`.
3. Health-check: `curl http://localhost:7071/health` → `ok`.

### Docker (minimal)
```
FROM node:18-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --production
COPY server ./
ENV PORT=7071 BOT_TOKEN=xxx REQUIRE_AUTH=true COLLECTIBLE_COUNT=10
CMD ["node", "server.js"]
```
Запуск: `docker build -t total_fun_server . && docker run -p 7071:7071 total_fun_server`.

## Клиент (Next.js static export)
1. В корне проекта:
```
npm install
npm run build
```
2. Раздайте содержимое `out/` по HTTPS (например, Nginx/Caddy/Cloudflare Pages/Vercel). В Telegram BotFather укажите URL на `out/` как Web App.
   - Если WebApp отдаётся по HTTPS (в Telegram так и должно быть), то WebSocket тоже должен быть **WSS** (иначе будет blocked mixed content).
   - Рекомендуется зафиксировать WS URL в сборке через env: `NEXT_PUBLIC_WS=wss://... npm run build`.
3. Запуск стенда локально: `npm run dev` и открыть `/game`.

### Nginx (статик `out/` + корректный `/game` без HTTPS→HTTP редиректа)
Если у вас маршрут экспортируется как `out/game/index.html`, то запрос на `/game` (без слэша) часто триггерит автоматический редирект Nginx на `/game/`.
Если при этом TLS терминируется не на вашем Nginx (например, за Cloudflare), редирект может получиться **на `http://.../game/`**, что ломает Telegram Mini App.

Решение: обработать `location = /game` и отдать `game/index.html` **без внешнего редиректа**.

Пример конфига (адаптируйте `root`, сертификаты и домены):
```nginx
server {
  listen 443 ssl http2;
  server_name example.com www.example.com;

  root /var/www/total_fun/out;
  index index.html;

  # Важно: отдать /game без 301 на /game/ (безопасно для Telegram).
  location = /game {
    try_files /game/index.html =404;
  }

  # Статика next export
  location / {
    try_files $uri $uri/ =404;
  }
}
```

Опционально: если хотите WS на том же домене через путь `/ws` (вместо `ws.example.com`), добавьте:
```nginx
location /ws {
  proxy_pass http://127.0.0.1:7071;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 60s;
}
```

## Telegram Mini App
- Настройки BotFather: `Menu Button` → `Web App` URL (HTTPS), `Allowed Updates` — не требуется.
- Рекомендация: указывать URL со слэшем (`https://YOUR_DOMAIN/game/`), чтобы избежать лишних редиректов (Telegram WebView бывает чувствителен к ним).
- Для prod выставить `REQUIRE_AUTH=true` и передавать initData; клиенты с неподписанным initData получат BAD_AUTH.
- Рекомендация: закрепить фиксированный URL WS (через `NEXT_PUBLIC_WS` или query `ws=`), скрыть debug UI (по умолчанию скрыто, `debug=1` для тестов).

## Быстрый smoke
- Сервер: `npm run smoke:ws -- --url=ws://localhost:7071` (в корне, сервер должен работать).
- Клиент offline: `npm run dev`, открыть `/game`.
- Клиент online (dev/http): `/game?ws=ws://localhost:7071&debug=1`.
- Клиент online (prod/https): `/game?ws=wss://YOUR_WS_HOST&debug=1`.

## Мониторинг
- `/health` на том же порту, возвращает `ok`.
- Логирование stdout/stderr systemd или docker logs. Добавить внешние метрики при необходимости.
