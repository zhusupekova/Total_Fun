import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const PORT = process.env.PORT || 7071;

const ARENA = { width: 16, height: 10, playerDepth: 0.7 };
const SIDES = ['top', 'right', 'bottom', 'left'];
const MAX_PLAYERS = 4;

const state = {
  players: new Map(),
  ball: {
    x: 0,
    z: 0,
    vx: 5.5 * Math.cos(Math.random() * Math.PI * 2),
    vz: 5.5 * Math.sin(Math.random() * Math.PI * 2),
    r: 0.45,
  },
};

function assignSide() {
  const used = new Set([...state.players.values()].map((p) => p.side));
  for (const s of SIDES) {
    if (!used.has(s)) return s;
  }
  return null;
}

function playerDefault(side) {
  switch (side) {
    case 'top': return { x: 0, z: -ARENA.height / 2 + ARENA.playerDepth };
    case 'bottom': return { x: 0, z: ARENA.height / 2 - ARENA.playerDepth };
    case 'left': return { x: -ARENA.width / 2 + ARENA.playerDepth, z: 0 };
    case 'right': return { x: ARENA.width / 2 - ARENA.playerDepth, z: 0 };
    default: return { x: 0, z: 0 };
  }
}

function clampPlayer(player) {
  const margin = 0.4;
  if (player.side === 'top' || player.side === 'bottom') {
    const z = player.side === 'top' ? -ARENA.height / 2 + ARENA.playerDepth : ARENA.height / 2 - ARENA.playerDepth;
    player.z = z;
    player.x = Math.min(Math.max(player.x, -ARENA.width / 2 + margin), ARENA.width / 2 - margin);
  } else {
    const x = player.side === 'left' ? -ARENA.width / 2 + ARENA.playerDepth : ARENA.width / 2 - ARENA.playerDepth;
    player.x = x;
    player.z = Math.min(Math.max(player.z, -ARENA.height / 2 + margin), ARENA.height / 2 - margin);
  }
}

function resetBall() {
  state.ball.x = 0;
  state.ball.z = 0;
  const ang = Math.random() * Math.PI * 2;
  const speed = 5.5;
  state.ball.vx = Math.cos(ang) * speed;
  state.ball.vz = Math.sin(ang) * speed;
}

function collideBallWithWalls() {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const r = state.ball.r;
  let hit = false;

  if (state.ball.x > halfW - r) {
    state.ball.x = halfW - r;
    state.ball.vx *= -1;
    hit = true;
  } else if (state.ball.x < -halfW + r) {
    state.ball.x = -halfW + r;
    state.ball.vx *= -1;
    hit = true;
  }

  if (state.ball.z > halfH - r) {
    state.ball.z = halfH - r;
    state.ball.vz *= -1;
    hit = true;
  } else if (state.ball.z < -halfH + r) {
    state.ball.z = -halfH + r;
    state.ball.vz *= -1;
    hit = true;
  }

  if (hit) state.ball.vx *= 0.995, state.ball.vz *= 0.995;
}

function collideBallWithPlayer(player) {
  const halfX = 1.1 + state.ball.r * 0.5;
  const halfZ = ARENA.playerDepth * 0.6 + state.ball.r;
  const dx = state.ball.x - player.x;
  const dz = state.ball.z - player.z;
  if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) return;

  const overlapX = halfX - Math.abs(dx);
  const overlapZ = halfZ - Math.abs(dz);

  if (overlapX < overlapZ) {
    const nx = Math.sign(dx) || 1;
    state.ball.x += nx * overlapX;
    state.ball.vx = Math.abs(state.ball.vx) * nx;
  } else {
    const nz = Math.sign(dz) || 1;
    state.ball.z += nz * overlapZ;
    state.ball.vz = Math.abs(state.ball.vz) * nz;
  }

  const punch = 1.15;
  const len = Math.hypot(state.ball.vx, state.ball.vz) * punch;
  const ang = Math.atan2(state.ball.vz, state.ball.vx);
  const clamped = Math.min(Math.max(len, 2.5), 11);
  state.ball.vx = Math.cos(ang) * clamped;
  state.ball.vz = Math.sin(ang) * clamped;
}

function tickPhysics() {
  state.players.forEach((p) => {
    const speed = 8;
    const dirX = (p.input?.right ? 1 : 0) - (p.input?.left ? 1 : 0);
    const dirZ = (p.input?.back ? 1 : 0) - (p.input?.forward ? 1 : 0);
    if (p.side === 'top' || p.side === 'bottom') {
      p.x += dirX * speed * DT;
      p.z += dirZ * speed * DT * 0.25;
    } else {
      p.z += dirZ * speed * DT;
      p.x += dirX * speed * DT * 0.25;
    }
    clampPlayer(p);
  });

  state.ball.x += state.ball.vx * DT;
  state.ball.z += state.ball.vz * DT;

  collideBallWithWalls();
  state.players.forEach((p) => collideBallWithPlayer(p));

  state.ball.vx *= 0.999;
  state.ball.vz *= 0.999;
}

function broadcast(wss, payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

const wss = new WebSocketServer({ port: PORT });
console.log(`WS server listening on :${PORT}`);

wss.on('connection', (ws) => {
  if (state.players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: 'room full' }));
    ws.close();
    return;
  }
  const side = assignSide();
  const id = nanoid(6);
  const pos = playerDefault(side);
  const player = { id, side, x: pos.x, z: pos.z, input: {} };
  state.players.set(id, player);

  ws.send(JSON.stringify({ type: 'welcome', id, side, arena: ARENA }));
  broadcast(wss, { type: 'player_join', id, side });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'input') {
        const target = state.players.get(id);
        if (target) target.input = msg.input || {};
      }
      if (msg.type === 'reset_ball') {
        resetBall();
      }
    } catch (err) {
      console.warn('Bad message', err);
    }
  });

  ws.on('close', () => {
    state.players.delete(id);
    broadcast(wss, { type: 'player_leave', id });
  });
});

setInterval(() => {
  tickPhysics();
  broadcast(wss, {
    type: 'state',
    t: Date.now(),
    ball: state.ball,
    players: [...state.players.values()].map((p) => ({ id: p.id, side: p.side, x: p.x, z: p.z })),
  });
}, 1000 / TICK_RATE);

process.on('SIGINT', () => {
  console.log('Shutting down');
  wss.close(() => process.exit(0));
});
