import { createHash } from 'node:crypto';
import { ProcModel, type ProcPart } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Prim } from './engineer/geom';
import { stackModel } from './engineer/fixtures';
import { closedAndWound, normalsAgree, vertexAt, volume } from './engineer/testGeom';
import { readGlb } from './glb';
import { buildEngineeringGlb, meshPart, meshProcModel, partNodeName, type PartMesh } from './index';

const origin = { by: 'manual' } as const;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PARTS = {
  flatTank: {
    kind: 'cylinder',
    id: 'c1',
    tag: 'T-101',
    class: 'tank',
    status: 'accepted',
    origin: { by: 'drawing', layer: 'TANKS' },
    base: [10, 0, -5],
    radius: 6,
    height: 12.5,
  },
  coneTank: {
    kind: 'cylinder',
    id: 'c2',
    status: 'accepted',
    origin,
    base: [0, 0, 0],
    radius: 4,
    height: 8,
    roof: 'cone',
    roofHeight: 1.5,
  },
  domeTank: {
    kind: 'cylinder',
    id: 'c3',
    status: 'accepted',
    origin,
    base: [0, 0, 0],
    radius: 4,
    height: 8,
    roof: 'dome',
    roofHeight: 1,
  },
  box: {
    kind: 'box',
    id: 'b1',
    class: 'skid',
    status: 'accepted',
    origin,
    base: [3, 1, 2],
    size: [6, 2.5, 3],
    yawDeg: 30,
  },
  building: {
    kind: 'extrusion',
    id: 'e1',
    class: 'building',
    status: 'accepted',
    origin,
    // an L shape, clockwise seen from above on purpose: the mesher fixes the winding
    footprint: [
      [0, 0],
      [0, -10],
      [4, -10],
      [4, -4],
      [10, -4],
      [10, 0],
    ],
    baseY: 0,
    height: 5,
  },
  pipe: {
    kind: 'pipe',
    id: 'p1',
    class: 'pipe',
    status: 'accepted',
    origin,
    points: [
      [0, 1.5, 0],
      [10, 1.5, 0],
      [10, 1.5, -6],
      [10, 4, -6],
    ],
    diameter: 0.3,
  },
  sphere: {
    kind: 'sphere',
    id: 's1',
    status: 'accepted',
    origin,
    center: [0, 5, 0],
    radius: 2,
  },
} satisfies Record<string, ProcPart>;

/** A part mesh as a kernel primitive in the model frame, for the shared mesh checks. */
const primOf = (m: PartMesh): Prim => ({
  material: 'part',
  positions: Array.from(m.positions, (v, i) => v + (m.translation[i % 3] ?? 0)),
  normals: Array.from(m.normals),
  indices: Array.from(m.indices),
});

describe('meshPart', () => {
  it.each(Object.entries(PARTS))('%s is closed, wound outwards and has unit normals', (_, p) => {
    const m = meshPart(p);
    expect(closedAndWound(primOf(m))).toBe(true);
    expect(normalsAgree(primOf(m))).toBe(true);
    expect(volume(primOf(m))).toBeGreaterThan(0);
    for (let i = 0; i < m.normals.length; i += 3) {
      const len = Math.hypot(m.normals[i] ?? 0, m.normals[i + 1] ?? 0, m.normals[i + 2] ?? 0);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('gives the right volumes and places parts where they stand', () => {
    expect(volume(primOf(meshPart(PARTS.flatTank))) / (Math.PI * 36 * 12.5)).toBeCloseTo(1, 2);
    expect(volume(primOf(meshPart(PARTS.box)))).toBeCloseTo(6 * 2.5 * 3, 3);
    expect(volume(primOf(meshPart(PARTS.building)))).toBeCloseTo((10 * 4 + 6 * 4) * 5, 3);
    const cone = volume(primOf(meshPart(PARTS.coneTank)));
    expect(cone / (Math.PI * 16 * 8 + (Math.PI * 16 * 1.5) / 3)).toBeCloseTo(1, 2);
    const pipe = volume(primOf(meshPart(PARTS.pipe)));
    // straight length 10 + 6 + 2.5, mitred joints add and remove the same wedge
    expect(pipe / (Math.PI * 0.15 ** 2 * 18.5)).toBeCloseTo(1, 1);
    // the tank stands on its base centre, 12.5 m tall
    const tank = meshPart(PARTS.flatTank);
    const tankPrim = primOf(tank);
    const ys = Array.from(
      { length: tank.positions.length / 3 },
      (_, i) => vertexAt(tankPrim, i)[1],
    );
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(12.5, 6);
    expect(tank.translation).toEqual([10, 0, -5]);
  });

  it('turns a box counter-clockwise seen from above', () => {
    const b = meshPart({ ...PARTS.box, yawDeg: 90 });
    const prim = primOf(b);
    const pts = Array.from({ length: b.positions.length / 3 }, (_, i) => vertexAt(prim, i));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    // 6 m along x turned 90 degrees towards north (-z): now 6 m along z, 3 m along x
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(6, 6);
  });
});

describe('meshProcModel', () => {
  const model = ProcModel.parse({
    schema: 'aio.procmodel/2',
    materials: [],
    assemblies: [],
    id: 'site',
    name: 'Site',
    createdAt: '2026-10-06T08:00:00Z',
    updatedAt: '2026-10-06T08:00:00Z',
    parts: [
      PARTS.flatTank,
      { ...PARTS.box, status: 'draft' },
      { ...PARTS.building, status: 'rejected' },
      { ...PARTS.pipe, name: 'Line 7' },
    ],
  });

  it('names a part node by tag, then name, then id', () => {
    const part = PARTS.flatTank;
    expect(partNodeName(part)).toBe('T-101');
    expect(partNodeName({ ...part, tag: undefined, name: 'Tank one' })).toBe('Tank one');
    expect(partNodeName({ ...part, tag: undefined })).toBe('c1');
  });

  it('builds a GLB of the accepted parts, one named node each', () => {
    const built = meshProcModel(model);
    expect(built.nodes).toEqual(['T-101', 'Line_7']);
    const { json, bin } = readGlb(built.glb);
    const nodes = json.nodes as { name: string; mesh?: number; extras?: unknown }[];
    expect(nodes.map((n) => n.name)).toEqual(['T-101', 'Line_7', 'site']);
    expect(nodes[0]?.extras).toEqual({ tag: 'T-101', type: 'tank', part: 'c1' });
    // every accessor fits its buffer view, every index is in range
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    const accessors = json.accessors as { bufferView: number; count: number; type: string }[];
    for (const v of views) expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(bin.length);
    for (const a of accessors) expect(views[a.bufferView]).toBeDefined();
    expect((json.asset as { version: string }).version).toBe('2.0');
  });

  it('loads in three.js with the parts as named, placed meshes', async () => {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const built = meshProcModel(model);
    const gltf = await new GLTFLoader().parseAsync(built.glb.slice().buffer, '');
    const tank = gltf.scene.getObjectByName('T-101');
    expect(tank?.position.toArray()).toEqual([10, 0, -5]);
    expect(tank?.userData).toMatchObject({ tag: 'T-101', type: 'tank' });
    expect(gltf.scene.getObjectByName('Line_7')).toBeDefined();
  });

  it('builds every part but the rejected ones for the draft preview', () => {
    expect(meshProcModel(model, { parts: 'all' }).nodes).toEqual(['T-101', 'b1', 'Line_7']);
  });

  it('builds an empty but valid GLB when nothing is accepted', () => {
    const none = meshProcModel({ ...model, parts: [] });
    expect(none.nodes).toEqual([]);
    expect(readGlb(none.glb).json.nodes).toEqual([{ name: 'site', children: [] }]);
  });

  it('writes the same bytes as before the engineering model (golden)', () => {
    // SHA-256 of the GLBs the parts mesher wrote before meshParts and partColour were split out
    const golden = ProcModel.parse({
      schema: 'aio.procmodel/2',
      materials: [],
      assemblies: [],
      id: 'site',
      name: 'Site',
      createdAt: '2026-10-06T08:00:00Z',
      updatedAt: '2026-10-06T08:00:00Z',
      parts: [
        { ...PARTS.flatTank },
        { ...PARTS.coneTank, status: 'draft' },
        {
          ...PARTS.flatTank,
          id: 'c3',
          tag: undefined,
          class: undefined,
          name: 'T-101',
          origin,
          base: [5, 0, 0],
          radius: 4,
          height: 8,
        },
        {
          ...PARTS.flatTank,
          id: 'c4',
          class: 'pipe',
          tag: '',
          status: 'rejected',
          origin,
          base: [5, 0, 9],
          radius: 1,
          height: 2,
        },
        { ...PARTS.box },
      ],
    });
    const accepted = meshProcModel(golden, { parts: 'accepted' });
    expect(accepted.nodes).toEqual(['T-101', 'T-101_c3', 'b1']);
    expect(accepted.glb.length).toBe(30260);
    expect(sha256(accepted.glb)).toBe(
      '322765eb9bf676527255be8f8ea4d23a4a850fdc23f8f08105413c1adf60682e',
    );
    const all = meshProcModel(golden, { parts: 'all' });
    expect(all.nodes).toEqual(['T-101', 'c2', 'T-101_c3', 'b1']);
    expect(sha256(all.glb)).toBe(
      '674f00e515d5b758885328a92bf565966916eee9553e81eb0b2a351c4ea92aac',
    );
  });

  it('a mixed model: parts mesh as before, the engineering GLB holds parts and assemblies', () => {
    const mixed: ProcModel = { ...stackModel(), id: 'site', parts: model.parts };
    const parts = meshProcModel(mixed);
    expect(parts.nodes).toEqual(['T-101', 'Line_7']);
    // assemblies change nothing in the parts GLB
    expect(sha256(parts.glb)).toBe(sha256(meshProcModel(model).glb));
    const built = buildEngineeringGlb(mixed, { detail: 'fast', drafts: false, generator: 't' });
    const names = (readGlb(built.glb).json.nodes as { name: string }[]).map((n) => n.name);
    // the accepted shaft, then the accepted parts, then the root
    expect(names).toEqual(['shaft-1', 'T-101', 'Line_7', 'site']);
    expect(built.nodes.map((n) => n.node)).toEqual(['shaft-1', 'T-101', 'Line_7']);
  });

  it('makes two parts with one tag two distinct node names', () => {
    const twin = meshProcModel({
      ...model,
      parts: [PARTS.flatTank, { ...PARTS.flatTank, id: 'c9' }],
    });
    expect(twin.nodes).toEqual(['T-101', 'T-101_c9']);
  });
});
