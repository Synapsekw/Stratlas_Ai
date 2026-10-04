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
});
