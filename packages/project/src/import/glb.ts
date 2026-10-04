/**
 * Minimal glTF 2.0 binary writer for generated meshes (terrain, outlines): float attributes,
 * 16 or 32-bit indices, embedded images, plain PBR materials, node extras.
 */

export interface GlbPrimitive {
  material: number;
  /** `triangles` (default) or `lines` (index pairs). */
  mode?: 'triangles' | 'lines';
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
}

export interface GlbMesh {
  name: string;
  primitives: GlbPrimitive[];
}

export interface GlbNode {
  name: string;
  mesh?: number;
  children?: number[];
  extras?: Record<string, unknown>;
}

export interface GlbMaterial {
  name: string;
  /** Linear RGBA base colour factor. */
  color?: [number, number, number, number];
  /** Index into `images`, used as the base colour texture. */
  texture?: number;
  doubleSided?: boolean;
}

export interface GlbDoc {
  generator?: string;
  nodes: GlbNode[];
  /** Root nodes of the scene. */
  scene: number[];
  meshes: GlbMesh[];
  materials: GlbMaterial[];
  images: { mimeType: 'image/jpeg' | 'image/png'; data: Uint8Array }[];
}

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3';
  min?: number[];
  max?: number[];
}

export interface GltfJson {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: GlbNode[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }[];
  }[];
  materials?: {
    name?: string;
    doubleSided?: boolean;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
      metallicFactor?: number;
      roughnessFactor?: number;
    };
  }[];
  textures?: { sampler: number; source: number }[];
  samplers?: { magFilter: number; minFilter: number; wrapS: number; wrapT: number }[];
  images?: { bufferView: number; mimeType: string }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[];
  buffers?: { byteLength: number }[];
}

const FLOAT = 5126;
const U16 = 5123;
const U32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function encodeGlb(doc: GlbDoc): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: NonNullable<GltfJson['bufferViews']> = [];
  const accessors: GltfAccessor[] = [];
  const view = (bytes: Uint8Array, target?: number): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    chunks.push(bytes);
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    offset += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const bytesOf = (a: Float32Array | Uint32Array | Uint16Array) =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const floatAccessor = (a: Float32Array, n: 2 | 3, bounds: boolean): number => {
    const acc: GltfAccessor = {
      bufferView: view(bytesOf(a), ARRAY_BUFFER),
      componentType: FLOAT,
      count: a.length / n,
      type: n === 3 ? 'VEC3' : 'VEC2',
    };
    if (bounds) {
      const min = new Array<number>(n).fill(Infinity);
      const max = new Array<number>(n).fill(-Infinity);
      for (let i = 0; i < a.length; i++) {
        const v = a[i] ?? 0;
        const k = i % n;
        if (v < (min[k] ?? 0)) min[k] = v;
        if (v > (max[k] ?? 0)) max[k] = v;
      }
      acc.min = min.map((v) => Math.fround(v));
      acc.max = max.map((v) => Math.fround(v));
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const indexAccessor = (idx: Uint32Array, vertexCount: number): number => {
    const small = vertexCount <= 0xffff;
    const data = small ? Uint16Array.from(idx) : idx;
    accessors.push({
      bufferView: view(bytesOf(data), ELEMENT_ARRAY_BUFFER),
      componentType: small ? U16 : U32,
      count: idx.length,
      type: 'SCALAR',
    });
    return accessors.length - 1;
  };

  const meshes: NonNullable<GltfJson['meshes']> = doc.meshes.map((m) => ({
    name: m.name,
    primitives: m.primitives.map((p) => {
      const count = p.positions.length / 3;
      const attributes: Record<string, number> = { POSITION: floatAccessor(p.positions, 3, true) };
      if (p.normals) attributes.NORMAL = floatAccessor(p.normals, 3, false);
      if (p.uvs) attributes.TEXCOORD_0 = floatAccessor(p.uvs, 2, false);
      return {
        attributes,
        indices: indexAccessor(p.indices, count),
        material: p.material,
        ...(p.mode === 'lines' ? { mode: 1 } : {}),
      };
    }),
  }));
  const images = doc.images.map((img) => ({ bufferView: view(img.data), mimeType: img.mimeType }));

  const json: GltfJson = {
    asset: { version: '2.0', ...(doc.generator ? { generator: doc.generator } : {}) },
    scene: 0,
    scenes: [{ nodes: doc.scene }],
    nodes: doc.nodes,
    meshes,
    materials: doc.materials.map((m) => ({
      name: m.name,
      ...(m.doubleSided ? { doubleSided: true } : {}),
      pbrMetallicRoughness: {
        ...(m.color ? { baseColorFactor: m.color } : {}),
        ...(m.texture !== undefined ? { baseColorTexture: { index: m.texture } } : {}),
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  if (images.length) {
    // linear filtering with mipmaps, clamped at the edges
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = images.map((_, i) => ({ sampler: 0, source: i }));
    json.images = images;
  }

  const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binLen = offset + ((4 - (offset % 4)) % 4);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let p = 20 + jsonBytes.byteLength;
  dv.setUint32(p, binLen, true);
  dv.setUint32(p + 4, 0x004e4942, true);
  p += 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

function padTo4(b: Uint8Array, fill: number): Uint8Array {
  const pad = (4 - (b.byteLength % 4)) % 4;
  if (!pad) return b;
  const out = new Uint8Array(b.byteLength + pad).fill(fill);
  out.set(b);
  return out;
}

/** Split a GLB into its JSON and BIN chunks. */
export function parseGlb(glb: Uint8Array): { json: GltfJson; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as GltfJson;
  const p = 20 + jsonLen;
  const bin =
    p + 8 <= glb.byteLength ? glb.subarray(p + 8, p + 8 + dv.getUint32(p, true)) : new Uint8Array();
  return { json, bin };
}

/** Values of an accessor as numbers (float, uint16 and uint32 components). */
export function readAccessor(
  json: GltfJson,
  bin: Uint8Array,
  index: number,
): Float32Array | Uint16Array | Uint32Array {
  const acc = json.accessors?.[index];
  const bv = acc ? json.bufferViews?.[acc.bufferView] : undefined;
  if (!acc || !bv) throw new Error(`No accessor ${index}`);
  const n = acc.count * (acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1);
  const start = bin.byteOffset + (bv.byteOffset ?? 0);
  const buf = bin.buffer.slice(start, start + bv.byteLength);
  if (acc.componentType === FLOAT) return new Float32Array(buf, 0, n);
  if (acc.componentType === U16) return new Uint16Array(buf, 0, n);
  if (acc.componentType === U32) return new Uint32Array(buf, 0, n);
  throw new Error(`Unsupported component type ${acc.componentType}`);
}
