/** A synthetic mesh for the 3D Tiles specs: big enough to be cut into several tiles. */

const GRID = 81; // 80 x 80 quads, 12 800 triangles
const SPAN = 60; // metres, centred on the project origin

/** A grid surface 2 m above the ground, in the project local frame (y up), as a GLB. */
export function gridGlb(): Buffer {
  const pos = new Float32Array(GRID * GRID * 3);
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const k = (j * GRID + i) * 3;
      const x = -SPAN / 2 + (SPAN * i) / (GRID - 1);
      const z = -SPAN / 2 + (SPAN * j) / (GRID - 1);
      pos[k] = x;
      pos[k + 1] = 2 + 0.3 * Math.sin(x / 7) * Math.cos(z / 9);
      pos[k + 2] = z;
    }
  const idx = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
  let p = 0;
  for (let j = 0; j < GRID - 1; j++)
    for (let i = 0; i < GRID - 1; i++) {
      const a = j * GRID + i;
      idx.set([a, a + GRID, a + 1, a + 1, a + GRID, a + GRID + 1], p);
      p += 6;
    }
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    min = min.map((m, a) => Math.min(m, pos[i + a] ?? 0));
    max = max.map((m, a) => Math.max(m, pos[i + a] ?? 0));
  }
  const gltf = {
    asset: { version: '2.0', generator: 'aio e2e grid' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'grid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: GRID * GRID, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}
