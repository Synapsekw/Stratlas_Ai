import { describe, expect, it } from 'vitest';
import { RemovalPlan, RemoveTarget, TRASH_SCHEMA, TrashRecord, emptyRemovalPlan } from './removal';
import { ipc } from './ipc';

describe('removal contract', () => {
  it('takes a layer, a run and a survey date as targets, and nothing else', () => {
    expect(RemoveTarget.safeParse({ layer: 'photos-a' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ run: '20261012-0930' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ capture: 'c1' }).success).toBe(true);
    expect(RemoveTarget.safeParse({ layer: 'a', run: 'b' }).success).toBe(false);
    expect(RemoveTarget.safeParse({ file: 'x' }).success).toBe(false);
    // a run id is a folder name: a path is refused at the boundary
    for (const run of ['../x', 'a/b', 'a\\b', '', '.hidden'])
      expect(RemoveTarget.safeParse({ run }).success).toBe(false);
  });

  it('parses an empty plan and one with every kind of reason', () => {
    expect(RemovalPlan.parse(emptyRemovalPlan())).toEqual(emptyRemovalPlan());
    const plan = {
      ...emptyRemovalPlan(),
      layers: [
        { id: 'photos-a', name: 'Flight A', kind: 'photos', why: 'asked' },
        { id: 'r-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r' } },
        { id: 'heat', name: 'Heat', kind: 'raster', why: { usedBy: 'r-ortho' } },
        { id: 'dsm', name: 'DSM', kind: 'raster', why: { filedUnder: 'c1' } },
      ],
      runs: [{ id: 'broken', status: null, why: { usedBy: 'photos-a' } }],
      keptCaptures: [{ id: 'c3', by: 'volume' }],
      files: ['photogrammetry/broken', 'rasters/r-ortho'],
      bytes: 2048,
    };
    expect(RemovalPlan.safeParse(plan).success).toBe(true);
  });

  it('refuses a path out of the project in files', () => {
    const plan = { ...emptyRemovalPlan(), files: ['../elsewhere'] };
    expect(RemovalPlan.safeParse(plan).success).toBe(false);
  });

  it('reads a trash record and refuses aio.trash/2', () => {
    const rec = {
      schema: TRASH_SCHEMA,
      at: '2026-10-13T08:15:30.000Z',
      targets: [{ run: '20261012-0930' }],
      plan: emptyRemovalPlan(),
      manifestBefore: 'manifest.before.json',
    };
    expect(TrashRecord.safeParse(rec).success).toBe(true);
    expect(TrashRecord.safeParse({ ...rec, schema: 'aio.trash/2' }).success).toBe(false);
  });

  it('has the four channels', () => {
    for (const c of ['builder:removePlan', 'builder:remove', 'builder:trash', 'builder:emptyTrash'])
      expect(Object.keys(ipc)).toContain(c);
  });
});
