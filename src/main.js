import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app root element');
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d111c);

let renderer = null;
let rendererReady = false;
function initRenderer() {
  if (rendererReady && renderer) return renderer;
  rendererReady = true;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0x000000, 1);
  app.appendChild(renderer.domElement);
  // Keep canvas visible even while GLB assets are loading; the overlay handles UX.
  renderer.domElement.style.visibility = 'visible';
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    // Required for Safari/iOS to allow the context to be restored later.
    e.preventDefault();
  });
  return renderer;
}
document.documentElement.style.overscrollBehavior = 'none';
document.body.style.overscrollBehavior = 'none';

// Default FOV is set to match the in-game gameplay camera preset (can be overridden by URL params).
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 100);
const camLookAt = new THREE.Vector3(0, 0, 0); // world-space lookAt
const camUp = new THREE.Vector3(0, 1, 0);
const camTempPos = new THREE.Vector3();
const camTempLook = new THREE.Vector3();
let camLookZ = 0; // local-space Z target (rotated per-player side)
// Avoid rendering from the origin during the initial asset-loading overlay (prevents the ball filling the screen).
camera.position.set(0, 6.2, 8.8);
camera.lookAt(camLookAt);

const ambient = new THREE.AmbientLight(0x9fb7ff, 0.62);
scene.add(ambient);

const dir = new THREE.DirectionalLight(0xffffff, 1.05);
dir.position.set(8, 14, 7);
dir.castShadow = false;
scene.add(dir);

const PALETTE = {
  outer: 0x181d24,
  floor: '#cfc8bb',
  floorPatch: '#c2b9aa',
  railBase: '#10222b',
  railTile: '#12c7c7',
  wood: '#d7a262',
  woodDark: '#b67d3f',
  metalLight: '#cdd6e2',
  metalDark: '#6f7c8a',
  drumBody: '#5fa6b4',
  drumTop: '#cfd9e8',
  drumRing: '#8aa6c5',
  drumHole: '#0e1626',
  ventGreen: '#56df7d',
  ventGray: '#4d565f',
  backdropTop: '#0b0f18',
  backdropBottom: '#121926',
};

function createBackdrop() {
  const radius = 60;
  const geom = new THREE.SphereGeometry(radius, 28, 18);
  // invert to keep scene inside
  geom.scale(-1, 1, 1);
  const colors = [];
  const top = new THREE.Color(PALETTE.backdropTop);
  const bottom = new THREE.Color(PALETTE.backdropBottom);
  geom.attributes.position.array.forEach((_, idx) => {
    if (idx % 3 !== 1) return;
    const y = geom.attributes.position.array[idx];
    const t = THREE.MathUtils.clamp((y + radius) / (radius * 2), 0, 1);
    const c = bottom.clone().lerp(top, t);
    colors.push(c.r, c.g, c.b);
  });
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'backdrop';
  scene.add(mesh);
}

createBackdrop();

const ballSpawnPoints = [];

export function getBallSpawnPoints() {
  // Return a copy to keep internal state immutable.
  return ballSpawnPoints.map((p) => ({ x: p.x, z: p.z }));
}

if (typeof window !== 'undefined') {
  window.getBallSpawnPoints = getBallSpawnPoints;
}

function collectArenaSpawns(arenaRoot) {
  arenaSpawnNodes.length = 0;
  ballSpawnPoints.length = 0;
  if (!arenaRoot) return;

  arenaRoot.updateMatrixWorld(true);

  // Preferred: author empty nodes named `BallSpawn_*` in the GLB.
  const foundBallSpawns = [];
  arenaRoot.traverse((obj) => {
    if (!obj?.name) return;
    if (obj.name.startsWith('BallSpawn')) foundBallSpawns.push(obj);
  });
  if (foundBallSpawns.length) {
    const idxFromName = (name) => {
      const m = String(name).match(/BallSpawn[_\\s-]*(\\d+)/);
      return m ? Number.parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
    };
    foundBallSpawns.sort((a, b) => (idxFromName(a.name) - idxFromName(b.name)) || a.name.localeCompare(b.name));
    const tmp = new THREE.Vector3();
    foundBallSpawns.forEach((node) => {
      arenaSpawnNodes.push(node);
      node.updateMatrixWorld(true);
      node.getWorldPosition(tmp);
      ballSpawnPoints.push({ x: tmp.x, z: tmp.z });
    });
    return;
  }

  // Backwards compatible names (older GLBs).
  [
    // preferred corner launchers (clockwise)
    'Spawn_TopLeft', 'Spawn_TopRight', 'Spawn_BottomRight', 'Spawn_BottomLeft',
    'Spawn_TL', 'Spawn_TR', 'Spawn_BR', 'Spawn_BL',
    // legacy names fallback
    'Spawn_Top', 'Spawn_Right', 'Spawn_Bottom', 'Spawn_Left',
  ].forEach((name) => {
    const node = arenaRoot.getObjectByName(name);
    if (node) arenaSpawnNodes.push(node);
  });
  const tmp = new THREE.Vector3();
  arenaSpawnNodes.forEach((node) => {
    node.updateMatrixWorld(true);
    node.getWorldPosition(tmp);
    ballSpawnPoints.push({ x: tmp.x, z: tmp.z });
  });
}

const ARENA = { width: 12, height: 8, wallHeight: 1.2, playerDepth: 0.6, ballRadius: 0.5 };
// Visual/physics approximations for arena obstacles (must match server-side expectations).
// These obstacles are used only for visual safety clamping on the client; the server remains authoritative.
const ARENA_OBSTACLES = { postRadius: 0.9 };
const PHYSICS = {
  playerSpeed: 6,
  // Must allow the ball to fully stop (no perpetual drift).
  minSpeed: 0,
  maxSpeed: 8,
  damping: 0.99,
};
// Default values are overridden by server config when connected; keep these close to server defaults
// so offline mode behaves similarly.
// NOTE: `collider.x` is paddle width (along movement axis). `collider.z` is paddle depth (toward/away from wall).
const PLAYER = { speed: 6, collider: { x: 3.0, z: 2.2 } };
// Keep paddles slightly inset from the rink walls so the visual mesh doesn't clip outside.
const PLAYER_WALL_MARGIN = 0.25;
// Inner playfield where the ball travels (the border area near walls is decorative).
const FIELD = { width: 0, height: 0 };

function recomputeBallField() {
  // Must not depend on `params` here: this runs early during module init.
  let margin = 0;
  try {
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('fieldMargin');
    const parsed = raw == null ? null : Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) margin = parsed;
  } catch {}

  const halfW = (ARENA.width / 2) - margin;
  const halfH = (ARENA.height / 2) - margin;

  const r = ARENA.ballRadius;
  const minHalf = Math.max(r + 0.05, 0.2);
  const safeHalfW = Number.isFinite(halfW) && halfW > minHalf ? halfW : (ARENA.width / 2);
  const safeHalfH = Number.isFinite(halfH) && halfH > minHalf ? halfH : (ARENA.height / 2);
  FIELD.width = safeHalfW * 2;
  FIELD.height = safeHalfH * 2;
}

recomputeBallField();
const READY_DURATION_MS = 2000;
let readyEndsAt = null;
const MAX_RECONNECT_ATTEMPTS = 8;
const SNAPSHOT_STALL_MS = 2500;
const ASSETS = {
  arena: '/assets/arena.glb',
  ball: '/assets/ball.glb',
  // Optional: if you upload these later, set the paths back.
  // Keeping them null avoids noisy 404s/warnings in production builds.
  boat: null,
  playerFallback: null,
  players: {
    top: '/assets/player_cat.glb',
    right: '/assets/player_dog.glb',
    bottom: '/assets/player_duck.glb',
    left: '/assets/player_pigeon.glb',
  },
};
const SPAWN_PADS = [];
let nextSpawnPad = 0;
const playerPrefabs = new Map();
let playerFallbackPrefab = null;
let boatPrefab = null;
const arenaSpawnNodes = [];
// Target footprint in our game units. The shipped player GLBs are ~1.4 x 2.0 (XZ),
// so the old `z: 1.2` was shrinking them too much and made the ball look enormous.
const TARGET_PLAYER_SIZE = { x: 2.6, z: 2.6 };
const TARGET_BOAT_SIZE = { x: 2.6, z: 2.6 };
const params = new URLSearchParams(window.location.search);
const PAGE_WS_PROTO = window.location.protocol === 'https:' ? 'wss' : 'ws';

// Prevent Telegram mobile WebView (and browsers) from scrolling/drag-to-close while the user is playing.
// CSS `touch-action: none` is not always sufficient on its own, so also cancel touchmove.
try {
  document.body.addEventListener(
    'touchmove',
    (e) => {
      if (e.cancelable) e.preventDefault();
    },
    { passive: false }
  );
} catch {}

function safeLocalStorageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {}
}

function normalizeWsUrl(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Allow specifying WS server via https URL (common in docs/configs).
  if (s.startsWith('https://')) return `wss://${s.slice('https://'.length)}`;
  if (s.startsWith('http://')) return `ws://${s.slice('http://'.length)}`;

  // `ws://` from an https page is blocked as mixed content, upgrade automatically.
  if (PAGE_WS_PROTO === 'wss' && s.startsWith('ws://')) return `wss://${s.slice('ws://'.length)}`;

  if (s.startsWith('ws://') || s.startsWith('wss://')) return s;

  // Relative path like `/ws` -> same origin.
  if (s.startsWith('/')) return `${PAGE_WS_PROTO}://${window.location.host}${s}`;

  // host[:port][/path]
  return `${PAGE_WS_PROTO}://${s}`;
}
// Tunables: seating + kickoff visuals
const BOAT_SEAT_Y_RATIO = 0.5;
const CHARACTER_PELVIS_Y_RATIO = 0.5;
// `boat.glb` is authored with its "nose" roughly along -X in local space.
// Rotate it so the nose points along +Z (same forward as our player models).
const BOAT_YAW_OFFSET = (() => {
  const raw = params.get('boatYaw');
  const parsed = raw == null ? null : Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  return Math.PI / 2;
})();
const OFFLINE_KICKOFF_CORNER_MARGIN = 0.02;
const PLAYER_Y = 0.0;

const MODEL_YAW_OFFSET = (() => {
  // Static yaw correction for the character model (glTF forward can vary by asset).
  // Keep default at 0, override via `?yaw=...` (radians) when an asset is authored differently.
  const raw = params.get('yaw');
  const parsed = raw == null ? null : Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  return 0;
})();
const currentHost = window.location.hostname || 'localhost';
const isProdMainHost = currentHost === 'dvkfh.ru' || currentHost === 'www.dvkfh.ru';
const wsFromQuery = normalizeWsUrl(params.get('ws'));
const envWs = normalizeWsUrl(process.env.NEXT_PUBLIC_WS);
const storedWsRaw = safeLocalStorageGet('tf_ws_url');
const storedWs = (() => {
  if (!storedWsRaw) return null;
  // Drop stale broken value from old builds on production host.
  if (isProdMainHost && /:\/\/(?:www\.)?dvkfh\.ru:7071\b/.test(storedWsRaw)) return null;
  // Drop localhost WS URLs when we're not actually running on localhost (common when moving from dev -> prod).
  if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(currentHost) && /:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?:[:/]|$)/.test(storedWsRaw)) {
    return null;
  }
  return normalizeWsUrl(storedWsRaw);
})();
const defaultWsCandidates = (() => {
  const port = params.get('wsp') || 7071;
  if (isProdMainHost) {
    // Keep several candidates for prod to survive infra changes:
    // - dedicated ws subdomain (with or without `/ws`)
    // - same-origin `/ws` behind TLS reverse proxy
    // - direct port (rare; usually blocked on mobile)
    const baseHost = currentHost.startsWith('www.') ? currentHost.slice(4) : currentHost;
    const candidates = [
      // Prefer dedicated WS host first (less brittle than a path proxy and avoids extra 404 attempts).
      `${PAGE_WS_PROTO}://ws.${baseHost}`,
      `${PAGE_WS_PROTO}://ws.${baseHost}/ws`,
      // Fallback: same-origin WS path behind a reverse proxy.
      `${PAGE_WS_PROTO}://${currentHost}/ws`,
      `${PAGE_WS_PROTO}://${baseHost}/ws`,
      `${PAGE_WS_PROTO}://${currentHost}:${port}`,
      `${PAGE_WS_PROTO}://${baseHost}:${port}`,
    ];
    return [...new Set(candidates.map(normalizeWsUrl).filter(Boolean))];
  }

  // Heuristics for common deployments:
  // 1) Same-origin `/ws` behind TLS reverse proxy (port 443).
  // 2) Dedicated ws subdomain (e.g. ws.example.com).
  // 3) Direct port access (e.g. :7071).
  const baseHost = currentHost.startsWith('www.') ? currentHost.slice(4) : currentHost;
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(baseHost);
  const isLocal = baseHost === 'localhost' || baseHost === '127.0.0.1' || baseHost === '0.0.0.0';

  const candidates = [];
  if (isLocal || isIp) {
    // Local/test setups typically expose WS on a port (no TLS reverse proxy).
    candidates.push(`${PAGE_WS_PROTO}://${currentHost}:${port}`);
    candidates.push(`${PAGE_WS_PROTO}://${currentHost}/ws`);
  } else {
    candidates.push(`${PAGE_WS_PROTO}://${currentHost}/ws`);
    if (!baseHost.startsWith('ws.') && baseHost.includes('.')) {
      candidates.push(`${PAGE_WS_PROTO}://ws.${baseHost}`);
    }
    candidates.push(`${PAGE_WS_PROTO}://${currentHost}:${port}`);
  }
  return [...new Set(candidates.map(normalizeWsUrl).filter(Boolean))];
})();
const wsCandidates = (() => {
  if (wsFromQuery) return [wsFromQuery];
  if (envWs) return [envWs];
  const list = [];
  if (storedWs) list.push(storedWs);
  defaultWsCandidates.forEach((u) => {
    if (u && !list.includes(u)) list.push(u);
  });
  return list;
})();
const wsUrl = wsCandidates[0] || null;
const wsCandidatesLocked = !!(wsFromQuery || envWs);
if (wsFromQuery) safeLocalStorageSet('tf_ws_url', wsFromQuery);

// Telegram Mini App bootstrap with graceful fallback.
// Load Telegram SDK in a non-blocking way: Mini App must still boot if SDK is slow/unavailable.
const TG_WEBAPP_SRC = 'https://telegram.org/js/telegram-web-app.js';
let tg = null;
let tgInitDone = false;
let tgScriptRequested = false;
let cachedInitDataRaw = '';

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function readInitDataFromLocation() {
  if (typeof window === 'undefined') return '';
  try {
    const fromSearch = new URLSearchParams(window.location.search);
    const direct = fromSearch.get('tgWebAppData') || fromSearch.get('initData') || '';
    if (direct) return safeDecodeUriComponent(direct);
  } catch {}

  try {
    const hashRaw = String(window.location.hash || '').replace(/^#/, '');
    if (!hashRaw) return '';
    const fromHash = new URLSearchParams(hashRaw);
    const v = fromHash.get('tgWebAppData') || fromHash.get('initData') || '';
    if (!v) return '';
    return safeDecodeUriComponent(v);
  } catch {
    return '';
  }
}

function getTelegramInitData() {
  try {
    const sdkValue = window?.Telegram?.WebApp?.initData;
    if (typeof sdkValue === 'string' && sdkValue.length > 0) {
      cachedInitDataRaw = sdkValue;
      return sdkValue;
    }
  } catch {}
  if (!cachedInitDataRaw) cachedInitDataRaw = readInitDataFromLocation();
  return cachedInitDataRaw || '';
}

function tryReadTelegramUserFromInitData() {
  const raw = getTelegramInitData();
  if (!raw) return null;
  try {
    const p = new URLSearchParams(raw);
    const userRaw = p.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || typeof user !== 'object') return null;
    return user;
  } catch {
    return null;
  }
}

function ensureTelegramWebAppScript() {
  if (typeof window === 'undefined') return;
  if (window.Telegram?.WebApp) return;
  if (tgScriptRequested) return;
  tgScriptRequested = true;

  try {
    const existing = document.querySelector(`script[src="${TG_WEBAPP_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => tryInitTelegramWebApp(), { once: true });
      tryInitTelegramWebApp();
      return;
    }

    const script = document.createElement('script');
    script.src = TG_WEBAPP_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => tryInitTelegramWebApp();
    script.onerror = () => {
      console.warn('Failed to load Telegram WebApp SDK');
    };
    document.head.appendChild(script);
  } catch (err) {
    console.warn('Telegram WebApp script injection failed', err);
  }
}

function tryInitTelegramWebApp() {
  if (tgInitDone) return;
  const candidate = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
  if (!candidate) return;
  tg = candidate;
  tgInitDone = true;
  try {
    tg.ready();
    tg.expand();
    const theme = tg.themeParams || {};
    const bg = theme.bg_color;
    if (bg) {
      document.body.style.backgroundColor = bg;
      document.documentElement.style.backgroundColor = bg;
    }
    const accent = theme.button_color || '#1ee0d7';
    document.documentElement.style.setProperty('--tf-accent', accent);
    const text = theme.text_color || '#e6f2ff';
    document.documentElement.style.setProperty('--tf-text', text);
  } catch (err) {
    console.warn('Telegram WebApp init failed', err);
  }
}

ensureTelegramWebAppScript();
tryInitTelegramWebApp();
if (!tgInitDone) {
  const start = Date.now();
  const timer = setInterval(() => {
    ensureTelegramWebAppScript();
    tryInitTelegramWebApp();
    if (tgInitDone || Date.now() - start > 5000) {
      clearInterval(timer);
      if (!tgInitDone) {
        console.warn('Telegram WebApp not detected; running in fallback mode');
      }
    }
  }, 100);
}
const audioContext = (() => {
  try {
    if (typeof AudioContext === 'undefined') return null;
    return new AudioContext();
  } catch (err) {
    console.warn('AudioContext init failed', err);
    return null;
  }
})();
const sfxBuffers = new Map();
let audioUnlocked = false;
const audioState = { enabled: true };
const net = {
  enabled: true,
  wsUrl: wsUrl || '',
  wsCandidates,
  wsCandidateIndex: 0,
  wsCandidateLocked: wsCandidatesLocked,
  everConnected: false,
  authRetryStartedAt: 0,
  ws: null,
  connected: false,
  id: null,
  side: null,
  snapshot: null,
  snapshotBuffer: { prev: null, curr: null },
  lastInput: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
  latencyMs: null,
  shouldReconnect: !!wsUrl,
  hasSnapshot: false,
  matchState: 'OFFLINE',
  players: new Map(),
  connectionState: 'idle',
  error: null,
  lastInputSentAt: 0,
  reconnectAttempts: 0,
  pingId: 0,
  lastPingTs: null,
  identity: null,
  manualRetry: false,
  snapshotIntervalMs: 33,
  errorMessage: '',
  avgPing: null,
  lastSnapshotAt: 0,
  stallTriggeredAt: 0,
};
const overlayDom = {
  root: null,
  text: null,
  sub: null,
};
let controlHintTimer = null;
let finishOverlayTimer = null;
let finishSubTimer = null;
const finishOverlayEl = { root: null };
let prevMatchState = null;
let inviteShownSession = false;
let inviteTimer = null;
const inviteDom = { root: null, btn: null };
const landscapeDom = { root: null, btn: null };
const landscapeState = { required: false, blocked: false, lockRequested: false };
const MOBILE_LANDSCAPE_SHORT_SIDE_MAX = 1024;
let matchCount = (() => {
  try {
    const v = parseInt(localStorage.getItem('tf_matches') || '0', 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
})();
const metricsEnabled = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_METRICS !== 'off') || params.get('metrics') === '1';
const sessionStartTs = metricsEnabled ? Date.now() : 0;
let sessionMatches = 0;
let lastKnownState = 'INIT';
let metricsSent = false;
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

let fatalErrorShown = false;
function showFatalError(err) {
  if (fatalErrorShown) return;
  fatalErrorShown = true;
  const message = typeof err === 'string' ? err : (err?.message || String(err));
  console.error('[fatal]', err);
  const el = document.getElementById('error-banner');
  if (el) {
    el.textContent = `Fatal error: ${message}`;
    el.style.display = 'block';
  }
}

window.addEventListener('error', (evt) => {
  showFatalError(evt?.error || evt?.message || 'Unknown error');
});
window.addEventListener('unhandledrejection', (evt) => {
  showFatalError(evt?.reason || 'Unhandled promise rejection');
});

function resolveIdentity() {
  const clampText = (value, maxLen, fallback = null) => {
    if (value == null) return fallback;
    const s = String(value).trim();
    if (!s) return fallback;
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  };
  const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user || tryReadTelegramUserFromInitData();
  const stored = safeLocalStorageGet('tf_identity');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const userId = clampText(parsed.userId, 64);
      const username = clampText(parsed.username, 32);
      if (userId && username) return { userId, username };
    } catch {}
  }
  const fallbackId = tgUser?.id ? `tg-${tgUser.id}` : `guest-${Math.random().toString(16).slice(2, 8)}`;
  const identity = {
    userId: clampText(tgUser?.id ? String(tgUser.id) : fallbackId, 64, fallbackId),
    username: clampText(tgUser?.username || `Player_${fallbackId.slice(-4)}`, 32, 'Player'),
  };
  safeLocalStorageSet('tf_identity', JSON.stringify(identity));
  return identity;
}

net.identity = resolveIdentity();

function isTouchDevice() {
  return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
}

function hasTelegramInitData() {
  try {
    const initData = getTelegramInitData();
    return typeof initData === 'string' && initData.length > 0;
  } catch {
    return false;
  }
}

function isProbablyTelegramUserAgent() {
  try {
    const ua = navigator.userAgent || '';
    // Telegram WebView UAs typically contain "Telegram". This is best-effort only.
    return /\bTelegram\b/i.test(ua);
  } catch {
    return false;
  }
}

function isLandscapeViewport() {
  return window.innerWidth >= window.innerHeight;
}

function shouldRequireLandscapeMode() {
  // Only enforce landscape inside the real Telegram Mini App environment.
  // In a normal mobile browser (even if `telegram-web-app.js` is loaded), we should not block gameplay.
  const force = (() => {
    const raw = params.get('landscape');
    return raw === '1' || raw === 'true';
  })();
  if (!force && !hasTelegramInitData()) return false;
  if (!isTouchDevice()) return false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return shortSide <= MOBILE_LANDSCAPE_SHORT_SIDE_MAX;
}

function syncLandscapeGate() {
  landscapeState.required = shouldRequireLandscapeMode();
  landscapeState.blocked = landscapeState.required && !isLandscapeViewport();
  document.body.classList.toggle('landscape-required', landscapeState.blocked);
  if (landscapeDom.root) {
    landscapeDom.root.classList.toggle('visible', landscapeState.blocked);
  }
}

async function requestLandscapeMode() {
  landscapeState.lockRequested = true;
  try {
    if (typeof tg?.requestFullscreen === 'function' && !tg.isFullscreen) {
      await tg.requestFullscreen();
    } else if (typeof tg?.expand === 'function') {
      tg.expand();
    }
  } catch (err) {
    console.warn('Telegram fullscreen request failed', err);
  }
  try {
    if (window.screen?.orientation?.lock) {
      await window.screen.orientation.lock('landscape');
    }
  } catch {}
  try {
    if (!document.fullscreenElement && document.documentElement?.requestFullscreen) {
      await document.documentElement.requestFullscreen();
      if (window.screen?.orientation?.lock) {
        await window.screen.orientation.lock('landscape');
      }
    }
  } catch {}
}


function enableShadows(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

async function loadOptionalGltf(url) {
  if (!url) return null;
  const LOAD_TIMEOUT_MS = 12000;
  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GLTF_TIMEOUT')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
  try {
    return await withTimeout(gltfLoader.loadAsync(url), LOAD_TIMEOUT_MS);
  } catch (err) {
    console.warn('Optional GLTF not found/failed:', url, err?.message || err);
    return null;
  }
}

function prefabForSide(side) {
  return playerPrefabs.get(side) || playerFallbackPrefab;
}

function buildFloorTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PALETTE.floor;
  ctx.fillRect(0, 0, 1024, 1024);

  const blobs = [
    { x: 210, y: 300, rx: 340, ry: 210, rot: 0.25 },
    { x: 640, y: 190, rx: 280, ry: 170, rot: -0.35 },
    { x: 520, y: 560, rx: 360, ry: 210, rot: 0.1 },
    { x: 190, y: 660, rx: 240, ry: 140, rot: -0.6 },
    { x: 820, y: 410, rx: 240, ry: 130, rot: 0.55 },
  ];
  ctx.fillStyle = PALETTE.floorPatch;
  blobs.forEach((b) => {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, b.rx, b.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

function buildRailTexture() {
  const railCanvas = document.createElement('canvas');
  railCanvas.width = 256;
  railCanvas.height = 64;
  const rctx = railCanvas.getContext('2d');
  rctx.fillStyle = PALETTE.railBase;
  rctx.fillRect(0, 0, 256, 64);
  rctx.fillStyle = PALETTE.railTile;
  for (let i = 0; i < 14; i++) {
    rctx.roundRect(6 + i * 18, 10, 14, 44, 5);
    rctx.fill();
  }
  const railTex = new THREE.CanvasTexture(railCanvas);
  railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping;
  railTex.repeat.set(22, 1);
  railTex.anisotropy = 2;
  return railTex;
}

function addVent(group, { x, z, rot = 0, color = 0x525a63, emissive = null, scale = 1 }) {
  const shape = new THREE.Shape();
  const w = 0.8 * scale;
  const h = 1.0 * scale;
  shape.moveTo(-w, -h * 0.1);
  shape.lineTo(0, h * 0.8);
  shape.lineTo(w, -h * 0.1);
  shape.closePath();

  const ventGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.05 * scale, bevelEnabled: false });
  const ventMat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.28,
    roughness: 0.35,
    emissive: emissive || 0x000000,
    emissiveIntensity: emissive ? 0.45 : 0,
  });
  const vent = new THREE.Mesh(ventGeom, ventMat);
  vent.rotation.set(-Math.PI / 2, 0, rot);
  vent.position.set(x, 0.026, z);
  group.add(vent);
}

function makeDrum(group, position, radius = 1.75, height = 0.7) {
  const bodyGeom = new THREE.CylinderGeometry(radius * 0.98, radius * 0.98, height, 42, 1, false);
  const bodyMat = new THREE.MeshStandardMaterial({ color: PALETTE.drumBody, roughness: 0.6, metalness: 0.18 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.set(position.x, height / 2, position.z);

  const topGeom = new THREE.CylinderGeometry(radius * 0.96, radius * 0.96, 0.1, 40);
  const top = new THREE.Mesh(topGeom, new THREE.MeshStandardMaterial({ color: PALETTE.drumTop, roughness: 0.35, metalness: 0.18 }));
  top.position.set(position.x, height + 0.05, position.z);

  const rimGeom = new THREE.TorusGeometry(radius * 0.9, 0.06, 10, 48);
  const rim = new THREE.Mesh(rimGeom, new THREE.MeshStandardMaterial({ color: PALETTE.drumRing, roughness: 0.35, metalness: 0.25 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(position.x, height + 0.05, position.z);

  const holeDepth = 0.9;
  const holeGeom = new THREE.CylinderGeometry(radius * 0.4, radius * 0.4, height * 1.4, 32, 1, true);
  const hole = new THREE.Mesh(
    holeGeom,
    new THREE.MeshStandardMaterial({ color: PALETTE.drumHole, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.05 })
  );
  hole.position.set(position.x, height * 0.55, position.z);

  const bolts = new THREE.Group();
  const boltGeom = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8);
  const boltMat = new THREE.MeshStandardMaterial({ color: PALETTE.metalDark, roughness: 0.4, metalness: 0.4 });
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const bx = position.x + Math.cos(a) * radius * 0.96;
    const bz = position.z + Math.sin(a) * radius * 0.96;
    const bolt = new THREE.Mesh(boltGeom, boltMat);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(bx, height + 0.03, bz);
    bolts.add(bolt);
  }

  group.add(body, top, rim, hole, bolts);
}

function makeSpawnPad(group, position) {
  const padRadius = 1.72;
  const padHeight = 0.72;

  const bodyGeom = new THREE.CylinderGeometry(padRadius * 0.96, padRadius, padHeight, 46);
  const bodyMat = new THREE.MeshStandardMaterial({ color: PALETTE.drumBody, roughness: 0.6, metalness: 0.18 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.set(position.x, padHeight / 2, position.z);

  const topGeom = new THREE.CylinderGeometry(padRadius * 0.94, padRadius * 0.94, 0.08, 46);
  const top = new THREE.Mesh(topGeom, new THREE.MeshStandardMaterial({ color: PALETTE.drumTop, roughness: 0.35, metalness: 0.15 }));
  top.position.set(position.x, padHeight + 0.04, position.z);

  const ringGeom = new THREE.TorusGeometry(padRadius * 0.9, 0.07, 10, 48);
  const ring = new THREE.Mesh(ringGeom, new THREE.MeshStandardMaterial({ color: PALETTE.drumRing, roughness: 0.35, metalness: 0.22 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(position.x, padHeight + 0.04, position.z);

  const hatchGeom = new THREE.CylinderGeometry(padRadius * 0.5, padRadius * 0.5, padHeight * 0.55, 32);
  const hatch = new THREE.Mesh(hatchGeom, new THREE.MeshStandardMaterial({ color: PALETTE.drumHole, roughness: 0.9, metalness: 0.05 }));
  hatch.position.set(position.x, padHeight * 0.58, position.z);

  const bolts = new THREE.Group();
  const boltGeom = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8);
  const boltMat = new THREE.MeshStandardMaterial({ color: PALETTE.metalDark, roughness: 0.4, metalness: 0.45 });
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const bx = position.x + Math.cos(a) * padRadius * 0.92;
    const bz = position.z + Math.sin(a) * padRadius * 0.92;
    const bolt = new THREE.Mesh(boltGeom, boltMat);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(bx, padHeight + 0.04, bz);
    bolts.add(bolt);
  }

  group.add(body, top, ring, hatch, bolts);
  SPAWN_PADS.push({ x: position.x, z: position.z });
}

function createArena() {
  const group = new THREE.Group();
  SPAWN_PADS.length = 0;

  const floorW = ARENA.width * 1.133;
  const floorH = ARENA.height * 1.1;
  const trackT = 0.5;
  const railH = 0.22;

  const outer = new THREE.Mesh(new THREE.PlaneGeometry(floorW + 5, floorH + 5), new THREE.MeshStandardMaterial({ color: PALETTE.outer, roughness: 0.96, metalness: 0.03 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.01;
  group.add(outer);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorH), new THREE.MeshStandardMaterial({ map: buildFloorTexture(), roughness: 0.9, metalness: 0.06 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const railMat = new THREE.MeshStandardMaterial({ map: buildRailTexture(), emissive: 0x00adb0, emissiveIntensity: 0.7, metalness: 0.22, roughness: 0.36 });
  const railGeomH = new THREE.BoxGeometry(floorW + trackT * 2, railH, trackT);
  const railGeomV = new THREE.BoxGeometry(trackT, railH, floorH + trackT * 2);
  const railTop = new THREE.Mesh(railGeomH, railMat);
  railTop.position.set(0, railH / 2, -floorH / 2 - trackT / 2);
  const railBottom = railTop.clone();
  railBottom.position.z = floorH / 2 + trackT / 2;
  const railLeft = new THREE.Mesh(railGeomV, railMat);
  railLeft.position.set(-floorW / 2 - trackT / 2, railH / 2, 0);
  const railRight = railLeft.clone();
  railRight.position.x = floorW / 2 + trackT / 2;

  [railTop, railBottom, railLeft, railRight].forEach((r) => {
    r.castShadow = true;
    r.receiveShadow = true;
    group.add(r);
  });

  const cornerRadius = trackT * 0.95;
  const cornerGeom = new THREE.CylinderGeometry(cornerRadius, cornerRadius, railH, 24);
  const cornerMat = railMat.clone();
  const cornerPos = [
    { x: -floorW / 2 - trackT / 2, z: -floorH / 2 - trackT / 2 },
    { x: floorW / 2 + trackT / 2, z: -floorH / 2 - trackT / 2 },
    { x: -floorW / 2 - trackT / 2, z: floorH / 2 + trackT / 2 },
    { x: floorW / 2 + trackT / 2, z: floorH / 2 + trackT / 2 },
  ];
  cornerPos.forEach((p) => {
    const c = new THREE.Mesh(cornerGeom, cornerMat);
    c.position.set(p.x, railH / 2, p.z);
    group.add(c);
  });

  const padOffsetX = floorW * 0.54;
  const padOffsetZ = floorH * 0.54;
  [
    { x: -padOffsetX, z: -padOffsetZ },
    { x: padOffsetX, z: -padOffsetZ },
    { x: -padOffsetX, z: padOffsetZ },
    { x: padOffsetX, z: padOffsetZ },
  ].forEach((p) => makeSpawnPad(group, p));

  addVent(group, { x: -floorW * 0.2, z: -floorH * 0.08, rot: Math.PI, emissive: 0x46d86c, scale: 1.05 });
  addVent(group, { x: floorW * 0.24, z: -floorH * 0.06, rot: Math.PI * 0.04, color: PALETTE.ventGray, scale: 1.0 });
  addVent(group, { x: floorW * 0.08, z: floorH * 0.18, rot: Math.PI * 0.28, emissive: 0x46d86c, scale: 1.05 });
  addVent(group, { x: -floorW * 0.22, z: floorH * 0.3, rot: Math.PI * 0.82, color: PALETTE.ventGray, scale: 1.1 });

  // top wooden arch
  const archY = 1.2;
  const arch = new THREE.Group();
  const plankGeom = new THREE.BoxGeometry(floorW * 0.62, 0.36, 0.4);
  const plankMat = new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.5, metalness: 0.05 });
  const plank = new THREE.Mesh(plankGeom, plankMat);
  plank.position.set(0, archY, -floorH * 0.62);
  const braceGeom = new THREE.BoxGeometry(0.2, 0.36, 0.5);
  const braceMat = new THREE.MeshStandardMaterial({ color: PALETTE.metalLight, roughness: 0.4, metalness: 0.25 });
  const braceL = new THREE.Mesh(braceGeom, braceMat);
  const braceR = braceL.clone();
  braceL.position.set(-plankGeom.parameters.width / 2 + 0.12, archY, -floorH * 0.62);
  braceR.position.set(plankGeom.parameters.width / 2 - 0.12, archY, -floorH * 0.62);
  arch.add(plank, braceL, braceR);
  group.add(arch);

  const bannerGeom = new THREE.BoxGeometry(2.4, 0.22, 0.08);
  const banner = new THREE.Mesh(
    bannerGeom,
    new THREE.MeshStandardMaterial({ color: 0x00c8e9, emissive: 0x00c8e9, emissiveIntensity: 0.65, roughness: 0.3, metalness: 0.1 })
  );
  banner.position.set(0, archY + 0.18, -floorH * 0.63);
  group.add(banner);

  scene.add(group);
  return group;
}

// arenaGroup is assigned after loading arena.glb; no temporary/test arena is added
let arenaGroup = null;
let arenaFloorY = 0;
let rinkDecorGroup = null;

function disposeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (!obj?.isMesh) return;
    if (obj.geometry?.dispose) obj.geometry.dispose();
    const mat = obj.material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => {
        if (m?.map?.dispose) m.map.dispose();
        if (m?.dispose) m.dispose();
      });
    } else if (mat) {
      if (mat.map?.dispose) mat.map.dispose();
      if (mat.dispose) mat.dispose();
    }
  });
}

function rebuildRinkDecor() {
  if (rinkDecorGroup) {
    scene.remove(rinkDecorGroup);
    disposeGroup(rinkDecorGroup);
    rinkDecorGroup = null;
  }

  const y0 = floorY();
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const wallH = 0.55;
  const wallT = 0.35;

  const group = new THREE.Group();
  group.name = 'tf_rink_decor';

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x10222b,
    roughness: 0.5,
    metalness: 0.25,
    emissive: 0x00adb0,
    emissiveIntensity: 0.22,
  });
  const wallGeomH = new THREE.BoxGeometry(ARENA.width + wallT * 2, wallH, wallT);
  const wallGeomV = new THREE.BoxGeometry(wallT, wallH, ARENA.height + wallT * 2);

  const topWall = new THREE.Mesh(wallGeomH, wallMat);
  topWall.position.set(0, y0 + wallH / 2, -halfH - wallT / 2);
  const bottomWall = topWall.clone();
  bottomWall.position.z = halfH + wallT / 2;

  const leftWall = new THREE.Mesh(wallGeomV, wallMat);
  leftWall.position.set(-halfW - wallT / 2, y0 + wallH / 2, 0);
  const rightWall = leftWall.clone();
  rightWall.position.x = halfW + wallT / 2;

  group.add(topWall, bottomWall, leftWall, rightWall);

  // Corner columns (slightly outside the rink) for framing, like in the reference.
  const colR = 0.58;
  const colH = 1.0;
  const colGeom = new THREE.CylinderGeometry(colR, colR, colH, 18);
  const colMat = new THREE.MeshStandardMaterial({
    color: 0x1a2a35,
    roughness: 0.42,
    metalness: 0.3,
    emissive: 0x00adb0,
    emissiveIntensity: 0.16,
  });
  [
    { x: -halfW - wallT / 2, z: -halfH - wallT / 2 },
    { x: halfW + wallT / 2, z: -halfH - wallT / 2 },
    { x: -halfW - wallT / 2, z: halfH + wallT / 2 },
    { x: halfW + wallT / 2, z: halfH + wallT / 2 },
  ].forEach((p) => {
    const c = new THREE.Mesh(colGeom, colMat);
    c.position.set(p.x, y0 + colH / 2, p.z);
    group.add(c);
  });

  // Tube/bumper posts at BallSpawn points so the player can see where the ball appears.
  const tubeR = ARENA_OBSTACLES.postRadius;
  const tubeH = 0.75;
  const tubeGeom = new THREE.CylinderGeometry(tubeR, tubeR, tubeH, 26);
  const tubeMat = new THREE.MeshStandardMaterial({
    color: 0x22313b,
    roughness: 0.55,
    metalness: 0.22,
    emissive: 0x00adb0,
    emissiveIntensity: 0.22,
  });
  const spawnPts = getBallSpawnPoints();
  spawnPts.forEach((p) => {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z)) return;
    const t = new THREE.Mesh(tubeGeom, tubeMat);
    t.position.set(p.x, y0 + tubeH / 2, p.z);
    group.add(t);
  });

  scene.add(group);
  rinkDecorGroup = group;
}

function computeArenaFloorY(arenaRoot) {
  if (!arenaRoot) return 0;
  // Raycasting depends on correct world matrices. This must run after arena scale/position adjustments.
  arenaRoot.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.far = 100;
  const dir = new THREE.Vector3(0, -1, 0);
  const samples = [
    new THREE.Vector3(0, 25, 0),
    new THREE.Vector3(0, 25, -ARENA.height * 0.25),
    new THREE.Vector3(0, 25, ARENA.height * 0.25),
    new THREE.Vector3(-ARENA.width * 0.25, 25, 0),
    new THREE.Vector3(ARENA.width * 0.25, 25, 0),
  ];

  for (const origin of samples) {
    raycaster.set(origin, dir);
    const hits = raycaster.intersectObject(arenaRoot, true);
    if (!hits.length) continue;
    // Prefer an upward-facing surface (the play floor).
    for (const h of hits) {
      const ny = h?.face?.normal?.y;
      if (typeof ny === 'number' && ny > 0.6) return h.point.y;
    }
    return hits[0].point.y;
  }
  return 0;
}

function floorY() {
  return arenaFloorY;
}

const playerMatColors = [0xff795a, 0xffd45c, 0x7ae7ff, 0xb28bff];
const playerPortraits = {};
const playerColorBySide = {
  top: 0xff9a46, // cat orange brighter
  right: 0xfafafa, // dog white brighter
  bottom: 0xffdf57, // duck yellow brighter
  left: 0x6f9ad1, // pigeon blue brighter
};
const sideHex = (side) => `#${(playerColorBySide[side] ?? 0xffffff).toString(16).padStart(6, '0')}`;

const SIDE_CENTER_YAW = {
  top: 0,
  right: -Math.PI / 2,
  bottom: Math.PI,
  left: Math.PI / 2,
};

function pickYawFacingCenterOrVelocity(playerRoot, side, velocity = null) {
  if (!playerRoot) return SIDE_CENTER_YAW[side] ?? 0;

  // Arcade rule: always face the arena center. Rotation never follows movement direction.
  // This matches Crash Bash Ballistix-style paddles.
  const dirX = -playerRoot.position.x;
  const dirZ = -playerRoot.position.z;

  if (dirX * dirX + dirZ * dirZ < 1e-8) {
    return SIDE_CENTER_YAW[side] ?? 0;
  }
  return Math.atan2(dirX, dirZ);
}

function applyPlayerFacing(playerRoot, side, velocity = null) {
  if (!playerRoot) return;
  const yaw = pickYawFacingCenterOrVelocity(playerRoot, side, velocity);
  playerRoot.rotation.set(0, yaw, 0);
}

function placeCharacterInBoat(character, boat, seat = null) {
  // Only adjust vertical placement. Rotation is handled separately so boat + character can share yaw.
  // Preserve prefab pivot/centering offsets from normalizePrefab(). Resetting to (0,0,0) after the
  // playerRoot refactor makes the boat appear attached to the character's neck/head for some assets.
  if (!character.userData._baseLocalPos) {
    character.userData._baseLocalPos = character.position.clone();
  }
  character.position.copy(character.userData._baseLocalPos);

  const charBox = new THREE.Box3().setFromObject(character);
  const charSize = new THREE.Vector3();
  charBox.getSize(charSize);
  if (charSize.y <= 1e-4) return;

  // Keep the boat around the character's torso/hips, not neck/head.
  const pelvisY = charBox.min.y + charSize.y * CHARACTER_PELVIS_Y_RATIO;
  if (seat) {
    character.position.y -= pelvisY;
    return;
  }

  const boatBox = new THREE.Box3().setFromObject(boat);
  const boatSize = new THREE.Vector3();
  boatBox.getSize(boatSize);
  const seatY = boatBox.min.y + boatSize.y * BOAT_SEAT_Y_RATIO;
  character.position.y += seatY - pelvisY;
}

const prefabHasSkinCache = new WeakMap();
function prefabHasSkinnedMeshes(root) {
  if (!root) return false;
  if (prefabHasSkinCache.has(root)) return prefabHasSkinCache.get(root);
  let found = false;
  root.traverse((child) => {
    if (child?.isSkinnedMesh) found = true;
  });
  prefabHasSkinCache.set(root, found);
  return found;
}

function clonePrefabSafe(prefab) {
  if (!prefab) return null;
  try {
    // Avoid SkeletonUtils.clone unless we actually need it (it can be expensive / flaky on some mobile WebViews).
    if (prefabHasSkinnedMeshes(prefab)) return cloneSkinned(prefab);
    return prefab.clone(true);
  } catch (err) {
    console.warn('Prefab clone failed; falling back', err);
    try {
      return prefab.clone(true);
    } catch {
      return null;
    }
  }
}

function createPlayer(colorIndex, side) {
  const characterPrefab = prefabForSide(side) || playerFallbackPrefab;

  if (boatPrefab && characterPrefab) {
    const playerRoot = new THREE.Object3D();
    playerRoot.name = 'playerRoot';
    playerRoot.userData.side = side;

    const boat = clonePrefabSafe(boatPrefab);
    boat.name = 'boat';
    boat.rotation.y = BOAT_YAW_OFFSET;
    enableShadows(boat);

    const character = clonePrefabSafe(characterPrefab);
    character.name = 'character';
    character.rotation.y = MODEL_YAW_OFFSET;
    enableShadows(character);

    placeCharacterInBoat(character, boat, null);
    playerRoot.add(boat);
    playerRoot.add(character);
    applyPlayerFacing(playerRoot, side);
    return playerRoot;
  }

  if (characterPrefab) {
    const playerRoot = new THREE.Object3D();
    playerRoot.name = 'playerRoot';
    playerRoot.userData.side = side;

    const character = clonePrefabSafe(characterPrefab);
    character.name = 'character';
    character.rotation.y = MODEL_YAW_OFFSET;
    enableShadows(character);

    // Keep the prefab's local pivot correction from normalizePrefab().
    playerRoot.add(character);
    applyPlayerFacing(playerRoot, side);
    return playerRoot;
  }

  const group = new THREE.Group();
  const color = playerColorBySide[side] ?? playerMatColors[colorIndex];
  const bodyGeom = new THREE.CapsuleGeometry(0.6, 0.8, 8, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.6 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.9;
  group.add(body);

  const headGeom = new THREE.SphereGeometry(0.55, 16, 12);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.y = 1.7;
  group.add(head);

  const noseGeom = new THREE.SphereGeometry(0.18, 12, 8);
  const nose = new THREE.Mesh(noseGeom, new THREE.MeshStandardMaterial({ color: 0x442a26, roughness: 0.4 }));
  nose.position.set(0, 1.6, 0.45);
  group.add(nose);

  const eyeGeom = new THREE.SphereGeometry(0.12, 10, 8);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000 });
  const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
  eyeL.position.set(-0.18, 1.75, 0.45);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.18;
  group.add(eyeL, eyeR);

  const browGeom = new THREE.BoxGeometry(0.26, 0.06, 0.02);
  const brow = new THREE.Mesh(browGeom, new THREE.MeshStandardMaterial({ color: 0x7b3b28 }));
  const browL = brow.clone();
  browL.position.set(-0.2, 1.9, 0.45);
  browL.rotation.z = 0.15;
  const browR = brow.clone();
  browR.position.set(0.2, 1.9, 0.45);
  browR.rotation.z = -0.15;
  group.add(browL, browR);

  // base (vehicle)
  const baseGeom = new THREE.CylinderGeometry(1.2, 1.3, 0.25, 16);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x222a3a, roughness: 0.75 });
  const base = new THREE.Mesh(baseGeom, baseMat);
  base.position.y = 0.1;
  group.add(base);

  const bumperGeom = new THREE.TorusGeometry(1.3, 0.18, 12, 24);
  const bumperMat = new THREE.MeshStandardMaterial({ color: 0xf05b4d, roughness: 0.5, metalness: 0.15, emissive: 0x3f0f0f, emissiveIntensity: 0.12 });
  const bumper = new THREE.Mesh(bumperGeom, bumperMat);
  bumper.rotation.x = Math.PI / 2;
  bumper.position.y = 0.2;
  group.add(bumper);

  group.rotation.y = (SIDE_CENTER_YAW[side] ?? 0) + MODEL_YAW_OFFSET;
  group.userData.side = side;
  return group;
}

function makeLabel(text, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(2.5, 0.7, 1);
  sprite.position.set(0, 1.8, 0);
  sprite.userData.texture = texture;
  return sprite;
}

function colorForSide(side) {
  const idx = sides.indexOf(side);
  return idx >= 0 ? `#${playerMatColors[idx].toString(16).padStart(6, '0')}` : '#ffffff';
}

async function loadSfx(name, url) {
  if (!audioContext || !url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const array = await res.arrayBuffer();
    // Placeholder/empty audio files should be silently ignored (avoid noisy decode warnings on mobile/iOS).
    if (!array?.byteLength) return null;
    const buffer = await audioContext.decodeAudioData(array);
    sfxBuffers.set(name, buffer);
    return buffer;
  } catch (e) {
    console.warn('SFX load failed', name, e);
    return null;
  }
}

function playSfx(name, volume = 0.8) {
  if (!audioContext || !audioUnlocked || !audioState.enabled) return;
  const buffer = sfxBuffers.get(name);
  if (!buffer) return;
  const src = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  gain.gain.value = volume;
  src.buffer = buffer;
  src.connect(gain).connect(audioContext.destination);
  src.start();
}

function unlockAudio() {
  if (audioUnlocked || !audioContext) return;
  audioContext.resume().then(() => {
    audioUnlocked = true;
  }).catch(() => {});
}

function fireHaptics(style = 'medium') {
  try {
    tg?.HapticFeedback?.impactOccurred?.(style);
  } catch (e) {
    // ignore haptic failures
  }
}

function triggerImpactFx() {
  ballFx.squashTime = ballFx.squashDuration;
  if (ballMesh?.scale) {
    ballMesh.scale.copy(impactScale);
  }
  camKick.time = camKick.duration;
}

function viewYawForSide(side) {
  // Rotate the camera so the local player is always "bottom" like in Crash Bash Ballistix.
  switch (side) {
    case 'top':
      return Math.PI;
    case 'left':
      return -Math.PI / 2;
    case 'right':
      return Math.PI / 2;
    case 'bottom':
    default:
      return 0;
  }
}

function currentViewYaw() {
  return viewYawForSide(net.side);
}

function applyCameraFromLocal(localPos) {
  const yaw = currentViewYaw();
  // `localPos` is a view-space offset from the fixed pivot (arena center).
  camTempPos.copy(camPivot).add(localPos).applyAxisAngle(camUp, yaw);
  camera.position.copy(camTempPos);
  camTempLook.set(camPivot.x, floorY(), camPivot.z + camLookZ).applyAxisAngle(camUp, yaw);
  camLookAt.copy(camTempLook);
  camera.lookAt(camLookAt);
}

function updateCameraPivot() {
  // Fixed gameplay camera: pivot stays at the arena center (view space).
  camPivot.set(0, floorY(), 0);
}

function updateCameraIntro(dt) {
  if (!camIntro.active) {
    camRestPos.copy(camBasePos);
    return;
  }
  camIntro.time = Math.min(camIntro.duration, camIntro.time + dt);
  const t = THREE.MathUtils.clamp(camIntro.time / camIntro.duration, 0, 1);
  const eased = t * t * (3 - 2 * t); // smoothstep
  tempVec3.lerpVectors(camIntro.start, camIntro.end, eased);
  camRestPos.copy(tempVec3);
  if (camIntro.time >= camIntro.duration) {
    camIntro.active = false;
  }
}

function updateVisualFx(dt) {
  updateCameraPivot();
  if (ballFx.squashTime > 0 && ballMesh?.scale) {
    ballFx.squashTime = Math.max(0, ballFx.squashTime - dt);
    const t = 1 - ballFx.squashTime / ballFx.squashDuration;
    const k = THREE.MathUtils.clamp(t, 0, 1);
    ballMesh.scale.lerpVectors(impactScale, normalScale, k);
    if (ballFx.squashTime === 0) {
      ballMesh.scale.copy(normalScale);
    }
  }
  if (camKick.time > 0) {
    camKick.time = Math.max(0, camKick.time - dt);
    const k = 1 - camKick.time / camKick.duration;
    const offset = THREE.MathUtils.lerp(camKick.strength, 0, k);
    tempVec3.set(camRestPos.x, camRestPos.y, camRestPos.z + offset);
    applyCameraFromLocal(tempVec3);
  } else {
    applyCameraFromLocal(camRestPos);
  }
}

function attachLabel(player, text) {
  if (player.label) {
    player.mesh.remove(player.label);
    if (player.label.material.map) player.label.material.map.dispose();
    player.label.material.dispose();
  }
  const label = makeLabel(text, colorForSide(player.side));
  player.mesh.add(label);
  player.label = label;
}

function attachPortrait(player, texture) {
  if (player.portrait) {
    player.mesh.remove(player.portrait);
    if (player.portrait.material.map) player.portrait.material.map.dispose();
    player.portrait.material.dispose();
  }
  if (!texture) return;
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  const aspect = texture.image ? texture.image.width / texture.image.height : 1;
  const baseH = 1.2;
  sprite.scale.set(baseH * aspect, baseH, 1);
  sprite.position.set(0, 2.5, 0);
  player.mesh.add(sprite);
  player.portrait = sprite;
}

const portraitCache = new Map();
function loadPortraitTexture(path) {
  if (portraitCache.has(path)) return portraitCache.get(path);
  const tex = texLoader.load(path, (texture) => {
    if (!texture.image) return;
    const c = document.createElement('canvas');
    c.width = texture.image.width;
    c.height = texture.image.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(texture.image, 0, 0);
    const imgData = ctx.getImageData(0, 0, c.width, c.height);
    const data = imgData.data;
    // simple chroma key: remove near-white/near-black background
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if ((r > 245 && g > 245 && b > 245) || (r < 10 && g < 10 && b < 10)) {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    texture.image = c;
    texture.needsUpdate = true;
  });
  portraitCache.set(path, tex);
  return tex;
}

const players = [];
const sides = ['top', 'right', 'bottom', 'left'];
const zeroVec3 = new THREE.Vector3();

function ensurePlayerMotionState(player) {
  if (!player.prevPos) player.prevPos = new THREE.Vector3().copy(player.mesh.position);
  if (!player.velocity) player.velocity = new THREE.Vector3();
}

function disposePlayer(player) {
  if (!player) return;
  if (player.label) {
    if (player.label.material.map) player.label.material.map.dispose();
    player.label.material.dispose();
    player.mesh.remove(player.label);
  }
  scene.remove(player.mesh);
}

function clearPlayers() {
  players.forEach(disposePlayer);
  players.length = 0;
}

function initOfflinePlayers() {
  clearPlayers();
  sides.forEach((side, idx) => {
    const mesh = createPlayer(idx, side);
    const pos = playerDefaultPosition(side);
    mesh.position.set(pos.x, floorY(), pos.z);
    scene.add(mesh);
    const player = { mesh, side, isLocal: idx === 0, id: idx === 0 ? 'local' : `bot-${idx}` };
    ensurePlayerMotionState(player);
    applyPlayerFacing(mesh, side);
    attachLabel(player, player.isLocal ? 'You' : `Bot ${idx}`);
    const portraitPath = playerPortraits[side];
    if (portraitPath) {
      const tex = loadPortraitTexture(portraitPath);
      attachPortrait(player, tex);
    }
    players.push(player);
  });
}

function applyPrefabsToExistingPlayers() {
  players.forEach((p) => {
    const newMesh = createPlayer(colorIndexBySide(p.side), p.side);
    if (!newMesh) return;
    newMesh.position.copy(p.mesh.position);
    newMesh.rotation.copy(p.mesh.rotation);
    scene.remove(p.mesh);
    p.mesh = newMesh;
    ensurePlayerMotionState(p);
    p.prevPos.copy(newMesh.position);
    scene.add(newMesh);
    attachLabel(p, p.isLocal ? (p.id === 'local' ? 'You' : p.id) : p.id || 'player');
    const portraitPath = playerPortraits[p.side];
    if (portraitPath) {
      const tex = loadPortraitTexture(portraitPath);
      attachPortrait(p, tex);
    }
  });
}

// players are spawned upon receiving snapshots from server

function playerDefaultPosition(side) {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const halfX = (PLAYER.collider?.x ?? 2.5) * 0.5;
  const halfZ = (PLAYER.collider?.z ?? ARENA.playerDepth ?? 0.6) * 0.5;
  switch (side) {
    case 'top':
      return { x: 0, z: -halfH + halfZ };
    case 'bottom':
      return { x: 0, z: halfH - halfZ };
    case 'left':
      return { x: -halfW + halfX, z: 0 };
    case 'right':
      return { x: halfW - halfX, z: 0 };
    default:
      return { x: 0, z: 0 };
  }
}

function makeBallTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(120, 100, 20, 130, 130, 120);
  grad.addColorStop(0, '#d9e5ff');
  grad.addColorStop(0.45, '#9bb6e8');
  grad.addColorStop(1, '#6f86b5');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(128, 128, 120, 0, Math.PI * 2);
  ctx.fill();
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(110, 90, 30, 18, -0.3, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

const BALL_VISUAL_RADIUS_FACTOR = (() => {
  // Visual-only scale multiplier relative to the authoritative physics radius.
  // Tweak quickly via `?ballScale=0.85`.
  const raw = params.get('ballScale');
  const parsed = raw == null ? null : Number(raw);
  if (Number.isFinite(parsed) && parsed > 0.2 && parsed < 1.5) return parsed;
  // Default: noticeably smaller than the player (visual-only).
  return 0.4;
})();

const ballState = {
  // Ball must be stationary after spawn. It only moves after a player hit / impulse.
  velocity: new THREE.Vector2(0, 0),
  radius: ARENA.ballRadius,
};
const ballVisualRadius = () => ballState.radius * BALL_VISUAL_RADIUS_FACTOR;
const lastBallPos = new THREE.Vector2();
const lastBallVel = new THREE.Vector2();
const tempVec2 = new THREE.Vector2();
const tempVec3 = new THREE.Vector3();
const tempNormalXZ = new THREE.Vector3();
const tempVel3 = new THREE.Vector3();
const impactScale = new THREE.Vector3(1.15, 0.85, 1.15);
const normalScale = new THREE.Vector3(1, 1, 1);
const ballFx = { squashTime: 0, squashDuration: 0.16 };
const MIN_REFLECTION_ANGLE = 0.2; // radians-ish component threshold to avoid wall-sticking

// Camera: fixed arcade angle (Crash Bash-style).
// Offsets are defined in "view space": rotate the whole view so the local player is always at the bottom,
// then apply a fixed pivot at the arena center. The camera does not pan/follow during gameplay.
const camPivot = new THREE.Vector3(0, 0, 0);

// `camBasePos` / `camRestPos` are view-space offsets from `camPivot`.
// Default tuned to:
// - keep the local player fully visible near the bottom
// - keep the bottom arena edge near the screen border (minimal "behind the player" space)
// - show the incoming ball trajectory without revealing the entire field at once
const camBasePos = new THREE.Vector3(0, 8.6, 10.8);
// MVP: fixed camera only (no shake/kick).
const camKick = { time: 0, duration: 0.15, strength: 0 };
const camIntro = {
  // MVP: fixed gameplay camera only (no intro movement).
  active: false,
  time: 0,
  duration: 0.82,
  start: new THREE.Vector3(camBasePos.x, camBasePos.y + 1.6, camBasePos.z + 1.6),
  end: camBasePos.clone(),
};
let camRestPos = camBasePos.clone();

function applyGameCameraPreset(resetIntro = false) {
  const num = (key) => {
    const raw = params.get(key);
    if (raw == null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };

  // Fixed-camera framing goal:
  // - tilted top-down view
  // - local player is fully visible near the bottom edge
  // - more visible space "in front" (toward arena center)
  // - avoids showing the entire arena at once
  //
  // Debug/tuning:
  // - `camFov`, `camHeight`/`camY`, `camBack`/`camZ`, `camLook`/`camLookZ`
  const fov = num('camFov') ?? 34;
  const height = num('camHeight') ?? num('camY') ?? 8.6;
  const back = num('camBack') ?? num('camZ') ?? 10.8;
  // Negative is "forward" in view space (toward arena center).
  const lookZ = num('camLook') ?? num('camLookZ') ?? -2.2;

  camera.fov = fov;
  camLookZ = lookZ;
  camBasePos.set(0, height, back);
  camRestPos.copy(camBasePos);
  camera.updateProjectionMatrix();

  // If the intro animation is active, keep its target synced with the latest preset.
  camIntro.end.copy(camBasePos);
  if (resetIntro) {
    // Keep gameplay camera fixed (no intro movement).
    camIntro.active = false;
    camIntro.time = 0;
  }
}
const ui = {
  sceneReady: false,
  arenaReady: false,
  prefabsReady: false,
  prefabsLoadStartedAt: 0,
  overlayState: '',
  hintShown: false,
};

const input = {
  moveX: 0,
  moveZ: 0,
  forward: false,
  back: false,
  left: false,
  right: false,
  touchActive: false,
  dragActive: false,
  source: 'idle',
};

const keyState = { up: false, down: false, left: false, right: false };

const ballGeom = new THREE.SphereGeometry(ballVisualRadius(), 36, 22);
const ballMat = new THREE.MeshStandardMaterial({
  color: 0xa7c2e0,
  map: makeBallTexture(),
  roughness: 0.22,
  metalness: 0.2,
  emissive: 0x1b3050,
  emissiveIntensity: 0.1,
  envMapIntensity: 0.35,
});
let ballMesh = new THREE.Mesh(ballGeom, ballMat);
ballMesh.castShadow = true;
ballMesh.position.y = ballVisualRadius();
scene.add(ballMesh);
normalScale.copy(ballMesh.scale);
impactScale.copy(ballMesh.scale).multiply(new THREE.Vector3(1.15, 0.85, 1.15));

const blobTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  grd.addColorStop(0, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(c);
})();

function makeBlobShadow(radius = 1) {
  const mat = new THREE.SpriteMaterial({ map: blobTexture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(radius * 2, radius * 2, 1);
  sprite.position.set(0, 0.02, 0);
  return sprite;
}

const shadowMesh = makeBlobShadow(ballVisualRadius());
scene.add(shadowMesh);
lastBallPos.set(ballMesh.position.x, ballMesh.position.z);

function initOverlayDom() {
  overlayDom.root = document.getElementById('investor-overlay');
  overlayDom.text = document.getElementById('investor-overlay__text');
  overlayDom.sub = document.getElementById('investor-overlay__subtext');
  finishOverlayEl.root = document.getElementById('finish-overlay');
  finishOverlayEl.sub = finishOverlayEl.root?.querySelector('.finish-sub') || null;
  inviteDom.root = document.getElementById('invite-overlay');
  inviteDom.btn = document.getElementById('invite-btn');
  landscapeDom.root = document.getElementById('landscape-overlay');
  landscapeDom.btn = document.getElementById('landscape-btn');
}

function updateOverlay() {
  if (!overlayDom.root) return;
  const playerCount = net.players.size || 0;
  const next = (() => {
    if (!ui.arenaReady) return 'LOADING';
    if (!net.connected) {
      const errCode = net.error?.code || net.error?.reason;
      if (net.connectionState === 'error' && (errCode || net.errorMessage)) return 'ERROR';
      return 'CONNECTING';
    }
    if (!ui.prefabsReady) {
      const loadingMs = ui.prefabsLoadStartedAt ? (Date.now() - ui.prefabsLoadStartedAt) : 0;
      // Fail-open for Telegram mobile: if model loading is taking too long while we're already in a live room,
      // don't block gameplay behind the fullscreen loading overlay.
      if (loadingMs > 12000 && (net.matchState === 'IN_PROGRESS' || playerCount > 0)) return 'HIDE';
      return 'LOADING_PLAYERS';
    }
    if (net.matchState === 'WAITING' || playerCount < 4) return 'WAITING';
    return 'HIDE';
  })();
  if (next === ui.overlayState) {
    return;
  }
  ui.overlayState = next;
  const root = overlayDom.root;
  const text = overlayDom.text;
  const sub = overlayDom.sub;
  switch (next) {
    case 'LOADING':
      text.textContent = 'Total Fun';
      sub.textContent = 'Loading…';
      root.classList.add('visible');
      break;
    case 'ERROR': {
      const errCode = net.error?.code || net.error?.reason;
      text.textContent = 'Connection error';
      sub.textContent = net.errorMessage || (errCode ? String(errCode) : '');
      root.classList.add('visible');
      break;
    }
    case 'CONNECTING':
      text.textContent = 'Connecting…';
      sub.textContent = net.reconnectAttempts > 0 ? `Retry ${net.reconnectAttempts}` : '';
      root.classList.add('visible');
      break;
    case 'LOADING_PLAYERS':
      text.textContent = 'Total Fun';
      sub.textContent = 'Loading characters…';
      root.classList.add('visible');
      break;
    case 'WAITING':
      text.textContent = 'Waiting for players';
      sub.textContent = `${playerCount}/4 ready`;
      root.classList.add('visible');
      break;
    default:
      root.classList.remove('visible');
      text.textContent = '';
      sub.textContent = '';
  }
}

function showFinishOverlay() {
  const el = finishOverlayEl.root;
  if (!el) return;
  el.classList.add('visible');
  el.classList.remove('sub-visible');
  if (finishOverlayTimer) clearTimeout(finishOverlayTimer);
  if (finishSubTimer) clearTimeout(finishSubTimer);
  finishSubTimer = setTimeout(() => {
    el.classList.add('sub-visible');
    finishSubTimer = null;
  }, 800);
  finishOverlayTimer = setTimeout(() => {
    el.classList.remove('visible');
    el.classList.remove('sub-visible');
    finishOverlayTimer = null;
  }, 2500);
}

function hideFinishOverlay() {
  const el = finishOverlayEl.root;
  if (!el) return;
  el.classList.remove('visible');
  el.classList.remove('sub-visible');
  if (finishOverlayTimer) {
    clearTimeout(finishOverlayTimer);
    finishOverlayTimer = null;
  }
  if (finishSubTimer) {
    clearTimeout(finishSubTimer);
    finishSubTimer = null;
  }
}

function showInviteOverlay() {
  if (inviteShownSession) return;
  const el = inviteDom.root;
  if (!el) return;
  el.classList.add('visible');
  inviteShownSession = true;
  if (inviteTimer) clearTimeout(inviteTimer);
  inviteTimer = setTimeout(hideInviteOverlay, 4000);
}

function hideInviteOverlay() {
  const el = inviteDom.root;
  if (!el) return;
  el.classList.remove('visible');
  if (inviteTimer) {
    clearTimeout(inviteTimer);
    inviteTimer = null;
  }
}

function setBallRadiusFromObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const radius = Math.max(size.x, size.z) / 2;
  if (radius > 0.05) {
    ballState.radius = radius;
  }
}

function normalizeBallModel(model) {
  if (!model) return model;
  // Wrap the imported GLB so we can recenter/scale without fighting external positioning.
  const root = new THREE.Object3D();
  root.name = 'ballRoot';
  root.add(model);

  // Scale the imported GLB so its XZ radius matches our desired visual radius.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const radius = Math.max(size.x, size.z) / 2;
  const desired = ballVisualRadius();
  if (!(radius > 0.05) || !(desired > 0.01)) return root;

  const center = new THREE.Vector3();
  box.getCenter(center);
  // Recenter inside the wrapper (keeps the wrapper position as the true "ball position").
  model.position.sub(center);

  const factor = desired / radius;
  if (Number.isFinite(factor) && factor > 0) {
    root.scale.multiplyScalar(factor);
  }
  return root;
}

function applyDirectionalFlags() {
  // Gameplay is 1D per-player (paddles slide along their wall). Make controls stable:
  // - Use ONLY horizontal stick axis (prevents diagonal drift slowing movement).
  // - Remap per-side so local player always controls left/right in screen space.
  const dead = 0.08;
  const side = net.side || 'bottom';
  const axis = Math.abs(input.moveX) > dead ? input.moveX : 0;

  input.forward = false;
  input.back = false;
  input.left = false;
  input.right = false;

  if (side === 'bottom') {
    input.left = axis < -dead;
    input.right = axis > dead;
    return;
  }
  if (side === 'top') {
    // Camera is rotated 180deg for the local top player, so swap left/right.
    input.left = axis > dead;
    input.right = axis < -dead;
    return;
  }
  if (side === 'left') {
    // Camera is rotated -90deg: screen left/right maps to world forward/back.
    input.forward = axis < -dead;
    input.back = axis > dead;
    return;
  }
  if (side === 'right') {
    // Camera is rotated +90deg: screen left/right maps to world back/forward.
    input.forward = axis > dead;
    input.back = axis < -dead;
  }
}

function setMoveVector(x, z, source = 'unknown') {
  const len = Math.hypot(x, z);
  const nx = len > 1 ? x / len : x;
  const nz = len > 1 ? z / len : z;
  input.moveX = nx;
  input.moveZ = nz;
  input.source = source;
  applyDirectionalFlags();
  hideControlHint();
}

function recomputeKeyboardVector() {
  const x = (keyState.right ? 1 : 0) - (keyState.left ? 1 : 0);
  const z = (keyState.down ? 1 : 0) - (keyState.up ? 1 : 0);
  if (input.touchActive || input.dragActive) return;
  setMoveVector(x, z, 'keyboard');
}

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (['ArrowUp', 'KeyW'].includes(e.code)) { keyState.up = true; e.preventDefault(); }
  if (['ArrowDown', 'KeyS'].includes(e.code)) { keyState.down = true; e.preventDefault(); }
  if (['ArrowLeft', 'KeyA'].includes(e.code)) { keyState.left = true; e.preventDefault(); }
  if (['ArrowRight', 'KeyD'].includes(e.code)) { keyState.right = true; e.preventDefault(); }
  recomputeKeyboardVector();
});

window.addEventListener('keyup', (e) => {
  if (['ArrowUp', 'KeyW'].includes(e.code)) keyState.up = false;
  if (['ArrowDown', 'KeyS'].includes(e.code)) keyState.down = false;
  if (['ArrowLeft', 'KeyA'].includes(e.code)) keyState.left = false;
  if (['ArrowRight', 'KeyD'].includes(e.code)) keyState.right = false;
  recomputeKeyboardVector();
});

function bindTouchControls() {
  const root = document.getElementById('touch-controls');
  const thumb = document.getElementById('stick-thumb');
  if (!root || !thumb) return;
  let pointerId = null;

  const resetStick = () => {
    // Center based on actual DOM sizes (more robust than hardcoding 44px).
    const rect = root.getBoundingClientRect();
    const tr = thumb.getBoundingClientRect();
    const base = rect.width || 160;
    const th = tr.width || 72;
    const center = (base - th) / 2;
    thumb.style.transform = `translate(${center}px, ${center}px)`;
    input.touchActive = false;
    setMoveVector(0, 0, 'touch');
    recomputeKeyboardVector();
  };

  const handleMove = (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    const rect = root.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const maxR = rect.width / 2;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, maxR);

    const ux = dist < 1e-6 ? 0 : (dx / dist);
    const uy = dist < 1e-6 ? 0 : (dy / dist);

    // Move thumb proportionally; don't snap to the edge (prevents "auto full speed" feeling).
    const tr = thumb.getBoundingClientRect();
    const th = tr.width || 72;
    const center = (rect.width - th) / 2;
    const maxTravel = center;
    const travel = maxR > 1e-6 ? Math.min(maxTravel, (clampedDist / maxR) * maxTravel) : 0;
    thumb.style.transform = `translate(${center + ux * travel}px, ${center + uy * travel}px)`;

    // Analog stick: -1..1 relative to base radius (y axis: up = negative dy).
    let mx = maxR > 1e-6 ? (dx / maxR) : 0;
    let mz = maxR > 1e-6 ? (dy / maxR) : 0;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) {
      mx /= mlen;
      mz /= mlen;
    }
    setMoveVector(mx, mz, 'touch');
  };

  root.addEventListener('pointerdown', (e) => {
    if (pointerId != null && e.pointerId !== pointerId) return; // allow multitouch elsewhere
    e.preventDefault();
    pointerId = e.pointerId;
    root.setPointerCapture(pointerId);
    input.touchActive = true;
    handleMove(e);
    hideControlHint();
  });
  root.addEventListener('pointermove', handleMove);
  const end = (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    pointerId = null;
    resetStick();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
}

function bindDragControls() {
  const canvas = renderer?.domElement;
  if (!canvas) return;
  let pointerId = null;
  let origin = { x: 0, y: 0 };

  const end = (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    canvas.releasePointerCapture(pointerId);
    pointerId = null;
    input.dragActive = false;
    setMoveVector(0, 0, 'drag');
    recomputeKeyboardVector();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointerId = e.pointerId;
    origin = { x: e.clientX, y: e.clientY };
    input.dragActive = true;
    setMoveVector(0, 0, 'drag');
    canvas.setPointerCapture(pointerId);
    e.preventDefault();
    hideControlHint();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    const clamp = 90;
    const nx = THREE.MathUtils.clamp(dx / clamp, -1, 1);
    const nz = THREE.MathUtils.clamp(dy / clamp, -1, 1);
    setMoveVector(nx, nz, 'drag');
  });

  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
}

function bindNetControls() {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('touchstart', unlock, { once: true });
  const ctaRetry = document.getElementById('cta-retry');
  if (ctaRetry) {
    ctaRetry.addEventListener('click', async () => {
      net.manualRetry = true;
      stopNet();
      net.shouldReconnect = true;
      await startNet(net.wsUrl);
      net.manualRetry = false;
      ctaRetry.style.display = 'none';
    });
  }
}

function bindGameUiControls() {
  // no local start/reset controls in MVP
}

function applyNetPanelVisibility() {
  const netPanel = document.getElementById('net-panel');
  const hud = document.getElementById('hud');
  const debugFlag = params.get('debug');
  const visible = debugFlag === '1' || debugFlag === 'true';
  if (netPanel) netPanel.classList.toggle('net-panel--visible', visible);
  if (hud) hud.classList.toggle('hud--visible', visible);
}

function getCountdownEl() {
  let el = document.getElementById('countdown-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'countdown-overlay';
    document.body.appendChild(el);
  }
  return el;
}

function showControlHint() {
  const el = document.getElementById('control-hint');
  if (!el || ui.hintShown) return;
  el.classList.add('visible');
  if (controlHintTimer) clearTimeout(controlHintTimer);
  controlHintTimer = setTimeout(hideControlHint, 3000);
}

function hideControlHint() {
  const el = document.getElementById('control-hint');
  if (!el) return;
  el.classList.remove('visible');
  ui.hintShown = true;
  try { localStorage.setItem('tf_hint_shown', '1'); } catch {}
  if (controlHintTimer) clearTimeout(controlHintTimer);
  controlHintTimer = null;
}

function applyConfigFromServer(cfg = {}) {
  if (cfg.arena) {
    ARENA.width = cfg.arena.width ?? ARENA.width;
    ARENA.height = cfg.arena.height ?? ARENA.height;
    ARENA.playerDepth = cfg.arena.playerDepth ?? ARENA.playerDepth;
    ARENA.ballRadius = cfg.arena.ballRadius ?? ARENA.ballRadius;
    ballState.radius = ARENA.ballRadius;
  }
  const phys = cfg.physics;
  if (phys?.player) {
    PLAYER.collider = phys.player.collider || PLAYER.collider;
    PLAYER.speed = phys.player.speed || PLAYER.speed;
  }
  if (phys?.ball) {
    PHYSICS.minSpeed = phys.ball.minSpeed ?? PHYSICS.minSpeed;
    PHYSICS.maxSpeed = phys.ball.maxSpeed ?? PHYSICS.maxSpeed;
    PHYSICS.damping = phys.ball.damping ?? PHYSICS.damping;
  }
  if (cfg.field) {
    const w = Number(cfg.field.width);
    const h = Number(cfg.field.height);
    if (Number.isFinite(w) && w > 0.5) FIELD.width = w;
    if (Number.isFinite(h) && h > 0.5) FIELD.height = h;
  } else if (cfg.arena || phys?.player) {
    recomputeBallField();
  }
  if (cfg.roomTimeoutMs != null) {
    window.SERVER_CONFIG = window.SERVER_CONFIG || {};
    window.SERVER_CONFIG.roomTimeoutMs = cfg.roomTimeoutMs;
  }
}

function applyDebugUi() {}

function offlineKickoffCorners() {
  const spawnX = ARENA.width / 2 - ARENA.ballRadius - OFFLINE_KICKOFF_CORNER_MARGIN;
  const spawnZ = ARENA.height / 2 - ARENA.ballRadius - OFFLINE_KICKOFF_CORNER_MARGIN;
  return [
    { x: -spawnX, z: -spawnZ },
    { x: spawnX, z: -spawnZ },
    { x: spawnX, z: spawnZ },
    { x: -spawnX, z: spawnZ },
  ];
}

function resetBall() {
  if (net.connected) return;
  const spawnIdx = nextSpawnPad;
  nextSpawnPad += 1;
  const spawnPos = new THREE.Vector3();
  const spawnNode = arenaSpawnNodes.length ? arenaSpawnNodes[spawnIdx % arenaSpawnNodes.length] : null;
  if (spawnNode) {
    spawnNode.updateMatrixWorld(true);
    spawnNode.getWorldPosition(spawnPos);
  } else if (SPAWN_PADS.length) {
    const pad = SPAWN_PADS[spawnIdx % SPAWN_PADS.length];
    spawnPos.set(pad.x, 0, pad.z);
  } else {
    const pad = offlineKickoffCorners()[spawnIdx % 4];
    spawnPos.set(pad.x, 0, pad.z);
  }
  ballMesh.position.copy(spawnPos);
  ballMesh.position.y = floorY() + ballVisualRadius();
  shadowMesh.position.x = spawnPos.x;
  shadowMesh.position.z = spawnPos.z;
  shadowMesh.position.y = floorY() + 0.02;
  // Stationary until a player hit provides an impulse.
  ballState.velocity.set(0, 0);
}

resetBall();


function scheduleReconnect() {
  if (!net.shouldReconnect) return;
  const backoff = [1000, 2000, 3000, 5000, 8000];
  const delay = backoff[Math.min(net.reconnectAttempts, backoff.length - 1)];
  net.reconnectAttempts += 1;
  if (net.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    net.shouldReconnect = false;
    net.connectionState = 'error';
    net.error = { code: 'RECONNECT_MAX' };
    net.errorMessage = 'Max reconnect attempts reached';
    showReconnectCta();
    return;
  }
  net.connectionState = 'reconnecting';
  if (net.reconnectTimer) clearTimeout(net.reconnectTimer);
  net.reconnectTimer = setTimeout(() => connectWebSocket(net.wsUrl), delay);
}

function handleNetMessage(raw) {
  try {
    const msg = JSON.parse(raw?.data ?? raw);
    if (msg.type === 'PING') {
      const ts = msg.payload?.ts;
      if (ts) {
        const sample = Date.now() - ts;
        net.latencyMs = net.latencyMs == null ? sample : THREE.MathUtils.lerp(net.latencyMs, sample, 0.3);
        net.avgPing = net.avgPing == null ? sample : THREE.MathUtils.lerp(net.avgPing, sample, 0.08);
      }
      net.ws?.send(JSON.stringify({ type: 'PONG', payload: { pingId: msg.payload?.pingId, ts: msg.payload?.ts } }));
      return;
    }
    if (msg.type === 'WELCOME') {
      net.connectionState = 'connected';
      net.connected = true;
      net.everConnected = true;
      net.authRetryStartedAt = 0;
      net.error = null;
      net.reconnectAttempts = 0;
      net.id = msg.payload?.playerId;
      net.side = msg.payload?.side;
      net.matchState = msg.payload?.matchState || net.matchState;
      if (!net.wsCandidateLocked) {
        // Persist the last known working WS URL so Telegram menu launches don't need query params.
        safeLocalStorageSet('tf_ws_url', net.wsUrl);
      }
      if (msg.payload?.tickRate) net.tickRate = msg.payload.tickRate;
      if (msg.payload?.snapshotRate) {
        net.snapshotRate = msg.payload.snapshotRate;
        net.snapshotIntervalMs = 1000 / msg.payload.snapshotRate;
      }
      if (msg.payload?.arena) {
        ARENA.width = msg.payload.arena.width ?? ARENA.width;
        ARENA.height = msg.payload.arena.height ?? ARENA.height;
        ARENA.playerDepth = msg.payload.arena.playerDepth ?? ARENA.playerDepth;
        ARENA.ballRadius = msg.payload.arena.ballRadius ?? ballState.radius;
        ballState.radius = ARENA.ballRadius;
      }
      if (msg.payload?.physics || msg.payload?.config || msg.payload?.field) {
        applyConfigFromServer({ physics: msg.payload.physics, arena: msg.payload.arena, field: msg.payload.field });
      }
      return;
    }
    if (msg.type === 'ROOM_STATE') {
      net.matchState = msg.payload?.matchState || net.matchState;
      net.players.clear();
      (msg.payload?.players || []).forEach((p) => {
        const pid = p.playerId || p.id;
        net.players.set(pid, { ...p, playerId: pid });
      });
      return;
    }
    if (msg.type === 'SNAPSHOT') {
      net.matchState = msg.payload?.matchState || net.matchState;
      net.matchReason = msg.payload?.matchReason || null;
      if (!net.hasSnapshot) {
        clearPlayers();
        net.hasSnapshot = true;
      }
      net.lastSnapshotAt = performance.now();
      net.stallTriggeredAt = 0;
      net.snapshotBuffer.prev = net.snapshotBuffer.curr;
      net.snapshotBuffer.curr = { t: msg.t, payload: msg.payload, recvAt: performance.now(), sentAt: msg.ts || performance.now() };
      net.snapshot = msg;
      return;
    }
    if (msg.type === 'ERROR') {
      net.error = msg.payload;
      net.connectionState = 'error';
      console.warn('[net] error', msg.payload);
      const code = msg.payload?.code;
      const message = msg.payload?.message ? String(msg.payload.message) : '';

      if (code === 'BAD_AUTH') {
        const reason = message ? ` (${message})` : '';
        const missingInitData = message === 'MISSING_INITDATA' || message === 'NO_HASH' || message === 'PARSE_ERROR';

        // On some mobile devices `telegram-web-app.js` / initData can be late. Retry briefly instead of failing hard.
        if (missingInitData && isProbablyTelegramUserAgent()) {
          if (!net.authRetryStartedAt) net.authRetryStartedAt = Date.now();
          if (Date.now() - net.authRetryStartedAt < 15000) {
            net.shouldReconnect = true;
            net.errorMessage = `Waiting for Telegram initData…${reason}`;
          } else {
            net.shouldReconnect = false;
            net.errorMessage = `Authentication failed${reason}. Open the game via the bot Menu Button Web App inside Telegram.`;
          }
        } else {
          net.authRetryStartedAt = 0;
          net.shouldReconnect = false;
          if (isProbablyTelegramUserAgent() && !hasTelegramInitData()) {
            net.errorMessage = `Authentication failed${reason}. Open the game via the bot Menu Button Web App inside Telegram (not a regular link).`;
          } else {
            net.errorMessage = `Authentication failed${reason}. Please relaunch from Telegram.`;
          }
        }
      }

      if (['BAD_HELLO', 'ROOM_FULL'].includes(code)) net.shouldReconnect = false;
      return;
    }
    if (msg.type === 'MATCH_EVENT') {
      net.matchState = msg.payload?.event?.replace('MATCH_', '') || net.matchState;
      if (net.matchState === 'READY') {
        readyEndsAt = Date.now() + READY_DURATION_MS;
      } else {
        readyEndsAt = null;
      }
      return;
    }
  } catch (err) {
    console.warn('Bad net message', err);
  }
}

function connectWebSocket(url) {
  const normalized = normalizeWsUrl(url);
  if (!normalized || !net.shouldReconnect) return;
  if (net.ws) {
    net.ws.close();
    net.ws = null;
  }
  if (net.reconnectTimer) {
    clearTimeout(net.reconnectTimer);
    net.reconnectTimer = null;
  }
  net.ws = new WebSocket(normalized);
  net.connectionState = 'connecting';
  net.ws.addEventListener('open', () => {
    net.connectionState = 'handshake';
    net.reconnectAttempts = 0;
    net.error = null;
    let helloSent = false;
    const sendHello = () => {
      if (helloSent) return;
      if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
      helloSent = true;
      const hello = {
        type: 'HELLO',
        payload: {
          userId: net.identity?.userId,
          username: net.identity?.username,
          initData: getTelegramInitData() || null,
        },
      };
      net.ws.send(JSON.stringify(hello));
    };

    // In Telegram Mini Apps the `telegram-web-app.js` can still be late on some devices.
    // If we send HELLO before `initData` exists, server auth can reject with BAD_AUTH.
    if (isProbablyTelegramUserAgent() && !hasTelegramInitData()) {
      const start = performance.now();
      const poll = () => {
        if (hasTelegramInitData()) {
          sendHello();
          return;
        }
        if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
        if (performance.now() - start > 8000) {
          // Fail open: send without initData (dev servers may allow it).
          sendHello();
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    } else {
      sendHello();
    }
  });
  net.ws.addEventListener('message', (evt) => handleNetMessage(evt));
  net.ws.addEventListener('close', (evt) => {
    const canFallback = !net.everConnected && !net.wsCandidateLocked && Array.isArray(net.wsCandidates) && net.wsCandidateIndex < net.wsCandidates.length - 1;
    net.connected = false;
    net.connectionState = 'disconnected';
    net.side = null;
    net.snapshot = null;
    net.hasSnapshot = false;
    const closeCode = Number(evt?.code || 0);
    const closeReason = String(evt?.reason || '');
    const knownClose = {
      4400: { code: 'BAD_HELLO', reconnect: false },
      4401: { code: 'BAD_AUTH', reconnect: false },
      4402: { code: 'BAD_ORDER', reconnect: false },
      4403: { code: 'ROOM_FULL', reconnect: false },
      4408: { code: 'RATE_CONN', reconnect: true },
      4409: { code: 'ALREADY_CONNECTED', reconnect: false },
    };
    if (knownClose[closeCode]) {
      const info = knownClose[closeCode];
      net.error = { code: info.code, message: closeReason || info.code };
      net.errorMessage = closeReason ? `${info.code}: ${closeReason}` : info.code;
      if (!info.reconnect) net.shouldReconnect = false;
    } else {
      net.errorMessage = closeCode ? `Connection closed (${closeCode})` : '';
    }
    if (net.shouldReconnect && !net.manualRetry) {
      if (canFallback) {
        net.wsCandidateIndex += 1;
        net.wsUrl = net.wsCandidates[net.wsCandidateIndex];
        net.reconnectAttempts = 0;
        // Try the next candidate immediately.
        setTimeout(() => connectWebSocket(net.wsUrl), 0);
        return;
      }
      scheduleReconnect();
    }
  });
  net.ws.addEventListener('error', (e) => {
    console.warn('[net] error', e);
    const canFallback = !net.everConnected && !net.wsCandidateLocked && Array.isArray(net.wsCandidates) && net.wsCandidateIndex < net.wsCandidates.length - 1;
    net.connected = false;
    net.connectionState = 'error';
    net.snapshot = null;
    net.hasSnapshot = false;
    net.errorMessage = e?.message || 'Network error';
    if (net.shouldReconnect && !net.manualRetry) {
      if (canFallback) {
        net.wsCandidateIndex += 1;
        net.wsUrl = net.wsCandidates[net.wsCandidateIndex];
        net.reconnectAttempts = 0;
        setTimeout(() => connectWebSocket(net.wsUrl), 0);
        return;
      }
      scheduleReconnect();
    }
  });
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTelegramBeforeNetworking() {
  const shouldWait = isProbablyTelegramUserAgent() || !!window?.Telegram?.WebApp;
  if (!shouldWait) return;

  ensureTelegramWebAppScript();
  if (hasTelegramInitData()) {
    // Init data is already present (e.g. parsed from launch URL hash); don't delay connection.
    return;
  }

  // Wait for `telegram-web-app.js` to initialize `window.Telegram.WebApp` (can be late on mobile).
  const start = performance.now();
  while (!window?.Telegram?.WebApp && performance.now() - start < 5000) {
    await waitMs(50);
  }

  // Signal readiness to Telegram (hides the native loading state/spinner).
  tryInitTelegramWebApp();
  try {
    window.Telegram?.WebApp?.ready?.();
  } catch {}

  // If initData is still empty, give Telegram a brief moment to populate it before opening WS.
  if (!hasTelegramInitData()) {
    await waitMs(300);
  }
}

async function bootNet() {
  if (!net.enabled) return;
  if (!net.wsUrl) return;
  await waitForTelegramBeforeNetworking();
  net.shouldReconnect = true;
  connectWebSocket(net.wsUrl);
}

bootNet().catch((err) => console.warn('[net] bootstrap failed', err));

function stopNet() {
  net.shouldReconnect = false;
  net.connected = false;
  net.id = null;
  net.side = null;
  net.snapshot = null;
  net.latencyMs = null;
  net.hasSnapshot = false;
  net.matchState = 'DISCONNECTED';
  net.players.clear();
  if (net.reconnectTimer) {
    clearTimeout(net.reconnectTimer);
    net.reconnectTimer = null;
  }
  if (net.ws) {
    net.ws.close();
    net.ws = null;
  }
  clearPlayers();
}

async function startNet(url) {
  if (url) net.wsUrl = url;
  net.shouldReconnect = true;
  net.enabled = true;
  net.snapshot = null;
  net.latencyMs = null;
  net.hasSnapshot = false;
  net.players.clear();
  net.matchState = 'CONNECTING';
  clearPlayers();
  await waitForTelegramBeforeNetworking();
  connectWebSocket(net.wsUrl);
}

async function hydrateWithGltf() {
  // Keep the full-screen overlay visible until the arena and character prefabs are ready.
  // This avoids spawning temporary placeholder meshes that later "pop" into the real models.
  ui.sceneReady = false;
  ui.arenaReady = false;
  ui.prefabsReady = false;
  ui.prefabsLoadStartedAt = Date.now();

  const arenaPromise = loadOptionalGltf(ASSETS.arena);
  const ballPromise = loadOptionalGltf(ASSETS.ball);
  const boatPromise = loadOptionalGltf(ASSETS.boat);
  const sfxPromise = Promise.all([
    loadSfx('hit_player', '/assets/sfx/hit_player.ogg'),
    loadSfx('hit_wall', '/assets/sfx/hit_wall.ogg'),
    loadSfx('goal', '/assets/sfx/goal.ogg'),
  ]);
  const fallbackPromise = ASSETS.playerFallback ? loadOptionalGltf(ASSETS.playerFallback) : Promise.resolve(null);
  const playerPromises = Object.entries(ASSETS.players || {}).map(async ([side, url]) => {
    const gltf = await loadOptionalGltf(url);
    return [side, gltf];
  });
  const boatGltf = await boatPromise;
  if (boatGltf) {
    boatPrefab = boatGltf.scene;
    normalizeBoat(boatPrefab);
    enableShadows(boatPrefab);
  }

  const arenaGltf = await arenaPromise;
  if (arenaGltf) {
    const deco = arenaGltf.scene;
    enableShadows(deco);
    const box = new THREE.Box3().setFromObject(deco);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.x > 0.1 && size.z > 0.1) {
      const scaleX = ARENA.width / size.x;
      const scaleZ = ARENA.height / size.z;
      const scaleY = (scaleX + scaleZ) * 0.5;
      deco.scale.set(scaleX, scaleY, scaleZ);
    }
    deco.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(deco);
    // Keep the arena above y=0. We'll raycast the real play-floor height and place players/ball there.
    deco.position.y = -scaledBox.min.y;
    // Important: update matrices after moving the arena so floor raycasts use the correct transform.
    deco.updateMatrixWorld(true);
    if (arenaGroup) {
      scene.remove(arenaGroup);
    }
    scene.add(deco);
    arenaGroup = deco;
    collectArenaSpawns(arenaGroup);

    arenaFloorY = computeArenaFloorY(arenaGroup) + 0.01; // small lift to avoid clipping
    // If players already exist (e.g. reconnect), snap their Y to the play floor.
    players.forEach((p) => {
      p.mesh.position.y = arenaFloorY;
      ensurePlayerMotionState(p);
      p.prevPos.copy(p.mesh.position);
    });
    ballMesh.position.y = arenaFloorY + ballVisualRadius();
    shadowMesh.position.y = arenaFloorY + 0.02;

    rebuildRinkDecor();

    applyGameCameraPreset(true);
    if (renderer?.domElement) {
      renderer.domElement.style.visibility = 'visible';
    }
  }
  // Even if the GLB fails to load, consider the arena stage done to avoid blocking the UX forever.
  ui.arenaReady = true;

  const fallbackGltf = await fallbackPromise;
  playerPrefabs.clear();
  playerFallbackPrefab = null;
  if (fallbackGltf) {
    playerFallbackPrefab = fallbackGltf.scene;
    normalizePrefab(playerFallbackPrefab);
    enableShadows(playerFallbackPrefab);
  }

  const playerResults = await Promise.all(playerPromises);
  playerResults.forEach(([side, gltf]) => {
    if (!gltf) return;
    const prefab = gltf.scene;
    normalizePrefab(prefab);
    enableShadows(prefab);
    playerPrefabs.set(side, prefab);
  });
  ui.prefabsReady = true;

  if (playerPrefabs.size || playerFallbackPrefab) {
    applyPrefabsToExistingPlayers();
  }

  const ballGltf = await ballPromise;
  if (ballGltf) {
    const model = ballGltf.scene;
    enableShadows(model);
    // Visual-only: make the imported ball match our desired on-screen size.
    const ballRoot = normalizeBallModel(model);
    ballRoot.position.copy(ballMesh.position);
    scene.remove(ballMesh);
    ballMesh = ballRoot;
    scene.add(ballMesh);
    normalScale.copy(ballMesh.scale);
    impactScale.copy(ballMesh.scale).multiply(new THREE.Vector3(1.15, 0.85, 1.15));
  }
  await sfxPromise;

  ui.sceneReady = ui.arenaReady && ui.prefabsReady;
}

hydrateWithGltf();

function colorIndexBySide(side) {
  const idx = sides.indexOf(side);
  return idx >= 0 ? idx : 0;
}

function clampPlayerToZone(pos, side) {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const halfWidth = (PLAYER.collider?.x ?? 2.5) * 0.5;
  const laneInset = (PLAYER.collider?.z ?? ARENA.playerDepth ?? 0.6) * 0.5 + PLAYER_WALL_MARGIN;

  if (side === 'top' || side === 'bottom') {
    pos.x = THREE.MathUtils.clamp(pos.x, -halfW + halfWidth, halfW - halfWidth);
    pos.z = side === 'top' ? (-halfH + laneInset) : (halfH - laneInset);
    return;
  }
  if (side === 'left' || side === 'right') {
    pos.z = THREE.MathUtils.clamp(pos.z, -halfH + halfWidth, halfH - halfWidth);
    pos.x = side === 'left' ? (-halfW + laneInset) : (halfW - laneInset);
  }
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

function clampPlayerAgainstPosts(pos, side) {
  const posts = getBallSpawnPoints();
  if (!posts.length) return;
  const postR = ARENA_OBSTACLES.postRadius;
  if (!(postR > 0.001)) return;

  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
  const ext = playerHalfExtentsForSide(side);

  // Iterate a couple times in case we're wedged between two posts.
  for (let iter = 0; iter < 2; iter += 1) {
    if (side === 'top' || side === 'bottom') {
      const minX = -halfW + ext.hx;
      const maxX = halfW - ext.hx;
      const rectMinZ = pos.z - ext.hz;
      const rectMaxZ = pos.z + ext.hz;

      for (const post of posts) {
        const cx = Number(post?.x);
        const cz = Number(post?.z);
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;

        let dz = 0;
        if (cz < rectMinZ) dz = rectMinZ - cz;
        else if (cz > rectMaxZ) dz = cz - rectMaxZ;
        if (dz >= postR) continue;

        const dxMax = Math.sqrt(Math.max(0, postR * postR - dz * dz));
        const forbiddenHalf = ext.hx + dxMax;
        if (!(Math.abs(pos.x - cx) < forbiddenHalf)) continue;

        const leftCandidate = cx - forbiddenHalf - 0.02;
        const rightCandidate = cx + forbiddenHalf + 0.02;
        const preferLeft = pos.x < cx;
        let candidate = preferLeft ? leftCandidate : rightCandidate;
        if (candidate < minX || candidate > maxX) {
          candidate = preferLeft ? rightCandidate : leftCandidate;
        }
        pos.x = THREE.MathUtils.clamp(candidate, minX, maxX);
      }
    } else if (side === 'left' || side === 'right') {
      const minZ = -halfH + ext.hz;
      const maxZ = halfH - ext.hz;
      const rectMinX = pos.x - ext.hx;
      const rectMaxX = pos.x + ext.hx;

      for (const post of posts) {
        const cx = Number(post?.x);
        const cz = Number(post?.z);
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;

        let dx = 0;
        if (cx < rectMinX) dx = rectMinX - cx;
        else if (cx > rectMaxX) dx = cx - rectMaxX;
        if (dx >= postR) continue;

        const dzMax = Math.sqrt(Math.max(0, postR * postR - dx * dx));
        const forbiddenHalf = ext.hz + dzMax;
        if (!(Math.abs(pos.z - cz) < forbiddenHalf)) continue;

        const lowCandidate = cz - forbiddenHalf - 0.02;
        const highCandidate = cz + forbiddenHalf + 0.02;
        const preferLow = pos.z < cz;
        let candidate = preferLow ? lowCandidate : highCandidate;
        if (candidate < minZ || candidate > maxZ) {
          candidate = preferLow ? highCandidate : lowCandidate;
        }
        pos.z = THREE.MathUtils.clamp(candidate, minZ, maxZ);
      }
    }

    clampPlayerToZone(pos, side);
  }
}

function normalizePrefab(prefab) {
  if (!prefab) return;
  const box = new THREE.Box3().setFromObject(prefab);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x === 0 || size.z === 0) return;
  const factor = Math.min(TARGET_PLAYER_SIZE.x / size.x, TARGET_PLAYER_SIZE.z / size.z);
  prefab.scale.multiplyScalar(factor);
  box.setFromObject(prefab);
  const center = new THREE.Vector3();
  box.getCenter(center);
  // Center XZ around origin, but keep Y pivot at the ground so models don't end up half under the arena floor.
  prefab.position.x -= center.x;
  prefab.position.z -= center.z;
  prefab.position.y -= box.min.y;
}

function normalizeBoat(prefab) {
  if (!prefab) return;
  const box = new THREE.Box3().setFromObject(prefab);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x === 0 || size.z === 0) return;
  const factor = Math.min(TARGET_BOAT_SIZE.x / size.x, TARGET_BOAT_SIZE.z / size.z);
  prefab.scale.multiplyScalar(factor);
  box.setFromObject(prefab);
  const center = new THREE.Vector3();
  box.getCenter(center);
  prefab.position.sub(center);
  box.setFromObject(prefab);
  prefab.position.y -= box.min.y; // seat boat on the ground
}

function clampPlayerToSideLine(pos, side) {
  clampPlayerToZone(pos, side);
  // Visual safety clamp: prevent snapshot interpolation from showing players inside corner posts/tubes.
  clampPlayerAgainstPosts(pos, side);
}

function enforcePlayerBounds() {
  players.forEach((p) => {
    clampPlayerToSideLine(p.mesh.position, p.side);
  });
}

function clampBallAgainstPosts(pos, derivedVel = null) {
  const posts = getBallSpawnPoints();
  if (!posts.length) return;
  const postR = ARENA_OBSTACLES.postRadius;
  if (!(postR > 0.001)) return;

  const r = ballState.radius;
  const minDist = r + postR;
  const minDistSq = minDist * minDist;

  for (let iter = 0; iter < 2; iter += 1) {
    let any = false;
    for (const post of posts) {
      const cx = Number(post?.x);
      const cz = Number(post?.z);
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;

      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const distSq = dx * dx + dz * dz;
      if (!(distSq < minDistSq)) continue;
      any = true;

      let nx = dx;
      let nz = dz;
      let dist = Math.sqrt(distSq);
      if (dist < 1e-6) {
        // Degenerate: use derived velocity direction as a hint, otherwise push toward arena center.
        const vx = derivedVel?.x ?? 0;
        const vz = derivedVel?.y ?? 0;
        const vlen = Math.hypot(vx, vz);
        if (vlen > 1e-6) {
          nx = -vx / vlen;
          nz = -vz / vlen;
        } else {
          const clen = Math.hypot(cx, cz) || 1;
          nx = -cx / clen;
          nz = -cz / clen;
        }
        dist = 1;
      } else {
        nx /= dist;
        nz /= dist;
      }

      // Push outside the obstacle.
      pos.x = cx + nx * minDist;
      pos.z = cz + nz * minDist;

      // Reflect derived velocity for impact FX so bounces don't look like tunneling.
      if (derivedVel) {
        const dot = derivedVel.x * nx + derivedVel.y * nz;
        if (dot < 0) {
          derivedVel.x = derivedVel.x - 2 * dot * nx;
          derivedVel.y = derivedVel.y - 2 * dot * nz;
          derivedVel.multiplyScalar(PHYSICS.damping);
        }
      }
    }
    if (!any) break;
  }
}

function syncNetPlayers(snapshotPlayers) {
  // Do not spawn temporary placeholder meshes before GLB prefabs are loaded.
  // This prevents the visible "swap" from capsules to real characters a moment later.
  if (net.connected && !ui.prefabsReady) return;
  const alive = new Set();
  snapshotPlayers.forEach((sp) => {
      const pid = sp.playerId || sp.id;
      const pos = sp.pos || { x: sp.x, z: sp.z };
      clampPlayerToZone(pos, sp.side);
      let player = players.find((p) => p.id === pid);
      if (!player) {
        const mesh = createPlayer(colorIndexBySide(sp.side), sp.side);
        mesh.position.set(pos.x, floorY(), pos.z);
        if (Number.isFinite(sp.yaw)) {
          mesh.rotation.y = sp.yaw;
        } else {
          applyPlayerFacing(mesh, sp.side, null);
        }
      scene.add(mesh);
      player = { mesh, side: sp.side, id: pid, isLocal: false, targetYaw: Number.isFinite(sp.yaw) ? sp.yaw : null };
      ensurePlayerMotionState(player);
      attachLabel(player, pid);
      const portraitPath = playerPortraits[sp.side];
      if (portraitPath) {
        const tex = loadPortraitTexture(portraitPath);
        attachPortrait(player, tex);
      }
      players.push(player);
    }
    ensurePlayerMotionState(player);
    player.isLocal = pid === net.id;
    player.side = sp.side;
    player.targetYaw = Number.isFinite(sp.yaw) ? sp.yaw : null;
    const displayName = net.players.get(pid)?.username || pid;
    attachLabel(player, player.isLocal ? `You (${player.side})` : displayName);
    const aligned = new THREE.Vector3(pos.x, floorY(), pos.z);
    clampPlayerToSideLine(aligned, player.side);
    // Local player: do not add extra interpolation delay (feels "sluggish").
    // Remote players: keep a bit of smoothing to hide network jitter.
    if (player.isLocal) player.mesh.position.copy(aligned);
    else player.mesh.position.lerp(aligned, 0.35);
    // Visual safeguard: interpolation can temporarily drift outside bounds before the next snapshot.
    clampPlayerToSideLine(player.mesh.position, player.side);
    alive.add(pid);
  });
  const toRemove = players.filter((p) => p.id && !alive.has(p.id));
  toRemove.forEach((p) => scene.remove(p.mesh));
  for (const dead of toRemove) {
    const idx = players.indexOf(dead);
    if (idx >= 0) players.splice(idx, 1);
  }
}

function applyNetState() {
  const curr = net.snapshotBuffer.curr;
  if (!curr) return;
  const prev = net.snapshotBuffer.prev;
  const now = performance.now();
  const interval = net.snapshotIntervalMs || 33;
  const sentDelta = prev ? Math.max(8, (curr.sentAt || 0) - (prev.sentAt || 0)) : interval;
  const elapsed = now - (curr.recvAt || now);
  // Never extrapolate past the latest authoritative snapshot.
  const alpha = prev ? THREE.MathUtils.clamp(elapsed / sentDelta, 0, 1.0) : 1;

  if (curr.payload?.config) {
    applyConfigFromServer(curr.payload.config);
  }

  const lerpVec = (a, b) => {
    const ax = a?.pos?.x ?? a?.x ?? 0;
    const az = a?.pos?.z ?? a?.z ?? 0;
    const bx = b?.pos?.x ?? b?.x ?? ax;
    const bz = b?.pos?.z ?? b?.z ?? az;
    return { x: THREE.MathUtils.lerp(ax, bx, alpha), z: THREE.MathUtils.lerp(az, bz, alpha) };
  };
  const lerpAngle = (a, b) => {
    const aa = Number.isFinite(a) ? a : 0;
    const bb = Number.isFinite(b) ? b : aa;
    const delta = normalizeAngleRad(bb - aa);
    return normalizeAngleRad(aa + delta * alpha);
  };

  const interpPlayers = [];
  const currPlayers = curr.payload?.players || [];
  const prevPlayers = prev?.payload?.players || [];
  currPlayers.forEach((cp) => {
    const pid = cp.playerId || cp.id;
    const prevP = prevPlayers.find((p) => (p.playerId || p.id) === pid) || cp;
    interpPlayers.push({
      playerId: pid,
      side: cp.side,
      pos: lerpVec(prevP.pos || prevP, cp.pos || cp),
      yaw: typeof cp.yaw === 'number' ? lerpAngle(prevP.yaw, cp.yaw) : null,
    });
  });
  syncNetPlayers(interpPlayers);

  const cBall = curr.payload?.ball || curr.payload;
  if (cBall) {
    const pBall = prev?.payload?.ball || cBall;
    if (typeof cBall.r === 'number' && cBall.r > 0.01) {
      ballState.radius = cBall.r;
    }
    // derive velocity from position delta for impact feedback
    const pos = lerpVec(pBall, cBall);
    const velX = pos.x - lastBallPos.x;
    const velZ = pos.z - lastBallPos.z;
    tempVec2.set(velX, velZ);
    // Visual safety clamp: keep ball inside arena even under jitter/precision issues.
    // Reflect derived velocity (for impact feedback) when clamping.
    const halfW = (FIELD.width > 0 ? FIELD.width : ARENA.width) / 2;
    const halfH = (FIELD.height > 0 ? FIELD.height : ARENA.height) / 2;
    const r = ballState.radius;
    const minX = -halfW + r;
    const maxX = halfW - r;
    const minZ = -halfH + r;
    const maxZ = halfH - r;
    if (pos.x > maxX) {
      pos.x = maxX;
      if (tempVec2.x > 0) tempVec2.x *= -1;
    } else if (pos.x < minX) {
      pos.x = minX;
      if (tempVec2.x < 0) tempVec2.x *= -1;
    }
    if (pos.z > maxZ) {
      pos.z = maxZ;
      if (tempVec2.y > 0) tempVec2.y *= -1;
    } else if (pos.z < minZ) {
      pos.z = minZ;
      if (tempVec2.y < 0) tempVec2.y *= -1;
    }

    // Same idea as the wall clamp, but for corner posts/tubes.
    // Keeps the ball from visually passing through them during snapshot interpolation.
    clampBallAgainstPosts(pos, tempVec2);

    const currSpeed = tempVec2.length();
    const prevSpeed = lastBallVel.length();
    if (currSpeed > 0.02 && prevSpeed > 0.02) {
      const cos = (tempVec2.dot(lastBallVel)) / (currSpeed * prevSpeed);
      if (cos < 0.2) {
        triggerImpactFx();
      }
    }
    lastBallVel.copy(tempVec2);
    lastBallPos.set(pos.x, pos.z);
    const vr = ballVisualRadius();
    ballMesh.position.x = pos.x;
    ballMesh.position.z = pos.z;
    ballMesh.position.y = floorY() + vr;
    shadowMesh.position.x = pos.x;
    shadowMesh.position.z = pos.z;
    shadowMesh.position.y = floorY() + 0.02;
    shadowMesh.scale.set(vr * 2, vr * 2, 1);
  }

  if (net.matchState && net.matchState !== 'IN_PROGRESS' && net.matchState !== 'READY') {
    players.forEach((p) => {
      const base = playerDefaultPosition(p.side);
      const aligned = new THREE.Vector3(base.x, floorY(), base.z);
      clampPlayerToSideLine(aligned, p.side);
      if (p.isLocal) p.mesh.position.copy(aligned);
      else p.mesh.position.lerp(aligned, 0.35);
      clampPlayerToSideLine(p.mesh.position, p.side);
    });
    ballMesh.position.lerp(new THREE.Vector3(0, floorY() + ballVisualRadius(), 0), 0.3);
    shadowMesh.position.x = ballMesh.position.x;
    shadowMesh.position.z = ballMesh.position.z;
    shadowMesh.position.y = floorY() + 0.02;
    const vr = ballVisualRadius();
    shadowMesh.scale.set(vr * 2, vr * 2, 1);
  }
  enforcePlayerBounds();

}

function sendNetInput() {
  if (!net.enabled || !net.connected || !net.ws || net.ws.readyState !== WebSocket.OPEN) return;
  // TЗ: управление доступно только в активной фазе матча.
  if (net.matchState && net.matchState !== 'IN_PROGRESS') return;
  const now = performance.now();
  if (now - net.lastInputSentAt < 33) return; // ~30 Hz cap client-side (feel more instant)
  const payload = { type: 'INPUT', payload: { forward: input.forward, back: input.back, left: input.left, right: input.right } };
  const serialized = JSON.stringify(payload);
  if (serialized !== net.lastInput) {
    net.ws.send(serialized);
    net.lastInput = serialized;
    net.lastInputSentAt = now;
  }
}

function updateHud() {
  const netEl = document.getElementById('net-status');
  const matchEl = document.getElementById('match-status');
  const errEl = document.getElementById('error-banner');
  const cta = document.getElementById('cta-retry');
  const matchBanner = document.getElementById('match-banner');
  const playerBoard = document.getElementById('player-board');
  const perfEl = null;
  const btnStart = null;
  const btnReset = null;
  const btnRestart = document.getElementById('btn-restart');
  const stateChip = document.getElementById('state-chip');
  if (!netEl) return;
  const hideBanner = () => { if (matchBanner) matchBanner.style.display = 'none'; };
  if (btnStart) {
    btnStart.disabled = true;
    btnStart.textContent = 'Waiting';
  }
  if (btnReset) btnReset.disabled = true;
  if (btnRestart) btnRestart.disabled = !net.connected;
  if (net.connected) {
    const pingVal = net.avgPing ?? net.latencyMs;
    const ping = pingVal != null ? `, ping ~${pingVal.toFixed(0)}ms` : '';
    const reason = net.matchReason ? `, reason: ${net.matchReason}` : '';
    netEl.textContent = `Online (${net.wsUrl}) — player ${net.id ?? '?'} side ${net.side ?? '?'} — state ${net.matchState}${ping}${reason}`;
    let suffix = '';
    if (net.matchState === 'READY' && readyEndsAt) {
      const left = Math.max(0, readyEndsAt - Date.now());
      suffix = ` — start in ${(left / 1000).toFixed(1)}s`;
    }
    if (matchEl) matchEl.textContent = `Match state: ${net.matchState || 'unknown'}${suffix}`;
    if (errEl) errEl.style.display = 'none';
    if (cta) cta.style.display = 'none';
    if (playerBoard) {
      playerBoard.style.display = 'grid';
      playerBoard.replaceChildren();
      const order = { top: 0, right: 1, bottom: 2, left: 3 };
      const playersArr = [...net.players.entries()].sort((a, b) => (order[a[1].side] ?? 99) - (order[b[1].side] ?? 99));
      playersArr.forEach(([pid, p]) => {
        const rowName = document.createElement('div');
        const rowScore = document.createElement('div');
        const dot = document.createElement('span');
        dot.className = 'pill-dot';
        dot.style.backgroundColor = sideHex(p.side || 'top');
        rowName.append(dot, document.createTextNode(pid === net.id ? `${p.username || pid} (you)` : (p.username || pid)));
        rowScore.textContent = `${p.side || '-'}${p.connected ? '' : ' (dc)'}`;
        playerBoard.append(rowName, rowScore);
      });
      if (!playerBoard.hasChildNodes()) {
        playerBoard.textContent = 'Waiting players...';
      }
    }
    if (matchBanner) {
      if (net.matchState === 'FINISHED') {
        matchBanner.textContent = `Match finished${net.matchReason ? `: ${net.matchReason}` : ''}`;
        matchBanner.style.borderColor = 'rgba(255,255,255,0.15)';
        matchBanner.style.color = '#e6f2ff';
        matchBanner.style.display = 'block';
      } else if (net.matchState === 'WAITING') {
        matchBanner.textContent = 'Waiting for players...';
        matchBanner.style.display = 'block';
      } else if (net.matchState === 'READY' && readyEndsAt) {
        matchBanner.textContent = `Starting in ${(Math.max(0, readyEndsAt - Date.now()) / 1000).toFixed(1)}s`;
        matchBanner.style.display = 'block';
      } else {
        matchBanner.style.display = 'none';
      }
    }
  } else {
    const errCode = net.error?.code || net.error?.reason;
    const errText = errCode ? ` — error: ${errCode}` : (net.errorMessage ? ` — ${net.errorMessage}` : '');
    const state = net.connectionState || 'connecting';
    netEl.textContent = `${state.toUpperCase()} to ${net.wsUrl || ''}${errText} (tap Connect to retry)`;
    if (matchEl) matchEl.textContent = `Match state: ${net.matchState || state}`;
    if (errEl) {
      const message = errCode || net.errorMessage;
      if (message) {
        errEl.textContent = `Connection error: ${message}`;
        errEl.style.display = 'block';
      } else {
        errEl.style.display = 'none';
      }
    }
    if (cta) {
      cta.style.display = errCode === 'RECONNECT_MAX' ? 'block' : 'none';
    }
    hideBanner();
    if (playerBoard) playerBoard.style.display = 'none';
  }
  if (stateChip) {
    stateChip.textContent = net.connected ? 'Online' : 'Connecting...';
  }

  const netPanel = document.getElementById('net-panel');
  if (netPanel && netPanel.classList.contains('net-panel--visible')) {
    const pingVal = net.avgPing ?? net.latencyMs;
    netPanel.innerHTML = `
      <div><b>WS:</b> ${net.wsUrl || '-'}</div>
      <div><b>State:</b> ${net.connectionState || 'idle'}</div>
      <div><b>Match:</b> ${net.matchState || '-'}</div>
      <div><b>Ping:</b> ${pingVal != null ? `${pingVal.toFixed(0)} ms` : 'n/a'}</div>
      <div><b>Reconnects:</b> ${net.reconnectAttempts}</div>
      <div><b>Error:</b> ${net.error?.code || net.errorMessage || 'none'}</div>
    `;
  }

  // READY countdown overlay
  const countdownEl = document.getElementById('countdown-overlay');
  if (countdownEl) {
    if (net.matchState === 'READY' && readyEndsAt) {
      const left = Math.max(0, readyEndsAt - Date.now());
      const val = left > 0 ? Math.ceil(left / 1000) : 'GO';
      countdownEl.textContent = val;
      countdownEl.style.display = 'flex';
      countdownEl.style.opacity = '1';
    } else if (net.matchState === 'IN_PROGRESS') {
      countdownEl.style.opacity = '0';
      countdownEl.style.display = 'none';
    } else {
      countdownEl.style.opacity = '0';
      countdownEl.style.display = 'none';
    }
  }

  updateOverlay();

  // match flow overlay
  if (net.matchState !== prevMatchState) {
    if (net.matchState === 'FINISHED') {
      showFinishOverlay();
      // match completion counter
      matchCount += 1;
      try { localStorage.setItem('tf_matches', String(matchCount)); } catch {}
      if (matchCount >= 2) {
        showInviteOverlay();
      }
      if (prevMatchState === 'IN_PROGRESS' && metricsEnabled) {
        sessionMatches += 1;
      }
    } else {
      hideFinishOverlay();
      hideInviteOverlay();
    }
    if (metricsEnabled) {
      lastKnownState = net.matchState || lastKnownState;
    }
    prevMatchState = net.matchState;
  }
}

function updatePlayersList() {
  const listEl = document.getElementById('players-list');
  if (!listEl) return;

  const renderRow = (name, status) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    const statusEl = document.createElement('span');
    statusEl.textContent = status || '';
    row.append(nameEl, statusEl);
    listEl.appendChild(row);
  };

  listEl.replaceChildren();

  if (net.enabled && net.players.size) {
    net.players.forEach((p) => {
      const name = p.playerId === net.id ? `${p.username || p.playerId} (you)` : (p.username || p.playerId);
      const status = p.connected ? p.side : `${p.side} (dc)`;
      renderRow(name, status);
    });
    return;
  }

  if (!players.length) {
    renderRow('No players', '');
    return;
  }

  players.forEach((p) => {
    const name = p.isLocal ? `${p.id || 'you'} (you)` : p.id || 'player';
    const side = p.side || '-';
    renderRow(name, side);
  });
}

function updatePlayerVelocities(dt) {
  if (dt <= 0) return;
  const invDt = 1 / dt;
  players.forEach((p) => {
    ensurePlayerMotionState(p);
    const pos = p.mesh.position;
    p.velocity.set(
      (pos.x - p.prevPos.x) * invDt,
      0,
      (pos.z - p.prevPos.z) * invDt
    );
    p.prevPos.copy(pos);
  });
}

function normalizeAngleRad(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngleRad(from, to, t) {
  const a = normalizeAngleRad(from);
  const b = normalizeAngleRad(to);
  const delta = normalizeAngleRad(b - a);
  return normalizeAngleRad(a + delta * t);
}

function updatePlayerRotations() {
  players.forEach((p) => {
    const hasAuthYaw = Number.isFinite(p.targetYaw);
    const desired = hasAuthYaw ? p.targetYaw : pickYawFacingCenterOrVelocity(p.mesh, p.side, p.velocity);
    const current = p.mesh.rotation.y || 0;
    // If server yaw exists, apply it directly to playerRoot. Fallback facing remains smoothed.
    p.mesh.rotation.y = lerpAngleRad(current, desired, hasAuthYaw ? 1 : 0.25);
  });
}

function enforceMinAngle2(vec) {
  const speed = vec.length();
  if (speed < 1e-5) return;
  tempVec2.copy(vec).normalize();
  if (Math.abs(tempVec2.x) < MIN_REFLECTION_ANGLE) {
    tempVec2.x = Math.sign(tempVec2.x || 1) * MIN_REFLECTION_ANGLE;
  }
  if (Math.abs(tempVec2.y) < MIN_REFLECTION_ANGLE) {
    tempVec2.y = Math.sign(tempVec2.y || 1) * MIN_REFLECTION_ANGLE;
  }
  tempVec2.normalize().multiplyScalar(speed);
  vec.copy(tempVec2);
}

function collideBallWithWalls() {
  // Keep offline behavior consistent with server-side bounds.
  const halfW = (FIELD.width > 0 ? FIELD.width : ARENA.width) / 2;
  const halfH = (FIELD.height > 0 ? FIELD.height : ARENA.height) / 2;
  const r = ballState.radius;
  let hit = false;

  if (ballMesh.position.x > halfW - r) {
    ballMesh.position.x = halfW - r;
    ballState.velocity.x *= -1;
    hit = true;
  } else if (ballMesh.position.x < -halfW + r) {
    ballMesh.position.x = -halfW + r;
    ballState.velocity.x *= -1;
    hit = true;
  }

  if (ballMesh.position.z > halfH - r) {
    ballMesh.position.z = halfH - r;
    ballState.velocity.y *= -1;
    hit = true;
  } else if (ballMesh.position.z < -halfH + r) {
    ballMesh.position.z = -halfH + r;
    ballState.velocity.y *= -1;
    hit = true;
  }

  if (hit) {
    ballState.velocity.multiplyScalar(PHYSICS.damping);
    enforceMinAngle2(ballState.velocity);
    playSfx('hit_wall', 0.4);
  }
}

function collideBallWithPlayer(player) {
  const { mesh: playerRoot } = player;
  const halfX = (PLAYER.collider?.x ?? 2.5) * 0.5 + ballState.radius * 0.5;
  const halfZ = (PLAYER.collider?.z ?? ARENA.playerDepth) * 0.5 + ballState.radius * 0.5;
  const dx = ballMesh.position.x - playerRoot.position.x;
  const dz = ballMesh.position.z - playerRoot.position.z;

  if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) return;

  const overlapX = halfX - Math.abs(dx);
  const overlapZ = halfZ - Math.abs(dz);

  // push ball outside collider AABB to avoid sticking
  if (overlapX < overlapZ) {
    const normalX = Math.sign(dx) || 1;
    ballMesh.position.x += normalX * overlapX;
  } else {
    const normalZ = Math.sign(dz) || 1;
    ballMesh.position.z += normalZ * overlapZ;
  }

  // arcade reflection: normal from player root to ball (XZ plane only)
  tempNormalXZ.set(dx, 0, dz);
  if (tempNormalXZ.lengthSq() < 1e-6) {
    // fallback to incoming velocity direction if positions match
    tempNormalXZ.set(-ballState.velocity.x, 0, -ballState.velocity.y);
  }
  if (tempNormalXZ.lengthSq() < 1e-6) {
    tempNormalXZ.set(0, 0, 1);
  }
  tempNormalXZ.y = 0;
  tempNormalXZ.normalize();

  tempVel3.set(ballState.velocity.x, 0, ballState.velocity.y);
  tempVel3.reflect(tempNormalXZ);

  const pVel = player.velocity || zeroVec3;
  tempVel3.addScaledVector(pVel, 0.5); // player's motion influences power

  ballState.velocity.set(tempVel3.x, tempVel3.z);
  enforceMinAngle2(ballState.velocity);
  const maxSpeed = PHYSICS.maxSpeed;
  const speedSq = ballState.velocity.lengthSq();
  if (speedSq > maxSpeed * maxSpeed) {
    ballState.velocity.setLength(maxSpeed);
  }
  ballState.velocity.clampLength(PHYSICS.minSpeed, PHYSICS.maxSpeed);
  playSfx('hit_player', 0.6);
}

function updateBall(dt) {
  ballMesh.position.x += ballState.velocity.x * dt;
  ballMesh.position.z += ballState.velocity.y * dt;
  const vr = ballVisualRadius();
  ballMesh.position.y = floorY() + vr;

  collideBallWithWalls();
  players.forEach(collideBallWithPlayer);

  ballState.velocity.multiplyScalar(PHYSICS.damping);
  ballState.velocity.clampLength(PHYSICS.minSpeed, PHYSICS.maxSpeed);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
  shadowMesh.position.y = floorY() + 0.02;
  shadowMesh.scale.set(vr * 2, vr * 2, 1);
}

let lastTime = performance.now();
let isPageHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  isPageHidden = document.hidden;
  // If the WebView loses focus/cancels a pointer, ensure controls don't "stick".
  if (document.hidden) {
    input.touchActive = false;
    input.dragActive = false;
    setMoveVector(0, 0, 'hidden');
  }
});
window.addEventListener('blur', () => {
  input.touchActive = false;
  input.dragActive = false;
  setMoveVector(0, 0, 'blur');
});

function update(dt) {
  // Portrait mode is allowed (we only show a hint banner). Do not block input here.

  if (net.enabled && (!net.connected || (net.matchState && net.matchState !== 'IN_PROGRESS'))) {
    setMoveVector(0, 0, 'net-guard');
  }

  updateCameraIntro(dt);

  if (net.connected) {
    // If the socket stays open but snapshots stop arriving, force a reconnect. This is a common failure
    // mode on mobile networks / WebViews that aggressively suspend background tabs.
    if (net.lastSnapshotAt) {
      const now = performance.now();
      if (now - net.lastSnapshotAt > SNAPSHOT_STALL_MS && !net.stallTriggeredAt) {
        net.stallTriggeredAt = now;
        net.errorMessage = 'Network stall. Reconnecting…';
        try { net.ws?.close(); } catch {}
      }
    }
    if (!input.touchActive && !input.dragActive) {
      recomputeKeyboardVector();
    }
    sendNetInput();
    applyNetState();
  }
  enforcePlayerBounds();
  updatePlayerVelocities(dt);
  updatePlayerRotations();
  updateVisualFx(dt);

  if (!net.connected) {
    hideFinishOverlay();
    hideInviteOverlay();
  }
}

function animate() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (!isPageHidden) {
    try {
      update(dt);
      updateHud();
      updatePlayersList();
      if (renderer) renderer.render(scene, camera);
    } catch (err) {
      showFatalError(err);
    }
  }
  requestAnimationFrame(animate);
}

let gameBooted = false;
async function bootGame() {
  if (gameBooted) return;
  gameBooted = true;

  await waitForTelegramBeforeNetworking();
  initRenderer();

  // Ensure correct viewport after Telegram expands the WebView (fixes mobile black screen).
  refreshViewport();

  // Render at least one frame immediately; Telegram mobile can otherwise show a black frame.
  try {
    renderer?.setClearColor(0x000000, 1);
    renderer?.render(scene, camera);
    requestAnimationFrame(() => {
      try { renderer?.render(scene, camera); } catch {}
    });
  } catch {}

  // Start loop + input only after the renderer exists.
  animate();
  bindTouchControls();
  bindDragControls();
  bindNetControls();
  bindGameUiControls();
  applyNetPanelVisibility();
  applyDebugUi();
  getCountdownEl();
  updateHud();
  syncLandscapeGate();

  window.addEventListener('resize', refreshViewport);
  window.addEventListener('orientationchange', () => {
    // Give WebView a moment to recalc safe-area/viewport.
    setTimeout(refreshViewport, 100);
  });
}

bootGame().catch((err) => console.warn('[boot] failed', err));

function refreshViewport() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyGameCameraPreset(false);
  camera.updateProjectionMatrix();
  if (renderer) renderer.setSize(window.innerWidth, window.innerHeight);
  syncLandscapeGate();
  updateHud();
}

window.addEventListener('message', (evt) => {
  if (evt?.data?.type) {
    try { handleNetMessage(evt.data); } catch (e) { console.warn('local message failed', e); }
  }
});

function onDomReady() {
  initOverlayDom();
  syncLandscapeGate();
  // Do not auto-call fullscreen/orientation lock on load: many WebViews require a user gesture and can
  // fail noisily. The button below is the safe path.

  if (landscapeDom.btn) {
    landscapeDom.btn.addEventListener('click', async () => {
      await requestLandscapeMode();
      setTimeout(refreshViewport, 120);
    });
  }

  const hintSeen = (() => {
    try { return localStorage.getItem('tf_hint_shown') === '1'; } catch { return true; }
  })();
  if (!hintSeen) showControlHint();

  if (inviteDom.btn) {
    inviteDom.btn.addEventListener('click', () => {
      hideInviteOverlay();
      try {
        if (tg?.shareMessage) {
          tg.shareMessage('Join me in this game!');
        } else if (tg?.openTelegramLink) {
          tg.openTelegramLink('https://t.me/share/url?url=&text=Join%20me%20in%20this%20game!');
        } else {
          const shareUrl = 'https://t.me/share/url?url=&text=Join%20me%20in%20this%20game!';
          window.open(shareUrl, '_blank', 'noopener');
        }
      } catch (e) {
        console.warn('Share failed', e);
      }
    });
  }

  if (metricsEnabled) {
    const logMetrics = () => {
      if (metricsSent) return;
      metricsSent = true;
      const durationSec = Math.max(0, Math.round((Date.now() - sessionStartTs) / 1000));
      const payload = { matches: sessionMatches, duration: durationSec, exitState: lastKnownState || 'UNKNOWN' };
      console.log('[tf-metrics]', payload);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) logMetrics();
    });
    window.addEventListener('beforeunload', logMetrics);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
} else {
  onDomReady();
}
