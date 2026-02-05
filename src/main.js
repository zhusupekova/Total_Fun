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

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 8.4, 11.5);
camera.lookAt(0, 0, 0);

const ambient = new THREE.AmbientLight(0x9fb7ff, 0.62);
scene.add(ambient);

const dir = new THREE.DirectionalLight(0xffffff, 1.05);
dir.position.set(8, 14, 7);
dir.castShadow = false;
scene.add(dir);

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
  playerFallback: '/assets/player.glb',
  players: {
    top: '/assets/player_cat.glb',
    right: '/assets/player_dog.glb',
    bottom: '/assets/player_duck.glb',
    left: '/assets/player_pigeon.glb',
  },
};
const playerPrefabs = new Map();
let playerFallbackPrefab = null;
const TARGET_PLAYER_SIZE = { x: 3.0, z: 1.2 };
const params = new URLSearchParams(window.location.search);
const envWs = process.env.NEXT_PUBLIC_WS;
const storedWs = typeof localStorage !== 'undefined' ? localStorage.getItem('tf_ws_url') : null;
const wsUrl = params.get('ws') || envWs || storedWs || 'ws://localhost:7071';

// Telegram Mini App bootstrap with graceful fallback
const tg = window.Telegram?.WebApp;
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

function createArena() {
  const group = new THREE.Group();

  // outer ring (dark)
  const outerGeom = new THREE.PlaneGeometry(ARENA.width + 3, ARENA.height + 3);
  const outerMat = new THREE.MeshStandardMaterial({ color: 0x1b2226, roughness: 0.9, metalness: 0.04 });
  const outer = new THREE.Mesh(outerGeom, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.005;
  group.add(outer);

  // main floor
  const floorGeom = new THREE.PlaneGeometry(ARENA.width * 0.9, ARENA.height * 0.9);
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024;
  floorCanvas.height = 1024;
  const fctx = floorCanvas.getContext('2d');
  fctx.fillStyle = '#d6d0c4';
  fctx.fillRect(0, 0, 1024, 1024);
  fctx.fillStyle = '#ccc5b8';
  for (let i = 0; i < 8; i++) {
    const w = 380 + Math.random() * 120;
    const h = 120 + Math.random() * 90;
    const x = Math.random() * (1024 - w);
    const y = Math.random() * (1024 - h);
    fctx.beginPath();
    fctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, Math.random() * 0.4, 0, Math.PI * 2);
    fctx.fill();
  }
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(1, 1);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.receiveShadow = true;
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // track/rail around edges
  const railCanvas = document.createElement('canvas');
  railCanvas.width = 256;
  railCanvas.height = 64;
  const rctx = railCanvas.getContext('2d');
  rctx.fillStyle = '#0c1621';
  rctx.fillRect(0, 0, 256, 64);
  rctx.fillStyle = '#12c6c3';
  for (let i = 0; i < 14; i++) {
    rctx.roundRect(6 + i * 18, 10, 14, 44, 4);
    rctx.fill();
  }
  const railTex = new THREE.CanvasTexture(railCanvas);
  railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping;
  railTex.repeat.set(20, 1);

  const railMat = new THREE.MeshStandardMaterial({ map: railTex, emissive: 0x00b7b2, emissiveIntensity: 0.5, metalness: 0.12, roughness: 0.5 });
  const railH = 0.36;
  const railT = 0.3;
  const railGeomH = new THREE.BoxGeometry(ARENA.width * 0.9 + railT * 1.2, railH, railT);
  const railGeomV = new THREE.BoxGeometry(railT, railH, ARENA.height * 0.9 + railT * 1.2);
  const railTop = new THREE.Mesh(railGeomH, railMat);
  railTop.position.set(0, railH / 2, -ARENA.height * 0.45);
  const railBottom = railTop.clone();
  railBottom.position.z = ARENA.height * 0.45;
  const railLeft = new THREE.Mesh(railGeomV, railMat);
  railLeft.position.set(-ARENA.width * 0.45, railH / 2, 0);
  const railRight = railLeft.clone();
  railRight.position.x = ARENA.width * 0.45;
  [railTop, railBottom, railLeft, railRight].forEach((r) => {
    r.castShadow = true;
    r.receiveShadow = true;
    group.add(r);
  });

  // outer wall
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b3646, metalness: 0.18, roughness: 0.6 });
  const wallThickness = 0.4;
  const wallHeight = ARENA.wallHeight;
  const edgeGeomH = new THREE.BoxGeometry(ARENA.width * 0.98, wallHeight, wallThickness);
  const edgeGeomV = new THREE.BoxGeometry(wallThickness, wallHeight, ARENA.height * 0.98);

  const topWall = new THREE.Mesh(edgeGeomH, wallMat);
  topWall.position.set(0, wallHeight / 2, -ARENA.height * 0.5);
  const bottomWall = topWall.clone();
  bottomWall.position.z = ARENA.height * 0.5;

  const leftWall = new THREE.Mesh(edgeGeomV, wallMat);
  leftWall.position.set(-ARENA.width * 0.5, wallHeight / 2, 0);
  const rightWall = leftWall.clone();
  rightWall.position.x = ARENA.width * 0.5;

  [topWall, bottomWall, leftWall, rightWall].forEach((wall) => {
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
  });

  // corner drums (cylinders)
  const drumMat = new THREE.MeshStandardMaterial({ color: 0x8ea3c3, metalness: 0.2, roughness: 0.65 });
  const drumRimMat = new THREE.MeshStandardMaterial({ color: 0xc0d6f2, metalness: 0.15, roughness: 0.5 });
  const drumRadius = 1.4;
  const drumHeight = 0.6;
  const drumGeom = new THREE.CylinderGeometry(drumRadius, drumRadius, drumHeight, 32);
  const drumTopGeom = new THREE.CircleGeometry(drumRadius * 0.9, 32);
  const drumPositions = [
    { x: -ARENA.width * 0.55, z: -ARENA.height * 0.55 },
    { x: ARENA.width * 0.55, z: -ARENA.height * 0.55 },
    { x: -ARENA.width * 0.55, z: ARENA.height * 0.55 },
    { x: ARENA.width * 0.55, z: ARENA.height * 0.55 },
  ];
  drumPositions.forEach((p) => {
    const drum = new THREE.Mesh(drumGeom, drumMat);
    drum.position.set(p.x, drumHeight / 2, p.z);
    const top = new THREE.Mesh(drumTopGeom, drumRimMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(p.x, drumHeight / 2 + 0.001, p.z);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(drumRadius * 0.78, drumRadius * 0.95, 32),
      new THREE.MeshBasicMaterial({ color: 0x91a9c8, side: THREE.DoubleSide })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(p.x, drumHeight / 2 + 0.002, p.z);
    group.add(drum, top, rim);
  });

  // spawn discs (side platforms)
  const spawnRadius = 1.15;
  const spawnH = 0.25;
  const spawnGeom = new THREE.CylinderGeometry(spawnRadius, spawnRadius, spawnH, 32);
  const spawnTopGeom = new THREE.CircleGeometry(spawnRadius * 0.9, 32);
  const spawnTopMat = new THREE.MeshStandardMaterial({ color: 0x5fb4ff, emissive: 0x1b6fb5, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.1 });
  const spawnBaseMat = new THREE.MeshStandardMaterial({ color: 0x243447, roughness: 0.6, metalness: 0.15 });
  const spawnPoints = [
    { x: 0, z: -ARENA.height / 2 - 0.2 },
    { x: 0, z: ARENA.height / 2 + 0.2 },
    { x: -ARENA.width / 2 - 0.2, z: 0 },
    { x: ARENA.width / 2 + 0.2, z: 0 },
  ];
  spawnPoints.forEach((p) => {
    const base = new THREE.Mesh(spawnGeom, spawnBaseMat);
    base.position.set(p.x, spawnH / 2, p.z);
    const cap = new THREE.Mesh(spawnTopGeom, spawnTopMat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.set(p.x, spawnH + 0.001, p.z);
    group.add(base, cap);
  });

  // floor vents / triangles
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x4d565f, roughness: 0.5, metalness: 0.2 });
  const ventGeom = new THREE.ConeGeometry(0.9, 0.12, 3);
  const vents = [
    { x: -ARENA.width * 0.18, z: -ARENA.height * 0.12, rot: Math.PI },
    { x: ARENA.width * 0.22, z: ARENA.height * 0.05, rot: 0 },
    { x: -ARENA.width * 0.22, z: ARENA.height * 0.28, rot: Math.PI / 3 },
  ];
  vents.forEach((v) => {
    const vent = new THREE.Mesh(ventGeom, ventMat);
    vent.rotation.set(Math.PI, 0, v.rot);
    vent.position.set(v.x, 0.06, v.z);
    group.add(vent);
  });

  scene.add(group);
  return group;
}

let arenaGroup = createArena();

const playerMatColors = [0xff6b6b, 0xffc952, 0x6be0ff, 0xa17dff];
const sideYaw = {
  top: 0,
  right: Math.PI / 2,
  bottom: Math.PI,
  left: -Math.PI / 2,
};
const playerPortraits = {};
const playerColorBySide = {
  top: 0xff8a3d, // cat orange
  right: 0xf5f5f5, // dog white
  bottom: 0xffd74a, // duck yellow
  left: 0x6d87b3, // pigeon blue
};
const sideHex = (side) => `#${(playerColorBySide[side] ?? 0xffffff).toString(16).padStart(6, '0')}`;

function createPlayer(colorIndex, side) {
  const prefab = prefabForSide(side);
  if (prefab) {
    const cloned = cloneSkinned(prefab);
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
    const prefab = prefabForSide(p.side);
    if (!prefab) return;
    const model = cloneSkinned(prefab);
    enableShadows(model);
    model.rotation.y = sideYaw[p.side] ?? 0;
    model.position.copy(p.mesh.position);
    scene.remove(p.mesh);
    p.mesh = model;
    scene.add(model);
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
  color: 0x8fb6f2,
  map: makeBallTexture(),
  roughness: 0.28,
  metalness: 0.12,
  emissive: 0x3c6dd8,
  emissiveIntensity: 0.2,
  envMapIntensity: 0.25,
});
let ballMesh = new THREE.Mesh(ballGeom, ballMat);
ballMesh.castShadow = true;
ballMesh.position.y = 0.5;
scene.add(ballMesh);

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
  ballMesh.position.set(0, ballState.radius, 0);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
  const angle = Math.random() * Math.PI * 2;
  const speed = 6;
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
  net.ws.addEventListener('close', () => {
    net.connected = false;
    net.connectionState = 'disconnected';
    net.side = null;
    net.snapshot = null;
    net.hasSnapshot = false;
    if (net.shouldReconnect && !net.manualRetry) scheduleReconnect();
  });
  net.ws.addEventListener('error', (e) => {
    console.warn('[net] error', e);
    net.connected = false;
    net.connectionState = 'error';
    net.snapshot = null;
    net.hasSnapshot = false;
    net.errorMessage = e?.message || '';
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
      const scaleY = Math.min(scaleX, scaleZ) * 0.1;
      deco.scale.set(scaleX, scaleY, scaleZ);
    }
    deco.position.y = 0.02;
    scene.add(deco);
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

  if (net.connected) {
    if (!input.touchActive && !input.dragActive) {
      recomputeKeyboardVector();
    }
    sendNetInput();
    applyNetState();
  }
  enforcePlayerBounds();
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
  }
  requestAnimationFrame(animate);
}

animate();
bindTouchControls();
bindDragControls();
bindNetControls();
bindGameUiControls();
applyDebugUi();
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
