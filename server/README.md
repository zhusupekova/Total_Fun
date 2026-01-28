# Total_Fun real-time server (WS, server-authoritative)

- Server side for Total_Fun (4-player arena, Stage 3 draft).
- Entry: `server.js` (Node + ws)
- Tick: 60 FPS physics, snapshots at 30 Hz, single room.
- Protocol (uppercase):
  - Client → Server: `HELLO { userId, username }`, `INPUT { forward, back, left, right }`, `PONG { pingId, ts }`, `DEBUG { cmd: "RESET_BALL" }`
  - Server → Client: `WELCOME { playerId, side, roomId, tickRate, snapshotRate, matchState, arena }`, `ROOM_STATE { players[], matchState }`, `SNAPSHOT { t, payload: { ball { pos, vel, r }, players[] } }`, `PING { pingId, ts }`, `ERROR { code, message }`, `MATCH_EVENT { event: MATCH_READY|MATCH_IN_PROGRESS|MATCH_WAITING }`
- Sides assignment order: top → right → bottom → left, max 4 players, 5-й получает `ERROR: ROOM_FULL`.
- Match flow: WAITING → READY (2s) → IN_PROGRESS; при потере игроков возвращается в WAITING, ball reset.
- Магниты: 4 зоны притяжения в углах (радиус 2, strength 4), можно отключить переменной `MAGNETS=off`.

## Run locally
```bash
cd server
npm install
npm start  # PORT=7071 by default
```

## Notes
- Physics mirrors the Stage 1 client (2D plane, reflective walls/players).
- This is a skeleton; client integration is not wired yet in Three.js demo.
- Deploy on a plain Node host (TCP/WS), keep sticky connections per room.

## Auth
- Set `BOT_TOKEN` to your Telegram bot token.
- Set `REQUIRE_AUTH=true` in production to reject clients without valid `initData`.
- `AUTH_GRACE_SEC` (default 86400) limits how long `auth_date` is accepted.
- Connection guard: `MAX_CONN_PER_IP` (default 8 per `CONN_WINDOW_MS` window, default 10s) and message rate limit (120 msg/sec).
- `MAX_PAYLOAD` — max incoming WS message size in bytes (default 4096).
- Metrics: `/health` returns JSON (uptime, players, tick, counters). Periodic stdout logging controlled by `METRICS_INTERVAL_MS` (default 60000, set to 0 to disable).
- Debug: `ALLOW_DEBUG=true` — разрешить DEBUG-команды (сброс мяча) от клиентов; по умолчанию выкл.
- `ROOM_TIMEOUT_MS` — принудительное завершение матча по времени (0 = выкл).
- `SCORE_TO_WIN` — включить счёт и завершение по очкам (0 = выкл), очки начисляются при касании север/юг борта.
- `FINISHED_RESET_MS` — через сколько мс после FINISHED возвращаться в WAITING (default 5000).
- `COLLECTIBLE_COUNT` — число коллектаблов (default 0, выкл).
- Сообщение `RESTART` (доступно при ALLOW_DEBUG=true) — сброс матча/позиций/коллектаблов, кулдаун 1s.
