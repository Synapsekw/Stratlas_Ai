import { describe, expect, it } from 'vitest';
import { encodeGlb, parseGlb, readAccessor, type GlbDoc } from './glb';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function doc(): GlbDoc {
  return {
    generator: 'test',
    images: [{ mimeType: 'image/jpeg', data: JPEG }],
    materials: [
      { name: 'Ground', texture: 0 },
      { name: 'Line', color: [1, 0.5, 0, 1] },
    ],
    meshes: [
      {
        name: 'quad',
        primitives: [
          {
            material: 0,
            positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 2, 1]),
            normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
            uvs: Float32Array.from([0, 0, 1, 0, 0, 1, 1, 1]),
            indices: Uint32Array.from([0, 2, 1, 1, 2, 3]),
          },
          {
            material: 1,
            mode: 'lines',
            positions: Float32Array.from([0, 3, 0, 1, 3, 0]),
            indices: Uint32Array.from([0, 1]),
          },
        ],
      },
    ],
    nodes: [
      { name: 'Root', children: [1] },
      { name: 'P01_e2', mesh: 0, extras: { type: 'stockpile' } },
    ],
    scene: [0],
  };
}

describe('GLB writer', () => {
  it('writes a glTF 2.0 binary with a JSON and a BIN chunk', () => {
    const glb = encodeGlb(doc());
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
    const { json, bin } = parseGlb(glb);
    expect(json.asset).toMatchObject({ version: '2.0', generator: 'test' });
    expect(bin.byteLength % 4).toBe(0);
  });

  it('keeps nodes, extras, materials and the embedded image', () => {
    const { json, bin } = parseGlb(encodeGlb(doc()));
    expect(json.scenes).toEqual([{ nodes: [0] }]);
    expect(json.nodes?.[1]).toEqual({ name: 'P01_e2', mesh: 0, extras: { type: 'stockpile' } });
    expect(json.materials?.[0]?.pbrMetallicRoughness).toMatchObject({
      baseColorTexture: { index: 0 },
      metallicFactor: 0,
    });
    expect(json.materials?.[1]?.pbrMetallicRoughness?.baseColorFactor).toEqual([1, 0.5, 0, 1]);
    const img = json.images?.[0];
    const bv = json.bufferViews?.[img?.bufferView ?? -1];
    expect(img?.mimeType).toBe('image/jpeg');
    expect([
      ...bin.subarray(bv?.byteOffset ?? 0, (bv?.byteOffset ?? 0) + (bv?.byteLength ?? 0)),
    ]).toEqual([...JPEG]);
  });

  it('round-trips attributes and indices with position bounds', () => {
    const { json, bin } = parseGlb(encodeGlb(doc()));
    const prim = json.meshes?.[0]?.primitives[0];
    const lines = json.meshes?.[0]?.primitives[1];
    expect(lines?.mode).toBe(1);
    expect(prim?.mode).toBeUndefined();
    const pos = json.accessors?.[prim?.attributes.POSITION ?? -1];
    expect(pos).toMatchObject({
      count: 4,
      type: 'VEC3',
      componentType: 5126,
      min: [0, 0, 0],
      max: [1, 2, 1],
    });
    expect([...readAccessor(json, bin, prim?.attributes.TEXCOORD_0 ?? -1)]).toEqual([
      0, 0, 1, 0, 0, 1, 1, 1,
    ]);
    expect([...readAccessor(json, bin, prim?.indices ?? -1)]).toEqual([0, 2, 1, 1, 2, 3]);
    for (const v of json.bufferViews ?? []) expect((v.byteOffset ?? 0) % 4).toBe(0);
  });

  it('uses 16-bit indices when they fit', () => {
    const { json } = parseGlb(encodeGlb(doc()));
    const prim = json.meshes?.[0]?.primitives[0];
    expect(json.accessors?.[prim?.indices ?? -1]?.componentType).toBe(5123);
  });
});
