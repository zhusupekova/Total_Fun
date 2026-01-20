import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';

const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d16);

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

const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(6, 10, 4);
dir.castShadow = true;
dir.shadow.camera.left = -16;
dir.shadow.camera.right = 16;
dir.shadow.camera.top = 16;
dir.shadow.camera.bottom = -16;
dir.shadow.mapSize.set(1024, 1024);
scene.add(dir);

const ARENA = { width: 16, height: 10, wallHeight: 1.2, playerDepth: 0.7 };

function createArena() {
  const group = new THREE.Group();

  const floorGeom = new THREE.PlaneGeometry(ARENA.width, ARENA.height);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x242b3d, roughness: 0.9, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.receiveShadow = true;
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const markings = new THREE.GridHelper(ARENA.width, ARENA.width / 1, 0x3b4b6b, 0x2c3b55);
  markings.position.y = 0.01;
  markings.rotation.y = Math.PI / 2;
  group.add(markings);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x303f58, metalness: 0.15, roughness: 0.6 });
  const wallThickness = 0.4;
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

  scene.add(group);
}

createArena();

const playerMatColors = [0xff6b6b, 0xffc952, 0x6be0ff, 0xa17dff];

function createPlayer(colorIndex, side) {
  const bodyGeom = new THREE.BoxGeometry(2.2, 0.8, ARENA.playerDepth);
  const mat = new THREE.MeshStandardMaterial({ color: playerMatColors[colorIndex], metalness: 0.1, roughness: 0.5 });
  const mesh = new THREE.Mesh(bodyGeom, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const paddleGeom = new THREE.BoxGeometry(2.2, 0.4, 0.3);
  const paddleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.3 });
  const paddle = new THREE.Mesh(paddleGeom, paddleMat);
  paddle.position.y = 0.4;
  mesh.add(paddle);

  const baseGeom = new THREE.CylinderGeometry(1.2, 1.3, 0.25, 14);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x222a3a, roughness: 0.8 });
  const base = new THREE.Mesh(baseGeom, baseMat);
  base.position.y = -0.4;
  mesh.add(base);

  mesh.userData.side = side;
  return mesh;
}

const players = [];
const sides = ['top', 'right', 'bottom', 'left'];

sides.forEach((side, idx) => {
  const mesh = createPlayer(idx, side);
  const pos = playerDefaultPosition(side);
  mesh.position.set(pos.x, 0.5, pos.z);
  scene.add(mesh);
  players.push({ mesh, side, isLocal: idx === 0 });
});

function playerDefaultPosition(side) {
  switch (side) {
    case 'top': return { x: 0, z: -ARENA.height / 2 + ARENA.playerDepth };
    case 'bottom': return { x: 0, z: ARENA.height / 2 - ARENA.playerDepth };
    case 'left': return { x: -ARENA.width / 2 + ARENA.playerDepth, z: 0 };
    case 'right': return { x: ARENA.width / 2 - ARENA.playerDepth, z: 0 };
    default: return { x: 0, z: 0 };
  }
}

const ballGeom = new THREE.SphereGeometry(0.45, 24, 18);
const ballMat = new THREE.MeshStandardMaterial({ color: 0x9ad1ff, roughness: 0.2, metalness: 0.3 });
const ballMesh = new THREE.Mesh(ballGeom, ballMat);
ballMesh.castShadow = true;
ballMesh.position.y = 0.45;
scene.add(ballMesh);

const shadowGeom = new THREE.CircleGeometry(0.65, 24);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.25, transparent: true });
const shadowMesh = new THREE.Mesh(shadowGeom, shadowMat);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.position.y = 0.001;
scene.add(shadowMesh);

const ballState = {
  velocity: new THREE.Vector2(4, 2.8),
  radius: 0.45,
};

const input = { forward: false, back: false, left: false, right: false, paused: false };

window.addEventListener('keydown', (e) => {
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

function resetBall() {
  ballMesh.position.set(0, ballState.radius, 0);
  shadowMesh.position.x = ballMesh.position.x;
  shadowMesh.position.z = ballMesh.position.z;
  const angle = Math.random() * Math.PI * 2;
  const speed = 5.5;
  ballState.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
}

resetBall();

function clampPlayer(pos, side) {
  const margin = 0.4;
  if (side === 'top' || side === 'bottom') {
    const z = side === 'top' ? -ARENA.height / 2 + ARENA.playerDepth : ARENA.height / 2 - ARENA.playerDepth;
    pos.z = z;
    pos.x = THREE.MathUtils.clamp(pos.x, -ARENA.width / 2 + margin, ARENA.width / 2 - margin);
  } else {
    const x = side === 'left' ? -ARENA.width / 2 + ARENA.playerDepth : ARENA.width / 2 - ARENA.playerDepth;
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
    moveLocalPlayer(dt);
    moveBots(dt);
    updateBall(dt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
