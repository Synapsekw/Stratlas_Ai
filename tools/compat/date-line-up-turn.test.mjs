// Line up dates with a turn and a scale (plan 2026-10-18-line-up-similarity), pinned against the
// 0.21 schema (tools/compat/schema-0.21, the build before the turn): a capture may carry the
// sibling `lineUpTurn` beside the unchanged strict `lineUp`. The capture object is not strict, so
// 0.21 opens the project, keeps `lineUp` (the shift at the pivot), and drops `lineUpTurn` on its
// next manifest save (the known drop). `change.lineup` still writes `lineup.json` with the keys
// 0.21 knows (a `range` result is written there as `disagree`), and the turn goes to
// `lineup-fit.json`. Both are deliberate behaviours. Contract row of 18 Oct 2026.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const lineUp = { eastM: 2, northM: -0.2, with: 'c1', spreadM: 0.01, at: '2026-10-18T08:00:00Z' };
const lineUpTurn = { rotationDeg: 0.4, scale: 1.002, pivotE: 500100, pivotN: 3200100 };
const manifest = () => ({
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  customer: 'Demo',
  site: 'Synthetic',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [
    { id: 'c1', label: 'First', date: '2026-01-10' },
    { id: 'c2', label: 'Second', date: '2026-02-10', lineUp, lineUpTurn },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

// The keys Python writes to jobs/<id>/lineup.json (unchanged by the turn).
const measure = (verdict) => ({
  keep: 'c1',
  move: 'c2',
  layerKeep: 'ortho-1',
  layerMove: 'ortho-2',
  source: 'ortho',
  eastM: 2,
  northM: -0.2,
  totalM: 2.01,
  cellM: 0.05,
  tolerancePx: 2,
  spreadPx: 0.4,
  tiles: 12,
  verdict,
});

describe('a capture line-up turn is additive, and 0.21 drops it', () => {
  it('opens in 0.21, which keeps lineUp and drops lineUpTurn when it re-serialises', () => {
    const r = v021.ProjectManifest.safeParse(manifest());
    expect(r.success).toBe(true);
    expect(r.data.captures[1].lineUp).toEqual(lineUp);
    expect('lineUpTurn' in r.data.captures[1]).toBe(false);
    // What 0.21 would save, read back by the current build: the shift stays, the turn is gone.
    const again = current.ProjectManifest.safeParse(JSON.parse(JSON.stringify(r.data)));
    expect(again.success).toBe(true);
    expect(again.data.captures[1].lineUp).toEqual(lineUp);
    expect(again.data.captures[1].lineUpTurn).toBeUndefined();
  });

  it('is kept by the current schema', () => {
    const r = current.ProjectManifest.safeParse(manifest());
    expect(r.success).toBe(true);
    expect(r.data.captures[1].lineUp).toEqual(lineUp);
    expect(r.data.captures[1].lineUpTurn).toEqual(lineUpTurn);
  });

  it('0.21 LineUpMeasure parses the new lineup.json, a range result written as disagree', () => {
    for (const verdict of ['ok', 'aligned', 'texture', 'disagree', 'overlap']) {
      expect(v021.LineUpMeasure.safeParse(measure(verdict)).success, verdict).toBe(true);
      expect(current.LineUpMeasure.safeParse(measure(verdict)).success, verdict).toBe(true);
    }
    // `range` exists only in lineup-fit.json; 0.21 never sees it in lineup.json.
    expect(v021.LineUpMeasure.safeParse(measure('range')).success).toBe(false);
  });
});
