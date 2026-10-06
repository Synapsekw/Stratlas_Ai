/**
 * A minimal glTF 2.0 binary (GLB) writer, browser and Node safe (no Buffer): one node per part,
 * named (so asset tags, issues and part matching across dates find it), with positions relative
 * to the node's translation (float64 in JSON, so float32 vertices keep millimetres far from the
 * origin), normals, linear vertex colours and one matte material. Same layout as
 * `tools/demo/glb.mjs` and `@aio/project` OBJ import.
 */

export interface GlbPart {
  name: string;
  /** glTF node extras (`tag`, `type`), read by the engine for the selection card. */
  extras?: Record<string, string | number | boolean>;
  translation: readonly [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex. */
  colors: Float32Array;
  indices: Uint32Array;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

interface BufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target: number;
}

export function writeGlb(
  parts: readonly GlbPart[],
  o: { root: string; generator: string },
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: BufferView[] = [];
  const accessors: Record<string, unknown>[] = [];
  const push = (typed: ArrayBufferView, target: number): number => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const part of parts) {
    const n = part.positions.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = part.positions[3 * i + k] ?? 0;
        if (v < (min[k] ?? 0)) min[k] = v;
        if (v > (max[k] ?? 0)) max[k] = v;
      }
    }
    const accessor = (a: Record<string, unknown>) => accessors.push(a) - 1;
    const pos = accessor({
      bufferView: push(part.positions, ARRAY_BUFFER),
      componentType: FLOAT,
      count: n,
      type: 'VEC3',
      min,
      max,
    });
    const nrm = accessor({
      bufferView: push(part.normals, ARRAY_BUFFER),
      componentType: FLOAT,
      count: n,
      type: 'VEC3',
    });
    const col = accessor({
      bufferView: push(part.colors, ARRAY_BUFFER),
      componentType: FLOAT,
      count: n,
      type: 'VEC3',
    });
    const small = n <= 65535;
    const idx = small ? Uint16Array.from(part.indices) : part.indices;
    const ind = accessor({
      bufferView: push(idx, ELEMENT_ARRAY_BUFFER),
      componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: idx.length,
      type: 'SCALAR',
    });
    meshes.push({
      name: part.name,
      primitives: [
        { attributes: { POSITION: pos, NORMAL: nrm, COLOR_0: col }, indices: ind, material: 0 },
      ],
    });
    nodes.push({
      name: part.name,
      mesh: meshes.length - 1,
      translation: [...part.translation],
      ...(part.extras ? { extras: part.extras } : {}),
    });
  }
  const gltf = {
    asset: { version: '2.0', generator: o.generator },
    scene: 0,
    scenes: [{ name: o.root, nodes: [nodes.length] }],
    nodes: [...nodes, { name: o.root, children: nodes.map((_, i) => i) }],
    ...(meshes.length ? { meshes } : {}),
    materials: [
      {
        name: 'paint',
        doubleSided: false,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.85,
        },
      },
    ],
    ...(accessors.length ? { accessors, bufferViews, buffers: [{ byteLength: offset }] } : {}),
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonLen = json.length + jsonPad;
  const total = 12 + 8 + jsonLen + (offset ? 8 + offset : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLen);
  if (offset) {
    let at = 20 + jsonLen;
    dv.setUint32(at, offset, true);
    dv.setUint32(at + 4, 0x004e4942, true); // BIN
    at += 8;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
  }
  return out;
}

/** The JSON chunk and binary chunk of a GLB (tests, checks). */
export function readGlb(glb: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) {
    throw new Error('Not a GLB file.');
  }
  if (dv.getUint32(8, true) !== glb.byteLength) throw new Error('The GLB length is wrong.');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('The GLB has no JSON chunk first.');
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as Record<
    string,
    unknown
  >;
  const at = 20 + jsonLen;
  if (at >= glb.byteLength) return { json, bin: new Uint8Array(0) };
  const binLen = dv.getUint32(at, true);
  if (dv.getUint32(at + 4, true) !== 0x004e4942)
    throw new Error('The second GLB chunk is not BIN.');
  return { json, bin: glb.subarray(at + 8, at + 8 + binLen) };
}
