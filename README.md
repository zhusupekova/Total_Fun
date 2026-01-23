# Total_Fun

MVP 3D PvP игра для Telegram Mini Apps: статичная арена на 4 игроков, сервер-авторитативная физика мяча, mobile-first WebView. Текущее состояние: готов офлайн стенд и черновой online (WS) режим с авторизацией по initData, антиспам и квоты подключений.

## Требования
- Node.js 18+
- npm

## Клиент (Next.js)
- Страница `/game` (SSR off). Запуск dev:
```bash
npm install
npm run dev
# открыть http://localhost:3000/game
```
- Прод сборка (статический экспорт):
```bash
npm run build
npm run export   # статика в out/
```
- Для хостинга в TMA отдавайте содержимое `out/` по HTTPS, укажите URL в BotFather (Web App).
- E2E smoke (Playwright): запустите dev-сервер и в другом терминале `npm run test:e2e` (BASE_URL можно переопределить).
- Параметры query:
  - `ws=ws://host:port` — включить online режим.
  - `magnets=off` — отключить магнитные зоны (клиент).
  - `debug=1` — показать debug UI (WS панель, текстовые подсказки).

## Сервер (Node + ws)
```
cd server
npm install
npm start           # PORT=7071 по умолчанию
```
### Env
- `PORT` — порт WS сервера.
- `MAGNETS=off` — отключить магнитные зоны.
- `BOT_TOKEN` — токен Telegram бота для проверки initData.
- `REQUIRE_AUTH=true` — требовать валидный initData (prod).
- `AUTH_GRACE_SEC` — TTL auth_date, по умолчанию 86400.
- `MAX_MSG_PER_SEC` — лимит входящих сообщений (120).
- `MAX_CONN_PER_IP` / `CONN_WINDOW_MS` — квота подключений с IP (8 / 10000).
- `SCORE_TO_WIN` — включить счёт и финиш по очкам (0 = выкл, очки при касании север/юг борта).
- `ROOM_TIMEOUT_MS` — принудительное завершение матча по времени (0 = выкл).
- `FINISHED_RESET_MS` — через сколько мс после FINISHED возвращаться в WAITING (default 5000).
- `MAX_PAYLOAD` — max incoming WS message size in bytes (default 4096).

### Протокол
- Client→Server: `HELLO { userId?, username?, initData? }`, `INPUT {forward,back,left,right}`, `PONG { pingId, ts }`, `DEBUG { cmd: "RESET_BALL" }`
- Server→Client: `WELCOME { playerId, side, roomId, tickRate, snapshotRate, matchState, arena }`, `ROOM_STATE`, `SNAPSHOT { t, ts, payload }`, `PING`, `ERROR { code, message }`, `MATCH_EVENT { event: MATCH_READY|MATCH_IN_PROGRESS|MATCH_WAITING|MATCH_FINISHED }`

## Состояния
- Матч: WAITING → READY (2s) → IN_PROGRESS → FINISHED; при недоборе игроков возвращается в WAITING/FINISHED.
- Ограничение: максимум 4 игрока, 5-й получает ROOM_FULL.

## Ассеты
- Положить GLB в `public/assets`: `arena.glb`, `ball.glb`, `player_cat.glb`, `player_dog.glb`, `player_duck.glb`, `player_pigeon.glb` (или `player.glb` как фолбек). Pivot (0,0,0), ширина ~2.2, глубина ~0.7.

## Безопасность / анти-чит
- initData проверяется HMAC (если задан BOT_TOKEN), в prod ставить REQUIRE_AUTH=true.
- Rate limit: входящие сообщения 120/сек; квота подключений per IP (по умолчанию 8 за 10s).
- INPUT принимается только в READY/IN_PROGRESS; сервер авторитетен по физике.

## Известные ограничения
- Нет финального прод-деплоя в README для TMA (нужен статики билд Next + hosting под https).
- UI ошибок минимальный, матчмейкинга нет (single room).

## Быстрые проверки
- Offline: `npm run dev` и открыть `/game` без ws.
- Online: запустить сервер и подключить `/game?ws=ws://localhost:7071&debug=1`.
- Smoke WS: `npm run smoke:ws -- --url=ws://localhost:7071`.
- CI локальный: `npm run test:all` (lint + build + Playwright).
