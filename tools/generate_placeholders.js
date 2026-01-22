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
      this.onloadend = null;
      this.result = null;
    }
    trigger(result) {
      this.result = result;
      const evt = { target: { result } };
      if (this.onload) this.onload(evt);
      if (this.onloadend) this.onloadend(evt);
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => this.trigger(buf));
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        const mime = blob.type || 'application/octet-stream';
        const url = `data:${mime};base64,${b64}`;
        this.trigger(url);
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
const assetsDir = path.join(root, 'public', 'assets');

const exporter = new GLTFExporter();

function makeStarGeometry(outerR = 0.22, innerR = 0.1, depth = 0.05) {
  const shape = new THREE.Shape();
  const steps = 10;
  const angleStep = (Math.PI * 2) / steps;
  shape.moveTo(Math.cos(-Math.PI / 2) * outerR, Math.sin(-Math.PI / 2) * outerR);
  for (let i = 1; i < steps; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = -Math.PI / 2 + i * angleStep;
    shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
}

function hoverBase(primary = 0x1f2736, accent = 0xf05b4d) {
  const base = new THREE.Group();
  const platformH = 0.28;
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.15, platformH, 24),
    new THREE.MeshStandardMaterial({ color: primary, roughness: 0.78, metalness: 0.08 })
  );
  platform.position.y = platformH / 2;
  const bumper = new THREE.Mesh(
    new THREE.TorusGeometry(1.18, 0.12, 14, 32),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.1, metalness: 0.22, roughness: 0.4 })
  );
  bumper.rotation.x = Math.PI / 2;
  bumper.position.y = 0.18;
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.06, 10, 20),
    new THREE.MeshStandardMaterial({ color: 0x47d0ff, emissive: 0x1ee0d7, emissiveIntensity: 0.35, roughness: 0.35 })
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.y = 0.05;
  base.add(platform, bumper, glow);
  return base;
}

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

function makePlayerBase() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const base = hoverBase();
  group.add(base);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 0.9, 12, 16),
    new THREE.MeshStandardMaterial({ color: 0xff6b6b, metalness: 0.08, roughness: 0.6 })
  );
  body.position.y = 1.1;
  group.add(body);

  const visor = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.08, 10, 24),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x5ee8ff, emissiveIntensity: 0.4, roughness: 0.32 })
  );
  visor.position.set(0, 1.5, 0.35);
  visor.rotation.x = Math.PI / 2;
  group.add(visor);

  const light = new THREE.DirectionalLight(0xffffff, 1.05);
  light.position.set(4, 8, 4);
  scene.add(group, light);
  return scene;
}

function makeCat() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.add(hoverBase(0x1b1e2c, 0xffa455));

  // Body
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.55, 0.65, 18, 22),
    new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.55, metalness: 0.08 })
  );
  body.position.y = 1.05;
  root.add(body);

  // Shirt + suspenders
  const shirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.58, 0.64, 0.7, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05 })
  );
  shirt.position.y = 1.05;
  root.add(shirt);
  const suspenderMat = new THREE.MeshStandardMaterial({ color: 0x4a5f8a, roughness: 0.35, metalness: 0.1 });
  const suspenderGeom = new THREE.BoxGeometry(0.12, 1.0, 0.06);
  const sL = new THREE.Mesh(suspenderGeom, suspenderMat);
  sL.position.set(-0.25, 1.05, 0.43);
  const sR = sL.clone();
  sR.position.x = 0.25;
  root.add(sL, sR);

  // Shorts
  const shorts = new THREE.Mesh(
    new THREE.CylinderGeometry(0.64, 0.72, 0.55, 24),
    new THREE.MeshStandardMaterial({ color: 0x4d5869, roughness: 0.55, metalness: 0.08 })
  );
  shorts.position.y = 0.65;
  root.add(shorts);
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.78, 0.12, 24),
    new THREE.MeshStandardMaterial({ color: 0x3a4455, roughness: 0.55 })
  );
  cuff.position.y = 0.4;
  root.add(cuff);

  // Arms
  const armMat = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.55 });
  const armGeom = new THREE.CapsuleGeometry(0.13, 0.6, 12, 14);
  const armL = new THREE.Mesh(armGeom, armMat);
  armL.position.set(-0.62, 1.0, 0.12);
  armL.rotation.z = Math.PI * 0.12;
  const armR = armL.clone();
  armR.position.set(0.65, 1.0, 0.25);
  armR.rotation.z = -Math.PI * 0.2;
  root.add(armL, armR);

  // Legs + shoes
  const legGeom = new THREE.CapsuleGeometry(0.16, 0.42, 12, 14);
  const legL = new THREE.Mesh(legGeom, armMat);
  legL.position.set(-0.22, 0.2, 0.1);
  const legR = legL.clone();
  legR.position.set(0.18, 0.2, -0.05);
  legL.rotation.x = 0.05;
  legR.rotation.x = -0.05;
  root.add(legL, legR);
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x5b3a26, roughness: 0.55, metalness: 0.1 });
  const shoeGeom = new THREE.BoxGeometry(0.34, 0.18, 0.5);
  const shoeL = new THREE.Mesh(shoeGeom, shoeMat);
  shoeL.position.set(-0.22, -0.05, 0.2);
  const shoeR = shoeL.clone();
  shoeR.position.set(0.18, -0.05, 0.05);
  root.add(shoeL, shoeR);

  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 32, 26),
    new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.5 })
  );
  head.position.y = 1.8;
  root.add(head);

  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0xffd9b2, roughness: 0.4 })
  );
  muzzle.scale.set(1.05, 0.85, 1.1);
  muzzle.position.set(0, 1.62, 0.7);
  root.add(muzzle);

  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0x5b2d24, roughness: 0.35 })
  );
  nose.position.set(0, 1.7, 0.96);
  root.add(nose);

  const earMat = new THREE.MeshStandardMaterial({ color: 0xffa455, roughness: 0.42 });
  const earGeom = new THREE.ConeGeometry(0.26, 0.55, 10);
  const earL = new THREE.Mesh(earGeom, earMat);
  earL.position.set(-0.48, 2.25, 0.12);
  earL.rotation.set(Math.PI / 2.2, 0, Math.PI / 7);
  const earR = earL.clone();
  earR.position.x = 0.48;
  earR.rotation.z = -Math.PI / 7;
  root.add(earL, earR);

  const browMat = new THREE.MeshStandardMaterial({ color: 0x7b2f24, roughness: 0.45 });
  const browGeom = new THREE.BoxGeometry(0.32, 0.08, 0.05);
  const browL = new THREE.Mesh(browGeom, browMat);
  browL.position.set(-0.26, 1.92, 0.85);
  browL.rotation.z = 0.22;
  const browR = browL.clone();
  browR.position.x = 0.26;
  browR.rotation.z = -0.22;
  root.add(browL, browR);

  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf8f5e9, roughness: 0.35 });
  const eyeGeom = new THREE.SphereGeometry(0.22, 18, 14);
  const eyeL = new THREE.Mesh(eyeGeom, eyeWhite);
  eyeL.position.set(-0.28, 1.88, 0.82);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.28;
  const pupil = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x2b1b14, emissive: 0x0c0a0a, emissiveIntensity: 0.35 })
  );
  pupil.position.set(0, 0, 0.16);
  eyeL.add(pupil.clone());
  eyeR.add(pupil.clone());
  root.add(eyeL, eyeR);

  const hat = new THREE.Group();
  const brim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.7, 0.08, 20),
    new THREE.MeshStandardMaterial({ color: 0x6b4a35, roughness: 0.55, metalness: 0.08 })
  );
  const crown = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.52, 0.32, 20),
    new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.5, metalness: 0.08 })
  );
  crown.position.y = 0.2;
  brim.position.y = 0.05;
  hat.add(brim, crown);
  hat.position.set(0.04, 2.28, -0.08);
  hat.rotation.z = -0.25;
  root.add(hat);

  const cane = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 1.75, 12),
    new THREE.MeshStandardMaterial({ color: 0x5b3a26, metalness: 0.08, roughness: 0.55 })
  );
  cane.position.set(0.92, 0.8, 0.65);
  cane.rotation.x = 0.18;
  const caneTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2b1b11, roughness: 0.6 })
  );
  caneTip.position.y = -0.9;
  cane.add(caneTip);
  root.add(cane);

  const watch = new THREE.Mesh(
    new THREE.TorusGeometry(0.11, 0.03, 10, 18),
    new THREE.MeshStandardMaterial({ color: 0xf5e44c, metalness: 0.4, roughness: 0.22, emissive: 0xf5e44c, emissiveIntensity: 0.2 })
  );
  watch.position.set(0.64, 1.02, 0.72);
  watch.rotation.x = Math.PI / 2;
  root.add(watch);

  const tail = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.6, 12),
    new THREE.MeshStandardMaterial({ color: 0xffa455, roughness: 0.45 })
  );
  tail.position.set(-0.35, 0.7, -0.48);
  tail.rotation.x = -Math.PI / 6;
  root.add(tail);

  const light = new THREE.DirectionalLight(0xffffff, 1.1);
  light.position.set(4, 8, 5);
  scene.add(root, light);
  return scene;
}

function makeDog() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.add(hoverBase(0x21252f, 0xf05b4d));

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.58, 0.75, 16, 20),
    new THREE.MeshStandardMaterial({ color: 0xf7f7f7, roughness: 0.4, metalness: 0.05 })
  );
  body.position.y = 1.0;
  root.add(body);

  const jacket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 0.85, 0.95, 22),
    new THREE.MeshStandardMaterial({ color: 0x5a2f1f, roughness: 0.55, metalness: 0.15 })
  );
  jacket.position.y = 1.0;
  root.add(jacket);

  const zipper = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.9, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.2, metalness: 0.6 })
  );
  zipper.position.set(0, 1.0, 0.45);
  root.add(zipper);

  // Collar with spikes
  const spikeGeom = new THREE.ConeGeometry(0.08, 0.16, 8);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.8, roughness: 0.2 });
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.07, 12, 24),
    new THREE.MeshStandardMaterial({ color: 0x0f0f0f, roughness: 0.4, metalness: 0.3 })
  );
  collar.position.set(0, 1.5, 0);
  collar.rotation.x = Math.PI / 2;
  for (let i = 0; i < 10; i++) {
    const spike = new THREE.Mesh(spikeGeom, spikeMat);
    const angle = (i / 10) * Math.PI * 2;
    spike.position.set(Math.cos(angle) * 0.55, 1.5, Math.sin(angle) * 0.55);
    spike.lookAt(0, 1.5, 0);
    root.add(spike);
  }
  root.add(collar);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 28, 22),
    new THREE.MeshStandardMaterial({ color: 0xf7f7f7, roughness: 0.42 })
  );
  head.position.y = 1.9;
  root.add(head);

  const snout = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.24, 16, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 })
  );
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, 1.72, 0.68);
  root.add(snout);

  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0x4b3129, roughness: 0.3 })
  );
  nose.position.set(0, 1.75, 0.95);
  root.add(nose);

  const earGeom = new THREE.BoxGeometry(0.18, 0.55, 0.22);
  const earMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e9, roughness: 0.32 });
  const earL = new THREE.Mesh(earGeom, earMat);
  earL.position.set(-0.38, 2.25, 0.06);
  earL.rotation.z = 0.18;
  const earR = earL.clone();
  earR.position.x = 0.38;
  earR.rotation.z = -0.18;
  root.add(earL, earR);

  const shadesMat = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, emissive: 0x303030, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.3 });
  const starGeo = makeStarGeometry(0.26, 0.11, 0.05);
  const shadeL = new THREE.Mesh(starGeo, shadesMat);
  shadeL.position.set(-0.24, 1.95, 0.82);
  const shadeR = shadeL.clone();
  shadeR.position.x = 0.24;
  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.06, 0.05),
    shadesMat.clone()
  );
  bridge.position.set(0, 1.92, 0.83);
  root.add(shadeL, shadeR, bridge);

  const browMat = new THREE.MeshStandardMaterial({ color: 0x6b3b2a, roughness: 0.4 });
  const browGeom = new THREE.BoxGeometry(0.24, 0.06, 0.04);
  const browL = new THREE.Mesh(browGeom, browMat);
  browL.position.set(-0.22, 1.98, 0.78);
  browL.rotation.z = 0.25;
  const browR = browL.clone();
  browR.position.x = 0.22;
  browR.rotation.z = -0.25;
  root.add(browL, browR);

  // Arms / hands
  const armMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f7, roughness: 0.42 });
  const armGeom = new THREE.CapsuleGeometry(0.14, 0.55, 12, 14);
  const armL = new THREE.Mesh(armGeom, armMat);
  armL.position.set(-0.7, 1.0, 0.1);
  armL.rotation.z = Math.PI * 0.18;
  const armR = armL.clone();
  armR.position.set(0.7, 1.0, 0.15);
  armR.rotation.z = -Math.PI * 0.16;
  root.add(armL, armR);

  // Legs / boots
  const legGeom = new THREE.CapsuleGeometry(0.18, 0.45, 12, 14);
  const legL = new THREE.Mesh(legGeom, armMat);
  legL.position.set(-0.22, 0.2, 0.05);
  const legR = legL.clone();
  legR.position.set(0.24, 0.2, 0.05);
  root.add(legL, legR);

  const bootMat = new THREE.MeshStandardMaterial({ color: 0x4b2f24, roughness: 0.55, metalness: 0.12 });
  const bootGeom = new THREE.BoxGeometry(0.38, 0.2, 0.58);
  const bootL = new THREE.Mesh(bootGeom, bootMat);
  bootL.position.set(-0.22, -0.05, 0.22);
  const bootR = bootL.clone();
  bootR.position.x = 0.24;
  root.add(bootL, bootR);

  const light = new THREE.DirectionalLight(0xffffff, 1.08);
  light.position.set(4, 8, 4);
  scene.add(root, light);
  return scene;
}

function makeDuck() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.add(hoverBase(0x163040, 0x5fd4ff));

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 28, 22),
    new THREE.MeshStandardMaterial({ color: 0xffe05c, roughness: 0.38 })
  );
  body.position.y = 1.05;
  root.add(body);

  const shirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 1.05, 0.85, 26, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x76b8ff, roughness: 0.45, metalness: 0.08 })
  );
  shirt.position.y = 1.05;
  shirt.position.z = 0.0;
  root.add(shirt);

  // Rips
  const tearMat = new THREE.MeshStandardMaterial({ color: 0x4f8bff, roughness: 0.5 });
  const tearGeom = new THREE.BoxGeometry(0.08, 0.16, 0.02);
  const tear = new THREE.Mesh(tearGeom, tearMat);
  tear.position.set(0.3, 0.65, 0.52);
  root.add(tear);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.78, 28, 22),
    new THREE.MeshStandardMaterial({ color: 0xffe05c, roughness: 0.36 })
  );
  head.position.y = 1.95;
  root.add(head);

  const beak = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.35, 14, 18),
    new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.32 })
  );
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.82, 0.9);
  root.add(beak);

  const shadesMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x111111, emissiveIntensity: 0.35, roughness: 0.25 });
  const starGeo = makeStarGeometry(0.26, 0.11, 0.05);
  const shadeL = new THREE.Mesh(starGeo, shadesMat);
  shadeL.position.set(-0.28, 2.02, 0.92);
  const shadeR = shadeL.clone();
  shadeR.position.x = 0.28;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.05), shadesMat);
  bridge.position.set(0, 1.98, 0.94);
  root.add(shadeL, shadeR, bridge);

  const browMat = new THREE.MeshStandardMaterial({ color: 0x7b4b1f, roughness: 0.4 });
  const browGeom = new THREE.BoxGeometry(0.24, 0.08, 0.04);
  const browL = new THREE.Mesh(browGeom, browMat);
  browL.position.set(-0.24, 2.08, 0.85);
  browL.rotation.z = 0.18;
  const browR = browL.clone();
  browR.position.x = 0.24;
  browR.rotation.z = -0.18;
  root.add(browL, browR);

  const wingMat = new THREE.MeshStandardMaterial({ color: 0xffe05c, roughness: 0.45 });
  const wingGeom = new THREE.CapsuleGeometry(0.2, 0.7, 14, 18);
  const wingL = new THREE.Mesh(wingGeom, wingMat);
  wingL.position.set(-0.98, 1.1, 0.05);
  wingL.rotation.z = Math.PI / 3;
  const wingR = wingL.clone();
  wingR.position.x = 0.98;
  wingR.rotation.z = -Math.PI / 3;
  root.add(wingL, wingR);

  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.24, 0.65, 14),
    new THREE.MeshStandardMaterial({ color: 0xea5a36, roughness: 0.35, metalness: 0.05 })
  );
  cup.position.set(0.92, 0.95, 0.5);
  const straw = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.55, 10),
    new THREE.MeshStandardMaterial({ color: 0x0f1d3a, emissive: 0x0f1d3a, emissiveIntensity: 0.2 })
  );
  straw.position.set(0, 0.45, 0.02);
  straw.rotation.x = -0.25;
  cup.add(straw);
  root.add(cup);

  const legMat = new THREE.MeshStandardMaterial({ color: 0xffa23d, roughness: 0.4 });
  const legGeom = new THREE.CapsuleGeometry(0.2, 0.28, 12, 14);
  const legL = new THREE.Mesh(legGeom, legMat);
  legL.position.set(-0.26, 0.1, 0);
  const legR = legL.clone();
  legR.position.x = 0.26;
  root.add(legL, legR);

  const footMat = new THREE.MeshStandardMaterial({ color: 0xde6b2d, roughness: 0.45 });
  const footGeom = new THREE.BoxGeometry(0.5, 0.15, 0.6);
  const footL = new THREE.Mesh(footGeom, footMat);
  footL.position.set(-0.26, -0.1, 0.18);
  const footR = footL.clone();
  footR.position.x = 0.26;
  root.add(footL, footR);

  const light = new THREE.DirectionalLight(0xffffff, 1.05);
  light.position.set(4, 8, 4);
  scene.add(root, light);
  return scene;
}

function makePigeon() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.add(hoverBase(0x1d2635, 0x7fd0ff));

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.58, 0.95, 16, 20),
    new THREE.MeshStandardMaterial({ color: 0x7f9cc6, roughness: 0.42, metalness: 0.08 })
  );
  body.position.y = 1.05;
  root.add(body);

  const jacket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.78, 0.88, 0.95, 22),
    new THREE.MeshStandardMaterial({ color: 0x0e111b, roughness: 0.55, metalness: 0.15 })
  );
  jacket.position.y = 1.0;
  root.add(jacket);

  const zipper = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.9, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xbcd7ff, roughness: 0.25, metalness: 0.5 })
  );
  zipper.position.set(0, 1.0, 0.46);
  root.add(zipper);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 26, 20),
    new THREE.MeshStandardMaterial({ color: 0x9ab5d8, roughness: 0.4 })
  );
  head.position.y = 1.92;
  root.add(head);

  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.32, 14),
    new THREE.MeshStandardMaterial({ color: 0xffb377, roughness: 0.32 })
  );
  beak.position.set(0, 1.78, 0.86);
  beak.rotation.x = Math.PI / 2;
  root.add(beak);

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x1e1e1e, emissiveIntensity: 0.12 });
  const eyeGeom = new THREE.SphereGeometry(0.18, 16, 12);
  const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
  eyeL.position.set(-0.24, 1.95, 0.74);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.24;
  const pupil = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x26324a, emissive: 0x26324a, emissiveIntensity: 0.25 })
  );
  pupil.position.set(0, 0, 0.12);
  eyeL.add(pupil.clone());
  eyeR.add(pupil.clone());
  root.add(eyeL, eyeR);

  const shadesMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, emissive: 0x202020, emissiveIntensity: 0.35, roughness: 0.25 });
  const starGeo = makeStarGeometry(0.22, 0.1, 0.05);
  const shadeL = new THREE.Mesh(starGeo, shadesMat);
  shadeL.position.set(-0.22, 2.06, 0.82);
  const shadeR = shadeL.clone();
  shadeR.position.x = 0.22;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.05), shadesMat);
  bridge.position.set(0, 2.02, 0.82);
  root.add(shadeL, shadeR, bridge);

  const cap = new THREE.Group();
  const capBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 0.5, 0.12, 20),
    new THREE.MeshStandardMaterial({ color: 0x0c121f, roughness: 0.5, metalness: 0.12 })
  );
  capBase.position.y = 0.06;
  const capTop = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 20, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x111a2c, roughness: 0.45, metalness: 0.12 })
  );
  capTop.position.y = 0.12;
  const brim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 0.06, 20),
    new THREE.MeshStandardMaterial({ color: 0x0c121f, roughness: 0.5, metalness: 0.08 })
  );
  brim.position.y = -0.02;
  const backFlap = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.08, 0.38),
    new THREE.MeshStandardMaterial({ color: 0x0c121f, roughness: 0.5, metalness: 0.08 })
  );
  backFlap.position.set(0, -0.05, -0.4);
  cap.add(capBase, capTop, brim, backFlap);
  cap.rotation.set(0.1, Math.PI, 0);
  cap.position.set(0, 2.32, -0.08);
  root.add(cap);

  const wingMat = new THREE.MeshStandardMaterial({ color: 0x6d87b3, roughness: 0.45 });
  const wingGeom = new THREE.CapsuleGeometry(0.2, 0.65, 14, 18);
  const wingL = new THREE.Mesh(wingGeom, wingMat);
  wingL.position.set(-0.92, 1.05, 0.1);
  wingL.rotation.z = Math.PI / 3.2;
  const wingR = wingL.clone();
  wingR.position.x = 0.92;
  wingR.rotation.z = -Math.PI / 3.2;
  root.add(wingL, wingR);

  const legMat = new THREE.MeshStandardMaterial({ color: 0xff8f8f, roughness: 0.45 });
  const legGeom = new THREE.CylinderGeometry(0.12, 0.1, 0.65, 10);
  const legL = new THREE.Mesh(legGeom, legMat);
  legL.position.set(-0.2, 0.2, 0.0);
  const legR = legL.clone();
  legR.position.x = 0.2;
  root.add(legL, legR);

  const footMat = new THREE.MeshStandardMaterial({ color: 0xff8080, roughness: 0.5 });
  const footGeom = new THREE.BoxGeometry(0.32, 0.12, 0.48);
  const footL = new THREE.Mesh(footGeom, footMat);
  footL.position.set(-0.2, -0.1, 0.18);
  const footR = footL.clone();
  footR.position.x = 0.2;
  root.add(footL, footR);

  const tail = new THREE.Mesh(
    new THREE.ConeGeometry(0.26, 0.7, 10),
    new THREE.MeshStandardMaterial({ color: 0x7f9cc6, roughness: 0.4 })
  );
  tail.position.set(0, 0.95, -0.7);
  tail.rotation.x = -Math.PI / 4;
  root.add(tail);

  const light = new THREE.DirectionalLight(0xffffff, 1.05);
  light.position.set(4, 8, 4);
  scene.add(root, light);
  return scene;
}

async function main() {
  await fs.promises.mkdir(assetsDir, { recursive: true });
  await exportScene(makeArena(), path.join(assetsDir, 'arena.glb'));
  await exportScene(makePlayerBase(), path.join(assetsDir, 'player.glb'));
  await exportScene(makeCat(), path.join(assetsDir, 'player_cat.glb'));
  await exportScene(makeDog(), path.join(assetsDir, 'player_dog.glb'));
  await exportScene(makeDuck(), path.join(assetsDir, 'player_duck.glb'));
  await exportScene(makePigeon(), path.join(assetsDir, 'player_pigeon.glb'));
  await exportScene(makeBall(), path.join(assetsDir, 'ball.glb'));
  console.log('Placeholders exported to assets/.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
