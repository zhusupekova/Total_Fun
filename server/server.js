import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const PORT = process.env.PORT || 7071;
const ROOM_ID = 'default';
const MAX_PLAYERS = 4;
const TICK_RATE = 60;
const SNAPSHOT_RATE = 30;
const SNAPSHOT_INTERVAL = 1000 / SNAPSHOT_RATE;
const READY_DURATION = 2000;
const RECLAIM_MS = 15000;
const INPUT_INTERVAL_MS = 33; // ~30 Hz

const ARENA = { width: 16, height: 10, playerDepth: 0.7, ballRadius: 0.5 };
const PLAYER = { speed: 6, collider: { x: 2.2, z: 0.7 } };
const BALL = {
  minSpeed: 2,
  baseSpeed: 6,
  maxSpeed: 12,
  damping: 0.995,
  restitutionWall: 1,
  restitutionPlayer: 1,
  hitImpulse: 2.5,
  angleInfluence: 1,
};

const SIDE_ORDER = ['top', 'right', 'bottom', 'left'];
const SIDE_ZONES = {
  top: { x: [-8, 8], z: [-5, -2.5] },
  bottom: { x: [-8, 8], z: [2.5, 5] },
  left: { x: [-8, -4], z: [-5, 5] },
  right: { x: [4, 8], z: [-5, 5] },
};

const MAGNETS_ENABLED = process.env.MAGNETS !== 'off';
const MAGNETS = [
  { id: 'nw', center: { x: -6.5, z: -3.5 }, radius: 2, strength: 4, type: 'pull', enabled: true },
  { id: 'ne', center: { x: 6.5, z: -3.5 }, radius: 2, strength: 4, type: 'pull', enabled: true },
  { id: 'se', center: { x: 6.5, z: 3.5 }, radius: 2, strength: 4, type: 'pull', enabled: true },
  { id: 'sw', center: { x: -6.5, z: 3.5 }, radius: 2, strength: 4, type: 'pull', enabled: true },
];

const state = {
  players: new Map(), // id -> {id,userId,username,side,x,z,input,lastInputAt,ws,connected,disconnectedAt,ping}
  tick: 0,
  matchState: 'WAITING',
  readyUntil: null,
  ball: { x: 0, z: 0, vx: 0, vz: 0 },
  lastSnapshotAt: 0,
};

const sockets = new Map(); // ws -> playerId
const wss = new WebSocketServer({ port: PORT });

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function playerDefault(side) {
  const zone = SIDE_ZONES[side] || { x: [0, 0], z: [0, 0] };
  return {
    x: (zone.x[0] + zone.x[1]) / 2,
    z: (zone.z[0] + zone.z[1]) / 2,
  };
}

function assignSide() {
  const used = new Set([...state.players.values()].map((p) => p.side));
  for (const side of SIDE_ORDER) {
    if (!used.has(side)) return side;
  }
  return null;
}

function clampPlayerToZone(player) {
  const zone = SIDE_ZONES[player.side];
  if (!zone) return;
  player.x = clamp(player.x, zone.x[0], zone.x[1]);
  player.z = clamp(player.z, zone.z[0], zone.z[1]);
}

function normalizeDir(input = {}) {
  let x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let z = (input.back ? 1 : 0) - (input.forward ? 1 : 0);
  const len = Math.hypot(x, z);
  if (len > 1e-5) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

function kickOffBall() {
  const ang = Math.random() * Math.PI * 2;
  state.ball.vx = Math.cos(ang) * BALL.baseSpeed;
  state.ball.vz = Math.sin(ang) * BALL.baseSpeed;
  state.ball.x = 0;
  state.ball.z = 0;
}

function applyMagnets(dt) {
  if (!MAGNETS_ENABLED) return;
  MAGNETS.filter((m) => m.enabled).forEach((mag) => {
    const dx = mag.center.x - state.ball.x;
    const dz = mag.center.z - state.ball.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4 || dist > mag.radius) return;
    const force = (1 - dist / mag.radius) * mag.strength;
    const nx = dx / dist;
    const nz = dz / dist;
    state.ball.vx += nx * force * dt;
    state.ball.vz += nz * force * dt;
  });
}

function collideWalls() {
  const r = ARENA.ballRadius;
  const minX = -ARENA.width / 2 + r;
  const maxX = ARENA.width / 2 - r;
  const minZ = -ARENA.height / 2 + r;
  const maxZ = ARENA.height / 2 - r;
  let hit = false;

  if (state.ball.x < minX) {
    state.ball.x = minX;
    state.ball.vx = Math.abs(state.ball.vx) * BALL.restitutionWall;
    hit = true;
  } else if (state.ball.x > maxX) {
    state.ball.x = maxX;
    state.ball.vx = -Math.abs(state.ball.vx) * BALL.restitutionWall;
    hit = true;
  }

  if (state.ball.z < minZ) {
    state.ball.z = minZ;
    state.ball.vz = Math.abs(state.ball.vz) * BALL.restitutionWall;
    hit = true;
  } else if (state.ball.z > maxZ) {
    state.ball.z = maxZ;
    state.ball.vz = -Math.abs(state.ball.vz) * BALL.restitutionWall;
    hit = true;
  }

  if (hit) {
    state.ball.vx *= BALL.damping;
    state.ball.vz *= BALL.damping;
  }
}

function collideWithPlayer(player) {
  const halfX = PLAYER.collider.x / 2 + ARENA.ballRadius * 0.5;
  const halfZ = PLAYER.collider.z / 2 + ARENA.ballRadius * 0.5;
  const dx = state.ball.x - player.x;
  const dz = state.ball.z - player.z;
  if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) return;

  const overlapX = halfX - Math.abs(dx);
  const overlapZ = halfZ - Math.abs(dz);
  let nx = 0; let nz = 0;

  if (overlapX < overlapZ) {
    nx = Math.sign(dx) || 1;
    state.ball.x += nx * overlapX;
    state.ball.vx = Math.abs(state.ball.vx) * nx * BALL.restitutionPlayer;
  } else {
    nz = Math.sign(dz) || 1;
    state.ball.z += nz * overlapZ;
    state.ball.vz = Math.abs(state.ball.vz) * nz * BALL.restitutionPlayer;
  }

  const dir = normalizeDir(player.input);
  const speed = Math.hypot(state.ball.vx, state.ball.vz);
  state.ball.vx += dir.x * BALL.hitImpulse;
  state.ball.vz += dir.z * BALL.hitImpulse;

  const clampedSpeed = clamp(speed, BALL.minSpeed, BALL.maxSpeed);
  const len = Math.hypot(state.ball.vx, state.ball.vz) || 1;
  state.ball.vx = (state.ball.vx / len) * clampedSpeed;
  state.ball.vz = (state.ball.vz / len) * clampedSpeed;
}

function applyBallLimits() {
  const speed = Math.hypot(state.ball.vx, state.ball.vz);
  if (speed < BALL.minSpeed) {
    const ang = Math.atan2(state.ball.vz, state.ball.vx) || Math.random() * Math.PI * 2;
    state.ball.vx = Math.cos(ang) * BALL.minSpeed;
    state.ball.vz = Math.sin(ang) * BALL.minSpeed;
  } else if (speed > BALL.maxSpeed) {
    const ang = Math.atan2(state.ball.vz, state.ball.vx);
    state.ball.vx = Math.cos(ang) * BALL.maxSpeed;
    state.ball.vz = Math.sin(ang) * BALL.maxSpeed;
  }
}

function connectedPlayers() {
  return [...state.players.values()].filter((p) => p.connected);
}

function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function sendRoomState() {
  broadcast({
    type: 'ROOM_STATE',
    payload: {
      matchState: state.matchState,
      players: [...state.players.values()].map((p) => ({
        playerId: p.id,
        userId: p.userId,
        username: p.username,
        side: p.side,
        connected: p.connected,
      })),
    },
  });
}

function setMatchState(next) {
  if (state.matchState === next) return;
  state.matchState = next;
  broadcast({ type: 'MATCH_EVENT', payload: { event: `MATCH_${next}` } });
}

function resetBall() {
  state.ball.x = 0;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vz = 0;
}

function maybeStartMatch() {
  const active = connectedPlayers().length;
  if (active === MAX_PLAYERS && state.matchState === 'WAITING') {
    state.readyUntil = Date.now() + READY_DURATION;
    setMatchState('READY');
  }
}

function maybeFinishMatch() {
  const active = connectedPlayers().length;
  if (active < MAX_PLAYERS && (state.matchState === 'READY' || state.matchState === 'IN_PROGRESS')) {
    setMatchState('WAITING');
    state.readyUntil = null;
    resetBall();
  }
}

function reclaimSlots() {
  const now = Date.now();
  for (const [id, p] of state.players.entries()) {
    if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > RECLAIM_MS) {
      state.players.delete(id);
    }
  }
}

function tick(dt) {
  state.tick += 1;
  reclaimSlots();

  const active = connectedPlayers();
  if (state.matchState === 'READY' && state.readyUntil && Date.now() >= state.readyUntil) {
    setMatchState('IN_PROGRESS');
    kickOffBall();
  }

  active.forEach((p) => {
    const dir = normalizeDir(p.input);
    p.x += dir.x * PLAYER.speed * dt;
    p.z += dir.z * PLAYER.speed * dt;
    clampPlayerToZone(p);
  });

  if (state.matchState === 'IN_PROGRESS') {
    applyMagnets(dt);
    state.ball.x += state.ball.vx * dt;
    state.ball.z += state.ball.vz * dt;
    connectedPlayers().forEach(collideWithPlayer);
    collideWalls();
    state.ball.vx *= BALL.damping;
    state.ball.vz *= BALL.damping;
    applyBallLimits();
  } else {
    resetBall();
  }
}

function snapshot() {
  const payload = {
    matchState: state.matchState,
    ball: { pos: { x: state.ball.x, z: state.ball.z }, vel: { x: state.ball.vx, z: state.ball.vz }, r: ARENA.ballRadius },
    players: connectedPlayers().map((p) => ({ playerId: p.id, side: p.side, pos: { x: p.x, z: p.z } })),
  };
  broadcast({ type: 'SNAPSHOT', t: state.tick, payload });
}

function sendWelcome(ws, player) {
  send(ws, {
    type: 'WELCOME',
    payload: {
      playerId: player.id,
      side: player.side,
      roomId: ROOM_ID,
      tickRate: TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      matchState: state.matchState,
      arena: { width: ARENA.width, height: ARENA.height, playerDepth: ARENA.playerDepth, ballRadius: ARENA.ballRadius },
    },
  });
}

function makeError(code, message) {
  return { type: 'ERROR', payload: { code, message } };
}

function handleHello(ws, payload) {
  const userId = payload?.userId ? String(payload.userId) : `guest-${nanoid(6)}`;
  const username = payload?.username?.slice?.(0, 32) || 'Player';
  const existing = [...state.players.values()].find((p) => p.userId === userId);
  const slotAvailable = connectedPlayers().length < MAX_PLAYERS || (existing && !existing.connected);

  if (!slotAvailable) {
    send(ws, makeError('ROOM_FULL', 'Room is full'));
    ws.close();
    return;
  }

  let player = existing;
  if (player && !player.connected) {
    player.connected = true;
    player.disconnectedAt = null;
    player.ws = ws;
  } else if (!player) {
    const side = assignSide();
    if (!side) {
      send(ws, makeError('ROOM_FULL', 'Room is full'));
      ws.close();
      return;
    }
    const pos = playerDefault(side);
    player = { id: nanoid(6), userId, username, side, x: pos.x, z: pos.z, input: {}, connected: true, ws, ping: null, lastInputAt: 0 };
    state.players.set(player.id, player);
  } else {
    send(ws, makeError('BAD_HELLO', 'Already connected'));
    ws.close();
    return;
  }

  sockets.set(ws, player.id);
  sendWelcome(ws, player);
  sendRoomState();
  maybeStartMatch();
}

function handleInput(ws, payload) {
  const id = sockets.get(ws);
  if (!id) return;
  const player = state.players.get(id);
  if (!player || !player.connected) return;
  const now = Date.now();
  if (now - player.lastInputAt < INPUT_INTERVAL_MS) return;
  player.lastInputAt = now;
  player.input = payload || {};
}

function handlePong(ws, payload) {
  const id = sockets.get(ws);
  if (!id) return;
  const player = state.players.get(id);
  if (!player) return;
  if (payload?.ts) {
    player.ping = Date.now() - payload.ts;
  }
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    send(ws, makeError('BAD_JSON', 'Invalid JSON'));
    return;
  }

  switch (msg.type) {
    case 'HELLO':
      handleHello(ws, msg.payload);
      break;
    case 'INPUT':
      handleInput(ws, msg.payload);
      break;
    case 'PONG':
      handlePong(ws, msg.payload);
      break;
    case 'DEBUG':
      if (msg.payload?.cmd === 'RESET_BALL') resetBall();
      break;
    default:
      send(ws, makeError('BAD_INPUT', 'Unknown message'));
  }
}

function disconnect(ws) {
  const id = sockets.get(ws);
  sockets.delete(ws);
  if (!id) return;
  const player = state.players.get(id);
  if (!player) return;
  player.connected = false;
  player.disconnectedAt = Date.now();
  player.ws = null;
  sendRoomState();
  maybeFinishMatch();
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

console.log(`WS server listening on :${PORT}`);

let lastTick = Date.now();
let lastSnapshot = Date.now();
let pingCounter = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  tick(dt);
  maybeFinishMatch();

  if (now - lastSnapshot >= SNAPSHOT_INTERVAL) {
    lastSnapshot = now;
    snapshot();
  }

  // heartbeat ping
  if (wss.clients.size > 0 && pingCounter % 120 === 0) {
    const pingId = Date.now();
    broadcast({ type: 'PING', payload: { pingId, ts: pingId } });
  }
  pingCounter += 1;
}, 1000 / TICK_RATE);
