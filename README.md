# Total_Fun

MVP 3D PvP игра для Telegram Mini Apps: статичная арена на 4 игроков, сервер-авторитативная физика мяча, mobile-first WebView. Текущее состояние: один матч на 4 игроков, online через WebSocket; 

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
npm run build    # статика в out/
```
- Для хостинга в TMA отдавайте содержимое `out/` по HTTPS, укажите URL в BotFather (Web App). При HTTPS WebSocket тоже должен быть **WSS**.
  - Практика: в BotFather указывать URL с финальным слэшем (`/game/`), чтобы избежать лишних редиректов (Telegram WebView бывает чувствителен к ним). См. `DEPLOY.md` для nginx-примера.
- E2E smoke (Playwright): запустите dev-сервер и в другом терминале `npm run test:e2e` (BASE_URL можно переопределить).
- Параметры query:
  - `ws=ws(s)://host[:port][/path]` — указать WebSocket сервер (в Telegram/HTTPS нужен `wss://`).
- Env (для прод-сборки, фиксирует WS URL без query): `NEXT_PUBLIC_WS=wss://...`
- Быстрый локальный WS smoke: `npm run smoke:ws:local` (поднимет сервер на 7071, прогонит smoke, остановит сервер).
- Локальный полный прогон: `npm run test:all` (lint + build + Playwright).

## Сервер (Node + ws)
```
npm run server:start          # PORT=7071 по умолчанию
```
### Env
- `PORT` — порт WS сервера.
- `BOT_TOKEN` — токен Telegram бота для проверки initData.
- `REQUIRE_AUTH=true` — требовать валидный initData (prod).
- `AUTH_GRACE_SEC` — TTL auth_date, по умолчанию 86400.
- `MAX_MSG_PER_SEC` — лимит входящих сообщений (120).
- `MAX_CONN_PER_IP` / `CONN_WINDOW_MS` — квота подключений с IP (8 / 10000).
- `ROOM_TIMEOUT_MS` — принудительное завершение матча по времени (0 = выкл).
- `MAX_PAYLOAD` — max incoming WS message size in bytes (default 4096).
- `/health` — JSON статус, uptime, игроки, tick, метрики; периодическое логирование метрик управляется `METRICS_INTERVAL_MS`.
- `HIT_COOLDOWN_MS` — защита от дребезга повторных ударов одним игроком (default 100).

### Протокол
- Client→Server: `HELLO { userId?, username?, initData? }`, `INPUT {forward,back,left,right}`, `PONG { pingId, ts }`
- Server→Client: `WELCOME { playerId, side, roomId, tickRate, snapshotRate, matchState, arena, physics }`, `ROOM_STATE`, `SNAPSHOT { t, ts, payload }`, `PING`, `ERROR { code, message }`, `MATCH_EVENT { event: MATCH_READY|MATCH_IN_PROGRESS|MATCH_WAITING|MATCH_FINISHED }`

## Состояния
- Матч: WAITING → READY (2s) → IN_PROGRESS → FINISHED; при недоборе игроков завершается/возвращается в WAITING.
- Ограничение: максимум 4 игрока, 5-й получает ROOM_FULL.

## Ассеты
- Положить GLB в `public/assets`: `arena.glb`, `ball.glb`, `player_cat.glb`, `player_dog.glb`, `player_duck.glb`, `player_pigeon.glb` (или `player.glb` как фолбек). Pivot (0,0,0), ширина ~2.2, глубина ~0.7.
- Дополнительные варианты игроков лежат в `public/assets/players`.

## Безопасность / анти-чит
- initData проверяется HMAC (если задан BOT_TOKEN), в prod ставить REQUIRE_AUTH=true.
- Rate limit: входящие сообщения 120/сек; квота подключений per IP (по умолчанию 8 за 10s).
- INPUT принимается только в READY/IN_PROGRESS; сервер авторитетен по физике.

## Известные ограничения
- Нет финального прод-деплоя в README для TMA (нужен статики билд Next + hosting под https).
- UI минимален; матчмейкинга нет (single room).

## Быстрые проверки
- Online (dev/http): запустить сервер и подключить `/game?ws=ws://localhost:7071`.
- Online (prod/https): `/game?ws=wss://YOUR_WS_HOST`.
- Smoke WS: `npm run smoke:ws -- --url=ws://localhost:7071`.
- CI локальный: `npm run test:all` (lint + build + Playwright).
