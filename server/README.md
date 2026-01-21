# Real-time server (WS, server-authoritative)

- Entry: `server.js` (Node + ws)
- Tick: 60 FPS, runs ball physics and player motion.
- Protocol:
  - `welcome`: sent on connect `{ type: "welcome", id, side, arena }`
  - `state`: broadcast each tick `{ type: "state", t, ball, players[] }`
  - `player_join` / `player_leave`: presence events
  - Client input: `{ type: "input", input: { forward, back, left, right } }`
  - Reset ball (debug): `{ type: "reset_ball" }`
- Sides assignment order: top → right → bottom → left.

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
