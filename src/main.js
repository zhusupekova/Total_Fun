import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d111c);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);
document.documentElement.style.overscrollBehavior = 'none';
document.body.style.overscrollBehavior = 'none';

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 9.2, 12.4);
camera.lookAt(0, 0, 0);

const ambient = new THREE.AmbientLight(0x9fb7ff, 0.62);
scene.add(ambient);

const dir = new THREE.DirectionalLight(0xffffff, 1.05);
dir.position.set(8, 14, 7);
dir.castShadow = false;
scene.add(dir);

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

const ARENA = { width: 12, height: 8, wallHeight: 1.2, playerDepth: 0.6, ballRadius: 0.5 };
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
const PHYSICS = {
  playerSpeed: 6,
  minSpeed: 2,
  maxSpeed: 12,
  damping: 0.995,
};
const READY_DURATION_MS = 2000;
let readyEndsAt = null;
const MAX_RECONNECT_ATTEMPTS = 8;
const ASSETS = {
  arena: '/assets/arena.glb',
  ball: '/assets/ball.glb',
  boat: '/assets/boat.glb',
  playerFallback: '/assets/player.glb',
  players: {
    top: '/assets/player_cat.glb',
    right: '/assets/player_dog.glb',
    bottom: '/assets/player_duck.glb',
    left: '/assets/player_pigeon.glb',
  },
};
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
const SPAWN_PADS = [];
let nextSpawnPad = 0;
const playerPrefabs = new Map();
let playerFallbackPrefab = null;
let boatPrefab = null;
const TARGET_PLAYER_SIZE = { x: 3.0, z: 1.2 };
const TARGET_BOAT_SIZE = { x: 3.0, z: 1.4 };
const CHARACTER_IN_BOAT_Y = 0.6;
const params = new URLSearchParams(window.location.search);
const envWs = process.env.NEXT_PUBLIC_WS;
const storedWs = typeof localStorage !== 'undefined' ? localStorage.getItem('tf_ws_url') : null;
const wsUrl = params.get('ws') || envWs || storedWs || 'ws://localhost:7071';

// Telegram Mini App bootstrap with graceful fallback
const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
if (tg) {
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
} else {
  console.warn('Telegram WebApp not detected; running in fallback mode');
}
const audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
const sfxBuffers = new Map();
let audioUnlocked = false;
const audioState = { enabled: true };
const net = {
  enabled: true,
  wsUrl: wsUrl || 'ws://localhost:7071',
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

function resolveIdentity() {
  const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user;
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('tf_identity') : null;
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.userId && parsed.username) return parsed;
    } catch {}
  }
  const fallbackId = tgUser?.id ? `tg-${tgUser.id}` : `guest-${Math.random().toString(16).slice(2, 8)}`;
  const identity = {
    userId: tgUser?.id ? String(tgUser.id) : fallbackId,
    username: tgUser?.username || `Player_${fallbackId.slice(-4)}`,
  };
  try {
    localStorage.setItem('tf_identity', JSON.stringify(identity));
  } catch {}
  return identity;
}

net.identity = resolveIdentity();


function enableShadows(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

async function loadOptionalGltf(url) {
  try {
    return await gltfLoader.loadAsync(url);
  } catch (err) {
    console.warn('Optional GLTF not found/failed:', url);
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

let arenaGroup = createArena();

const playerMatColors = [0xff795a, 0xffd45c, 0x7ae7ff, 0xb28bff];
const sideYaw = {
  top: 0,
  right: Math.PI / 2,
  bottom: Math.PI,
  left: -Math.PI / 2,
};
const playerPortraits = {};
const playerColorBySide = {
  top: 0xff9a46, // cat orange brighter
  right: 0xfafafa, // dog white brighter
  bottom: 0xffdf57, // duck yellow brighter
  left: 0x6f9ad1, // pigeon blue brighter
};
const sideHex = (side) => `#${(playerColorBySide[side] ?? 0xffffff).toString(16).padStart(6, '0')}`;

function createPlayer(colorIndex, side) {
  const characterPrefab = prefabForSide(side) || playerFallbackPrefab;

  if (boatPrefab && characterPrefab) {
    const playerRoot = new THREE.Object3D();
    playerRoot.name = 'playerRoot';
    playerRoot.userData.side = side;

    const boat = cloneSkinned(boatPrefab);
    boat.name = 'boat';
    enableShadows(boat);

    const character = cloneSkinned(characterPrefab);
    character.name = 'character';
    enableShadows(character);
    character.position.y += CHARACTER_IN_BOAT_Y;

    boat.add(character);
    playerRoot.add(boat);
    playerRoot.rotation.y = sideYaw[side] ?? 0;
    return playerRoot;
  }

  if (characterPrefab) {
    const cloned = cloneSkinned(characterPrefab);
    enableShadows(cloned);
    cloned.scale.multiplyScalar(1.25);
    cloned.rotation.y = sideYaw[side] ?? 0;
    cloned.userData.side = side;
    return cloned;
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
  });
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

function updateCameraIntro(dt) {
  if (!camIntro.active) {
    camRestPos.copy(camBasePos);
    return;
  }
  camIntro.time = Math.min(camIntro.duration, camIntro.time + dt);
  const t = THREE.MathUtils.clamp(camIntro.time / camIntro.duration, 0, 1);
  const eased = t * t * (3 - 2 * t); // smoothstep
  tempVec3.lerpVectors(camIntro.start, camIntro.end, eased);
  camera.position.copy(tempVec3);
  camera.lookAt(0, 0, 0);
  camRestPos.copy(tempVec3);
  if (camIntro.time >= camIntro.duration) {
    camIntro.active = false;
  }
}

function updateVisualFx(dt) {
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
    camera.position.set(camRestPos.x, camRestPos.y, camRestPos.z + offset);
  } else {
    camera.position.copy(camRestPos);
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
    mesh.position.set(pos.x, 0.5, pos.z);
    scene.add(mesh);
    const player = { mesh, side, isLocal: idx === 0, id: idx === 0 ? 'local' : `bot-${idx}` };
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
    scene.remove(p.mesh);
    p.mesh = newMesh;
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
  const zone = SIDE_ZONES[side];
  if (!zone) return { x: 0, z: 0 };
  const base = {
    x: (zone.x[0] + zone.x[1]) / 2,
    z: (zone.z[0] + zone.z[1]) / 2,
  };
  if (SIDE_ANCHOR[side]) {
    const anchor = SIDE_ANCHOR[side]();
    return { x: anchor.x ?? base.x, z: anchor.z ?? base.z };
  }
  return base;
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

const ballGeom = new THREE.SphereGeometry(0.5, 36, 22);
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
ballMesh.position.y = 0.5;
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

const shadowMesh = makeBlobShadow(0.9);
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
}

function updateOverlay() {
  if (!overlayDom.root) return;
  const next = (() => {
    if (!ui.sceneReady) return 'LOADING';
    if (!net.connected) return 'CONNECTING';
    const playerCount = net.players.size || 0;
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
  const playerCount = net.players.size || 0;
  switch (next) {
    case 'LOADING':
      text.textContent = 'Total Fun';
      sub.textContent = tg ? 'Loading…' : 'Open in Telegram to play';
      root.classList.add('visible');
      break;
    case 'CONNECTING':
      text.textContent = 'Connecting…';
      sub.textContent = net.reconnectAttempts > 0 ? `Retry ${net.reconnectAttempts}` : '';
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

const ballState = {
  velocity: new THREE.Vector2(4, 2.8),
  radius: ARENA.ballRadius,
};
const lastBallPos = new THREE.Vector2();
const lastBallVel = new THREE.Vector2();
const tempVec2 = new THREE.Vector2();
const tempVec3 = new THREE.Vector3();
const impactScale = new THREE.Vector3(1.15, 0.85, 1.15);
const normalScale = new THREE.Vector3(1, 1, 1);
const ballFx = { squashTime: 0, squashDuration: 0.16 };
const camBasePos = camera.position.clone();
const camKick = { time: 0, duration: 0.15, strength: 0.1 };
const camIntro = { active: true, time: 0, duration: 0.82, start: new THREE.Vector3(camBasePos.x, camBasePos.y + 1.8, camBasePos.z + 1.8), end: camBasePos.clone() };
let camRestPos = camBasePos.clone();
const ui = {
  sceneReady: false,
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

function applyDirectionalFlags() {
  const dead = 0.08;
  input.forward = input.moveZ < -dead;
  input.back = input.moveZ > dead;
  input.left = input.moveX < -dead;
  input.right = input.moveX > dead;
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
    thumb.style.transform = 'translate(44px, 44px)';
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
    const dist = Math.min(Math.hypot(dx, dy), maxR);
    const nx = dist === 0 ? 0 : dx / dist;
    const ny = dist === 0 ? 0 : dy / dist;
    const clampR = maxR - 36; // keep thumb inside base
    thumb.style.transform = `translate(${clampR * nx + clampR + 8}px, ${clampR * ny + clampR + 8}px)`;

    // y axis inverted: up = negative dy
    setMoveVector(nx, ny, 'touch');
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
}

function bindDragControls() {
  const canvas = renderer.domElement;
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
}

function bindNetControls() {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('touchstart', unlock, { once: true });
  const ctaRetry = document.getElementById('cta-retry');
  if (ctaRetry) {
    ctaRetry.addEventListener('click', () => {
      net.manualRetry = true;
      stopNet();
      net.shouldReconnect = true;
      startNet(net.wsUrl);
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
  if (!netPanel) return;
  const debugFlag = params.get('debug');
  const visible = debugFlag === '1' || debugFlag === 'true';
  netPanel.classList.toggle('net-panel--visible', visible);
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
  if (cfg.roomTimeoutMs != null) {
    window.SERVER_CONFIG = window.SERVER_CONFIG || {};
    window.SERVER_CONFIG.roomTimeoutMs = cfg.roomTimeoutMs;
  }
}

function applyDebugUi() {}

function resetBall() {
  if (net.connected) return;
  const spawn = SPAWN_PADS[nextSpawnPad % SPAWN_PADS.length] || { x: 0, z: 0 };
  nextSpawnPad = (nextSpawnPad + 1) % Math.max(1, SPAWN_PADS.length);
  ballMesh.position.set(spawn.x, ballState.radius, spawn.z);
  shadowMesh.position.x = spawn.x;
  shadowMesh.position.z = spawn.z;
  const toCenter = new THREE.Vector2(-spawn.x, -spawn.z).normalize();
  const spread = (Math.random() - 0.5) * 0.45;
  const angle = Math.atan2(toCenter.y, toCenter.x) + spread;
  const speed = 6.2;
  ballState.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
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
      net.error = null;
      net.reconnectAttempts = 0;
      net.id = msg.payload?.playerId;
      net.side = msg.payload?.side;
      net.matchState = msg.payload?.matchState || net.matchState;
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
      if (msg.payload?.physics || msg.payload?.config) applyConfigFromServer({ physics: msg.payload.physics, arena: msg.payload.arena });
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
      net.snapshotBuffer.prev = net.snapshotBuffer.curr;
      net.snapshotBuffer.curr = { t: msg.t, payload: msg.payload, recvAt: performance.now(), sentAt: msg.ts || performance.now() };
      net.snapshot = msg;
      return;
    }
    if (msg.type === 'ERROR') {
      net.error = msg.payload;
      net.connectionState = 'error';
      console.warn('[net] error', msg.payload);
      if (msg.payload?.code === 'BAD_AUTH') {
        net.shouldReconnect = false;
        net.errorMessage = 'Authentication failed. Please relaunch from Telegram.';
      }
      if (['BAD_AUTH', 'BAD_HELLO', 'ROOM_FULL'].includes(msg.payload?.code)) {
        net.shouldReconnect = false;
      }
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
  if (!url || !net.shouldReconnect) return;
  if (net.ws) {
    net.ws.close();
    net.ws = null;
  }
  if (net.reconnectTimer) {
    clearTimeout(net.reconnectTimer);
    net.reconnectTimer = null;
  }
  net.ws = new WebSocket(url);
  net.connectionState = 'connecting';
  net.ws.addEventListener('open', () => {
    net.connectionState = 'handshake';
    net.reconnectAttempts = 0;
    net.error = null;
    const hello = {
      type: 'HELLO',
      payload: {
        userId: net.identity?.userId,
        username: net.identity?.username,
        initData: window?.Telegram?.WebApp?.initData || null,
      },
    };
    net.ws.send(JSON.stringify(hello));
  });
  net.ws.addEventListener('message', (evt) => handleNetMessage(evt));
  net.ws.addEventListener('close', (evt) => {
    net.connected = false;
    net.connectionState = 'disconnected';
    net.side = null;
    net.snapshot = null;
    net.hasSnapshot = false;
    net.errorMessage = evt?.code ? `Connection closed (${evt.code})` : '';
    if (net.shouldReconnect && !net.manualRetry) scheduleReconnect();
  });
  net.ws.addEventListener('error', (e) => {
    console.warn('[net] error', e);
    net.connected = false;
    net.connectionState = 'error';
    net.snapshot = null;
    net.hasSnapshot = false;
    net.errorMessage = e?.message || 'Network error';
    if (net.shouldReconnect && !net.manualRetry) scheduleReconnect();
  });
}

if (net.enabled) {
  net.shouldReconnect = true;
  connectWebSocket(net.wsUrl);
}

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

function startNet(url) {
  if (url) net.wsUrl = url;
  net.shouldReconnect = true;
  net.enabled = true;
  net.snapshot = null;
  net.latencyMs = null;
  net.hasSnapshot = false;
  net.players.clear();
  net.matchState = 'CONNECTING';
  clearPlayers();
  connectWebSocket(net.wsUrl);
}

async function hydrateWithGltf() {
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
    deco.position.y = -scaledBox.min.y + 0.02;
    if (arenaGroup) {
      scene.remove(arenaGroup);
    }
    scene.add(deco);
    arenaGroup = deco;
  }

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

  if (playerPrefabs.size || playerFallbackPrefab) {
    applyPrefabsToExistingPlayers();
  }

  const ballGltf = await ballPromise;
  if (ballGltf) {
    const model = ballGltf.scene;
    enableShadows(model);
    model.position.copy(ballMesh.position);
    scene.remove(ballMesh);
    ballMesh = model;
    scene.add(ballMesh);
    setBallRadiusFromObject(model);
    normalScale.copy(ballMesh.scale);
    impactScale.copy(ballMesh.scale).multiply(new THREE.Vector3(1.15, 0.85, 1.15));
  }
  await sfxPromise;
}

hydrateWithGltf();

function colorIndexBySide(side) {
  const idx = sides.indexOf(side);
  return idx >= 0 ? idx : 0;
}

function clampPlayerToZone(pos, side) {
  const zone = SIDE_ZONES[side];
  if (!zone) return;
  pos.x = THREE.MathUtils.clamp(pos.x, zone.x[0], zone.x[1]);
  pos.z = THREE.MathUtils.clamp(pos.z, zone.z[0], zone.z[1]);
}

function normalizePrefab(prefab) {
  if (!prefab) return;
  const box = new THREE.Box3().setFromObject(prefab);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x === 0 || size.z === 0) return;
  const factor = Math.min(TARGET_PLAYER_SIZE.x / size.x, TARGET_PLAYER_SIZE.z / size.z);
  prefab.scale.multiplyScalar(factor);
  const center = new THREE.Vector3();
  box.getCenter(center);
  prefab.position.sub(center); // pivot to (0,0,0)
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
  const anchor = SIDE_ANCHOR[side]?.();
  if (anchor?.x != null) pos.x = anchor.x;
  if (anchor?.z != null) pos.z = anchor.z;
}

function enforcePlayerBounds() {
  players.forEach((p) => {
    clampPlayerToSideLine(p.mesh.position, p.side);
  });
}

function syncNetPlayers(snapshotPlayers) {
  const alive = new Set();
  snapshotPlayers.forEach((sp) => {
    const pid = sp.playerId || sp.id;
    const pos = sp.pos || { x: sp.x, z: sp.z };
    clampPlayerToZone(pos, sp.side);
    let player = players.find((p) => p.id === pid);
    if (!player) {
      const mesh = createPlayer(colorIndexBySide(sp.side), sp.side);
      mesh.position.set(pos.x, 0.5, pos.z);
      scene.add(mesh);
      player = { mesh, side: sp.side, id: pid, isLocal: false };
      attachLabel(player, pid);
      const portraitPath = playerPortraits[sp.side];
      if (portraitPath) {
        const tex = loadPortraitTexture(portraitPath);
        attachPortrait(player, tex);
      }
      players.push(player);
    }
    player.isLocal = pid === net.id;
    player.side = sp.side;
    player.mesh.rotation.y = sideYaw[player.side] ?? 0;
    const displayName = net.players.get(pid)?.username || pid;
    attachLabel(player, player.isLocal ? `You (${player.side})` : displayName);
    const aligned = new THREE.Vector3(pos.x, 0.5, pos.z);
    clampPlayerToSideLine(aligned, player.side);
    player.mesh.position.lerp(aligned, 0.35);
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
  const alpha = prev ? THREE.MathUtils.clamp(elapsed / sentDelta, 0, 1.3) : 1;

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
    });
  });
  syncNetPlayers(interpPlayers);

  const cBall = curr.payload?.ball || curr.payload;
  if (cBall) {
    const pBall = prev?.payload?.ball || cBall;
    if (typeof cBall.r === 'number' && cBall.r > 0.01) {
      ballState.radius = cBall.r;
    }
    const pos = lerpVec(pBall, cBall);
    // derive velocity from position delta for impact feedback
    const velX = pos.x - lastBallPos.x;
    const velZ = pos.z - lastBallPos.z;
    tempVec2.set(velX, velZ);
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
    ballMesh.position.x = pos.x;
    ballMesh.position.z = pos.z;
    ballMesh.position.y = ballState.radius;
    shadowMesh.position.x = pos.x;
    shadowMesh.position.z = pos.z;
    shadowMesh.scale.set(ballState.radius * 2, ballState.radius * 2, 1);
  }

  if (net.matchState && net.matchState !== 'IN_PROGRESS' && net.matchState !== 'READY') {
    players.forEach((p) => {
      const base = playerDefaultPosition(p.side);
      const aligned = new THREE.Vector3(base.x, 0.5, base.z);
      clampPlayerToSideLine(aligned, p.side);
      p.mesh.position.lerp(aligned, 0.35);
    });
    ballMesh.position.lerp(new THREE.Vector3(0, ballState.radius, 0), 0.3);
    shadowMesh.position.x = ballMesh.position.x;
    shadowMesh.position.z = ballMesh.position.z;
    shadowMesh.scale.set(ballState.radius * 2, ballState.radius * 2, 1);
  }
  enforcePlayerBounds();

}

function sendNetInput() {
  if (!net.enabled || !net.connected || !net.ws || net.ws.readyState !== WebSocket.OPEN) return;
  if (net.matchState && net.matchState !== 'IN_PROGRESS' && net.matchState !== 'READY') return;
  const now = performance.now();
  if (now - net.lastInputSentAt < 50) return; // ~20 Hz cap client-side
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

function collideBallWithWalls() {
  const halfW = ARENA.width / 2;
  const halfH = ARENA.height / 2;
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
    playSfx('hit_wall', 0.4);
  }
}

function collideBallWithPlayer(player) {
  const { mesh } = player;
  const halfX = 1.1 + ballState.radius * 0.5;
  const halfZ = ARENA.playerDepth * 0.6 + ballState.radius;
  const dx = ballMesh.position.x - mesh.position.x;
  const dz = ballMesh.position.z - mesh.position.z;

  if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) return;

  const overlapX = halfX - Math.abs(dx);
  const overlapZ = halfZ - Math.abs(dz);

  if (overlapX < overlapZ) {
    const normalX = Math.sign(dx);
    ballMesh.position.x += normalX * overlapX;
    ballState.velocity.x = Math.abs(ballState.velocity.x) * normalX;
  } else {
    const normalZ = Math.sign(dz);
    ballMesh.position.z += normalZ * overlapZ;
    ballState.velocity.y = Math.abs(ballState.velocity.y) * normalZ;
  }

  const punch = player.isLocal ? 1.2 : 1.05;
  ballState.velocity.multiplyScalar(punch);
  ballState.velocity.clampLength(PHYSICS.minSpeed, PHYSICS.maxSpeed);
  playSfx('hit_player', 0.6);
}

function updateBall(dt) {
  ballMesh.position.x += ballState.velocity.x * dt;
  ballMesh.position.z += ballState.velocity.y * dt;
  ballMesh.position.y = ballState.radius;

  collideBallWithWalls();
  players.forEach(collideBallWithPlayer);

  ballState.velocity.multiplyScalar(PHYSICS.damping);
  ballState.velocity.clampLength(PHYSICS.minSpeed, PHYSICS.maxSpeed);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
}

let lastTime = performance.now();
let isPageHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  isPageHidden = document.hidden;
});

function update(dt) {
  if (net.enabled && (!net.connected || (net.matchState && net.matchState !== 'IN_PROGRESS' && net.matchState !== 'READY'))) {
    setMoveVector(0, 0, 'net-guard');
  }

  updateCameraIntro(dt);

  if (net.connected) {
    if (!input.touchActive && !input.dragActive) {
      recomputeKeyboardVector();
    }
    sendNetInput();
    applyNetState();
  }
  enforcePlayerBounds();
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
    update(dt);
    updateHud();
    updatePlayersList();
    renderer.render(scene, camera);
    if (!ui.sceneReady) ui.sceneReady = true;
  }
  requestAnimationFrame(animate);
}

animate();
bindTouchControls();
bindDragControls();
bindNetControls();
bindGameUiControls();
applyNetPanelVisibility();
applyDebugUi();
getCountdownEl();
updateHud();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('orientationchange', () => {
  // give WebView a moment to recalc safe-area
  setTimeout(() => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateHud();
  }, 100);
});

window.addEventListener('message', (evt) => {
  if (evt?.data?.type) {
    try { handleNetMessage(evt.data); } catch (e) { console.warn('local message failed', e); }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initOverlayDom();
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
});
