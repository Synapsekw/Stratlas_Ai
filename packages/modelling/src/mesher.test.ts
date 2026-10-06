import { ProcModel, type ProcPart } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { readGlb } from './glb';
import { meshPart, meshProcModel, partNodeName, type PartMesh } from './index';

const origin = { by: 'manual' } as const;

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

const pos = (m: PartMesh, i: number): [number, number, number] => [
  (m.positions[3 * i] ?? 0) + m.translation[0],
  (m.positions[3 * i + 1] ?? 0) + m.translation[1],
  (m.positions[3 * i + 2] ?? 0) + m.translation[2],
];

/** Every edge of the welded mesh is used once in each direction: closed and consistently wound. */
function closedAndWound(m: PartMesh): boolean {
  const key = (p: number[]) => p.map((v) => Math.round(v * 1e4)).join(',');
  const ids = new Map<string, number>();
  const weld = (i: number) => {
    const k = key(pos(m, i));
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  };
  const directed = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => weld(m.indices[t + k] ?? 0));
    for (let e = 0; e < 3; e++) {
      const a = v[e] ?? 0;
      const b = v[(e + 1) % 3] ?? 0;
      if (a === b) continue;
      const k = `${String(a)}>${String(b)}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (n !== 1 || directed.get(`${b ?? ''}>${a ?? ''}`) !== 1) return false;
  }
  return directed.size > 0;
}

/** Signed volume by the divergence theorem (positive when the faces point outwards). */
function volume(m: PartMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => pos(m, m.indices[t + k] ?? 0)) as unknown as [
      number[],
      number[],
      number[],
    ];
    v +=
      ((a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0)) -
        (a[1] ?? 0) * ((b[0] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[0] ?? 0)) +
        (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0))) /
      6;
  }
  return v;
}

/** Each triangle's winding agrees with its vertex normals. */
function normalsAgree(m: PartMesh): boolean {
  for (let t = 0; t < m.indices.length; t += 3) {
    const i = [0, 1, 2].map((k) => m.indices[t + k] ?? 0);
    const [a, b, c] = i.map((j) => pos(m, j)) as unknown as [number[], number[], number[]];
    const u = [0, 1, 2].map((k) => (b[k] ?? 0) - (a[k] ?? 0));
    const w = [0, 1, 2].map((k) => (c[k] ?? 0) - (a[k] ?? 0));
    const n = [
      (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
      (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
      (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
    ];
    if (Math.hypot(...n) < 1e-9) continue;
    const vn = [0, 1, 2].map((k) => i.reduce((s, j) => s + (m.normals[3 * j + k] ?? 0), 0));
    if ((n[0] ?? 0) * (vn[0] ?? 0) + (n[1] ?? 0) * (vn[1] ?? 0) + (n[2] ?? 0) * (vn[2] ?? 0) <= 0)
      return false;
  }
  return true;
}

describe('meshPart', () => {
  it.each(Object.entries(PARTS))('%s is closed, wound outwards and has unit normals', (_, p) => {
    const m = meshPart(p);
    expect(closedAndWound(m)).toBe(true);
    expect(normalsAgree(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    for (let i = 0; i < m.normals.length; i += 3) {
      const len = Math.hypot(m.normals[i] ?? 0, m.normals[i + 1] ?? 0, m.normals[i + 2] ?? 0);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('gives the right volumes and places parts where they stand', () => {
    expect(volume(meshPart(PARTS.flatTank)) / (Math.PI * 36 * 12.5)).toBeCloseTo(1, 2);
    expect(volume(meshPart(PARTS.box))).toBeCloseTo(6 * 2.5 * 3, 3);
    expect(volume(meshPart(PARTS.building))).toBeCloseTo((10 * 4 + 6 * 4) * 5, 3);
    const cone = volume(meshPart(PARTS.coneTank));
    expect(cone / (Math.PI * 16 * 8 + (Math.PI * 16 * 1.5) / 3)).toBeCloseTo(1, 2);
    const pipe = volume(meshPart(PARTS.pipe));
    // straight length 10 + 6 + 2.5, mitred joints add and remove the same wedge
    expect(pipe / (Math.PI * 0.15 ** 2 * 18.5)).toBeCloseTo(1, 1);
    // the tank stands on its base centre, 12.5 m tall
    const tank = meshPart(PARTS.flatTank);
    const ys = Array.from({ length: tank.positions.length / 3 }, (_, i) => pos(tank, i)[1]);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(12.5, 6);
    expect(tank.translation).toEqual([10, 0, -5]);
  });

  it('turns a box counter-clockwise seen from above', () => {
    const b = meshPart({ ...PARTS.box, yawDeg: 90 });
    const pts = Array.from({ length: b.positions.length / 3 }, (_, i) => pos(b, i));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    // 6 m along x turned 90 degrees towards north (-z): now 6 m along z, 3 m along x
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(6, 6);
  });
});

describe('meshProcModel', () => {
  const model = ProcModel.parse({
    schema: 'aio.procmodel/1',
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

  it('makes two parts with one tag two distinct node names', () => {
    const twin = meshProcModel({
      ...model,
      parts: [PARTS.flatTank, { ...PARTS.flatTank, id: 'c9' }],
    });
    expect(twin.nodes).toEqual(['T-101', 'T-101_c9']);
  });
});
