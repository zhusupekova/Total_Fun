# Total_Fun real-time server (WS, server-authoritative)

- Server side for Total_Fun (4-player arena, Stage 3 draft).
- Entry: `server.js` (Node + ws)
- Tick: 60 FPS physics, snapshots at 30 Hz, single room.
- Protocol (uppercase):
  - Client → Server: `HELLO { userId, username }`, `INPUT { forward, back, left, right }`, `PONG { pingId, ts }`, `DEBUG { cmd: "RESET_BALL" }`
  - Server → Client: `WELCOME { playerId, side, roomId, tickRate, snapshotRate, matchState, arena }`, `ROOM_STATE { players[], matchState }`, `SNAPSHOT { t, payload: { ball { pos, vel, r }, players[] } }`, `PING { pingId, ts }`, `ERROR { code, message }`, `MATCH_EVENT { event: MATCH_READY|MATCH_IN_PROGRESS|MATCH_WAITING }`
- Sides assignment order: top → right → bottom → left, max 4 players, 5-й получает `ERROR: ROOM_FULL`.
- Match flow: WAITING → READY (2s) → IN_PROGRESS; при потере игроков возвращается в WAITING, ball reset.

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
