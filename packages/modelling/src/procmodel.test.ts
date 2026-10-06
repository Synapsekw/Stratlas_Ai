import { ProcModel, type ProcPart } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  addParts,
  applyDimension,
  checkProcModel,
  newProcModel,
  partDimensions,
  partSummary,
  setPartStatus,
  summarise,
  updatePart,
} from './procmodel';

const NOW = '2026-10-06T08:00:00Z';
const LATER = '2026-10-06T09:00:00Z';

const tank: ProcPart = {
  kind: 'cylinder',
  id: 'p1',
  tag: 'T-101',
  class: 'tank',
  status: 'draft',
  origin: { by: 'drawing', layer: 'TANKS' },
  base: [0, 0, 0],
  radius: 10,
  height: 12.5,
  roof: 'cone',
};
const building: ProcPart = {
  kind: 'extrusion',
  id: 'p2',
  name: 'Workshop',
  class: 'building',
  status: 'draft',
  origin: { by: 'manual' },
  footprint: [
    [0, 0],
    [10, 0],
    [10, -6],
    [0, -6],
  ],
  baseY: 0,
  height: 4,
};

function model(parts: ProcPart[] = [tank, building]): ProcModel {
  return ProcModel.parse({ ...newProcModel({ id: 'site', name: 'Site', now: NOW }), parts });
}

describe('procmodel helpers', () => {
  it('starts an empty, valid model', () => {
    const m = newProcModel({ id: 'site', name: 'Site', now: NOW, capture: 'c1' });
    expect(ProcModel.parse(m)).toEqual(m);
    expect(m).toMatchObject({ schema: 'aio.procmodel/1', parts: [], capture: 'c1' });
  });

  it('accepts or rejects one part, a list, or all of them, and stamps the update', () => {
    const one = setPartStatus(model(), ['p1'], 'accepted', LATER);
    expect(one.parts.map((p) => p.status)).toEqual(['accepted', 'draft']);
    expect(one.updatedAt).toBe(LATER);
    const all = setPartStatus(model(), 'all', 'rejected', LATER);
    expect(all.parts.every((p) => p.status === 'rejected')).toBe(true);
  });

  it('summarises parts and accepted parts', () => {
    const m = setPartStatus(model(), ['p2'], 'accepted', LATER);
    expect(summarise(m)).toEqual({
      id: 'site',
      name: 'Site',
      parts: 2,
      accepted: 1,
      updatedAt: LATER,
    });
  });

  it('adds parts with unique ids, as drafts, and skips ones it already has', () => {
    const m = model([tank]);
    const next = addParts(
      m,
      [{ ...tank }, { ...tank, id: 'p1', tag: 'T-102', origin: { by: 'agent' } }, building],
      LATER,
    );
    // the same id from the same origin is the same part: skipped; a clash gets a new id
    expect(next.parts.map((p) => p.id)).toEqual(['p1', 'p1-2', 'p2']);
    expect(next.parts.every((p) => p.status === 'draft')).toBe(true);
    expect(() => ProcModel.parse(next)).not.toThrow();
  });

  it('edits a part, keeping its kind and id', () => {
    const m = updatePart(model(), 'p1', { height: 14, tag: 'T-109' }, LATER);
    expect(m.parts[0]).toMatchObject({ id: 'p1', kind: 'cylinder', height: 14, tag: 'T-109' });
    expect(() => updatePart(model(), 'nope', { height: 1 }, LATER)).toThrow(/nope/);
  });

  it('lists editable dimensions and applies a typed value', () => {
    expect(partDimensions(tank).map((d) => d.key)).toEqual([
      'x',
      'y',
      'z',
      'radius',
      'height',
      'roofHeight',
    ]);
    expect(applyDimension(tank, 'radius', 6)).toMatchObject({ radius: 6 });
    expect(applyDimension(tank, 'x', 5)).toMatchObject({ base: [5, 0, 0] });
    expect(applyDimension(building, 'height', 7)).toMatchObject({ height: 7 });
    // moving an extrusion moves the whole footprint (x is its centre, 5)
    const moved = applyDimension(building, 'x', 2);
    expect(moved.kind === 'extrusion' && moved.footprint[0]).toEqual([-3, 0]);
    expect(() => applyDimension(tank, 'radius', 0)).toThrow(/more than 0/);
  });

  it('describes a part in one line', () => {
    expect(partSummary(tank)).toBe('Cylinder, radius 10.0 m, height 12.5 m');
    expect(partSummary(building)).toBe('Extrusion, 4 corners, height 4.0 m');
  });
});

describe('checkProcModel', () => {
  it('passes a good model', () => {
    expect(checkProcModel(model())).toEqual([]);
  });

  it('names the part and the problem', () => {
    const bad = model([
      {
        ...building,
        id: 'bow',
        footprint: [
          [0, 0],
          [4, 4],
          [4, 0],
          [0, 4],
        ],
      },
      {
        ...building,
        id: 'flat',
        footprint: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
      {
        kind: 'pipe',
        id: 'pipe',
        status: 'draft',
        origin: { by: 'manual' },
        points: [
          [0, 1, 0],
          [0, 1, 0],
        ],
        diameter: 0.3,
      },
      { ...tank, id: 'far', base: [250_000, 0, 0] },
      { ...tank, id: 'twin' },
    ]);
    const messages = checkProcModel(bad).map((p) => p.message);
    expect(messages).toEqual([
      'Part "bow": the footprint crosses itself.',
      'Part "flat": the footprint has no area.',
      'Part "pipe": the pipe has no length.',
      'Part "far": it lies more than 100 km from the project origin.',
      'Tag "T-101" is on 2 parts (far, twin).',
    ]);
  });

  it('reads a file that does not match the schema with a readable message', () => {
    const problems = checkProcModel({ schema: 'aio.procmodel/1', id: 'x', parts: 'no' });
    expect(problems[0]?.message).toMatch(/^The model file is not valid at /);
  });
});
