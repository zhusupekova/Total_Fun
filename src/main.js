import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.161.0/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'https://unpkg.com/three@0.161.0/examples/jsm/utils/SkeletonUtils.js';

const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d111c);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 13, 15);
camera.lookAt(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xa0d8ff, 0x1a1f2a, 0.8);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.25);
dir.position.set(10, 16, 9);
dir.castShadow = true;
dir.shadow.camera.left = -16;
dir.shadow.camera.right = 16;
dir.shadow.camera.top = 16;
dir.shadow.camera.bottom = -16;
dir.shadow.mapSize.set(1024, 1024);
scene.add(dir);

const ARENA = { width: 16, height: 10, wallHeight: 1.2, playerDepth: 0.7 };
const ASSETS = {
  arena: 'assets/arena.glb',
  ball: 'assets/ball.glb',
  playerFallback: 'assets/player.glb',
  players: {
    top: 'assets/player_cat.glb',
    right: 'assets/player_dog.glb',
    bottom: 'assets/player_duck.glb',
    left: 'assets/player_pigeon.glb',
  },
};
const playerPrefabs = new Map();
let playerFallbackPrefab = null;
const params = new URLSearchParams(window.location.search);
const wsUrl = params.get('ws');
const audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
const sfxBuffers = new Map();
let audioUnlocked = false;
const net = {
  enabled: !!wsUrl,
  wsUrl: wsUrl || 'ws://localhost:7071',
  ws: null,
  connected: false,
  id: null,
  side: null,
  snapshot: null,
  lastInput: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
  latencyMs: null,
  shouldReconnect: !!wsUrl,
  hasSnapshot: false,
};
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

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

  // main floor
  const floorGeom = new THREE.PlaneGeometry(ARENA.width, ARENA.height);
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024;
  floorCanvas.height = 1024;
  const fctx = floorCanvas.getContext('2d');
  fctx.fillStyle = '#d6d1cf';
  fctx.fillRect(0, 0, 1024, 1024);
  fctx.fillStyle = '#c9c3c0';
  for (let i = 0; i < 18; i++) {
    const w = 180 + Math.random() * 220;
    const h = 40 + Math.random() * 80;
    const x = Math.random() * (1024 - w);
    const y = Math.random() * (1024 - h);
    fctx.beginPath();
    fctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, Math.random(), 0, Math.PI * 2);
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
  rctx.fillStyle = '#0e1624';
  rctx.fillRect(0, 0, 256, 64);
  rctx.fillStyle = '#1ee0d7';
  for (let i = 0; i < 12; i++) {
    rctx.roundRect(8 + i * 20, 16, 14, 32, 4);
    rctx.fill();
  }
  const railTex = new THREE.CanvasTexture(railCanvas);
  railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping;
  railTex.repeat.set(20, 1);

  const railMat = new THREE.MeshStandardMaterial({ map: railTex, emissive: 0x0b9dad, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.4 });
  const railH = 0.4;
  const railT = 0.35;
  const railGeomH = new THREE.BoxGeometry(ARENA.width + railT * 2, railH, railT);
  const railGeomV = new THREE.BoxGeometry(railT, railH, ARENA.height + railT * 2);
  const railTop = new THREE.Mesh(railGeomH, railMat);
  railTop.position.set(0, railH / 2, -ARENA.height / 2 - railT / 2);
  const railBottom = railTop.clone();
  railBottom.position.z = ARENA.height / 2 + railT / 2;
  const railLeft = new THREE.Mesh(railGeomV, railMat);
  railLeft.position.set(-ARENA.width / 2 - railT / 2, railH / 2, 0);
  const railRight = railLeft.clone();
  railRight.position.x = ARENA.width / 2 + railT / 2;
  [railTop, railBottom, railLeft, railRight].forEach((r) => {
    r.castShadow = true;
    r.receiveShadow = true;
    group.add(r);
  });

  // outer wall
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b3d64, metalness: 0.2, roughness: 0.5 });
  const wallThickness = 0.6;
  const wallHeight = ARENA.wallHeight;
  const edgeGeomH = new THREE.BoxGeometry(ARENA.width + wallThickness * 2, wallHeight, wallThickness);
  const edgeGeomV = new THREE.BoxGeometry(wallThickness, wallHeight, ARENA.height + wallThickness * 2);

  const topWall = new THREE.Mesh(edgeGeomH, wallMat);
  topWall.position.set(0, wallHeight / 2, -ARENA.height / 2 - wallThickness / 2);
  const bottomWall = topWall.clone();
  bottomWall.position.z = ARENA.height / 2 + wallThickness / 2;

  const leftWall = new THREE.Mesh(edgeGeomV, wallMat);
  leftWall.position.set(-ARENA.width / 2 - wallThickness / 2, wallHeight / 2, 0);
  const rightWall = leftWall.clone();
  rightWall.position.x = ARENA.width / 2 + wallThickness / 2;

  [topWall, bottomWall, leftWall, rightWall].forEach((wall) => {
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
  });

  // corner pods and mid structures (simplified)
  const podGeom = new THREE.CylinderGeometry(1.2, 1.2, 0.7, 22);
  const podMat = new THREE.MeshStandardMaterial({ color: 0x6ba8d9, metalness: 0.25, roughness: 0.5 });
  const podPositions = [
    [-ARENA.width / 2 - 2.2, -ARENA.height / 2 - 2.2],
    [ARENA.width / 2 + 2.2, -ARENA.height / 2 - 2.2],
    [-ARENA.width / 2 - 2.2, ARENA.height / 2 + 2.2],
    [ARENA.width / 2 + 2.2, ARENA.height / 2 + 2.2],
  ];
  podPositions.forEach(([x, z]) => {
    const pod = new THREE.Mesh(podGeom, podMat);
    pod.position.set(x, 0.35, z);
    pod.castShadow = true;
    pod.receiveShadow = true;
    group.add(pod);
  });

  // triangular floor markers
  const triGeom = new THREE.ConeGeometry(0.7, 0.05, 3);
  const triMat = new THREE.MeshStandardMaterial({ color: 0x2f3c4f, metalness: 0.1, roughness: 0.6 });
  const triOffsets = [
    [-ARENA.width * 0.3, -ARENA.height * 0.05],
    [ARENA.width * 0.3, ARENA.height * 0.05],
    [ARENA.width * 0.1, -ARENA.height * 0.3],
    [-ARENA.width * 0.1, ARENA.height * 0.3],
  ];
  triOffsets.forEach(([x, z], idx) => {
    const tri = new THREE.Mesh(triGeom, triMat);
    tri.rotation.x = Math.PI / 2;
    tri.rotation.z = idx % 2 === 0 ? 0 : Math.PI;
    tri.position.set(x, 0.03, z);
    tri.castShadow = false;
    tri.receiveShadow = false;
    group.add(tri);
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
const playerPortraits = {
  top: 'ref_character_cat.jpeg',
  right: 'ref_character_dog.png',
  bottom: 'ref_character_duck.jpeg',
  left: 'ref_character_pigeon.jpeg',
};
const playerColorBySide = {
  top: 0xff8a3d, // cat orange
  right: 0xf5f5f5, // dog white
  bottom: 0xffd74a, // duck yellow
  left: 0x6d87b3, // pigeon blue
};
function prefabForSide(side) {
  return playerPrefabs.get(side) || playerFallbackPrefab || null;
}

function createPlayer(colorIndex, side) {
  const prefab = prefabForSide(side);
  if (prefab) {
    const cloned = cloneSkinned(prefab);
    enableShadows(cloned);
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
  if (!audioContext || !audioUnlocked) return;
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

initOfflinePlayers();

function playerDefaultPosition(side) {
  switch (side) {
    case 'top': return { x: 0, z: -ARENA.height / 2 + ARENA.playerDepth };
    case 'bottom': return { x: 0, z: ARENA.height / 2 - ARENA.playerDepth };
    case 'left': return { x: -ARENA.width / 2 + ARENA.playerDepth, z: 0 };
    case 'right': return { x: ARENA.width / 2 - ARENA.playerDepth, z: 0 };
    default: return { x: 0, z: 0 };
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

const shadowGeom = new THREE.CircleGeometry(0.8, 28);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.35, transparent: true });
const shadowMesh = new THREE.Mesh(shadowGeom, shadowMat);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.position.y = 0.001;
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
  radius: 0.5,
};

const input = { forward: false, back: false, left: false, right: false, paused: false };

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.code === 'KeyW') input.forward = true;
  if (e.code === 'KeyS') input.back = true;
  if (e.code === 'KeyA') input.left = true;
  if (e.code === 'KeyD') input.right = true;
  if (e.code === 'Space') input.paused = !input.paused;
  if (e.code === 'KeyR') resetBall();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') input.forward = false;
  if (e.code === 'KeyS') input.back = false;
  if (e.code === 'KeyA') input.left = false;
  if (e.code === 'KeyD') input.right = false;
});

function bindTouchControls() {
  const root = document.getElementById('touch-controls');
  if (!root) return;
  const active = new Set();
  const setDir = (dir, down) => {
    if (dir === 'up') input.forward = down;
    if (dir === 'down') input.back = down;
    if (dir === 'left') input.left = down;
    if (dir === 'right') input.right = down;
  };
  const handleDown = (dir, id) => {
    active.add(id);
    setDir(dir, true);
  };
  const handleUp = (id) => {
    active.delete(id);
    // recompute all directions from active pointers
    input.forward = false;
    input.back = false;
    input.left = false;
    input.right = false;
    active.forEach((stored) => {
      const btn = root.querySelector(`[data-id="${stored}"]`);
      if (!btn) return;
      const dir = btn.dataset.dir;
      setDir(dir, true);
    });
  };
  const buttons = root.querySelectorAll('.tc-btn');
  buttons.forEach((btn, idx) => {
    btn.dataset.id = `touch-${idx}`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      handleDown(btn.dataset.dir, e.pointerId.toString());
    });
    btn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      handleUp(e.pointerId.toString());
      btn.releasePointerCapture(e.pointerId);
    });
    btn.addEventListener('pointercancel', (e) => {
      handleUp(e.pointerId.toString());
    });
  });
}

function bindNetControls() {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('touchstart', unlock, { once: true });
  const input = document.getElementById('ws-url');
  const btnConnect = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');
  if (input && net.wsUrl) input.value = net.wsUrl;
  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      const url = input?.value?.trim() || net.wsUrl;
      startNet(url);
    });
  }
  if (btnDisconnect) {
    btnDisconnect.addEventListener('click', () => {
      stopNet();
    });
  }
}

function resetBall() {
  if (net.enabled && net.connected && net.ws && net.ws.readyState === WebSocket.OPEN) {
    net.ws.send(JSON.stringify({ type: 'reset_ball' }));
    return;
  }
  ballMesh.position.set(0, ballState.radius, 0);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
  const angle = Math.random() * Math.PI * 2;
  const speed = 5.5;
  ballState.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
}

resetBall();

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
  net.ws.addEventListener('open', () => {
    net.connected = true;
    net.reconnectDelay = 1000;
    console.log('[net] connected');
  });
  net.ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'welcome') {
        net.id = msg.id;
        net.side = msg.side;
        if (msg.arena) {
          ARENA.width = msg.arena.width ?? ARENA.width;
          ARENA.height = msg.arena.height ?? ARENA.height;
          ARENA.playerDepth = msg.arena.playerDepth ?? ARENA.playerDepth;
        }
      }
      if (msg.type === 'state') {
        if (typeof msg.t === 'number') {
          const sample = Math.max(0, Date.now() - msg.t);
          net.latencyMs = net.latencyMs == null ? sample : THREE.MathUtils.lerp(net.latencyMs, sample, 0.25);
        }
        if (!net.hasSnapshot) {
          clearPlayers();
          net.hasSnapshot = true;
        }
        net.snapshot = msg;
      }
    } catch (err) {
      console.warn('Bad net message', err);
    }
  });
  net.ws.addEventListener('close', () => {
    net.connected = false;
    console.warn('[net] disconnected');
    if (net.shouldReconnect) {
      net.reconnectTimer = setTimeout(() => {
        net.reconnectDelay = Math.min(net.reconnectDelay * 1.6, 8000);
        connectWebSocket(net.wsUrl);
      }, net.reconnectDelay);
    }
  });
  net.ws.addEventListener('error', (e) => {
    console.warn('[net] error', e);
  });
}

if (net.enabled) {
  net.shouldReconnect = true;
  connectWebSocket(net.wsUrl);
}

function stopNet() {
  net.shouldReconnect = false;
  net.enabled = false;
  net.connected = false;
  net.id = null;
  net.side = null;
  net.snapshot = null;
  net.latencyMs = null;
  net.hasSnapshot = false;
  if (net.reconnectTimer) {
    clearTimeout(net.reconnectTimer);
    net.reconnectTimer = null;
  }
  if (net.ws) {
    net.ws.close();
    net.ws = null;
  }
  clearPlayers();
  initOfflinePlayers();
  resetBall();
}

function startNet(url) {
  if (url) net.wsUrl = url;
  net.shouldReconnect = true;
  net.enabled = true;
  net.snapshot = null;
  net.latencyMs = null;
  net.hasSnapshot = false;
  clearPlayers();
  connectWebSocket(net.wsUrl);
}

function applyPrefabsToExistingPlayers() {
  players.forEach((p) => {
    const prefab = prefabForSide(p.side);
    if (!prefab) return;
    const model = cloneSkinned(prefab);
    enableShadows(model);
    model.position.copy(p.mesh.position);
    model.rotation.y = sideYaw[p.side] ?? 0;
    model.userData.side = p.side;
    scene.remove(p.mesh);
    p.mesh = model;
    scene.add(model);
  });
}

async function hydrateWithGltf() {
  const arenaPromise = loadOptionalGltf(ASSETS.arena);
  const ballPromise = loadOptionalGltf(ASSETS.ball);
  const sfxPromise = Promise.all([
    loadSfx('hit_player', 'assets/sfx/hit_player.ogg'),
    loadSfx('hit_wall', 'assets/sfx/hit_wall.ogg'),
    loadSfx('goal', 'assets/sfx/goal.ogg'),
    loadSfx('magnet', 'assets/sfx/magnet.ogg'),
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
    enableShadows(playerFallbackPrefab);
  }

  const playerResults = await Promise.all(playerPromises);
  playerResults.forEach(([side, gltf]) => {
    if (!gltf) return;
    const prefab = gltf.scene;
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

function clampPlayer(pos, side) {
  const margin = 0.4;
  if (side === 'top' || side === 'bottom') {
    const z = side === 'top' ? -ARENA.height / 2 + 1.1 : ARENA.height / 2 - 1.1;
    pos.z = z;
    pos.x = THREE.MathUtils.clamp(pos.x, -ARENA.width / 2 + margin, ARENA.width / 2 - margin);
  } else {
    const x = side === 'left' ? -ARENA.width / 2 + 1.1 : ARENA.width / 2 - 1.1;
    pos.x = x;
    pos.z = THREE.MathUtils.clamp(pos.z, -ARENA.height / 2 + margin, ARENA.height / 2 - margin);
  }
}

function moveLocalPlayer(dt) {
  const speed = 8;
  const player = players.find((p) => p.isLocal);
  if (!player) return;
  const dir = new THREE.Vector2(0, 0);
  if (input.forward) dir.y -= 1;
  if (input.back) dir.y += 1;
  if (input.left) dir.x -= 1;
  if (input.right) dir.x += 1;
  if (dir.lengthSq() > 0) dir.normalize();

  if (player.side === 'top' || player.side === 'bottom') {
    player.mesh.position.x += dir.x * speed * dt;
    player.mesh.position.z += dir.y * speed * dt * 0.25;
  } else {
    player.mesh.position.z += dir.y * speed * dt;
    player.mesh.position.x += dir.x * speed * dt * 0.25;
  }
  clampPlayer(player.mesh.position, player.side);
}

function moveBots(dt) {
  players.forEach((p) => {
    if (p.isLocal) return;
    const target = ballMesh.position;
    const speed = 4.2;
    if (p.side === 'top' || p.side === 'bottom') {
      const dirX = Math.sign(target.x - p.mesh.position.x);
      p.mesh.position.x += dirX * speed * dt;
    } else {
      const dirZ = Math.sign(target.z - p.mesh.position.z);
      p.mesh.position.z += dirZ * speed * dt;
    }
    clampPlayer(p.mesh.position, p.side);
  });
}

function syncNetPlayers(snapshotPlayers) {
  const alive = new Set();
  snapshotPlayers.forEach((sp) => {
    let player = players.find((p) => p.id === sp.id);
    if (!player) {
      const mesh = createPlayer(colorIndexBySide(sp.side), sp.side);
      mesh.position.set(sp.x, 0.5, sp.z);
      scene.add(mesh);
      player = { mesh, side: sp.side, id: sp.id, isLocal: false };
      attachLabel(player, sp.id);
      const portraitPath = playerPortraits[sp.side];
      if (portraitPath) {
        const tex = loadPortraitTexture(portraitPath);
        attachPortrait(player, tex);
      }
      players.push(player);
    }
    player.isLocal = sp.id === net.id;
    player.side = sp.side;
    player.mesh.rotation.y = sideYaw[player.side] ?? 0;
    attachLabel(player, player.isLocal ? `You (${player.side})` : `${player.id}`);
    player.mesh.position.lerp(new THREE.Vector3(sp.x, 0.5, sp.z), 0.35);
    alive.add(sp.id);
  });
  const toRemove = players.filter((p) => p.id && !alive.has(p.id));
  toRemove.forEach((p) => scene.remove(p.mesh));
  for (const dead of toRemove) {
    const idx = players.indexOf(dead);
    if (idx >= 0) players.splice(idx, 1);
  }
}

function applyNetState(dt) {
  if (!net.snapshot) return;
  const { ball, players: plist } = net.snapshot;
  syncNetPlayers(plist || []);
  if (ball) {
    if (typeof ball.r === 'number' && ball.r > 0.01) {
      ballState.radius = ball.r;
    }
    ballMesh.position.x = THREE.MathUtils.lerp(ballMesh.position.x, ball.x, 0.4);
    ballMesh.position.z = THREE.MathUtils.lerp(ballMesh.position.z, ball.z, 0.4);
    ballMesh.position.y = ballState.radius;
    shadowMesh.position.x = ballMesh.position.x;
    shadowMesh.position.z = ballMesh.position.z;
  }
}

function sendNetInput() {
  if (!net.enabled || !net.connected || !net.ws || net.ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: 'input', input: { forward: input.forward, back: input.back, left: input.left, right: input.right } };
  const serialized = JSON.stringify(payload);
  if (serialized !== net.lastInput) {
    net.ws.send(serialized);
    net.lastInput = serialized;
  }
}

function updateHud() {
  const netEl = document.getElementById('net-status');
  if (!netEl) return;
  if (!net.enabled) {
    netEl.textContent = 'Mode: offline demo (local physics + bots)';
  } else if (net.connected) {
    const ping = net.latencyMs != null ? `, ping ~${net.latencyMs.toFixed(0)}ms` : '';
    netEl.textContent = `Mode: online WS (${net.wsUrl}) — player ${net.id ?? '?'} side ${net.side ?? '?'}${ping}`;
  } else {
    netEl.textContent = `Mode: online WS connecting to ${net.wsUrl || ''}`;
  }
}

function updatePlayersList() {
  const listEl = document.getElementById('players-list');
  if (!listEl) return;
  if (!players.length) {
    listEl.innerHTML = '<div class="player-row"><span>No players</span><span></span></div>';
    return;
  }
  listEl.innerHTML = players
    .map((p) => {
      const name = p.isLocal ? `${p.id || 'you'} (you)` : p.id || 'player';
      const side = p.side || '-';
      return `<div class="player-row"><span>${name}</span><span>${side}</span></div>`;
    })
    .join('');
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
    ballState.velocity.multiplyScalar(0.995);
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
  ballState.velocity.clampLength(2.5, 11);
  playSfx('hit_player', 0.6);
}

function updateBall(dt) {
  ballMesh.position.x += ballState.velocity.x * dt;
  ballMesh.position.z += ballState.velocity.y * dt;
  ballMesh.position.y = ballState.radius;

  collideBallWithWalls();
  players.forEach(collideBallWithPlayer);

  ballState.velocity.multiplyScalar(0.999);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
}

let lastTime = performance.now();

function animate() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;

  if (!input.paused) {
    if (net.enabled && net.connected) {
      sendNetInput();
      applyNetState(dt);
    } else {
      moveLocalPlayer(dt);
      moveBots(dt);
      updateBall(dt);
    }
  }

  updateHud();
  updatePlayersList();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
bindTouchControls();
bindNetControls();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
