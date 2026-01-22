import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Polyfills required by GLTFExporter in Node
if (typeof FileReader === 'undefined') {
  globalThis.FileReader = class {
    constructor() {
      this.onload = null;
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        if (this.onload) this.onload({ target: { result: buf } });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        const mime = blob.type || 'application/octet-stream';
        const url = `data:${mime};base64,${b64}`;
        if (this.onload) this.onload({ target: { result: url } });
      });
    }
  };
}
if (typeof URL === 'undefined' || !URL.createObjectURL) {
  globalThis.URL = {
    createObjectURL: () => '',
    revokeObjectURL: () => {},
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');

const exporter = new GLTFExporter();

function exportScene(scene, outPath) {
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (gltf) => {
        console.log('Parsed', outPath, 'type', gltf?.constructor?.name);
        if (gltf instanceof ArrayBuffer) {
          fs.writeFileSync(outPath, Buffer.from(gltf));
          console.log('Wrote', outPath);
          resolve();
        } else {
          fs.writeFileSync(outPath, JSON.stringify(gltf, null, 2), 'utf-8');
          console.log('Wrote (json)', outPath);
          resolve();
        }
      },
      (err) => {
        console.error('Export error for', outPath, err);
        reject(err);
      },
      { binary: true }
    );
  });
}

function makeArena() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const W = 16;
  const H = 10;
  const wallH = 1.2;
  const wallT = 0.4;

  const floorGeom = new THREE.PlaneGeometry(W, H);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x283346, roughness: 0.9, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x374864, metalness: 0.2, roughness: 0.5 });
  const edgeGeomH = new THREE.BoxGeometry(W + wallT * 2, wallH, wallT);
  const edgeGeomV = new THREE.BoxGeometry(wallT, wallH, H + wallT * 2);

  const top = new THREE.Mesh(edgeGeomH, wallMat);
  top.position.set(0, wallH / 2, -H / 2 - wallT / 2);
  const bottom = top.clone();
  bottom.position.z = H / 2 + wallT / 2;
  const left = new THREE.Mesh(edgeGeomV, wallMat);
  left.position.set(-W / 2 - wallT / 2, wallH / 2, 0);
  const right = left.clone();
  right.position.x = W / 2 + wallT / 2;

  [top, bottom, left, right].forEach((w) => group.add(w));

  scene.add(group);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 10, 5);
  scene.add(light);
  return scene;
}

function makePlayer() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();

  const body = new THREE.CapsuleGeometry(0.9, 1.1, 10, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff6b6b, metalness: 0.1, roughness: 0.6 });
  const bodyMesh = new THREE.Mesh(body, bodyMat);
  bodyMesh.position.y = 1.2;
  group.add(bodyMesh);

  const base = new THREE.CylinderGeometry(1.2, 1.3, 0.3, 14);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1f2736, roughness: 0.85 });
  const baseMesh = new THREE.Mesh(base, baseMat);
  baseMesh.position.y = 0.2;
  group.add(baseMesh);

  const paddle = new THREE.BoxGeometry(2.2, 0.4, 0.3);
  const paddleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.3 });
  const paddleMesh = new THREE.Mesh(paddle, paddleMat);
  paddleMesh.position.y = 1.5;
  group.add(paddleMesh);

  group.rotation.y = 0;
  scene.add(group);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(4, 8, 4);
  scene.add(light);
  return scene;
}

function makeBall() {
  const scene = new THREE.Scene();
  const sphere = new THREE.SphereGeometry(0.45, 24, 18);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ad1ff, roughness: 0.25, metalness: 0.25 });
  const mesh = new THREE.Mesh(sphere, mat);
  mesh.position.y = 0.45;
  scene.add(mesh);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(3, 6, 2);
  scene.add(light);
  return scene;
}

async function main() {
  await fs.promises.mkdir(assetsDir, { recursive: true });
  await exportScene(makeArena(), path.join(assetsDir, 'arena.glb'));
  await exportScene(makePlayer(), path.join(assetsDir, 'player.glb'));
  await exportScene(makeBall(), path.join(assetsDir, 'ball.glb'));
  console.log('Placeholders exported to assets/.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
