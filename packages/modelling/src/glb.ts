/**
 * A minimal glTF 2.0 binary (GLB) writer, browser and Node safe (no Buffer): one node per part,
 * named (so asset tags, issues and part matching across dates find it), with positions relative
 * to the node's translation (float64 in JSON, so float32 vertices keep millimetres far from the
 * origin), normals, linear vertex colours and one matte material. Same layout as
 * `tools/demo/glb.mjs` and `@aio/project` OBJ import. `writeGlbV2` writes the engineering model:
 * PBR materials, a node hierarchy and JSON extras, one primitive per material.
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
  return packGlb(gltf, chunks, offset);
}

/** A PBR material of a `writeGlbV2` file (linear RGB factors). */
export interface GlbMaterial {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive?: [number, number, number];
  doubleSided?: boolean;
}

/**
 * A node of a `writeGlbV2` file: one mesh with one primitive per material (no mesh when there are
 * no primitives), positions relative to `translation`, JSON `extras`, and child nodes.
 */
export interface GlbNodeV2 {
  name: string;
  extras: Record<string, unknown>;
  translation: [number, number, number];
  primitives: {
    material: number;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
  }[];
  children?: GlbNodeV2[];
}

/** The binary chunk of a GLB being written: buffer views and accessors over it. */
class BinChunk {
  readonly chunks: Uint8Array[] = [];
  readonly bufferViews: BufferView[] = [];
  readonly accessors: Record<string, unknown>[] = [];
  offset = 0;

  /** Appends `typed` (4-byte aligned) as a buffer view; returns the view index. */
  view(typed: ArrayBufferView, target: number): number {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    this.bufferViews.push({ buffer: 0, byteOffset: this.offset, byteLength: bytes.length, target });
    this.chunks.push(bytes, new Uint8Array(pad));
    this.offset += bytes.length + pad;
    return this.bufferViews.length - 1;
  }

  accessor(a: Record<string, unknown>): number {
    return this.accessors.push(a) - 1;
  }
}

function minMax(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] ?? 0;
      if (v < (min[k] ?? 0)) min[k] = v;
      if (v > (max[k] ?? 0)) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * A glTF 2.0 binary with PBR materials and a node hierarchy: under one root node `o.root`, each
 * node of `nodes` (and its children) with its JSON `extras` and one mesh holding one primitive per
 * material index. Materials are written as `pbrMetallicRoughness` with `emissiveFactor` and
 * `doubleSided`; `o.assetExtras` becomes `asset.extras`. Positions are written as given (relative
 * to the node translation); indices are 16-bit when a primitive has fewer than 65536 vertices.
 * Primitives without triangles are left out.
 */
export function writeGlbV2(
  nodes: readonly GlbNodeV2[],
  o: {
    root: string;
    generator: string;
    materials: readonly GlbMaterial[];
    assetExtras?: Record<string, unknown>;
  },
): Uint8Array {
  const bin = new BinChunk();
  const meshes: Record<string, unknown>[] = [];
  const out: Record<string, unknown>[] = [];
  const add = (n: GlbNodeV2): number => {
    const primitives: Record<string, unknown>[] = [];
    for (const p of n.primitives) {
      const count = p.positions.length / 3;
      if (p.indices.length === 0 || count === 0) continue;
      if (!(p.material >= 0 && p.material < o.materials.length))
        throw new Error(
          `GLB node "${n.name}" uses material ${String(p.material)}, which is missing.`,
        );
      const POSITION = bin.accessor({
        bufferView: bin.view(p.positions, ARRAY_BUFFER),
        componentType: FLOAT,
        count,
        type: 'VEC3',
        ...minMax(p.positions),
      });
      const NORMAL = bin.accessor({
        bufferView: bin.view(p.normals, ARRAY_BUFFER),
        componentType: FLOAT,
        count,
        type: 'VEC3',
      });
      // 65535 is the primitive restart value of 16-bit indices, so it is never an index
      const small = count <= 65535;
      const idx = small ? Uint16Array.from(p.indices) : p.indices;
      const indices = bin.accessor({
        bufferView: bin.view(idx, ELEMENT_ARRAY_BUFFER),
        componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT,
        count: idx.length,
        type: 'SCALAR',
      });
      primitives.push({ attributes: { POSITION, NORMAL }, indices, material: p.material });
    }
    const at = out.push({}) - 1;
    const node: Record<string, unknown> = { name: n.name, translation: [...n.translation] };
    if (primitives.length) node.mesh = meshes.push({ name: n.name, primitives }) - 1;
    if (Object.keys(n.extras).length) node.extras = n.extras;
    const children = (n.children ?? []).map(add);
    if (children.length) node.children = children;
    out[at] = node;
    return at;
  };
  const top = nodes.map(add);
  const root = out.push({ name: o.root, children: top }) - 1;
  const gltf = {
    asset: {
      version: '2.0',
      generator: o.generator,
      ...(o.assetExtras ? { extras: o.assetExtras } : {}),
    },
    scene: 0,
    scenes: [{ name: o.root, nodes: [root] }],
    nodes: out,
    ...(meshes.length ? { meshes } : {}),
    ...(o.materials.length
      ? {
          materials: o.materials.map((m) => ({
            name: m.name,
            pbrMetallicRoughness: {
              baseColorFactor: [...m.baseColor],
              metallicFactor: m.metallic,
              roughnessFactor: m.roughness,
            },
            ...(m.emissive ? { emissiveFactor: [...m.emissive] } : {}),
            ...(m.doubleSided ? { doubleSided: true } : {}),
          })),
        }
      : {}),
    ...(bin.accessors.length
      ? {
          accessors: bin.accessors,
          bufferViews: bin.bufferViews,
          buffers: [{ byteLength: bin.offset }],
        }
      : {}),
  };
  return packGlb(gltf, bin.chunks, bin.offset);
}

/** The GLB container: a 12-byte header, the JSON chunk and, when there is one, the BIN chunk. */
function packGlb(gltf: unknown, chunks: readonly Uint8Array[], offset: number): Uint8Array {
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
