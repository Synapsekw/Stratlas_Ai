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
  schema: 'aio.procmodel/1',
  id: 'site',
  name: 'Site massing',
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:00Z',
  sources: [{ kind: 'drawing', ref: 'drawings/plot.dxf' }],
  parts,
};

describe('procedural models (aio.procmodel/1)', () => {
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
});
