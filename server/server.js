import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pkg from './package.json' assert { type: 'json' };
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

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const AUTH_GRACE_SEC = parseInt(process.env.AUTH_GRACE_SEC || '86400', 10); // 24h by default
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const ALLOW_DEBUG = process.env.ALLOW_DEBUG === 'true';
const ROOM_TIMEOUT_MS = parseInt(process.env.ROOM_TIMEOUT_MS || '0', 10); // 0 = disable
const SCORE_TO_WIN = parseInt(process.env.SCORE_TO_WIN || '0', 10); // 0 = disable scoring
const FINISHED_RESET_MS = parseInt(process.env.FINISHED_RESET_MS || '5000', 10); // auto reset to WAITING after finish
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
  score: { top: 0, right: 0, bottom: 0, left: 0 },
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

const metrics = {
  startedAt: Date.now(),
  connectionsTotal: 0,
  messagesTotal: 0,
  rateLimitHits: 0,
  badAuth: 0,
  roomFull: 0,
};
const METRICS_INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '60000', 10);

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
    scorePoint('top');
  } else if (state.ball.z > maxZ) {
    state.ball.z = maxZ;
    state.ball.vz = -Math.abs(state.ball.vz) * BALL.restitutionWall;
    hit = true;
    scorePoint('bottom');
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

function scorePoint(side) {
  if (!SCORE_TO_WIN) return;
  if (!state.score[side]) state.score[side] = 0;
  state.score[side] += 1;
  broadcast({ type: 'SCORE', payload: { side, score: state.score } });
  if (state.score[side] >= SCORE_TO_WIN) {
    setMatchState('FINISHED', `WIN_${side.toUpperCase()}`);
    resetBall();
  } else {
    resetBall();
    setMatchState('READY', 'SCORE');
    state.readyUntil = Date.now() + READY_DURATION;
  }
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

function setMatchState(next, reason = null) {
  if (state.matchState === next) return;
  state.matchState = next;
  state.matchReason = reason;
  if (next === 'IN_PROGRESS') roomStartedAt = Date.now();
  if (next === 'FINISHED') state.finishedAt = Date.now();
  if (next === 'WAITING') state.finishedAt = null;
  broadcast({ type: 'MATCH_EVENT', payload: { event: `MATCH_${next}`, reason: state.matchReason } });
  if (next === 'FINISHED') resetBall();
}

function resetBall() {
  state.ball.x = 0;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vz = 0;
}

function resetScore() {
  state.score = { top: 0, right: 0, bottom: 0, left: 0 };
}

function maybeStartMatch() {
  const active = connectedPlayers().length;
  if (active === MAX_PLAYERS && (state.matchState === 'WAITING' || state.matchState === 'FINISHED')) {
    resetScore();
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
  const q = (v) => Math.round(v * 1000) / 1000;
  const ts = Date.now();
  const payload = {
    matchState: state.matchState,
    matchReason: state.matchReason,
    ball: { pos: { x: q(state.ball.x), z: q(state.ball.z) }, r: ARENA.ballRadius },
    players: connectedPlayers().map((p) => ({ playerId: p.id, side: p.side, pos: { x: q(p.x), z: q(p.z) } })),
    score: state.score,
  };
  if (state.tick % CONFIG_EVERY_TICKS === 0) {
    payload.config = {
      arena: ARENA,
      physics: { BALL, PLAYER, MAGNETS: MAGNETS_ENABLED ? MAGNETS : [] },
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
        magnets: MAGNETS_ENABLED ? MAGNETS : [],
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
  if (!BOT_TOKEN) return { ok: !REQUIRE_AUTH, reason: 'NO_BOT_TOKEN' };
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
    case 'DEBUG':
      if (!ALLOW_DEBUG) return;
      if (!meta.get(ws)?.handshaked) return;
      if (msg.payload?.cmd === 'RESET_BALL') resetBall();
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

  if (FINISHED_RESET_MS > 0 && state.matchState === 'FINISHED' && state.finishedAt) {
    if (now - state.finishedAt > FINISHED_RESET_MS) {
      state.readyUntil = null;
      resetScore();
      setMatchState('WAITING', 'RESET');
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
