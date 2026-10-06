// A minimal glTF 2.0 binary writer: one node per part (named, so asset tags can point at it),
// positions, normals and vertex colours (COLOR_0, linear), one double-sided matte material.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * @param {{ name: string, arrays: () => { pos: Float32Array, nrm: Float32Array, col: Float32Array, idx: Uint32Array } }[]} parts
 * @param {{ root: string, generator: string }} o
 * @returns {Buffer}
 */
export function writeGlb(parts, o) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const push = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes, Buffer.alloc(pad));
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const meshes = [];
  const nodes = [];
  for (const part of parts) {
    const a = part.arrays();
    const n = a.pos.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], a.pos[3 * i + k]);
        max[k] = Math.max(max[k], a.pos[3 * i + k]);
      }
    const lin = new Float32Array(a.col.length);
    for (let i = 0; i < lin.length; i++) lin[i] = Math.round(srgbToLinear(a.col[i]) * 1e4) / 1e4;
    const pos =
      accessors.push({
        bufferView: push(a.pos, 34962),
        componentType: 5126,
        count: n,
        type: 'VEC3',
        min,
        max,
      }) - 1;
    const nrm =
      accessors.push({
        bufferView: push(a.nrm, 34962),
        componentType: 5126,
        count: n,
        type: 'VEC3',
      }) - 1;
    const col =
      accessors.push({
        bufferView: push(lin, 34962),
        componentType: 5126,
        count: n,
        type: 'VEC3',
      }) - 1;
    const big = n > 65535;
    const idx = big ? a.idx : Uint16Array.from(a.idx);
    const ind =
      accessors.push({
        bufferView: push(idx, 34963),
        componentType: big ? 5125 : 5123,
        count: idx.length,
        type: 'SCALAR',
      }) - 1;
    meshes.push({
      name: part.name,
      primitives: [
        { attributes: { POSITION: pos, NORMAL: nrm, COLOR_0: col }, indices: ind, material: 0 },
      ],
    });
    nodes.push({ name: part.name, mesh: meshes.length - 1 });
  }
  const gltf = {
    asset: { version: '2.0', generator: o.generator },
    scene: 0,
    scenes: [{ name: o.root, nodes: [nodes.length] }],
    nodes: [...nodes, { name: o.root, children: nodes.map((_, i) => i) }],
    meshes,
    materials: [
      {
        name: 'paint',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.85,
        },
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const bin = Buffer.concat(chunks);
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, json, bh, bin]);
}
