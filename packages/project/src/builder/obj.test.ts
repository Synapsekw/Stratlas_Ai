import { describe, expect, it } from 'vitest';
import { parseGlb, readAccessor } from '../import/glb';
import { objToGlb } from './obj';

const QUAD = `# unit quad
mtllib quad.mtl
v 0 0 0
v 1 0 0
v 1 0 -1
v 0 0 -1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 1 0
usemtl skin
f 1/1/1 2/2/1 3/3/1 4/4/1
`;

const MTL = `newmtl skin
Kd 0.8 0.4 0.2
map_Kd tex.png
`;

describe('objToGlb', () => {
  it('triangulates faces and keeps positions, normals, uvs and the material texture', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = objToGlb(QUAD, MTL, (name) => (name === 'tex.png' ? png : null));
    expect(r.triangles).toBe(2);
    expect(r.warnings).toEqual([]);
    const { json, bin } = parseGlb(r.glb);
    const prim = json.meshes?.[0]?.primitives[0];
    expect(prim?.attributes).toHaveProperty('NORMAL');
    expect(prim?.attributes).toHaveProperty('TEXCOORD_0');
    const pos = readAccessor(json, bin, prim?.attributes.POSITION ?? -1);
    expect(pos.length).toBe(4 * 3);
    expect(json.images).toHaveLength(1);
    expect(json.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture?.index).toBe(0);
  });

  it('accepts negative indices, faces without uvs and a missing material file', () => {
    const r = objToGlb('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n', null, () => null);
    expect(r.triangles).toBe(1);
    const { json } = parseGlb(r.glb);
    expect(json.meshes?.[0]?.primitives[0]?.attributes).toHaveProperty('NORMAL');
  });

  it('warns about a texture that is not next to the OBJ', () => {
    const r = objToGlb(QUAD, MTL, () => null);
    expect(r.warnings.join(' ')).toMatch(/tex\.png/);
  });

  it('rejects a file with no faces', () => {
    expect(() => objToGlb('v 0 0 0\n', null, () => null)).toThrow(/no faces/i);
  });

  const spaced =
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n';

  it('embeds a texture whose name has spaces', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const r = objToGlb(
      `mtllib m.mtl\nusemtl a\n${spaced}`,
      'newmtl a\nmap_Kd my tower.jpg\n',
      (n) => (n === 'my tower.jpg' ? jpeg : null),
    );
    expect(r.warnings).toEqual([]);
  });

  it('warns with the whole name when a spaced texture is missing', () => {
    const r = objToGlb(
      `mtllib m.mtl\nusemtl a\n${spaced}`,
      'newmtl a\nmap_Kd my tower.jpg\n',
      () => null,
    );
    expect(r.warnings.join(' ')).toContain('Texture my tower.jpg was not found');
  });
});

describe('shift', () => {
  it('reports the raw bounds and stores the vertices minus the shift', () => {
    const far = 'v 500000 3200000 10\nv 500002 3200000 10\nv 500000 3200002 12\nf 1 2 3\n';
    const r = objToGlb(far, null, () => null, { shift: () => [500000, 3200000, 10] });
    expect(r.bounds).toEqual({ min: [500000, 3200000, 10], max: [500002, 3200002, 12] });
    expect(r.shift).toEqual([500000, 3200000, 10]);
    // the GLB's POSITION accessor max is small: the shift was taken off before float32
    const json = JSON.parse(
      new TextDecoder().decode(
        r.glb.subarray(20, 20 + new DataView(r.glb.buffer, r.glb.byteOffset).getUint32(12, true)),
      ),
    ) as { accessors: { max?: number[] }[] };
    expect(Math.max(...json.accessors.flatMap((a) => a.max ?? []))).toBeLessThanOrEqual(2);
  });
});
