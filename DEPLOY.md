# Deployment guide

## WebSocket сервер
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
ENV PORT=7071 BOT_TOKEN=xxx REQUIRE_AUTH=true
CMD ["node", "server.js"]
```
Запуск: `docker build -t total_fun_server . && docker run -p 7071:7071 total_fun_server`.

## Клиент (Next.js static export)
1. В корне проекта:
```
npm install
npm run build
npm run export   # статика в out/
```
2. Раздайте содержимое `out/` по HTTPS (например, Nginx/Caddy/Cloudflare Pages/Vercel). В Telegram BotFather укажите URL на `out/` как Web App.
3. Запуск стенда локально: `npm run dev` и открыть `/game`.

## Telegram Mini App
- Настройки BotFather: `Menu Button` → `Web App` URL (HTTPS), `Allowed Updates` — не требуется.
- Для prod выставить `REQUIRE_AUTH=true` и передавать initData; клиенты с неподписанным initData получат BAD_AUTH.
- Рекомендация: закрепить фиксированный URL WS в конфиге TMA (через query `ws=` или хардкод), скрыть debug UI (по умолчанию скрыто, `debug=1` для тестов).

## Быстрый smoke
- Сервер: `npm run smoke:ws -- --url=ws://localhost:7071` (в корне, сервер должен работать).
- Клиент offline: `npm run dev`, открыть `/game`.
- Клиент online: `/game?ws=ws://localhost:7071&debug=1`.

## Мониторинг
- `/health` на том же порту, возвращает `ok`.
- Логирование stdout/stderr systemd или docker logs. Добавить внешние метрики при необходимости.
