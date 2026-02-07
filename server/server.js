import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import crypto from 'crypto';

const PORT = process.env.PORT || 7071;
const ROOM_ID = 'default';
const MAX_PLAYERS = 4;
const TICK_RATE = 60;
const SNAPSHOT_RATE = 30;
const SNAPSHOT_INTERVAL = 1000 / SNAPSHOT_RATE;
const READY_DURATION = 2000;
const RECLAIM_MS = 15000;
const INPUT_INTERVAL_MS = 33; // ~30 Hz
const MAX_MSG_PER_SEC = 120;
const CONFIG_EVERY_TICKS = 120; // send config in snapshot every ~2s at 60Hz
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP || '8', 10);
const CONN_WINDOW_MS = parseInt(process.env.CONN_WINDOW_MS || '10000', 10);

const ARENA = { width: 12, height: 8, playerDepth: 0.6, ballRadius: 0.5 };
const PLAYER = { speed: 6, collider: { x: 2.5, z: 0.9 } };
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
  top: { x: [-6, 6], z: [-4, -1.5] },
  bottom: { x: [-6, 6], z: [1.5, 4] },
  left: { x: [-6, -3], z: [-4, 4] },
  right: { x: [3, 6], z: [-4, 4] },
};
const SIDE_ANCHOR = {
  top: () => ({ z: (SIDE_ZONES.top.z[0] + SIDE_ZONES.top.z[1]) / 2 }),
  bottom: () => ({ z: (SIDE_ZONES.bottom.z[0] + SIDE_ZONES.bottom.z[1]) / 2 }),
  left: () => ({ x: (SIDE_ZONES.left.x[0] + SIDE_ZONES.left.x[1]) / 2 }),
  right: () => ({ x: (SIDE_ZONES.right.x[0] + SIDE_ZONES.right.x[1]) / 2 }),
};

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const AUTH_GRACE_SEC = parseInt(process.env.AUTH_GRACE_SEC || '86400', 10); // 24h by default
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const ROOM_TIMEOUT_MS = parseInt(process.env.ROOM_TIMEOUT_MS || '0', 10); // 0 = disable
const HIT_COOLDOWN_MS = parseInt(process.env.HIT_COOLDOWN_MS || '100', 10);
const MAX_USERNAME = 32;
const MAX_USERID = 64;

const state = {
  players: new Map(), // id -> {id,userId,username,side,x,z,input,lastInputAt,ws,connected,disconnectedAt,ping}
  tick: 0,
  matchState: 'WAITING',
  matchReason: null,
  finishedAt: null,
  readyUntil: null,
  ball: { x: 0, z: 0, vx: 0, vz: 0 },
  lastSnapshotAt: 0,
};

const sockets = new Map(); // ws -> playerId
const meta = new Map(); // ws -> { handshaked: bool, ip }
const rate = new Map(); // ws -> { count, ts }
const connRate = new Map(); // ip -> { count, ts }
const MAX_PAYLOAD = parseInt(process.env.MAX_PAYLOAD || '4096', 10);
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    const payload = {
      status: 'ok',
      uptime_sec: Math.round((Date.now() - metrics.startedAt) / 1000),
      players: connectedPlayers().length,
      tick: state.tick,
      metrics,
      version: pkg.version,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });
httpServer.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const metrics = {
  startedAt: Date.now(),
  connectionsTotal: 0,
  messagesTotal: 0,
  rateLimitHits: 0,
  badAuth: 0,
  roomFull: 0,
};
const METRICS_INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '60000', 10);

function ensureFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function ensureFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function playerDefault(side) {
  const zone = SIDE_ZONES[side] || { x: [0, 0], z: [0, 0] };
  const base = {
    x: (zone.x[0] + zone.x[1]) / 2,
    z: (zone.z[0] + zone.z[1]) / 2,
  };
  const anchor = SIDE_ANCHOR[side]?.();
  return {
    x: anchor?.x ?? base.x,
    z: anchor?.z ?? base.z,
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
  const anchor = SIDE_ANCHOR[player.side]?.();
  if (anchor?.x != null) player.x = anchor.x;
  if (anchor?.z != null) player.z = anchor.z;
}

function enforcePlayerBounds() {
  state.players.forEach((p) => clampPlayerToZone(p));
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
  // spawn from one of four side platforms, shoot toward center
  const spawnPoints = [
    { x: 0, z: -ARENA.height / 2 - 0.2 },
    { x: 0, z: ARENA.height / 2 + 0.2 },
    { x: -ARENA.width / 2 - 0.2, z: 0 },
    { x: ARENA.width / 2 + 0.2, z: 0 },
  ];
  const origin = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
  state.ball.x = ensureFinite(origin.x, 0);
  state.ball.z = ensureFinite(origin.z, 0);
  const dirX = -origin.x;
  const dirZ = -origin.z;
  const len = Math.hypot(dirX, dirZ) || 1;
  state.ball.vx = ensureFinite((dirX / len) * BALL.baseSpeed, 0);
  state.ball.vz = ensureFinite((dirZ / len) * BALL.baseSpeed, 0);
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
  const now = Date.now();
  if (player.lastHitAt && now - player.lastHitAt < HIT_COOLDOWN_MS) return;
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
  player.lastHitAt = now;
}

function applyBallLimits() {
  state.ball.vx = ensureFinite(state.ball.vx, 0);
  state.ball.vz = ensureFinite(state.ball.vz, 0);
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

function setMatchState(next, reason = null) {
  if (state.matchState === next) return;
  state.matchState = next;
  state.matchReason = reason;
  if (next === 'IN_PROGRESS') roomStartedAt = Date.now();
  if (next === 'FINISHED') state.finishedAt = Date.now();
  if (next === 'WAITING') state.finishedAt = null;
  broadcast({ type: 'MATCH_EVENT', payload: { event: `MATCH_${next}`, reason: state.matchReason } });
  if (next === 'FINISHED') resetBall();
  if (next === 'READY') {
    resetBall();
    resetPlayersPositions();
  }
  if (next === 'WAITING') {
    resetBall();
    resetPlayersPositions();
  }
}

function resetBall() {
  state.ball.x = 0;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vz = 0;
}

function resetPlayersPositions() {
  state.players.forEach((p) => {
    const pos = playerDefault(p.side);
    p.x = pos.x;
    p.z = pos.z;
    p.input = {};
    p.lastHitAt = 0;
  });
}

function maybeStartMatch() {
  const active = connectedPlayers().length;
  if (active === MAX_PLAYERS && (state.matchState === 'WAITING' || state.matchState === 'FINISHED')) {
    state.readyUntil = Date.now() + READY_DURATION;
    setMatchState('READY');
  }
}

function maybeFinishMatch() {
  const active = connectedPlayers().length;
  if (active < MAX_PLAYERS && (state.matchState === 'READY' || state.matchState === 'IN_PROGRESS')) {
    setMatchState(active === 0 ? 'WAITING' : 'FINISHED', active === 0 ? 'EMPTY' : 'PLAYER_LEFT');
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
    setMatchState('IN_PROGRESS', 'ALL_READY');
    kickOffBall();
  }

  active.forEach((p) => {
    const dir = normalizeDir(p.input);
    if (p.side === 'top' || p.side === 'bottom') {
      p.x = ensureFinite(p.x + dir.x * PLAYER.speed * dt, p.x);
    } else if (p.side === 'left' || p.side === 'right') {
      p.z = ensureFinite(p.z + dir.z * PLAYER.speed * dt, p.z);
    }
    clampPlayerToZone(p);
  });
  enforcePlayerBounds();

  if (state.matchState === 'IN_PROGRESS') {
    state.ball.x = ensureFinite(state.ball.x + state.ball.vx * dt, 0);
    state.ball.z = ensureFinite(state.ball.z + state.ball.vz * dt, 0);
    connectedPlayers().forEach(collideWithPlayer);
    collideWalls();
    state.ball.vx = ensureFinite(state.ball.vx * BALL.damping, 0);
    state.ball.vz = ensureFinite(state.ball.vz * BALL.damping, 0);
    applyBallLimits();
  } else {
    resetBall();
  }
}

function snapshot() {
  const q = (v) => Math.round(v * 1000) / 1000;
  const ts = Date.now();
  const payload = {
    matchState: state.matchState,
    matchReason: state.matchReason,
    ball: { pos: { x: q(ensureFinite(state.ball.x, 0)), z: q(ensureFinite(state.ball.z, 0)) }, r: ARENA.ballRadius },
    players: connectedPlayers().map((p) => ({
      playerId: p.id,
      side: p.side,
      pos: { x: q(ensureFinite(p.x, 0)), z: q(ensureFinite(p.z, 0)) },
    })),
  };
  if (state.tick % CONFIG_EVERY_TICKS === 0) {
    payload.config = {
      arena: ARENA,
      physics: { BALL, PLAYER },
      roomTimeoutMs: ROOM_TIMEOUT_MS,
    };
  }
  broadcast({ type: 'SNAPSHOT', t: state.tick, ts, payload });
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
      physics: {
        ball: BALL,
        player: PLAYER,
      },
    },
  });
}

function makeError(code, message) {
  return { type: 'ERROR', payload: { code, message } };
}

function sanitizeHelloPayload(payload) {
  if (payload == null || typeof payload !== 'object') return { ok: false, reason: 'BAD_PAYLOAD' };
  const userIdRaw = payload.userId != null ? String(payload.userId) : null;
  const usernameRaw = payload.username != null ? String(payload.username) : null;
  if (userIdRaw && userIdRaw.length > MAX_USERID) return { ok: false, reason: 'USERID_TOO_LONG' };
  if (usernameRaw && usernameRaw.length > MAX_USERNAME) return { ok: false, reason: 'USERNAME_TOO_LONG' };
  return {
    ok: true,
    userId: userIdRaw,
    username: usernameRaw,
    initData: payload.initData,
  };
}

function sanitizeInputPayload(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  return {
    forward: !!payload.forward,
    back: !!payload.back,
    left: !!payload.left,
    right: !!payload.right,
  };
}

function verifyTelegramInitData(initDataRaw) {
  if (!BOT_TOKEN) {
    return { ok: !REQUIRE_AUTH, reason: 'NO_BOT_TOKEN' };
  }
  if (!initDataRaw) return { ok: false, reason: 'MISSING_INITDATA' };
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'NO_HASH' };
    params.delete('hash');
    const pairs = [];
    params.forEach((value, key) => {
      pairs.push(`${key}=${value}`);
    });
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (hmac !== hash) return { ok: false, reason: 'BAD_HASH' };
    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && (Date.now() / 1000 - authDate > AUTH_GRACE_SEC)) return { ok: false, reason: 'STALE_AUTH' };
    const userRaw = params.get('user');
    const user = userRaw ? JSON.parse(userRaw) : null;
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: 'PARSE_ERROR' };
  }
}

function handleHello(ws, payload) {
  const cleaned = sanitizeHelloPayload(payload);
  if (!cleaned.ok) {
    send(ws, makeError('BAD_HELLO', cleaned.reason));
    ws.close();
    return;
  }

  const initDataRaw = cleaned.initData;
  const auth = verifyTelegramInitData(initDataRaw);
  if (!auth.ok) {
    metrics.badAuth += 1;
    send(ws, makeError('BAD_AUTH', auth.reason || 'Auth failed'));
    ws.close();
    return;
  }

  const tgUser = auth.user;
  // Enforce auth when required: if REQUIRE_AUTH=true but auth.user missing, deny.
  if (REQUIRE_AUTH && !tgUser) {
    metrics.badAuth += 1;
    send(ws, makeError('BAD_AUTH', auth.reason || 'Missing Telegram user'));
    ws.close();
    return;
  }

  const userId = tgUser?.id ? String(tgUser.id) : (cleaned.userId || `guest-${nanoid(6)}`);
  const username = tgUser?.username || (cleaned.username || 'Player').slice(0, MAX_USERNAME);
  const existing = [...state.players.values()].find((p) => p.userId === userId);
  const slotAvailable = connectedPlayers().length < MAX_PLAYERS || (existing && !existing.connected);

  if (!slotAvailable) {
    metrics.roomFull += 1;
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
    player = { id: nanoid(6), userId, username, side, x: pos.x, z: pos.z, input: {}, connected: true, ws, ping: null, lastInputAt: 0, lastHitAt: 0 };
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
  if (state.matchState !== 'READY' && state.matchState !== 'IN_PROGRESS') return;
  const now = Date.now();
  if (now - player.lastInputAt < INPUT_INTERVAL_MS) return;
  player.lastInputAt = now;
  const input = sanitizeInputPayload(payload);
  if (!input) return;
  player.input = input;
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
  metrics.messagesTotal += 1;
  const now = Date.now();
  const bucket = rate.get(ws) || { count: 0, ts: now };
  if (now - bucket.ts >= 1000) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  rate.set(ws, bucket);
  if (bucket.count > MAX_MSG_PER_SEC) {
    metrics.rateLimitHits += 1;
    send(ws, makeError('RATE_LIMIT', 'Too many messages'));
    return;
  }

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
      meta.set(ws, { handshaked: true });
      break;
    case 'INPUT':
      if (!meta.get(ws)?.handshaked) {
        send(ws, makeError('BAD_ORDER', 'Send HELLO first'));
        ws.close();
        return;
      }
      handleInput(ws, msg.payload);
      break;
    case 'PONG':
      if (!meta.get(ws)?.handshaked) return;
      handlePong(ws, msg.payload);
      break;
    default:
      send(ws, makeError('BAD_INPUT', 'Unknown message'));
  }
}

function disconnect(ws) {
  const id = sockets.get(ws);
  sockets.delete(ws);
  meta.delete(ws);
  if (!id) return;
  const player = state.players.get(id);
  if (!player) return;
  player.connected = false;
  player.disconnectedAt = Date.now();
  player.ws = null;
  sendRoomState();
  maybeFinishMatch();
}

wss.on('connection', (ws, req) => {
  const ip = req?.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = connRate.get(ip) || { count: 0, ts: now };
  if (now - bucket.ts > CONN_WINDOW_MS) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  connRate.set(ip, bucket);
  if (bucket.count > MAX_CONN_PER_IP) {
    send(ws, makeError('RATE_CONN', 'Too many connections from IP'));
    ws.close();
    return;
  }

  metrics.connectionsTotal += 1;
  meta.set(ws, { handshaked: false, ip });
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

console.log(`WS server listening on :${PORT}`);

let lastTick = Date.now();
let lastSnapshot = Date.now();
let pingCounter = 0;
let roomStartedAt = Date.now();

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

  if (ROOM_TIMEOUT_MS > 0 && state.matchState === 'IN_PROGRESS') {
    if (now - roomStartedAt > ROOM_TIMEOUT_MS) {
      setMatchState('FINISHED', 'TIMEOUT');
      resetBall();
    }
  }

}, 1000 / TICK_RATE);

if (METRICS_INTERVAL_MS > 0) {
  setInterval(() => {
    const uptime = Math.round((Date.now() - metrics.startedAt) / 1000);
    const payload = {
      version: pkg.version,
      uptime,
      conns: metrics.connectionsTotal,
      msgs: metrics.messagesTotal,
      rateHits: metrics.rateLimitHits,
      badAuth: metrics.badAuth,
      roomFull: metrics.roomFull,
      players: connectedPlayers().length,
      matchState: state.matchState,
      tick: state.tick,
    };
    console.log('[metrics]', JSON.stringify(payload));
  }, METRICS_INTERVAL_MS);
}
