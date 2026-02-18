import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

// Extract `BallSpawn*` empty nodes from an arena GLB and convert them into game XZ coordinates.
// This is a build-time utility to keep server-authoritative spawn points in sync with the GLB.
//
// Usage:
//   node tools/extract_ball_spawns.js [arena.glb] [out.json]
//
// Notes:
// - We compute the arena X/Z scale exactly like the client: scale to ARENA.width/height using GLB bbox.
// - We only output X/Z, because gameplay runs on XZ plane.
// - If BallSpawn nodes have meaningful rotation, we also export a forward direction (fx,fz) in game space.
//   Some GLBs ship spawns with identity rotation; in that case we fall back to aiming toward arena center.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const inPath = process.argv[2] || path.join(root, 'public', 'assets', 'arena.glb');
const outPath = process.argv[3] || path.join(root, 'server', 'ball_spawns.json');

const ARENA_WIDTH = Number(process.env.ARENA_WIDTH || 12);
const ARENA_HEIGHT = Number(process.env.ARENA_HEIGHT || 8);

function readGlbJson(buffer) {
  // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
  if (buffer.length < 20) throw new Error('GLB too small');
  const magic = buffer.toString('utf8', 0, 4);
  if (magic !== 'glTF') throw new Error('Not a GLB (missing glTF magic)');
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}`);
  const totalLen = buffer.readUInt32LE(8);
  if (totalLen !== buffer.length) {
    // tolerate mismatch; some tools pad the buffer
  }
  let off = 12;
  while (off + 8 <= buffer.length) {
    const chunkLen = buffer.readUInt32LE(off);
    const chunkType = buffer.readUInt32LE(off + 4);
    off += 8;
    const chunk = buffer.subarray(off, off + chunkLen);
    off += chunkLen;
    // JSON chunk type = 0x4E4F534A ('JSON')
    if (chunkType === 0x4e4f534a) {
      const jsonText = new TextDecoder('utf-8').decode(chunk);
      return JSON.parse(jsonText);
    }
  }
  throw new Error('No JSON chunk found in GLB');
}

function computeBboxXZ(gltf) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const accessors = gltf.accessors || [];
  const meshes = gltf.meshes || [];

  for (const mesh of meshes) {
    for (const prim of mesh?.primitives || []) {
      const accIdx = prim?.attributes?.POSITION;
      if (typeof accIdx !== 'number') continue;
      const acc = accessors[accIdx];
      if (!acc?.min || !acc?.max || acc.min.length < 3 || acc.max.length < 3) continue;
      minX = Math.min(minX, acc.min[0]);
      maxX = Math.max(maxX, acc.max[0]);
      minZ = Math.min(minZ, acc.min[2]);
      maxZ = Math.max(maxZ, acc.max[2]);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    throw new Error('Unable to compute bbox from POSITION accessors (missing min/max?)');
  }
  return { minX, maxX, minZ, maxZ };
}

function buildParentMap(gltf) {
  const nodes = gltf.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, idx) => {
    for (const child of n?.children || []) {
      if (typeof child === 'number' && child >= 0 && child < nodes.length) {
        parent[child] = idx;
      }
    }
  });
  return parent;
}

function localMatrixForNode(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return new THREE.Matrix4().fromArray(node.matrix);
  }
  const t = node?.translation || [0, 0, 0];
  const r = node?.rotation || [0, 0, 0, 1];
  const s = node?.scale || [1, 1, 1];
  const pos = new THREE.Vector3(t[0] || 0, t[1] || 0, t[2] || 0);
  const quat = new THREE.Quaternion(r[0] || 0, r[1] || 0, r[2] || 0, r[3] == null ? 1 : r[3]);
  const scl = new THREE.Vector3(s[0] == null ? 1 : s[0], s[1] == null ? 1 : s[1], s[2] == null ? 1 : s[2]);
  return new THREE.Matrix4().compose(pos, quat, scl);
}

function computeWorldMatrices(gltf) {
  const nodes = gltf.nodes || [];
  const parent = buildParentMap(gltf);
  const local = nodes.map(localMatrixForNode);
  const world = new Array(nodes.length).fill(null);

  const compute = (idx) => {
    if (world[idx]) return world[idx];
    const p = parent[idx];
    if (p >= 0) {
      world[idx] = compute(p).clone().multiply(local[idx]);
    } else {
      world[idx] = local[idx].clone();
    }
    return world[idx];
  };

  for (let i = 0; i < nodes.length; i += 1) compute(i);
  return world;
}

function extractBallSpawnNodes(gltf) {
  const nodes = gltf.nodes || [];
  const candidates = [];
  nodes.forEach((n, idx) => {
    const name = n?.name;
    if (typeof name === 'string' && name.startsWith('BallSpawn')) {
      candidates.push({ idx, name });
    }
  });

  const idxFromName = (name) => {
    const m = String(name).match(/BallSpawn[_\\s-]*(\\d+)/);
    return m ? Number.parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
  };
  candidates.sort((a, b) => (idxFromName(a.name) - idxFromName(b.name)) || a.name.localeCompare(b.name));
  return candidates;
}

function main() {
  const buf = fs.readFileSync(inPath);
  const gltf = readGlbJson(buf);

  const bbox = computeBboxXZ(gltf);
  const sizeX = bbox.maxX - bbox.minX;
  const sizeZ = bbox.maxZ - bbox.minZ;
  if (!(sizeX > 1e-6 && sizeZ > 1e-6)) throw new Error('Invalid bbox size');

  const scaleX = ARENA_WIDTH / sizeX;
  const scaleZ = ARENA_HEIGHT / sizeZ;

  const world = computeWorldMatrices(gltf);
  const spawnNodes = extractBallSpawnNodes(gltf);

  if (!spawnNodes.length) {
    console.warn('[extract_ball_spawns] No BallSpawn* nodes found in', inPath);
  }

  const out = spawnNodes.map(({ idx, name }) => {
    const m = world[idx];
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    // three.js Matrix4 is column-major: column 2 is local +Z axis in world space.
    const e = m.elements;
    const plusZ = new THREE.Vector3(e[8], e[9], e[10]);

    // Convert both position and direction into our game arena space (non-uniform scale on X/Z),
    // then project onto XZ plane and normalize.
    const gx = pos.x * scaleX;
    const gz = pos.z * scaleZ;

    const forward = new THREE.Vector2(plusZ.x * scaleX, plusZ.z * scaleZ);
    const forwardLen = forward.length();
    const forwardN = forwardLen > 1e-6 ? forward.multiplyScalar(1 / forwardLen) : null;

    const toCenter = new THREE.Vector2(-gx, -gz);
    const toCenterLen = toCenter.length();
    const toCenterN = toCenterLen > 1e-6 ? toCenter.multiplyScalar(1 / toCenterLen) : new THREE.Vector2(0, 1);

    const alignment = forwardN ? Math.abs(forwardN.dot(toCenterN)) : 0;

    return { name, x: gx, z: gz, forwardN, toCenterN, alignment };
  });

  // If spawns do not have meaningful rotation (common for simple "empty" nodes),
  // using matrix forward will be wrong (all spawns will share the same axis).
  // Detect this and fall back to "aim at center" for forward vectors.
  const avgAlign = out.length ? out.reduce((sum, p) => sum + (p.alignment || 0), 0) / out.length : 0;
  const useForwardAxes = avgAlign >= 0.85;
  if (!useForwardAxes && out.length) {
    console.warn(`[extract_ball_spawns] BallSpawn forward axes look unconfigured (avg alignment ${avgAlign.toFixed(2)}). Falling back to center-based fx/fz.`);
  }

  // Write server format: [{x,z,fx,fz},...]
  const points = out.map((p) => {
    const dir = (useForwardAxes && p.forwardN) ? p.forwardN.clone() : p.toCenterN.clone();
    // Ensure direction points inward (roughly toward center).
    if (dir.dot(p.toCenterN) < 0) dir.multiplyScalar(-1);
    return {
      x: Math.round(p.x * 1000) / 1000,
      z: Math.round(p.z * 1000) / 1000,
      fx: Math.round(dir.x * 1000) / 1000,
      fz: Math.round(dir.y * 1000) / 1000,
    };
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(points, null, 2)}\n`, 'utf-8');
  console.log('[extract_ball_spawns] wrote', outPath);
  if (out.length) {
    console.log('[extract_ball_spawns] points:', out.map((p) => ({
      name: p.name,
      x: p.x,
      z: p.z,
      fx: (useForwardAxes && p.forwardN ? p.forwardN.x : p.toCenterN.x),
      fz: (useForwardAxes && p.forwardN ? p.forwardN.y : p.toCenterN.y),
    })));
  }
}

main();
