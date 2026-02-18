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
// Collider approximates the (boat+character) footprint in our game units.
// Important: this also affects clamp-to-lane, so keep it large enough that boats never clip outside.
// NOTE: `collider.x` is paddle width (along its movement axis). `collider.z` is paddle depth (toward/away from wall).
const PLAYER = { speed: 6, collider: { x: 3.0, z: 2.2 } };
// Extra safety inset from the arena walls (visual meshes can extend beyond the collider).
// Increase if boats still appear to clip outside the rink.
const PLAYER_WALL_MARGIN = parseFloat(process.env.PLAYER_WALL_MARGIN || '0.25');
// Small separation to prevent jitter when resolving overlaps.
const PLAYER_PLAYER_EPS = parseFloat(process.env.PLAYER_PLAYER_EPS || '0.02');
// Small separation to prevent jitter when clamping against arena obstacles (corner posts/tubes).
const PLAYER_POST_EPS = parseFloat(process.env.PLAYER_POST_EPS || String(PLAYER_PLAYER_EPS));
// Arcade MVP ball:
// - Receives a small kickoff impulse when the match starts.
// - Keeps moving (no passive damping to zero).
// - Direction changes only on collisions (walls/posts/players).
// Fast arcade defaults (can be overridden via env).
// Intentionally ignore legacy `BALL_SPEED` alias so old env values don't silently slow down gameplay.
// Safety floors ensure old/slow env configs cannot degrade arcade pace.
const BALL_START_SPEED = Math.max(15.0, ensureFinite(parseFloat(process.env.BALL_START_SPEED || '15.0'), 15.0));
const BALL_MIN_SPEED = Math.max(13.0, ensureFinite(parseFloat(process.env.BALL_MIN_SPEED || '13.0'), 13.0));
const BALL_HIT_SPEED = Math.max(18.0, ensureFinite(parseFloat(process.env.BALL_HIT_SPEED || '18.0'), 18.0));
const BALL_MAX_SPEED = Math.max(26.0, ensureFinite(parseFloat(process.env.BALL_MAX_SPEED || '26.0'), 26.0));
const BALL_DAMPING = Math.max(0.999, ensureFinite(parseFloat(process.env.BALL_DAMPING || '1.0'), 1.0)); // 0..1 (1 = no damping)
const BALL_HIT_BOOST = Math.max(1.25, ensureFinite(parseFloat(process.env.BALL_HIT_BOOST || '1.25'), 1.25)); // per-player hit multiplier (clamped by BALL_MAX_SPEED)
const BALL_MOVE_INFLUENCE = ensureFinite(parseFloat(process.env.BALL_MOVE_INFLUENCE || '0.75'), 0.75);
const BALL_TANGENT_INFLUENCE = ensureFinite(parseFloat(process.env.BALL_TANGENT_INFLUENCE || '0.45'), 0.45);
const BALL_REST_EPS = ensureFinite(parseFloat(process.env.BALL_REST_EPS || '0.05'), 0.05); // treat ball as "resting" below this speed
const BALL_STUCK_MS = parseInt(process.env.BALL_STUCK_MS || '200', 10);
const BALL_STUCK_DIST_EPS = ensureFinite(parseFloat(process.env.BALL_STUCK_DIST_EPS || '0.0005'), 0.0005);
const BALL = {
  // Walls reflect, player hits can add energy.
  minSpeed: BALL_MIN_SPEED,
  hitSpeed: BALL_HIT_SPEED,
  // Legacy alias: older clients/tools expected `baseSpeed` for constant-speed mode.
  baseSpeed: BALL_HIT_SPEED,
  maxSpeed: BALL_MAX_SPEED,
  damping: BALL_DAMPING,
  restitutionWall: parseFloat(process.env.BALL_RESTITUTION_WALL || '1'),
  restitutionPlayer: parseFloat(process.env.BALL_RESTITUTION_PLAYER || '1'),
  // How much a moving paddle affects outgoing direction.
  playerInfluence: parseFloat(process.env.BALL_PLAYER_INFLUENCE || '0.5'),
};
const MIN_REFLECTION_ANGLE = 0.24;
const KICKOFF_CORNER_MARGIN = 0.02;
const RING_EPSILON = 1e-4;
// Arena plays like a rectangular rink (Crash Bash Ballistix-style).
// Default to AABB + CCD to support corner tube spawns and prevent tunneling.
const RING_COLLIDER = (process.env.RING_COLLIDER || 'aabb').toLowerCase(); // aabb|ellipse
// Corner posts/tubes (bumper colliders) placed at BallSpawn_* positions from the arena GLB.
// If your arena has no such posts, set this to 0.
const CORNER_POST_RADIUS = parseFloat(process.env.CORNER_POST_RADIUS || process.env.TUBE_RADIUS || '0.9');
const BALL_SPAWN_POINTS_ENV = process.env.BALL_SPAWN_POINTS || process.env.BALL_SPAWNS || null; // JSON: [{x,z},...]
const BALL_SPAWN_POINTS_FILE = process.env.BALL_SPAWN_POINTS_FILE || 'ball_spawns.json';

const SIDE_ORDER = ['top', 'right', 'bottom', 'left'];
// Players are constrained to their side "lane" computed from arena and collider sizes.

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const AUTH_GRACE_SEC = parseInt(process.env.AUTH_GRACE_SEC || '86400', 10); // 24h by default
// Temporary/dev override to allow testing in a normal browser (no Telegram initData).
// To enable strict Telegram auth again, set:
//   DISABLE_TELEGRAM_AUTH=false
//   REQUIRE_AUTH=true
const DISABLE_TELEGRAM_AUTH = process.env.DISABLE_TELEGRAM_AUTH === 'true';
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true' && !DISABLE_TELEGRAM_AUTH;
// PvP-only MVP: bots are hard-disabled regardless of env.
const FILL_BOTS = false;
const BOT_AI = false;
const BOT_DEADZONE = parseFloat(process.env.BOT_DEADZONE || '0.25');
const ROOM_TIMEOUT_MS = parseInt(process.env.ROOM_TIMEOUT_MS || '0', 10); // 0 = disable
const HIT_COOLDOWN_MS = parseInt(process.env.HIT_COOLDOWN_MS || '90', 10);
const MAX_USERNAME = 32;
const MAX_USERID = 64;

const state = {
  players: new Map(), // id -> {id,userId,username,side,x,z,input,lastInputAt,ws,connected,disconnectedAt,ping}
  tick: 0,
  matchState: 'WAITING',
  matchReason: null,
  finishedAt: null,
  readyUntil: null,
  // `lastMoveAt/lastX/lastZ` are server-side guardrails to prevent the ball from "freezing" due to numerical
  // edge cases. They are not part of the network protocol.
  ball: { x: 0, z: 0, vx: 0, vz: 0, launchAt: null, pendingVx: 0, pendingVz: 0, spawnIdx: 0, lastMoveAt: 0, lastX: 0, lastZ: 0 },
  lastSnapshotAt: 0,
};
let cachedBallSpawnPoints = null;
let cachedCornerPosts = null;

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeBallField() {
  // Ball travel bounds. Defaults to the full arena (Crash Bash Ballistix-style).
  // If you ever need to shrink the ball field without touching player lanes (rare), set:
  //   BALL_FIELD_MARGIN=0.1   (game units, applied on all sides)
  const margin = parseFloat(process.env.BALL_FIELD_MARGIN || '0');
  const m = Number.isFinite(margin) && margin > 0 ? margin : 0;
  const halfW = (ARENA.width / 2) - m;
  const halfH = (ARENA.height / 2) - m;

  // Must be large enough to contain a ball at all; otherwise fall back to the full arena.
  const r = ARENA.ballRadius;
  const minHalf = Math.max(r + 0.05, 0.2);
  const safeHalfW = Number.isFinite(halfW) && halfW > minHalf ? halfW : (ARENA.width / 2);
  const safeHalfH = Number.isFinite(halfH) && halfH > minHalf ? halfH : (ARENA.height / 2);
  return { width: safeHalfW * 2, height: safeHalfH * 2 };
}

const FIELD = computeBallField();

function playerDefault(side) {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const laneInset = (PLAYER.collider?.z ?? ARENA.playerDepth ?? 0.6) * 0.5 + PLAYER_WALL_MARGIN;
  switch (side) {
    case 'top':
      return { x: 0, z: -halfH + laneInset };
    case 'bottom':
      return { x: 0, z: halfH - laneInset };
    case 'left':
      return { x: -halfW + laneInset, z: 0 };
    case 'right':
      return { x: halfW - laneInset, z: 0 };
    default:
      return { x: 0, z: 0 };
  }
}

function assignSide() {
  const used = new Set([...state.players.values()].map((p) => p.side));
  for (const side of SIDE_ORDER) {
    if (!used.has(side)) return side;
  }
  return null;
}

function clampPlayerToZone(player) {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const halfWidth = (PLAYER.collider?.x ?? 2.5) * 0.5;
  const laneInset = (PLAYER.collider?.z ?? ARENA.playerDepth ?? 0.6) * 0.5 + PLAYER_WALL_MARGIN;

  if (player.side === 'top' || player.side === 'bottom') {
    player.x = clamp(player.x, -halfW + halfWidth, halfW - halfWidth);
    player.z = player.side === 'top' ? (-halfH + laneInset) : (halfH - laneInset);
    return;
  }
  if (player.side === 'left' || player.side === 'right') {
    player.z = clamp(player.z, -halfH + halfWidth, halfH - halfWidth);
    player.x = player.side === 'left' ? (-halfW + laneInset) : (halfW - laneInset);
  }
}

function enforcePlayerBounds() {
  state.players.forEach((p) => clampPlayerToZone(p));
}

function sideAllowsX(side) {
  return side === 'top' || side === 'bottom';
}

function sideAllowsZ(side) {
  return side === 'left' || side === 'right';
}

function playerHalfExtentsForSide(side) {
  const w = PLAYER.collider?.x ?? 2.5; // along movement axis
  const d = PLAYER.collider?.z ?? ARENA.playerDepth ?? 0.6; // toward/away from wall
  if (side === 'left' || side === 'right') {
    // Left/right paddles move along Z, so width is on Z axis; depth is on X axis.
    return { hx: d * 0.5, hz: w * 0.5 };
  }
  // Top/bottom paddles move along X, so width is on X axis; depth is on Z axis.
  return { hx: w * 0.5, hz: d * 0.5 };
}

function pushSignTowardCenterX(x) {
  if (x > 1e-6) return -1;
  if (x < -1e-6) return 1;
  return 1;
}

function pushSignTowardCenterZ(z) {
  if (z > 1e-6) return -1;
  if (z < -1e-6) return 1;
  return 1;
}

function resolvePlayerCollisions() {
  const players = connectedPlayers();
  if (players.length < 2) return;

  // Few iterations are enough for 4 players to resolve corner overlaps.
  for (let iter = 0; iter < 3; iter += 1) {
    let any = false;

    for (let i = 0; i < players.length; i += 1) {
      const a = players[i];
      const aExt = playerHalfExtentsForSide(a.side);
      for (let j = i + 1; j < players.length; j += 1) {
        const b = players[j];
        const bExt = playerHalfExtentsForSide(b.side);

        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const overlapX = (aExt.hx + bExt.hx) - Math.abs(dx);
        const overlapZ = (aExt.hz + bExt.hz) - Math.abs(dz);
        if (overlapX <= 0 || overlapZ <= 0) continue;
        any = true;

        const aCanX = sideAllowsX(a.side);
        const bCanX = sideAllowsX(b.side);
        const aCanZ = sideAllowsZ(a.side);
        const bCanZ = sideAllowsZ(b.side);

        // Prefer resolving on the axis with smaller penetration, but only if someone can move there.
        let axis = overlapX < overlapZ ? 'x' : 'z';
        if (axis === 'x' && !aCanX && !bCanX) axis = 'z';
        if (axis === 'z' && !aCanZ && !bCanZ) axis = 'x';

        if (axis === 'x') {
          const push = overlapX + PLAYER_PLAYER_EPS;
          if (aCanX && bCanX) {
            const dir = dx !== 0 ? Math.sign(dx) : (a.id < b.id ? 1 : -1);
            a.x += dir * push * 0.5;
            b.x -= dir * push * 0.5;
            clampPlayerToZone(a);
            clampPlayerToZone(b);
          } else if (aCanX) {
            const dir = dx !== 0 ? Math.sign(dx) : pushSignTowardCenterX(a.x);
            a.x += dir * push;
            clampPlayerToZone(a);
          } else if (bCanX) {
            const dir = dx !== 0 ? -Math.sign(dx) : pushSignTowardCenterX(b.x);
            b.x += dir * push;
            clampPlayerToZone(b);
          }
        } else {
          const push = overlapZ + PLAYER_PLAYER_EPS;
          if (aCanZ && bCanZ) {
            const dir = dz !== 0 ? Math.sign(dz) : (a.id < b.id ? 1 : -1);
            a.z += dir * push * 0.5;
            b.z -= dir * push * 0.5;
            clampPlayerToZone(a);
            clampPlayerToZone(b);
          } else if (aCanZ) {
            const dir = dz !== 0 ? Math.sign(dz) : pushSignTowardCenterZ(a.z);
            a.z += dir * push;
            clampPlayerToZone(a);
          } else if (bCanZ) {
            const dir = dz !== 0 ? -Math.sign(dz) : pushSignTowardCenterZ(b.z);
            b.z += dir * push;
            clampPlayerToZone(b);
          }
        }
      }
    }

    if (!any) break;
  }
}

function resolvePlayerPostCollisions(prevPosById = null) {
  const postR = Number.isFinite(CORNER_POST_RADIUS) ? CORNER_POST_RADIUS : 0;
  if (!(postR > 0.001)) return;
  const posts = getCornerPosts();
  if (!posts.length) return;

  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const players = connectedPlayers();
  if (!players.length) return;

  // Few iterations to settle if a player is wedged between a post and the wall bounds.
  for (let iter = 0; iter < 2; iter += 1) {
    for (const p of players) {
      const ext = playerHalfExtentsForSide(p.side);
      const prev = prevPosById ? prevPosById.get(p.id) : null;

      if (sideAllowsX(p.side)) {
        const minX = -halfW + ext.hx;
        const maxX = halfW - ext.hx;
        const rectMinZ = p.z - ext.hz;
        const rectMaxZ = p.z + ext.hz;

        for (const post of posts) {
          const cx = ensureFinite(post?.x, null);
          const cz = ensureFinite(post?.z, null);
          if (cx == null || cz == null) continue;

          // Compute distance from post center to the player's rect on the fixed Z axis.
          let dz = 0;
          if (cz < rectMinZ) dz = rectMinZ - cz;
          else if (cz > rectMaxZ) dz = cz - rectMaxZ;
          if (dz >= postR) continue;

          const dxMax = Math.sqrt(Math.max(0, postR * postR - dz * dz));
          const forbiddenHalf = ext.hx + dxMax;
          if (!(Math.abs(p.x - cx) < forbiddenHalf)) continue;

          const prevX = prev ? prev.x : p.x;
          const leftCandidate = cx - forbiddenHalf - PLAYER_POST_EPS;
          const rightCandidate = cx + forbiddenHalf + PLAYER_POST_EPS;

          // Prefer keeping the player on the same side of the obstacle they were previously on.
          const preferLeft = prevX < cx;
          let candidate = preferLeft ? leftCandidate : rightCandidate;

          // If that side is not feasible due to arena bounds, snap to the other side.
          if (candidate < minX || candidate > maxX) {
            candidate = preferLeft ? rightCandidate : leftCandidate;
          }

          p.x = clamp(candidate, minX, maxX);
        }

        clampPlayerToZone(p);
        continue;
      }

      if (sideAllowsZ(p.side)) {
        const minZ = -halfH + ext.hz;
        const maxZ = halfH - ext.hz;
        const rectMinX = p.x - ext.hx;
        const rectMaxX = p.x + ext.hx;

        for (const post of posts) {
          const cx = ensureFinite(post?.x, null);
          const cz = ensureFinite(post?.z, null);
          if (cx == null || cz == null) continue;

          let dx = 0;
          if (cx < rectMinX) dx = rectMinX - cx;
          else if (cx > rectMaxX) dx = cx - rectMaxX;
          if (dx >= postR) continue;

          const dzMax = Math.sqrt(Math.max(0, postR * postR - dx * dx));
          const forbiddenHalf = ext.hz + dzMax;
          if (!(Math.abs(p.z - cz) < forbiddenHalf)) continue;

          const prevZ = prev ? prev.z : p.z;
          const lowCandidate = cz - forbiddenHalf - PLAYER_POST_EPS;
          const highCandidate = cz + forbiddenHalf + PLAYER_POST_EPS;

          const preferLow = prevZ < cz;
          let candidate = preferLow ? lowCandidate : highCandidate;
          if (candidate < minZ || candidate > maxZ) {
            candidate = preferLow ? highCandidate : lowCandidate;
          }

          p.z = clamp(candidate, minZ, maxZ);
        }

        clampPlayerToZone(p);
      }
    }
  }
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

function enforceMinAngle() {
  const speed = Math.hypot(state.ball.vx, state.ball.vz);
  if (speed < 1e-5) return;
  let dx = state.ball.vx / speed;
  let dz = state.ball.vz / speed;
  if (Math.abs(dx) < MIN_REFLECTION_ANGLE) dx = Math.sign(dx || 1) * MIN_REFLECTION_ANGLE;
  if (Math.abs(dz) < MIN_REFLECTION_ANGLE) dz = Math.sign(dz || 1) * MIN_REFLECTION_ANGLE;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  state.ball.vx = dx * speed;
  state.ball.vz = dz * speed;
}

function fallbackBallSpawnPoints() {
  // Safe default: 4 points near corners inside the rink collider.
  const halfW = (FIELD?.width ?? ARENA.width) / 2;
  const halfH = (FIELD?.height ?? ARENA.height) / 2;
  const spawnX = halfW - ARENA.ballRadius - KICKOFF_CORNER_MARGIN;
  const spawnZ = halfH - ARENA.ballRadius - KICKOFF_CORNER_MARGIN;
  const points = [
    { x: -spawnX, z: -spawnZ },
    { x: spawnX, z: -spawnZ },
    { x: spawnX, z: spawnZ },
    { x: -spawnX, z: spawnZ },
  ];
  // Default "forward" points inward, toward arena center.
  return points.map((p) => {
    const dx = -p.x;
    const dz = -p.z;
    const len = Math.hypot(dx, dz) || 1;
    return { ...p, fx: dx / len, fz: dz / len };
  });
}

function parseBallSpawnPoints(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const points = [];
    for (const item of parsed) {
      const x = ensureFinite(Number(item?.x), null);
      const z = ensureFinite(Number(item?.z), null);
      if (x == null || z == null) continue;
      let fx = ensureFinite(Number(item?.fx), null);
      let fz = ensureFinite(Number(item?.fz), null);
      if (fx != null && fz != null) {
        const flen = Math.hypot(fx, fz);
        if (flen > 1e-6) {
          fx /= flen;
          fz /= flen;
        } else {
          fx = null;
          fz = null;
        }
      }
      points.push({ x, z, fx, fz });
      if (points.length >= 32) break; // MVP guardrail
    }
    return points.length ? points : null;
  } catch {
    return null;
  }
}

function getBallSpawnPoints() {
  if (cachedBallSpawnPoints) return cachedBallSpawnPoints;

  const fromEnv = parseBallSpawnPoints(BALL_SPAWN_POINTS_ENV);
  if (fromEnv) {
    cachedBallSpawnPoints = fromEnv;
    return cachedBallSpawnPoints;
  }

  try {
    const p = path.join(__dirname, BALL_SPAWN_POINTS_FILE);
    const raw = fs.readFileSync(p, 'utf-8');
    const fromFile = parseBallSpawnPoints(raw);
    if (fromFile) {
      cachedBallSpawnPoints = fromFile;
      return cachedBallSpawnPoints;
    }
  } catch {
    // ignore
  }

  cachedBallSpawnPoints = fallbackBallSpawnPoints();
  return cachedBallSpawnPoints;
}

function getCornerPosts() {
  if (cachedCornerPosts) return cachedCornerPosts;
  const r = Number.isFinite(CORNER_POST_RADIUS) ? CORNER_POST_RADIUS : 0;
  if (!(r > 0.001)) {
    cachedCornerPosts = [];
    return cachedCornerPosts;
  }
  const spawns = getBallSpawnPoints();
  const seen = new Set();
  const posts = [];
  for (const p of spawns) {
    const x = ensureFinite(p?.x, null);
    const z = ensureFinite(p?.z, null);
    if (x == null || z == null) continue;
    const key = `${Math.round(x * 1000) / 1000},${Math.round(z * 1000) / 1000}`;
    if (seen.has(key)) continue;
    seen.add(key);
    posts.push({ x, z });
  }
  cachedCornerPosts = posts;
  return cachedCornerPosts;
}

function spawnBall() {
  const spawnPoints = getBallSpawnPoints();
  const idx = Math.max(0, state.ball.spawnIdx || 0);
  const origin = spawnPoints[idx % spawnPoints.length];
  state.ball.spawnIdx = (idx + 1) % spawnPoints.length;

  // MVP kickoff:
  // - Spawn at a tube point.
  // - Launch immediately with a deterministic direction (biased toward arena center).
  let dirX = ensureFinite(origin?.fx, null);
  let dirZ = ensureFinite(origin?.fz, null);
  if (dirX == null || dirZ == null) {
    const ox = ensureFinite(origin?.x, 0);
    const oz = ensureFinite(origin?.z, 0);
    dirX = -ox;
    dirZ = -oz;
  }
  let len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) {
    // Degenerate (spawn at center): pick a deterministic direction.
    dirX = Math.SQRT1_2;
    dirZ = Math.SQRT1_2;
    len = 1;
  }
  dirX /= len;
  dirZ /= len;

  // MVP constraint: deterministic server-authoritative kickoff (no random spread).

  // If the arena has visible corner posts/tubes, avoid spawning the ball "inside" their mesh.
  // Move it toward the launch direction by (post radius + ball radius).
  const postR = (Number.isFinite(CORNER_POST_RADIUS) && CORNER_POST_RADIUS > 0) ? CORNER_POST_RADIUS : 0;
  const exitOffset = postR > 0 ? (postR + ARENA.ballRadius + 0.02) : 0;
  state.ball.x = ensureFinite(origin?.x, 0) + dirX * exitOffset;
  state.ball.z = ensureFinite(origin?.z, 0) + dirZ * exitOffset;

  // Clamp spawn inside inner playfield.
  const halfW = (FIELD?.width ?? ARENA.width) / 2;
  const halfH = (FIELD?.height ?? ARENA.height) / 2;
  const minX = -halfW + ARENA.ballRadius;
  const maxX = halfW - ARENA.ballRadius;
  const minZ = -halfH + ARENA.ballRadius;
  const maxZ = halfH - ARENA.ballRadius;
  state.ball.x = clamp(state.ball.x, minX, maxX);
  state.ball.z = clamp(state.ball.z, minZ, maxZ);

  state.ball.pendingVx = 0;
  state.ball.pendingVz = 0;
  state.ball.launchAt = null;

  const minSpeed = Math.max(0, ensureFinite(BALL.minSpeed, BALL_MIN_SPEED));
  const kick = Math.max(minSpeed, BALL_START_SPEED);
  state.ball.vx = ensureFinite(dirX * kick, 0);
  state.ball.vz = ensureFinite(dirZ * kick, 0);
  enforceMinAngle();

  state.ball.lastX = state.ball.x;
  state.ball.lastZ = state.ball.z;
  state.ball.lastMoveAt = Date.now();
}

function collideWithCornerPost(post) {
  const postR = (Number.isFinite(CORNER_POST_RADIUS) && CORNER_POST_RADIUS > 0) ? CORNER_POST_RADIUS : 0;
  if (!(postR > 0.001)) return false;
  const cx = ensureFinite(post?.x, null);
  const cz = ensureFinite(post?.z, null);
  if (cx == null || cz == null) return false;

  const r = ARENA.ballRadius + postR;
  const dx = state.ball.x - cx;
  const dz = state.ball.z - cz;
  const distSq = dx * dx + dz * dz;
  if (distSq > r * r) return false;

  let nx = dx;
  let nz = dz;
  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) {
    // Degenerate: pick a stable normal based on current travel direction.
    const vlen = Math.hypot(state.ball.vx, state.ball.vz);
    if (vlen > 1e-6) {
      nx = -state.ball.vx / vlen;
      nz = -state.ball.vz / vlen;
      dist = 1;
    } else {
      // Fallback: push toward arena center.
      nx = -cx;
      nz = -cz;
      dist = Math.hypot(nx, nz) || 1;
      nx /= dist;
      nz /= dist;
      dist = 1;
    }
  } else {
    nx /= dist;
    nz /= dist;
  }

  // Resolve penetration.
  const push = (r - Math.min(r, dist)) + RING_EPSILON;
  state.ball.x += nx * push;
  state.ball.z += nz * push;

  // Reflect if moving into the post.
  const dot = state.ball.vx * nx + state.ball.vz * nz;
  if (dot < 0) {
    state.ball.vx = state.ball.vx - 2 * dot * nx;
    state.ball.vz = state.ball.vz - 2 * dot * nz;
    state.ball.vx *= BALL.restitutionWall;
    state.ball.vz *= BALL.restitutionWall;
    enforceMinAngle();
  }
  return true;
}

function collideCornerPosts() {
  const posts = getCornerPosts();
  if (!posts.length) return false;
  let hitAny = false;
  for (const post of posts) {
    if (collideWithCornerPost(post)) hitAny = true;
  }
  return hitAny;
}

function collideWallsAabbCCD(prevX, prevZ, dt) {
  const r = ARENA.ballRadius;
  const halfW = (FIELD?.width ?? ARENA.width) / 2;
  const halfH = (FIELD?.height ?? ARENA.height) / 2;
  const minX = -halfW + r;
  const maxX = halfW - r;
  const minZ = -halfH + r;
  const maxZ = halfH - r;
  const currX = state.ball.x;
  const currZ = state.ball.z;

  // If we're still inside, nothing to do.
  if (currX >= minX && currX <= maxX && currZ >= minZ && currZ <= maxZ) return;

  const dx = currX - prevX;
  const dz = currZ - prevZ;

  // Degenerate sweep: just clamp back inside and reflect based on the side we violated.
  const segLenSq = dx * dx + dz * dz;
  if (segLenSq < 1e-12) {
    let hitX = false;
    let hitZ = false;
    if (state.ball.x < minX) { state.ball.x = minX; hitX = true; }
    if (state.ball.x > maxX) { state.ball.x = maxX; hitX = true; }
    if (state.ball.z < minZ) { state.ball.z = minZ; hitZ = true; }
    if (state.ball.z > maxZ) { state.ball.z = maxZ; hitZ = true; }
    if (hitX) state.ball.vx *= -BALL.restitutionWall;
    if (hitZ) state.ball.vz *= -BALL.restitutionWall;
    enforceMinAngle();
    return;
  }

  const candidates = [];
  // X walls
  if (dx > 0 && currX > maxX) {
    const t = (maxX - prevX) / dx;
    if (t >= 0 && t <= 1) candidates.push({ t, axis: 'x', sign: 1 });
  } else if (dx < 0 && currX < minX) {
    const t = (minX - prevX) / dx;
    if (t >= 0 && t <= 1) candidates.push({ t, axis: 'x', sign: -1 });
  }
  // Z walls
  if (dz > 0 && currZ > maxZ) {
    const t = (maxZ - prevZ) / dz;
    if (t >= 0 && t <= 1) candidates.push({ t, axis: 'z', sign: 1 });
  } else if (dz < 0 && currZ < minZ) {
    const t = (minZ - prevZ) / dz;
    if (t >= 0 && t <= 1) candidates.push({ t, axis: 'z', sign: -1 });
  }

  candidates.sort((a, b) => a.t - b.t);

  let hit = candidates[0] || null;
  if (!hit) {
    // Fallback: clamp & reflect naively.
    let hitX = false;
    let hitZ = false;
    if (state.ball.x < minX) { state.ball.x = minX; hitX = true; }
    if (state.ball.x > maxX) { state.ball.x = maxX; hitX = true; }
    if (state.ball.z < minZ) { state.ball.z = minZ; hitZ = true; }
    if (state.ball.z > maxZ) { state.ball.z = maxZ; hitZ = true; }
    if (hitX) state.ball.vx *= -BALL.restitutionWall;
    if (hitZ) state.ball.vz *= -BALL.restitutionWall;
    enforceMinAngle();
    return;
  }

  // Corner: if the 2nd earliest hit is almost simultaneous, reflect both axes.
  const hit2 = candidates[1];
  const isCorner = hit2 && Math.abs(hit2.t - hit.t) < 1e-6;

  const t = hit.t;
  const hitX = prevX + dx * t;
  const hitZ = prevZ + dz * t;
  state.ball.x = clamp(hitX, minX, maxX);
  state.ball.z = clamp(hitZ, minZ, maxZ);

  if (hit.axis === 'x' || (isCorner && hit2.axis === 'x')) state.ball.vx *= -BALL.restitutionWall;
  if (hit.axis === 'z' || (isCorner && hit2.axis === 'z')) state.ball.vz *= -BALL.restitutionWall;

  enforceMinAngle();

  // Advance remaining time with reflected velocity.
  const remaining = dt * (1 - t);
  if (remaining > 1e-6) {
    state.ball.x = ensureFinite(state.ball.x + state.ball.vx * remaining, state.ball.x);
    state.ball.z = ensureFinite(state.ball.z + state.ball.vz * remaining, state.ball.z);
    state.ball.x = clamp(state.ball.x, minX, maxX);
    state.ball.z = clamp(state.ball.z, minZ, maxZ);
  }
}

function collideWallsEllipseCCD(prevX, prevZ, dt) {
  const r = ARENA.ballRadius;
  const rx = (FIELD?.width ?? ARENA.width) / 2 - r;
  const rz = (FIELD?.height ?? ARENA.height) / 2 - r;
  if (!(rx > 0.01 && rz > 0.01)) return;

  const insideValue = (x, z) => (x * x) / (rx * rx) + (z * z) / (rz * rz);

  // If we're still inside the rink collider, nothing to do.
  if (insideValue(state.ball.x, state.ball.z) <= 1) return;

  // Sweep from prev -> curr to find time-of-impact against ellipse.
  const currX = state.ball.x;
  const currZ = state.ball.z;
  const dx = currX - prevX;
  const dz = currZ - prevZ;

  // Fallback: if we have no segment (numerical), just project back inside.
  const segLenSq = dx * dx + dz * dz;
  if (segLenSq < 1e-12) {
    const val = insideValue(currX, currZ);
    const scale = val > 0 ? 1 / Math.sqrt(val) : 1;
    const hitX = currX * scale;
    const hitZ = currZ * scale;
    let nx = hitX / (rx * rx);
    let nz = hitZ / (rz * rz);
    const nlen = Math.hypot(nx, nz) || 1;
    nx /= nlen;
    nz /= nlen;
    state.ball.x = hitX - nx * RING_EPSILON;
    state.ball.z = hitZ - nz * RING_EPSILON;
    const dot = state.ball.vx * nx + state.ball.vz * nz;
    state.ball.vx = state.ball.vx - 2 * dot * nx;
    state.ball.vz = state.ball.vz - 2 * dot * nz;
    state.ball.vx *= BALL.restitutionWall;
    state.ball.vz *= BALL.restitutionWall;
    enforceMinAngle();
    return;
  }

  const A = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
  const B = 2 * ((prevX * dx) / (rx * rx) + (prevZ * dz) / (rz * rz));
  const C = (prevX * prevX) / (rx * rx) + (prevZ * prevZ) / (rz * rz) - 1;

  let t = 0;
  const disc = B * B - 4 * A * C;
  if (disc >= 0 && Math.abs(A) > 1e-12) {
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-B - sqrtDisc) / (2 * A);
    const t2 = (-B + sqrtDisc) / (2 * A);
    const candidates = [t1, t2].filter((v) => v >= 0 && v <= 1);
    if (candidates.length) t = Math.min(...candidates);
  }

  const hitX = prevX + dx * t;
  const hitZ = prevZ + dz * t;
  let nx = hitX / (rx * rx);
  let nz = hitZ / (rz * rz);
  const nlen = Math.hypot(nx, nz) || 1;
  nx /= nlen;
  nz /= nlen;

  // Clamp to surface before reflecting.
  state.ball.x = hitX - nx * RING_EPSILON;
  state.ball.z = hitZ - nz * RING_EPSILON;

  // Reflect about collision normal.
  const dot = state.ball.vx * nx + state.ball.vz * nz;
  state.ball.vx = state.ball.vx - 2 * dot * nx;
  state.ball.vz = state.ball.vz - 2 * dot * nz;
  state.ball.vx *= BALL.restitutionWall;
  state.ball.vz *= BALL.restitutionWall;
  enforceMinAngle();

  // Advance the remaining fraction of the tick using the reflected velocity.
  const remaining = dt * (1 - t);
  if (remaining > 1e-6) {
    state.ball.x = ensureFinite(state.ball.x + state.ball.vx * remaining, state.ball.x);
    state.ball.z = ensureFinite(state.ball.z + state.ball.vz * remaining, state.ball.z);
    // Final safety: if we still ended up outside, project back inside.
    const val = insideValue(state.ball.x, state.ball.z);
    if (val > 1) {
      const scale = 1 / Math.sqrt(val);
      state.ball.x *= scale;
      state.ball.z *= scale;
    }
  }
}

function collideWalls(prevX, prevZ, dt) {
  if (RING_COLLIDER === 'aabb') {
    collideWallsAabbCCD(prevX, prevZ, dt);
    return;
  }
  collideWallsEllipseCCD(prevX, prevZ, dt);
}

function clampBallInsideAabb() {
  const r = ARENA.ballRadius;
  const halfW = (FIELD?.width ?? ARENA.width) / 2;
  const halfH = (FIELD?.height ?? ARENA.height) / 2;
  const minX = -halfW + r;
  const maxX = halfW - r;
  const minZ = -halfH + r;
  const maxZ = halfH - r;
  let clamped = false;

  if (state.ball.x <= minX) {
    state.ball.x = minX + RING_EPSILON;
    if (state.ball.vx < 0) state.ball.vx *= -BALL.restitutionWall;
    clamped = true;
  } else if (state.ball.x >= maxX) {
    state.ball.x = maxX - RING_EPSILON;
    if (state.ball.vx > 0) state.ball.vx *= -BALL.restitutionWall;
    clamped = true;
  }

  if (state.ball.z <= minZ) {
    state.ball.z = minZ + RING_EPSILON;
    if (state.ball.vz < 0) state.ball.vz *= -BALL.restitutionWall;
    clamped = true;
  } else if (state.ball.z >= maxZ) {
    state.ball.z = maxZ - RING_EPSILON;
    if (state.ball.vz > 0) state.ball.vz *= -BALL.restitutionWall;
    clamped = true;
  }

  if (clamped) enforceMinAngle();
}

function computePlayerYaw(player) {
  // Arcade rule: player always faces the arena center; movement direction does not affect rotation.
  // Game yaw convention: +Z is forward, yaw is atan2(x, z).
  const cx = -player.x;
  const cz = -player.z;
  if (Math.hypot(cx, cz) < 1e-6) return 0;
  return Math.atan2(cx, cz);
}

function collideWithPlayer(player) {
  const now = Date.now();
  const inCooldown = !!(player.lastHitAt && now - player.lastHitAt < HIT_COOLDOWN_MS);
  const r = ARENA.ballRadius;
  const ext = playerHalfExtentsForSide(player.side);

  // Circle (ball) vs axis-aligned rectangle (paddle) collision via closest point.
  const closestX = clamp(state.ball.x, player.x - ext.hx, player.x + ext.hx);
  const closestZ = clamp(state.ball.z, player.z - ext.hz, player.z + ext.hz);
  const dxRect = state.ball.x - closestX;
  const dzRect = state.ball.z - closestZ;
  const distSq = dxRect * dxRect + dzRect * dzRect;
  if (distSq > r * r) return false;

  // Contact normal from the closest point on the paddle AABB to the ball center.
  // This avoids "orbit lock" where a radial correction can pin the ball on paddle corners.
  let nX = dxRect;
  let nZ = dzRect;
  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) {
    // Degenerate: ball center is inside rect projection. Push through the nearest face.
    const toLeft = Math.abs(state.ball.x - (player.x - ext.hx));
    const toRight = Math.abs((player.x + ext.hx) - state.ball.x);
    const toTop = Math.abs(state.ball.z - (player.z - ext.hz));
    const toBottom = Math.abs((player.z + ext.hz) - state.ball.z);
    if (toLeft <= toRight && toLeft <= toTop && toLeft <= toBottom) {
      nX = -1;
      nZ = 0;
    } else if (toRight <= toTop && toRight <= toBottom) {
      nX = 1;
      nZ = 0;
    } else if (toTop <= toBottom) {
      nX = 0;
      nZ = -1;
    } else {
      nX = 0;
      nZ = 1;
    }
    dist = 0;
  } else {
    nX /= dist;
    nZ /= dist;
  }

  // Prevent "behind the paddle" cases from kicking the ball into the wall.
  if (player.side === 'top' && nZ < 0) { nX *= -1; nZ *= -1; }
  else if (player.side === 'bottom' && nZ > 0) { nX *= -1; nZ *= -1; }
  else if (player.side === 'left' && nX < 0) { nX *= -1; nZ *= -1; }
  else if (player.side === 'right' && nX > 0) { nX *= -1; nZ *= -1; }

  // Minimal penetration correction along the contact normal (never pulls inward).
  const correction = Math.max(0, r - dist) + 0.01;
  state.ball.x += nX * correction;
  state.ball.z += nZ * correction;

  // Keep separation inside the rink bounds to avoid chaining into wall collisions.
  const halfW = (FIELD?.width ?? ARENA.width) / 2;
  const halfH = (FIELD?.height ?? ARENA.height) / 2;
  const minX = -halfW + r;
  const maxX = halfW - r;
  const minZ = -halfH + r;
  const maxZ = halfH - r;
  state.ball.x = clamp(state.ball.x, minX, maxX);
  state.ball.z = clamp(state.ball.z, minZ, maxZ);

  const minSpeed = Math.max(0, ensureFinite(BALL.minSpeed, BALL_MIN_SPEED));
  const maxSpeed = Math.max(minSpeed, ensureFinite(BALL.maxSpeed, BALL_MAX_SPEED));
  const hitSpeed = clamp(Math.max(minSpeed, ensureFinite(BALL.hitSpeed, BALL_HIT_SPEED)), minSpeed, maxSpeed);
  const currentSpeed = Math.hypot(state.ball.vx, state.ball.vz);
  const dotIn = state.ball.vx * nX + state.ball.vz * nZ;

  // If the ball is already travelling away from the paddle, don't "re-hit" it. Separation above is enough.
  if (dotIn >= 0 && currentSpeed > BALL_REST_EPS) return true;

  // Cooldown: still prevent tunneling (if moving into paddle), but don't apply steering/boost repeatedly.
  if (inCooldown) {
    if (dotIn < 0) {
      const s = Math.max(minSpeed, currentSpeed);
      state.ball.vx = nX * s;
      state.ball.vz = nZ * s;
      enforceMinAngle();
    }
    return true;
  }

  // Player movement direction (prefer authoritative velocity, fallback to input).
  let mX = ensureFinite(player.vx, 0);
  let mZ = ensureFinite(player.vz, 0);
  let mLen = Math.hypot(mX, mZ);
  if (mLen <= 0.001) {
    const dir = normalizeDir(player.input);
    if (player.side === 'top' || player.side === 'bottom') {
      mX = dir.x;
      mZ = 0;
    } else if (player.side === 'left' || player.side === 'right') {
      mX = 0;
      mZ = dir.z;
    } else {
      mX = dir.x;
      mZ = dir.z;
    }
    mLen = Math.hypot(mX, mZ);
  }
  if (mLen > 0.001) {
    mX /= mLen;
    mZ /= mLen;
  } else {
    mX = 0;
    mZ = 0;
  }

  const moveInfluence = Math.max(0, Math.min(1, ensureFinite(BALL_MOVE_INFLUENCE, 0.65)));
  let dX = nX + moveInfluence * mX;
  let dZ = nZ + moveInfluence * mZ;
  let dLen = Math.hypot(dX, dZ);
  if (dLen < 1e-6) {
    dX = nX;
    dZ = nZ;
    dLen = 1;
  }
  dX /= dLen;
  dZ /= dLen;

  // Tangential steering based on movement direction relative to the tangent at contact.
  const tX = -nZ;
  const tZ = nX;
  const side = mX * tX + mZ * tZ; // -1..1
  const tangentInfluence = Math.max(0, Math.min(1, ensureFinite(BALL_TANGENT_INFLUENCE, 0.35)));
  dX += tangentInfluence * side * tX;
  dZ += tangentInfluence * side * tZ;
  const dLen2 = Math.hypot(dX, dZ) || 1;
  dX /= dLen2;
  dZ /= dLen2;

  // Speed after hit: slightly boost, clamped to [minSpeed..maxSpeed].
  const boost = Math.max(1, ensureFinite(BALL_HIT_BOOST, 1.25));
  let speed = currentSpeed;
  // Arcade feel: ensure hits re-energize the ball to at least `hitSpeed`, then apply a mild boost when already fast.
  if (!(speed > BALL_REST_EPS) || speed < hitSpeed) {
    speed = hitSpeed;
  } else {
    speed = clamp(speed * boost, minSpeed, maxSpeed);
  }

  state.ball.vx = dX * speed;
  state.ball.vz = dZ * speed;

  // Keep outgoing trajectory away from ultra-shallow angles to avoid wall/paddle sticking.
  enforceMinAngle();

  // Apply cooldown after the actual hit response is applied.
  player.lastHitAt = now;
  return true;
}

function applyBallLimits() {
  state.ball.vx = ensureFinite(state.ball.vx, 0);
  state.ball.vz = ensureFinite(state.ball.vz, 0);
  const speed = Math.hypot(state.ball.vx, state.ball.vz);
  const minSpeed = Math.max(0, ensureFinite(BALL.minSpeed, BALL_MIN_SPEED));
  const maxSpeed = Math.max(minSpeed, ensureFinite(BALL.maxSpeed, BALL_MAX_SPEED));

  // Degenerate: direction is undefined; restore to minSpeed with a deterministic direction.
  // This is a server-side guardrail; direction should normally change only on collisions.
  const DIR_EPS = 1e-3;
  if (speed < DIR_EPS) {
    if (minSpeed <= 1e-6) return;
    let dx = -ensureFinite(state.ball.x, 0);
    let dz = -ensureFinite(state.ball.z, 0);
    let dLen = Math.hypot(dx, dz);
    if (dLen < 1e-6) {
      dx = 1;
      dz = 1;
      dLen = Math.SQRT2;
    }
    dx /= dLen;
    dz /= dLen;
    state.ball.vx = dx * minSpeed;
    state.ball.vz = dz * minSpeed;
    enforceMinAngle();
    return;
  }

  if (speed < minSpeed && minSpeed > 1e-6) {
    const s = minSpeed / speed;
    state.ball.vx *= s;
    state.ball.vz *= s;
  } else if (speed > maxSpeed && maxSpeed > 1e-6) {
    const s = maxSpeed / speed;
    state.ball.vx *= s;
    state.ball.vz *= s;
  }
}

function connectedPlayers() {
  return [...state.players.values()].filter((p) => p.connected);
}

function humanConnectedPlayers() {
  return connectedPlayers().filter((p) => !p.isBot);
}

function connectedBotPlayers() {
  return connectedPlayers().filter((p) => p.isBot);
}

function removeOneBot(preferSide = null) {
  const bots = connectedBotPlayers();
  if (!bots.length) return false;
  const pick = (preferSide && bots.find((b) => b.side === preferSide)) || bots[bots.length - 1];
  state.players.delete(pick.id);
  return true;
}

function ensureBotFill() {
  // When bot-fill mode is disabled, ensure no bots linger in the room.
  // (Useful if the feature was enabled in a previous deployment/build.)
  if (!FILL_BOTS) {
    let changed = false;
    for (const [id, p] of state.players.entries()) {
      if (p?.isBot) {
        state.players.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  let changed = false;

  const humans = humanConnectedPlayers();
  if (humans.length === 0) {
    // When no humans are connected, remove bots so room goes back to idle state.
    for (const [id, p] of state.players.entries()) {
      if (p.isBot) {
        state.players.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  // Bot-fill mode is a single-player-friendly mode: the active (human) player should always
  // be on the primary "bottom" slot (closest to camera in our default view).
  // To avoid side conflicts with reconnect buffers, drop disconnected human slots in this mode.
  for (const [id, p] of state.players.entries()) {
    if (!p.connected && !p.isBot) {
      state.players.delete(id);
      changed = true;
    }
  }

  // If there's exactly one human, force them into the bottom slot and rebuild bots.
  if (humans.length === 1) {
    const human = humans[0];
    if (human.side !== 'bottom') {
      // Remove all bots (we'll recreate them with correct names/sides below).
      for (const [id, p] of state.players.entries()) {
        if (p.isBot) {
          state.players.delete(id);
          changed = true;
        }
      }
      human.side = 'bottom';
      const pos = playerDefault('bottom');
      human.x = pos.x;
      human.z = pos.z;
      human.input = {};
      human.lastHitAt = 0;
      changed = true;
    }
  }

  const usedSides = new Set(connectedPlayers().map((p) => p.side));
  for (const side of SIDE_ORDER) {
    if (usedSides.has(side)) continue;
    const pos = playerDefault(side);
    const bot = {
      id: `bot-${side}`,
      userId: `bot-${side}`,
      username: `Bot_${side}`,
      side,
      x: pos.x,
      z: pos.z,
      input: {},
      lastInputAt: 0,
      lastHitAt: 0,
      ws: null,
      connected: true,
      disconnectedAt: null,
      ping: null,
      isBot: true,
    };
    state.players.set(bot.id, bot);
    usedSides.add(side);
    changed = true;
  }
  return changed;
}

function botDecideInput(bot) {
  const input = { forward: false, back: false, left: false, right: false };
  if (!BOT_AI) return input;

  if (bot.side === 'top' || bot.side === 'bottom') {
    const dx = state.ball.x - bot.x;
    if (dx > BOT_DEADZONE) input.right = true;
    else if (dx < -BOT_DEADZONE) input.left = true;
    return input;
  }

  if (bot.side === 'left' || bot.side === 'right') {
    const dz = state.ball.z - bot.z;
    // In our coordinate system: forward = negative z, back = positive z
    if (dz > BOT_DEADZONE) input.back = true;
    else if (dz < -BOT_DEADZONE) input.forward = true;
  }
  return input;
}

function updateBots() {
  if (!FILL_BOTS) return;
  const bots = connectedBotPlayers();
  if (!bots.length) return;
  bots.forEach((b) => {
    b.input = botDecideInput(b);
  });
}

function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

function broadcastHandshaked(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (!meta.get(client)?.handshaked) return;
    client.send(data);
  });
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function sendErrorAndClose(ws, errorCode, message, wsCode = 4000) {
  send(ws, makeError(errorCode, message));
  try {
    if (ws.readyState === 1) {
      // Use explicit app-level close codes so clients don't see ambiguous 1005.
      ws.close(wsCode, String(errorCode || 'ERROR'));
      return;
    }
  } catch {}
  try { ws.close(); } catch {}
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
  state.ball.launchAt = null;
  state.ball.pendingVx = 0;
  state.ball.pendingVz = 0;
  state.ball.lastX = 0;
  state.ball.lastZ = 0;
  state.ball.lastMoveAt = Date.now();
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
  const prevPosById = new Map();
  active.forEach((p) => {
    prevPosById.set(p.id, { x: p.x, z: p.z });
  });
  if (state.matchState === 'READY' && state.readyUntil && Date.now() >= state.readyUntil) {
    setMatchState('IN_PROGRESS', 'ALL_READY');
    spawnBall();
  }

  const inProgress = state.matchState === 'IN_PROGRESS';

  // TЗ: до старта матча управление заблокировано.
  if (inProgress) {
    updateBots();
    active.forEach((p) => {
      const dir = normalizeDir(p.input);
      let vx = 0;
      let vz = 0;
      if (p.side === 'top' || p.side === 'bottom') {
        vx = dir.x * PLAYER.speed;
        p.x = ensureFinite(p.x + vx * dt, p.x);
      } else if (p.side === 'left' || p.side === 'right') {
        vz = dir.z * PLAYER.speed;
        p.z = ensureFinite(p.z + vz * dt, p.z);
      } else {
        // Shouldn't happen, but keep it deterministic if side is ever unknown.
        vx = dir.x * PLAYER.speed;
        vz = dir.z * PLAYER.speed;
        p.x = ensureFinite(p.x + vx * dt, p.x);
        p.z = ensureFinite(p.z + vz * dt, p.z);
      }
      // Authoritative movement velocity used for arcade ball steering.
      p.vx = ensureFinite(vx, 0);
      p.vz = ensureFinite(vz, 0);
      clampPlayerToZone(p);
    });
    enforcePlayerBounds();
    resolvePlayerPostCollisions(prevPosById);
    resolvePlayerCollisions();
    // Player-player separation can push into obstacles; clamp again.
    resolvePlayerPostCollisions(prevPosById);
  } else {
    // Freeze any stale input while waiting/ready/finished states are shown.
    active.forEach((p) => {
      p.input = {};
      p.vx = 0;
      p.vz = 0;
    });
    enforcePlayerBounds();
  }

  // After collision resolution, recompute yaw from the authoritative positions.
  active.forEach((p) => {
    p.yaw = computePlayerYaw(p);
  });

  if (inProgress) {
    const now = Date.now();
    if (state.ball.launchAt && now >= state.ball.launchAt) {
      state.ball.vx = ensureFinite(state.ball.pendingVx, 0);
      state.ball.vz = ensureFinite(state.ball.pendingVz, 0);
      state.ball.launchAt = null;
      state.ball.pendingVx = 0;
      state.ball.pendingVz = 0;
    }

    // Hold ball stationary during the spawn delay (tube launcher).
    if (state.ball.launchAt && now < state.ball.launchAt) {
      state.ball.vx = 0;
      state.ball.vz = 0;
    } else {
      const prevBallX = state.ball.x;
      const prevBallZ = state.ball.z;
      state.ball.x = ensureFinite(state.ball.x + state.ball.vx * dt, 0);
      state.ball.z = ensureFinite(state.ball.z + state.ball.vz * dt, 0);
      // Multiple passes so the ball can't end a tick overlapping multiple paddles (corner traps).
      const ps = connectedPlayers();
      for (let iter = 0; iter < 3; iter += 1) {
        let hitAny = false;
        for (const p of ps) {
          if (collideWithPlayer(p)) hitAny = true;
        }
        if (collideCornerPosts()) hitAny = true;
        if (!hitAny) break;
      }
      collideWalls(prevBallX, prevBallZ, dt);
      // Final guardrail: keep ball inside rink even under extreme overlap resolution or numerical jitter.
      if (RING_COLLIDER === 'aabb') clampBallInsideAabb();

      // Mild damping to prevent indefinite speed buildup from repeated hits.
      const damp = ensureFinite(BALL.damping, BALL_DAMPING);
      const d = Math.min(1, Math.max(0, damp));
      state.ball.vx *= d;
      state.ball.vz *= d;

      // Keep ball speed within bounds and above the minimum so it never looks static.
      applyBallLimits();

      // Stuck watchdog: if the ball position isn't changing (numerical edge cases / overlap traps),
      // re-apply a normalized velocity so the ball never freezes.
      const dxMoved = state.ball.x - state.ball.lastX;
      const dzMoved = state.ball.z - state.ball.lastZ;
      const movedSq = dxMoved * dxMoved + dzMoved * dzMoved;
      const distEps = Math.max(0, ensureFinite(BALL_STUCK_DIST_EPS, 0));
      const distEpsSq = distEps * distEps;
      if (movedSq > distEpsSq) {
        state.ball.lastX = state.ball.x;
        state.ball.lastZ = state.ball.z;
        state.ball.lastMoveAt = now;
      } else if (state.ball.lastMoveAt && now - state.ball.lastMoveAt > BALL_STUCK_MS) {
        const minSpeed = Math.max(0, ensureFinite(BALL.minSpeed, BALL_MIN_SPEED));
        if (minSpeed > 1e-6) {
          let vx = ensureFinite(state.ball.vx, 0);
          let vz = ensureFinite(state.ball.vz, 0);
          let s = Math.hypot(vx, vz);
          const DIR_EPS = 1e-3;
          if (s < DIR_EPS) {
            // Deterministic fallback: push back toward arena center.
            vx = -ensureFinite(state.ball.x, 0);
            vz = -ensureFinite(state.ball.z, 0);
            s = Math.hypot(vx, vz);
            if (s < 1e-6) {
              vx = 1;
              vz = 1;
              s = Math.SQRT2;
            }
          }
          vx /= s;
          vz /= s;
          state.ball.vx = vx * minSpeed;
          state.ball.vz = vz * minSpeed;
          enforceMinAngle();
        }
        state.ball.lastX = state.ball.x;
        state.ball.lastZ = state.ball.z;
        state.ball.lastMoveAt = now;
      }
    }
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
      yaw: q(ensureFinite(p.yaw, 0)),
    })),
  };
  if (state.tick % CONFIG_EVERY_TICKS === 0) {
    payload.config = {
      arena: ARENA,
      field: FIELD,
      physics: { BALL, PLAYER },
      roomTimeoutMs: ROOM_TIMEOUT_MS,
    };
  }
  broadcastHandshaked({ type: 'SNAPSHOT', t: state.tick, ts, payload });
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
      field: FIELD,
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
  // tolerate empty/invalid payloads by treating as anonymous guest
  if (payload == null || typeof payload !== 'object') {
    return { ok: true, userId: null, username: null, initData: null };
  }
  const norm = (value, maxLen) => {
    if (value == null) return null;
    let out = String(value).trim();
    if (!out) return null;
    if (out.length > maxLen) out = out.slice(0, maxLen);
    return out;
  };
  const userIdRaw = norm(payload.userId, MAX_USERID);
  const usernameRaw = norm(payload.username, MAX_USERNAME);
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
    const hash = String(params.get('hash') || '').toLowerCase();
    if (!hash) return { ok: false, reason: 'NO_HASH' };
    params.delete('hash');
    const pairs = [];
    params.forEach((value, key) => {
      pairs.push(`${key}=${value}`);
    });
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    // Telegram Mini App validation:
    // secret_key = HMAC_SHA256(bot_token, "WebAppData")
    // hash = HEX(HMAC_SHA256(data_check_string, secret_key))
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHex = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex').toLowerCase();

    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = Buffer.from(hash, 'hex');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { ok: false, reason: 'BAD_HASH' };
    }

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
    sendErrorAndClose(ws, 'BAD_HELLO', cleaned.reason, 4400);
    return;
  }

  const initDataRaw = cleaned.initData;
  let tgUser = null;
  const auth = verifyTelegramInitData(initDataRaw);
  if (REQUIRE_AUTH) {
    if (!auth.ok) {
      metrics.badAuth += 1;
      sendErrorAndClose(ws, 'BAD_AUTH', auth.reason || 'Auth failed', 4401);
      return;
    }
    tgUser = auth.user;
    if (!tgUser) {
      metrics.badAuth += 1;
      sendErrorAndClose(ws, 'BAD_AUTH', auth.reason || 'Missing Telegram user', 4401);
      return;
    }
  } else if (auth.ok && auth.user) {
    // Optional auth mode: use Telegram identity if verification succeeded.
    tgUser = auth.user;
  }

  const userId = tgUser?.id ? String(tgUser.id) : (cleaned.userId || `guest-${nanoid(6)}`);
  const username = tgUser?.username || (cleaned.username || 'Player').slice(0, MAX_USERNAME);
  const existing = [...state.players.values()].find((p) => p.userId === userId);
  let slotAvailable = connectedPlayers().length < MAX_PLAYERS || (existing && !existing.connected);

  if (!slotAvailable && FILL_BOTS && connectedBotPlayers().length) {
    // In bot-fill mode, let humans replace bots.
    if (removeOneBot()) {
      slotAvailable = connectedPlayers().length < MAX_PLAYERS || (existing && !existing.connected);
    }
  }

  if (!slotAvailable) {
    metrics.roomFull += 1;
    sendErrorAndClose(ws, 'ROOM_FULL', 'Room is full', 4403);
    return;
  }

  let player = existing;
  if (player && !player.connected) {
    // Reconnect: if a bot currently occupies this side, free it.
    if (FILL_BOTS && connectedPlayers().length >= MAX_PLAYERS) {
      removeOneBot(player.side);
    }
    player.connected = true;
    player.disconnectedAt = null;
    player.ws = ws;
  } else if (!player) {
    const side = assignSide();
    if (!side) {
      sendErrorAndClose(ws, 'ROOM_FULL', 'Room is full', 4403);
      return;
    }
    const pos = playerDefault(side);
    player = { id: nanoid(6), userId, username, side, x: pos.x, z: pos.z, input: {}, connected: true, ws, ping: null, lastInputAt: 0, lastHitAt: 0 };
    state.players.set(player.id, player);
  } else {
    sendErrorAndClose(ws, 'ALREADY_CONNECTED', 'Already connected', 4409);
    return;
  }

  sockets.set(ws, player.id);
  ensureBotFill();
  sendWelcome(ws, player);
  sendRoomState();
  maybeStartMatch();
}

function handleInput(ws, payload) {
  const id = sockets.get(ws);
  if (!id) return;
  const player = state.players.get(id);
  if (!player || !player.connected) return;
  // TЗ: управление доступно только в активной фазе матча.
  if (state.matchState !== 'IN_PROGRESS') return;
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
      meta.set(ws, { ...(meta.get(ws) || {}), handshaked: true });
      break;
    case 'INPUT':
      if (!meta.get(ws)?.handshaked) {
        sendErrorAndClose(ws, 'BAD_ORDER', 'Send HELLO first', 4402);
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
  ensureBotFill();
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
    sendErrorAndClose(ws, 'RATE_CONN', 'Too many connections from IP', 4408);
    return;
  }

  metrics.connectionsTotal += 1;
  meta.set(ws, { handshaked: false, ip });
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

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
