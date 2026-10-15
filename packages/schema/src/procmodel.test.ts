import { describe, expect, it } from 'vitest';
import { ProcModel, type ProcPart } from './index';

const fit = { by: 'fit', residualM: 0.02, inliers: 5400 } as const;

const parts: ProcPart[] = [
  {
    kind: 'cylinder',
    id: 't101',
    tag: 'T-101',
    class: 'tank',
    status: 'draft',
    confidence: 0.92,
    origin: fit,
    base: [10, 0, -20],
    radius: 12,
    height: 14,
    roof: 'dome',
  },
  {
    kind: 'extrusion',
    id: 'b1',
    name: 'Control building',
    class: 'building',
    status: 'accepted',
    origin: { by: 'drawing', file: 'drawings/plot.dxf', layer: 'BUILDINGS', entity: '2F' },
    footprint: [
      [0, 0],
      [20, 0],
      [20, -10],
      [0, -10],
    ],
    baseY: 0,
    height: 6,
  },
  {
    kind: 'box',
    id: 's1',
    class: 'skid',
    status: 'rejected',
    origin: { by: 'manual' },
    base: [5, 0, 5],
    size: [4, 2.5, 6],
    yawDeg: 30,
  },
  {
    kind: 'pipe',
    id: 'p1',
    status: 'draft',
    origin: { by: 'agent', runId: 'run-1' },
    points: [
      [0, 1, 0],
      [10, 1, 0],
    ],
    diameter: 0.3,
  },
  { kind: 'sphere', id: 'v1', status: 'draft', origin: fit, center: [0, 5, 0], radius: 3 },
];

const model = {
  schema: 'aio.procmodel/2',
  id: 'site',
  name: 'Site massing',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  sources: [{ kind: 'drawing', ref: 'drawings/plot.dxf' }],
  parts,
  materials: [],
  assemblies: [],
};

const engineer = { by: 'engineer', runId: 'r1' } as const;
const shaft = (id: string, parent?: string) => ({
  id,
  ...(parent === undefined ? {} : { parent }),
  kind: 'shaft',
  name: 'Shaft',
  description: 'Tapered shaft',
  category: 'Shaft',
  status: 'draft',
  origin: engineer,
  quality: {},
  sources: [],
  params: {
    base: [0, 0, 0],
    profile: [
      { y: 0, r: 10 },
      { y: 100, r: 7 },
    ],
    wall: 0.4,
    openTop: true,
  },
});

describe('procedural models (aio.procmodel/2)', () => {
  it('accepts every part kind with its origin', () => {
    const r = ProcModel.safeParse(model);
    expect(r.success, r.error?.message).toBe(true);
  });

  it('refuses duplicate part ids, bad sizes and unsafe ids', () => {
    expect(ProcModel.safeParse({ ...model, parts: [parts[0], parts[0]] }).success).toBe(false);
    expect(ProcModel.safeParse({ ...model, parts: [{ ...parts[0], radius: 0 }] }).success).toBe(
      false,
    );
    expect(ProcModel.safeParse({ ...model, id: 'a/b' }).success).toBe(false);
    expect(
      ProcModel.safeParse({ ...model, parts: [{ ...parts[0], origin: { by: 'fit' } }] }).success,
    ).toBe(false);
  });

  it('accepts engineering assemblies with an engineer origin and a parent', () => {
    const r = ProcModel.safeParse({
      ...model,
      assemblies: [shaft('shaft-1'), shaft('shaft-2', 'shaft-1')],
    });
    expect(r.success, r.error?.message).toBe(true);
  });

  it('refuses duplicate assembly ids', () => {
    const r = ProcModel.safeParse({ ...model, assemblies: [shaft('shaft-1'), shaft('shaft-1')] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/Duplicate assembly id/);
  });

  it('refuses an assembly parent that does not exist', () => {
    const r = ProcModel.safeParse({ ...model, assemblies: [shaft('shaft-1', 'nothing')] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['assemblies', 0, 'parent']);
  });

  it('refuses a material that is not in the model', () => {
    const r = ProcModel.safeParse({
      ...model,
      assemblies: [{ ...shaft('shaft-1'), material: 'brick' }],
    });
    expect(r.success).toBe(false);
    const band = {
      ...shaft('band-1'),
      kind: 'band',
      params: { shaft: 'shaft-1', y0: 10, y1: 12, material: 'paint' },
    };
    const brick = {
      id: 'brick',
      name: 'Brick',
      baseColor: [0.6, 0.3, 0.2, 1],
      metallic: 0,
      roughness: 0.9,
    };
    expect(
      ProcModel.safeParse({ ...model, materials: [brick], assemblies: [shaft('shaft-1'), band] })
        .success,
    ).toBe(false);
    expect(
      ProcModel.safeParse({
        ...model,
        materials: [brick],
        assemblies: [shaft('shaft-1'), { ...band, params: { ...band.params, material: 'brick' } }],
      }).success,
    ).toBe(true);
  });

  it('refuses an assembly id that is also a part id', () => {
    const r = ProcModel.safeParse({ ...model, assemblies: [shaft('t101')] });
    expect(r.success).toBe(false);
  });

  it('refuses a /1 model (readers migrate it first)', () => {
    expect(ProcModel.safeParse({ ...model, schema: 'aio.procmodel/1' }).success).toBe(false);
  });

  it('refuses a self-parent and a parent cycle', () => {
    const self = ProcModel.safeParse({ ...model, assemblies: [shaft('shaft-1', 'shaft-1')] });
    expect(self.success).toBe(false);
    expect(self.error?.issues.some((i) => i.message.includes('cycle'))).toBe(true);
    const loop = ProcModel.safeParse({
      ...model,
      assemblies: [
        shaft('shaft-1', 'shaft-2'),
        shaft('shaft-2', 'shaft-3'),
        shaft('shaft-3', 'shaft-1'),
      ],
    });
    expect(loop.success).toBe(false);
    expect(loop.error?.issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('needs a band to sit on an existing shaft assembly', () => {
    const brick = {
      id: 'brick',
      name: 'Brick',
      baseColor: [0.6, 0.3, 0.2, 1],
      metallic: 0,
      roughness: 0.9,
    };
    const band = (on: string) => ({
      ...shaft('band-1'),
      kind: 'band',
      params: { shaft: on, y0: 10, y1: 12, material: 'brick' },
    });
    const flue = {
      ...shaft('flue-1'),
      kind: 'flue',
      params: { centre: [0, 100, 0], rOuter: 1, rInner: 0.8, height: 5 },
    };
    const parse = (assemblies: unknown[]) =>
      ProcModel.safeParse({ ...model, materials: [brick], assemblies });
    expect(parse([shaft('shaft-1'), band('shaft-1')]).success).toBe(true);
    expect(parse([shaft('shaft-1'), band('shaft-9')]).success).toBe(false);
    expect(parse([flue, band('flue-1')]).success).toBe(false);
  });

  it('refuses an empty run id', () => {
    expect(ProcModel.safeParse({ ...model, run: { id: '', detail: 'fast' } }).success).toBe(false);
  });
});
